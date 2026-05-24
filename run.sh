#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  KofiFX Terminal — Startup Script (macOS / Linux)
# ─────────────────────────────────────────────────────────────────────────────
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "  ██╗  ██╗ ██████╗ ███████╗██╗███████╗██╗  ██╗"
echo "  ██║ ██╔╝██╔═══██╗██╔════╝██║██╔════╝╚██╗██╔╝"
echo "  █████╔╝ ██║   ██║█████╗  ██║█████╗   ╚███╔╝ "
echo "  ██╔═██╗ ██║   ██║██╔══╝  ██║██╔══╝   ██╔██╗ "
echo "  ██║  ██╗╚██████╔╝██║     ██║██║     ██╔╝ ██╗"
echo "  ╚═╝  ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝  ╚═╝"
echo "         T E R M I N A L  v1.0"
echo ""

# ── Python check ──────────────────────────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
  echo "[ERROR] python3 not found. Please install Python 3.10+."
  exit 1
fi

PYTHON=$(command -v python3)
echo "[INFO]  Python: $($PYTHON --version)"

# ── Virtual-env (optional but recommended) ────────────────────────────────────
VENV_DIR="$SCRIPT_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
  echo "[INFO]  Creating virtual environment…"
  $PYTHON -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

# ── Install / upgrade dependencies ───────────────────────────────────────────
echo "[INFO]  Installing dependencies…"
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

# ── Launch ────────────────────────────────────────────────────────────────────
echo ""
echo "[OK]    Starting KofiFX Terminal → http://localhost:5001"
echo "[OK]    Press Ctrl+C to stop."
echo ""
python app.py
