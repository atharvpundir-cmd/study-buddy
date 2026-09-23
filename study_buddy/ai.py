"""Calls to Claude, plus a demo mode that works without an API key."""

import json
import os
import time

import anthropic

MODEL = os.environ.get("STUDY_BUDDY_MODEL", "claude-opus-5")
FALLBACK_BETA = "server-side-fallback-2026-07-01"  # retries a declined request on another model
TEXT_MAX_TOKENS = 64000
JSON_MAX_TOKENS = 32000

_client = None


class AIError(Exception):
    """An AI failure with a message that is safe and friendly to show a student."""


def demo_mode() -> bool:
    """True when there are no API credentials, or STUDY_BUDDY_DEMO=1 forces it."""
    forced = os.environ.get("STUDY_BUDDY_DEMO", "").strip().lower()
    if forced in ("1", "true", "yes"):
        return True
    if forced in ("0", "false", "no"):
        return False
    return not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(max_retries=2, timeout=600.0)
    return _client


def _request(system: str, messages: list, effort: str, max_tokens: int, output_format=None) -> dict:
    params = {
        "model": MODEL,
        "max_tokens": max_tokens,
        "system": system,
        "messages": messages,
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": effort},
        "cache_control": {"type": "ephemeral"},  # re-sent files in a chat are read from cache
        "betas": [FALLBACK_BETA],
        "fallbacks": "default",
    }
    if output_format:
        params["output_config"]["format"] = output_format
    return params


def _friendly(exc: Exception) -> AIError:
    if isinstance(exc, anthropic.AuthenticationError):
        return AIError("StudyBuddy's AI key isn't set up correctly. Please tell whoever runs this app.")
    if isinstance(exc, anthropic.PermissionDeniedError):
        return AIError("StudyBuddy's AI key isn't allowed to do this. Please tell whoever runs this app.")
    if isinstance(exc, anthropic.RateLimitError):
        return AIError("Lots of people are studying right now! Please wait a minute and try again.")
    if isinstance(exc, anthropic.BadRequestError):
        message = str(getattr(exc, "message", exc)).lower()
        if "too long" in message or "too large" in message or "exceed" in message:
            return AIError("That's too much to read at once. Try fewer or smaller files.")
        if "pdf" in message or "image" in message or "document" in message:
            return AIError("The AI couldn't read one of your files. Try saving it as a different PDF or a photo.")
        return AIError("The AI couldn't handle that request. Try changing your files or question.")
    if isinstance(exc, anthropic.APIStatusError):
        return AIError("The AI is busy right now. Please try again in a moment.")
    if isinstance(exc, anthropic.APIConnectionError):
        return AIError("StudyBuddy can't reach the AI right now. Check the internet connection and try again.")
    return AIError("Something went wrong. Please try again.")


REFUSAL_MESSAGE = "Sorry, StudyBuddy can't help with that one. Try asking about something else you're studying."
TRUNCATED_NOTE = "\n\n*(That was a long one, so I stopped here. Ask me to carry on if you need more!)*"


def stream_text(system: str, messages: list, effort: str):
    """Yield Markdown text chunks from Claude. Raises AIError on failure."""
    if demo_mode():
        yield from _demo_text(messages)
        return
    try:
        with _get_client().beta.messages.stream(**_request(system, messages, effort, TEXT_MAX_TOKENS)) as stream:
            for text in stream.text_stream:
                yield text
            final = stream.get_final_message()
    except anthropic.APIError as exc:
        raise _friendly(exc) from exc
    if final.stop_reason == "refusal":
        raise AIError(REFUSAL_MESSAGE)
    if final.stop_reason == "max_tokens":
        yield TRUNCATED_NOTE


def generate_json(system: str, messages: list, effort: str, schema: dict) -> dict:
    """Return a JSON object from Claude that matches `schema`. Raises AIError on failure."""
    if demo_mode():
        return _demo_json(schema)
    output_format = {"type": "json_schema", "schema": schema}
    try:
        # Streaming keeps long generations clear of HTTP timeouts.
        with _get_client().beta.messages.stream(**_request(system, messages, effort, JSON_MAX_TOKENS, output_format)) as stream:
            final = stream.get_final_message()
    except anthropic.APIError as exc:
        raise _friendly(exc) from exc
    if final.stop_reason == "refusal":
        raise AIError(REFUSAL_MESSAGE)
    if final.stop_reason == "max_tokens":
        raise AIError("That was too big to make in one go. Try asking for fewer questions.")
    text = "".join(block.text for block in final.content if block.type == "text")
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise AIError("The AI got muddled making that. Please try again.") from exc


# ---------------------------------------------------------------------------
# Demo mode: canned answers so the app can be tried (and tested) without a key.

DEMO_NOTES = r"""## Demo mode 👋

StudyBuddy is running **without an AI key**, so this is a sample answer. Ask whoever runs this app to add an `ANTHROPIC_API_KEY` to get real help.

### Photosynthesis (sample notes)

**Overview:** Plants make their own food using sunlight.

- **Chlorophyll** – the green pigment in leaves that captures light.
- **Inputs:** carbon dioxide + water + light energy
- **Outputs:** glucose + oxygen

\[ 6CO_2 + 6H_2O \xrightarrow{\text{light}} C_6H_{12}O_6 + 6O_2 \]

| Part of the leaf | Job |
|---|---|
| Stomata | Let CO\(_2\) in and O\(_2\) out |
| Chloroplasts | Where photosynthesis happens |

### Key points to remember
1. Light energy is turned into chemical energy.
2. Oxygen is released as a by-product.
"""

DEMO_QUIZ = {
    "title": "Photosynthesis (demo quiz)",
    "questions": [
        {
            "question": "What gas do plants take in for photosynthesis?",
            "choices": ["Oxygen", "Carbon dioxide", "Nitrogen", "Helium"],
            "answer_index": 1,
            "explanation": "Plants take in carbon dioxide through their stomata and release oxygen.",
        },
        {
            "question": "What is the green pigment that captures light called?",
            "choices": ["Chlorophyll", "Glucose", "Stomata", "Cellulose"],
            "answer_index": 0,
            "explanation": "Chlorophyll absorbs light energy, mostly red and blue light.",
        },
        {
            "question": "Which of these is made during photosynthesis?",
            "choices": ["Salt", "Protein", "Glucose", "Carbon dioxide"],
            "answer_index": 2,
            "explanation": "Glucose is the sugar plants make to store energy.",
        },
    ],
}

DEMO_CARDS = {
    "title": "Photosynthesis (demo flashcards)",
    "cards": [
        {"front": "Photosynthesis", "back": "How plants use light energy to make glucose from carbon dioxide and water."},
        {"front": "Chlorophyll", "back": "The green pigment in chloroplasts that absorbs light."},
        {"front": "Stomata", "back": "Tiny holes in leaves that let gases in and out."},
    ],
}


def _demo_text(messages):
    last = messages[-1]["content"] if messages else ""
    if isinstance(last, list):
        last = " ".join(b.get("text", "") for b in last if b.get("type") == "text")
    text = DEMO_NOTES if len(messages) <= 1 else f"*(Demo mode)* You said: “{last[:200]}”. Add an API key for real answers!"
    for i in range(0, len(text), 40):
        time.sleep(0.01)
        yield text[i : i + 40]


def _demo_json(schema):
    return json.loads(json.dumps(DEMO_QUIZ if "questions" in schema["properties"] else DEMO_CARDS))
