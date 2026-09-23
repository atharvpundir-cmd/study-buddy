#!/usr/bin/env bash
# Start StudyBuddy on Mac or Linux:  ./start.sh
set -e
cd "$(dirname "$0")"

PY=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PY="$candidate"
    break
  fi
done
if [ -z "$PY" ]; then
  echo "StudyBuddy needs Python 3.10 or newer. Download it from https://www.python.org/downloads/ and run this again."
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "Setting up StudyBuddy for the first time (this takes a minute)..."
  "$PY" -m venv .venv
fi
.venv/bin/python -m pip install --quiet --disable-pip-version-check -r requirements.txt

if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "  Tip: put your Anthropic API key in the .env file to get real AI answers."
  echo "  Until then StudyBuddy runs in demo mode."
  echo ""
fi

exec .venv/bin/python app.py
