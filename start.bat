@echo off
REM KofiFX Terminal — Windows Startup Script
TITLE KofiFX Terminal

echo.
echo  KofiFX Terminal v1.0
echo  =======================
echo.

cd /d "%~dp0"

REM Check Python
where python >nul 2>nul
IF ERRORLEVEL 1 (
    echo [ERROR] Python not found. Install Python 3.10+ from https://python.org
    pause
    exit /b 1
)

REM Create venv if needed
IF NOT EXIST ".venv" (
    echo [INFO]  Creating virtual environment...
    python -m venv .venv
)

REM Activate
call .venv\Scripts\activate.bat

REM Install dependencies
echo [INFO]  Installing dependencies...
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

echo.
echo [OK]    Starting KofiFX Terminal on http://localhost:5001
echo [OK]    Open your browser and navigate to the URL above.
echo [OK]    Press Ctrl+C to stop.
echo.

python app.py
pause
