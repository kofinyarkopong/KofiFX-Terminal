#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  KofiFX Terminal — macOS double-click launcher
#  Double-click this file in Finder to start the terminal in your browser.
#
#  First-time setup (one-off):
#    Right-click this file → Open (to bypass Gatekeeper on first run)
#    macOS will ask for permission — click Open.
#    After that, double-click works normally.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Resolve script directory (works even with spaces in path) ─────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-5001}"
VENV="$SCRIPT_DIR/.venv"
URL="http://localhost:$PORT"
LOG="$SCRIPT_DIR/kofifx.log"

# ── Pretty header ─────────────────────────────────────────────────────────
echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║        KofiFX Terminal  Launcher         ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# ── Check Python ─────────────────────────────────────────────────────────
if command -v python3 &>/dev/null; then
    PYTHON=python3
elif command -v python &>/dev/null; then
    PYTHON=python
else
    osascript -e 'display alert "Python not found" message "Please install Python 3 from https://www.python.org and try again." as critical'
    exit 1
fi

echo "  Python  : $($PYTHON --version)"

# ── Create / reuse virtualenv ─────────────────────────────────────────────
if [ ! -d "$VENV" ]; then
    echo "  Setting up virtual environment…"
    $PYTHON -m venv "$VENV"
fi

# shellcheck source=/dev/null
source "$VENV/bin/activate"

# ── Install / upgrade dependencies ───────────────────────────────────────
echo "  Checking dependencies…"
pip install --quiet --upgrade pip
pip install --quiet -r "$SCRIPT_DIR/requirements.txt"

# ── Copy .env.example → .env on first run ────────────────────────────────
if [ ! -f "$SCRIPT_DIR/.env" ] && [ -f "$SCRIPT_DIR/.env.example" ]; then
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
    echo "  Created .env from .env.example — edit it to add your OANDA key."
fi

# ── Kill any previous instance on this port ──────────────────────────────
OLD_PID=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
    echo "  Stopping previous instance (PID $OLD_PID)…"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
fi

# ── Start Flask in background ─────────────────────────────────────────────
echo "  Starting KofiFX Terminal on port $PORT…"
nohup "$PYTHON" "$SCRIPT_DIR/app.py" > "$LOG" 2>&1 &
SERVER_PID=$!
echo "  Server PID : $SERVER_PID"
echo "  Log file   : $LOG"

# ── Wait for server to be ready (up to 20 s) ─────────────────────────────
echo "  Waiting for server…"
MAX_WAIT=20
WAITED=0
until curl -s "$URL" > /dev/null 2>&1; do
    sleep 1
    WAITED=$((WAITED + 1))
    if [ $WAITED -ge $MAX_WAIT ]; then
        echo ""
        echo "  ⚠  Server did not start within ${MAX_WAIT}s."
        echo "     Check $LOG for errors."
        osascript -e "display alert \"KofiFX failed to start\" message \"The server did not respond within ${MAX_WAIT} seconds.\nCheck kofifx.log in the project folder for details.\" as critical"
        exit 1
    fi
    printf "."
done

echo ""
echo "  ✓  Server is up!  Opening $URL"
echo ""

# ── Open browser ──────────────────────────────────────────────────────────
open "$URL"

# ── Keep terminal window alive so the user can see the log ───────────────
echo "  ─────────────────────────────────────────────"
echo "  Press Ctrl-C or close this window to stop."
echo "  ─────────────────────────────────────────────"
echo ""

# Tail the log so the terminal window shows live output
tail -f "$LOG"
