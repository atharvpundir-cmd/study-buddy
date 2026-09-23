"""A small in-memory rate limiter, so one person can't use up the whole AI budget."""

import threading
import time
from collections import defaultdict, deque


class RateLimiter:
    def __init__(self, max_requests: int, window_seconds: int):
        self.max_requests = max_requests
        self.window = window_seconds
        self._hits = defaultdict(deque)
        self._lock = threading.Lock()

    @classmethod
    def from_spec(cls, spec: str) -> "RateLimiter":
        """Build from a spec like '30/600' (30 requests per 600 seconds). '0' disables limiting."""
        spec = (spec or "").strip()
        if spec in ("", "0"):
            return cls(0, 1)
        count, _, seconds = spec.partition("/")
        return cls(int(count), int(seconds or 60))

    def retry_after(self, key: str) -> int:
        """Record a request for `key`. Returns 0 if allowed, else seconds until it will be."""
        if self.max_requests <= 0:
            return 0
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and hits[0] <= now - self.window:
                hits.popleft()
            if len(hits) >= self.max_requests:
                return max(1, int(hits[0] + self.window - now) + 1)
            hits.append(now)
            if len(self._hits) > 10_000:  # forget idle visitors so memory stays small
                for idle in [k for k, v in self._hits.items() if not v]:
                    del self._hits[idle]
            return 0
