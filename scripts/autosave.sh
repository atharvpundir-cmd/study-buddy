#!/usr/bin/env bash
# Automatically commit and push your changes to GitHub.
#   ./scripts/autosave.sh          (checks every 60 seconds)
#   ./scripts/autosave.sh 300      (checks every 5 minutes)
# Stop it with Ctrl+C. Files listed in .gitignore (like .env with your API key) are never pushed.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
INTERVAL="${1:-60}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "Auto-saving '$BRANCH' to GitHub every ${INTERVAL}s. Press Ctrl+C to stop."
while true; do
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -q -m "Auto-save: $(date '+%Y-%m-%d %H:%M')"
    if git push -q origin "$BRANCH"; then
      echo "$(date '+%H:%M:%S') pushed changes"
    else
      echo "$(date '+%H:%M:%S') push failed - will try again next time"
    fi
  fi
  sleep "$INTERVAL"
done
