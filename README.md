# 📚 StudyBuddy

**Your friendly AI study helper – from Year 6 all the way to university.**

Drop in your class notes, a worksheet, textbook pages or lecture slides (or just type a topic), then pick what you need:

| | What you get |
|---|---|
| 📝 **Notes** | Tidy, well-organised study notes with key terms in bold |
| 📋 **Summary** | The big idea and the main points, fast |
| 💡 **Explain it** | A step-by-step explanation with an everyday example |
| ❓ **Quiz me** | An interactive multiple-choice quiz with instant feedback and a score |
| 🃏 **Flashcards** | Flip cards to test yourself, with shuffle |
| 💬 **Ask a tutor** | Chat about anything – homework help, "why?" questions, exam tips |

Pick your level at the top – **Year 6**, **Years 7-9**, **Years 10-12** or **University** – and StudyBuddy changes how it explains things to suit you.

**Works with:** PDF · Word (.docx) · PowerPoint (.pptx) · photos (JPG, PNG, WebP, GIF) · text files. You can take a photo of a worksheet with your phone, or paste a screenshot with Ctrl+V / ⌘+V.

Answers can be copied, saved, or printed (choose "Save as PDF" when printing to keep a copy). Maths and science formulas display properly too.

---

## 🚀 Run it on your computer (5 minutes)

You need **Python 3.10 or newer** ([download it here](https://www.python.org/downloads/)) and an **Anthropic API key** ([get one here](https://console.anthropic.com/)).
No key yet? StudyBuddy still starts in **demo mode** so you can look around.

1. **Download StudyBuddy.** Click the green **Code** button on this page → **Download ZIP**, then unzip it.
   (Or: `git clone https://github.com/atharvpundir-cmd/study-buddy.git`)
2. **Start it.**
   - **Windows:** double-click `start.bat`
   - **Mac / Linux:** open Terminal in the folder and run `./start.sh`
3. **Add your key.** The first run creates a file called `.env`. Open it, paste your key after `ANTHROPIC_API_KEY=`, save it, and start StudyBuddy again.
4. **Open** <http://localhost:5000> in your browser. Done! 🎉

<details>
<summary>Prefer doing it by hand?</summary>

```bash
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env              # then add your ANTHROPIC_API_KEY
python app.py
```
</details>

---

## 🏫 Put it online for a class (teachers & parents)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/atharvpundir-cmd/study-buddy)

1. Click the button above (you'll need a free [Render](https://render.com) account).
2. Paste your `ANTHROPIC_API_KEY` when asked.
3. **Set a class code** in `STUDY_BUDDY_ACCESS_CODE` (e.g. `owl-42`). Students type it once; without it, anyone with the link could use your API credit.
4. Share the link with your students.

You can also run it anywhere that runs Docker (`docker build -t study-buddy . && docker run -p 8000:8000 --env-file .env study-buddy`).

**About cost:** every answer uses your Anthropic API credit. Set a monthly spend limit in the [Anthropic Console](https://console.anthropic.com/), keep a class code on, and use the built-in per-student rate limit.

### Settings

Put these in `.env` (on your computer) or in your host's environment variables.

| Setting | What it does | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key. Without it, StudyBuddy runs in demo mode. | – |
| `STUDY_BUDDY_ACCESS_CODE` | A class code students must enter first. Strongly recommended online. | off |
| `STUDY_BUDDY_RATE_LIMIT` | Requests allowed per person, as `requests/seconds`. `0` turns it off. | `30/600` |
| `STUDY_BUDDY_TRUST_PROXY` | Set to `1` behind a proxy/host (Render, Railway, Fly…) so each student is rate-limited separately. | off |
| `STUDY_BUDDY_MODEL` | Which Claude model to use. | `claude-opus-5` |
| `STUDY_BUDDY_DEMO` | `1` forces demo mode, `0` forces real AI. | auto |
| `PORT` / `HOST` | Where the local server listens. | `5000` / `127.0.0.1` |

---

## 🛡️ Safety & privacy

- Answers are written to suit school students, including children as young as 10. If a student seems upset or unsafe, StudyBuddy gently points them to a trusted adult or helpline.
- StudyBuddy explains *how* to solve problems so students learn, not just copy answers.
- Uploaded files are processed in memory to answer the question and **are not saved** by StudyBuddy. They are sent to Anthropic's API to generate the answer (see [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy)).
- AI can make mistakes – check important facts with a teacher or textbook.
- Limits: up to 10 files, 20 MB in total, per request.

---

## 🧑‍💻 For developers

```
app.py                 Flask app: routes, validation, access code, rate limiting
study_buddy/ai.py      Claude calls (streaming text, structured JSON) + demo mode
study_buddy/files.py   Turns uploads into Claude content blocks (PDF/images native, DOCX/PPTX → text)
study_buddy/prompts.py Levels, study modes, and the tutor system prompt
static/                The whole frontend: plain HTML, CSS and JavaScript (no build step)
tests/                 pytest suite (runs without an API key)
```

```bash
pip install -r requirements-dev.txt
pytest
```

**How it works:** PDFs and images go straight to Claude, which can read text, diagrams and handwriting. Word and PowerPoint files are converted to text first (including tables and speaker notes). Notes, summaries, explanations and chat replies stream back as Markdown. Quizzes and flashcards use structured outputs, so they always arrive as valid JSON that the page turns into interactive cards. If Claude declines a request, a server-side fallback retries it automatically.

**Auto-save to GitHub:** run `./scripts/autosave.sh` while you work and your changes are committed and pushed every minute (`.env` is never pushed).

Contributions are welcome – open an issue or a pull request!

## License

[MIT](LICENSE)
