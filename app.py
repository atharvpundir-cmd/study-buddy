"""StudyBuddy: upload study files and get notes, quizzes, flashcards and explanations from AI."""

import hmac
import json
import os
import re
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context
from werkzeug.middleware.proxy_fix import ProxyFix

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


def _load_dotenv(path: Path) -> None:
    """Read KEY=value lines from a .env file into the environment (real env vars win)."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip().strip('"').strip("'")
        if value:
            os.environ.setdefault(key.strip(), value)


_load_dotenv(BASE_DIR / ".env")

from study_buddy import ai, files, prompts  # noqa: E402  (after .env so settings apply)
from study_buddy.limits import RateLimiter  # noqa: E402

MAX_TEXT_CHARS = 50_000  # anything a student types
MAX_REPLY_CHARS = 300_000  # a StudyBuddy answer carried in chat history (long notes can be big)
MAX_HISTORY = 40
DEFAULT_COUNT = {"quiz": 10, "flashcards": 12}

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = files.MAX_TOTAL_BYTES + 8 * 1024 * 1024  # files plus form fields
app.config["MAX_FORM_MEMORY_SIZE"] = 8 * 1024 * 1024  # a long chat history is one big form field

ACCESS_CODE = os.environ.get("STUDY_BUDDY_ACCESS_CODE", "").strip()
# Students in one classroom usually share an internet address, so the main limit is per
# browser; a looser per-address limit stops anyone dodging it by inventing new browser IDs.
limiter = RateLimiter.from_spec(os.environ.get("STUDY_BUDDY_RATE_LIMIT", "30/600"))
network_limiter = RateLimiter.from_spec(os.environ.get("STUDY_BUDDY_NETWORK_RATE_LIMIT", "300/600"))
CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")


def _proxy_count(value: str) -> int:
    """How many proxies sit in front of the app ('1'/'true' means one)."""
    value = value.strip().lower()
    if value in ("true", "yes"):
        return 1
    return int(value) if value.isdigit() else 0


PROXIES = _proxy_count(os.environ.get("STUDY_BUDDY_TRUST_PROXY", ""))
if PROXIES:
    # Use the client address the trusted proxy saw, not one the browser could fake.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=PROXIES, x_proto=PROXIES)


class BadInput(ValueError):
    """A problem with the request, worded for a student."""


# ---------------------------------------------------------------------------
# Helpers


def _error(message: str, status: int, **extra):
    return jsonify({"error": message, **extra}), status


def _check_access():
    """Return an error response if the request isn't allowed, otherwise None."""
    if ACCESS_CODE:
        given = request.headers.get("X-Access-Code", "")
        if not hmac.compare_digest(given.encode(), ACCESS_CODE.encode()):
            return _error("Please enter the class code to use StudyBuddy.", 401, needs_code=True)
    address = request.remote_addr or "unknown"
    client_id = request.headers.get("X-Client-Id", "")
    student = f"browser:{client_id}" if CLIENT_ID_RE.match(client_id) else f"address:{address}"
    wait = limiter.retry_after(student)
    if wait:
        return _error(f"You've asked a lot of questions! Take a short break and try again in about {_minutes(wait)}.", 429)
    wait = network_limiter.retry_after(address)
    if wait:
        return _error(f"StudyBuddy is very busy on your network right now. Please try again in about {_minutes(wait)}.", 429)
    return None


def _minutes(seconds: int) -> str:
    minutes = max(1, round(seconds / 60))
    return f"{minutes} minute{'s' if minutes > 1 else ''}"


def _level() -> str:
    level = request.form.get("level", prompts.DEFAULT_LEVEL)
    return level if level in prompts.LEVELS else prompts.DEFAULT_LEVEL


def _student_text() -> str:
    text = (request.form.get("text") or "").strip()
    if len(text) > MAX_TEXT_CHARS:
        raise BadInput(f"Your text is too long. Please keep it under {MAX_TEXT_CHARS:,} characters, or upload it as a file.")
    return text


def _file_blocks() -> list:
    uploads = [f for f in request.files.getlist("files") if f and f.filename]
    return files.to_content_blocks([(f.filename, f.read()) for f in uploads])


def _history() -> list:
    """Parse and validate the chat history sent by the browser."""
    try:
        history = json.loads(request.form.get("history") or "[]")
    except json.JSONDecodeError as exc:
        raise BadInput("Something went wrong with the chat. Try starting a new one.") from exc
    if not isinstance(history, list) or not history:
        raise BadInput("Type a question to ask StudyBuddy.")
    if len(history) > MAX_HISTORY:
        raise BadInput("This chat is getting very long. Start a new chat to keep going.")
    cleaned = []
    for i, turn in enumerate(history):
        expected = "user" if i % 2 == 0 else "assistant"
        if not isinstance(turn, dict) or turn.get("role") != expected or not isinstance(turn.get("content"), str):
            raise BadInput("Something went wrong with the chat. Try starting a new one.")
        content = turn["content"].strip()
        if not content:
            raise BadInput("Something went wrong with the chat. Try starting a new one.")
        if len(content) > (MAX_TEXT_CHARS if expected == "user" else MAX_REPLY_CHARS):
            raise BadInput(f"Your message is too long. Please keep it under {MAX_TEXT_CHARS:,} characters.")
        cleaned.append({"role": expected, "content": content})
    if cleaned[-1]["role"] != "user":
        raise BadInput("Type a question to ask StudyBuddy.")
    return cleaned


def _first_turn(blocks: list, text: str) -> list:
    return [{"role": "user", "content": [*blocks, {"type": "text", "text": text}]}]


def _count(mode: str) -> int:
    try:
        count = int(request.form.get("count") or DEFAULT_COUNT[mode])
    except ValueError:
        count = DEFAULT_COUNT[mode]
    return min(max(count, 3), 25)


def _ndjson(event: dict) -> str:
    return json.dumps(event, ensure_ascii=False) + "\n"


# ---------------------------------------------------------------------------
# Validation of AI output for quizzes and flashcards


def _clean_quiz(data: dict) -> dict:
    questions = []
    for q in data.get("questions") or []:
        choices = [str(c).strip() for c in q.get("choices") or [] if str(c).strip()]
        answer = q.get("answer_index")
        if q.get("question") and len(choices) >= 2 and isinstance(answer, int) and 0 <= answer < len(choices):
            questions.append({"question": q["question"].strip(), "choices": choices, "answer_index": answer, "explanation": (q.get("explanation") or "").strip()})
    if not questions:
        raise ai.AIError("The AI got muddled making that quiz. Please try again.")
    return {"title": (data.get("title") or "Quiz").strip(), "questions": questions}


def _clean_cards(data: dict) -> dict:
    cards = [{"front": c["front"].strip(), "back": c["back"].strip()} for c in data.get("cards") or [] if c.get("front", "").strip() and c.get("back", "").strip()]
    if not cards:
        raise ai.AIError("The AI got muddled making those flashcards. Please try again.")
    return {"title": (data.get("title") or "Flashcards").strip(), "cards": cards}


# ---------------------------------------------------------------------------
# Routes


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/api/config")
def config():
    return {
        "demo": ai.demo_mode(),
        "needsCode": bool(ACCESS_CODE),
        "levels": [{"id": key, "label": value["label"]} for key, value in prompts.LEVELS.items()],
        "defaultLevel": prompts.DEFAULT_LEVEL,
        "accept": files.ACCEPTED,
        "maxFiles": files.MAX_FILES,
        "maxMegabytes": files.MAX_TOTAL_BYTES // (1024 * 1024),
    }


@app.post("/api/generate")
def generate():
    """Stream notes, a summary, an explanation or a chat reply as newline-delimited JSON."""
    denied = _check_access()
    if denied:
        return denied
    mode = request.form.get("mode", "")
    if mode not in prompts.TEXT_MODES:
        return _error("Please pick what you'd like StudyBuddy to make.", 400)
    try:
        level = _level()
        blocks = _file_blocks()
        if mode == "chat":
            history = _history()
            messages = _first_turn(blocks, history[0]["content"]) + history[1:]
        else:
            text = _student_text()
            if not blocks and not text:
                raise BadInput("Add a file or type a topic first.")
            messages = _first_turn(blocks, prompts.task_text(prompts.TEXT_MODES[mode]["prompt"], text, bool(blocks)))
    except (BadInput, files.FileError) as exc:
        return _error(str(exc), 400)

    system = prompts.system_prompt(level)
    effort = prompts.TEXT_MODES[mode]["effort"]

    def events():
        try:
            for chunk in ai.stream_text(system, messages, effort):
                yield _ndjson({"type": "delta", "text": chunk})
            yield _ndjson({"type": "done"})
        except ai.AIError as exc:
            yield _ndjson({"type": "error", "message": str(exc)})
        except Exception:  # never leak internals to the browser
            app.logger.exception("generate failed")
            yield _ndjson({"type": "error", "message": "Something went wrong. Please try again."})

    return Response(
        stream_with_context(events()),
        mimetype="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/practice")
def practice():
    """Make a quiz or a set of flashcards as JSON."""
    denied = _check_access()
    if denied:
        return denied
    mode = request.form.get("mode", "")
    if mode not in prompts.JSON_MODES:
        return _error("Please pick quiz or flashcards.", 400)
    try:
        level = _level()
        text = _student_text()
        blocks = _file_blocks()
        if not blocks and not text:
            raise BadInput("Add a file or type a topic first.")
    except (BadInput, files.FileError) as exc:
        return _error(str(exc), 400)

    spec = prompts.JSON_MODES[mode]
    instruction = spec["prompt"].format(count=_count(mode))
    messages = _first_turn(blocks, prompts.task_text(instruction, text, bool(blocks)))
    try:
        data = ai.generate_json(prompts.system_prompt(level), messages, spec["effort"], spec["schema"])
        return jsonify(_clean_quiz(data) if mode == "quiz" else _clean_cards(data))
    except ai.AIError as exc:
        return _error(str(exc), 502)
    except Exception:
        app.logger.exception("practice failed")
        return _error("Something went wrong. Please try again.", 500)


@app.errorhandler(413)
def too_large(_):
    return _error(f"Your files are too big. Keep them under {files.MAX_TOTAL_BYTES // (1024 * 1024)} MB in total.", 413)


@app.after_request
def security_headers(response):
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; "
        "font-src 'self' data: https://cdn.jsdelivr.net https://fonts.gstatic.com; "
        "img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    )
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    return response


if __name__ == "__main__":
    import sys
    import threading
    import webbrowser

    port = int(os.environ.get("PORT", "5000"))
    url = f"http://localhost:{port}"
    print(f"\n  📚 StudyBuddy is running!  Open {url} in your browser.\n")
    if ai.demo_mode():
        print("  (Demo mode: set ANTHROPIC_API_KEY to get real AI answers.)\n")
    if "--open" in sys.argv:  # the start scripts open the browser once the server is up
        threading.Timer(1.5, webbrowser.open, args=[url]).start()
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=port, threaded=True)
