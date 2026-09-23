@echo off
rem Start StudyBuddy on Windows: double-click this file.
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (set "PY=py -3") else (set "PY=python")
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if errorlevel 1 (
  echo StudyBuddy needs Python 3.10 or newer. Download it from https://www.python.org/downloads/
  pause
  exit /b 1
)

if not exist .venv\Scripts\python.exe (
  echo Setting up StudyBuddy for the first time, this takes a minute...
  %PY% -m venv .venv
)
.venv\Scripts\python -m pip install --quiet --disable-pip-version-check -r requirements.txt

if not exist .env (
  copy .env.example .env >nul
  echo Tip: put your Anthropic API key in the .env file to get real AI answers.
)

start "" http://localhost:5000
.venv\Scripts\python app.py
pause
