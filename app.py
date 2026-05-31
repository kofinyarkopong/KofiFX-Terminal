"""
KofiFX Terminal — Flask Backend
================================
Endpoints:
  GET /                        — serve the dashboard
  GET /api/ohlcv               — ?symbol=EURUSD&timeframe=1h&limit=300
  GET /api/price               — ?symbol=EURUSD
  GET /api/prices              — ?symbols=EURUSD,GBPUSD  (bulk, for polling mode)
  GET /api/symbols             — full symbol list
  GET /api/config              — tells client whether to use Socket.IO or polling
  WS  subscribe / unsubscribe  — Socket.IO live feed (local / dedicated server only)
  WS  price_update             — server → client push

Vercel deployment:
  Set IS_VERCEL=1 (Vercel sets this automatically via the VERCEL env var).
  When running on Vercel, background threads and Socket.IO are disabled;
  the client automatically switches to HTTP polling via /api/prices.
"""

import logging
import os
import threading
import time

# Load .env before anything else (python-dotenv is optional)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
from flask_socketio import SocketIO, emit

from data_source import (
    SYMBOL_MAP, TIMEFRAME_MAP, OANDA_API_KEY,
    get_ohlcv, get_price,
)

# ---------------------------------------------------------------------------
# Environment detection
# ---------------------------------------------------------------------------
# Vercel injects VERCEL=1 automatically; honour an explicit override too.
IS_VERCEL = bool(os.getenv('VERCEL') or os.getenv('IS_VERCEL'))

# ---------------------------------------------------------------------------
# Symbols to pre-warm on startup (the default pane symbols + common extras)
# ---------------------------------------------------------------------------
_PRE_WARM: list[tuple[str, str]] = [
    ("EURUSD", "1h"), ("GBPUSD", "1h"), ("USDJPY", "1h"), ("XAUUSD",  "1h"),
    ("AUDUSD", "1h"), ("USDCAD", "1h"), ("SP500",  "1d"), ("US100",   "1d"),
    ("GBPJPY", "1h"), ("AUDJPY", "1h"), ("CADJPY", "1h"), ("USDCHF",  "1h"),
    ("NZDJPY", "1h"), ("DXY",    "1d"), ("GER40",  "1d"),
    ("EURUSD", "4h"), ("GBPUSD", "4h"), ("XAUUSD", "4h"),
    ("EURUSD", "1d"), ("USDJPY", "4h"),
]


def _pre_warm_cache():
    """Fetch OHLCV data for the most common symbols at startup so the first
    page load is instant rather than waiting on yfinance for every pane."""
    logger.info("Cache pre-warm starting (%d jobs)…", len(_PRE_WARM))
    for sym, tf in _PRE_WARM:
        try:
            get_ohlcv(sym, tf, 300)
            logger.info("  Warmed  %s / %s", sym, tf)
        except Exception as exc:
            logger.warning("  Failed  %s / %s: %s", sym, tf, exc)
        time.sleep(0.25)   # gentle pacing — don't trigger Yahoo rate-limits
    logger.info("Cache pre-warm complete.")


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config["SECRET_KEY"] = "kofifx-terminal-2026"
CORS(app, origins="*")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

SYMBOLS    = sorted(SYMBOL_MAP.keys())
TIMEFRAMES = list(TIMEFRAME_MAP.keys())

# Shared set of symbols the client wants live ticks for
_watched: set[str] = set()
_watch_lock = threading.Lock()

# Per-symbol last-known price (to detect direction on broadcast)
_last_price: dict[str, float] = {}


# ---------------------------------------------------------------------------
# REST routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html", symbols=SYMBOLS, timeframes=TIMEFRAMES)


@app.route("/position-sizing")
def position_sizing():
    """Standalone Forex Position Sizing & Risk Dashboard."""
    return render_template("position_sizing.html")


@app.route("/api/ohlcv")
def api_ohlcv():
    symbol    = request.args.get("symbol",    "EURUSD").upper()
    timeframe = request.args.get("timeframe", "1h")
    limit     = min(int(request.args.get("limit", 300)), 500)
    data      = get_ohlcv(symbol, timeframe, limit)
    return jsonify({"symbol": symbol, "timeframe": timeframe, "data": data})


@app.route("/api/price")
def api_price():
    symbol = request.args.get("symbol", "EURUSD").upper()
    return jsonify(get_price(symbol))


@app.route("/api/symbols")
def api_symbols():
    return jsonify(SYMBOLS)


@app.route("/api/prices")
def api_prices():
    """Bulk price endpoint used by the client in polling mode (Vercel / no WS).
    ?symbols=EURUSD,GBPUSD,XAUUSD  — returns {SYMBOL: snap, …}"""
    raw     = request.args.get("symbols", "")
    symbols = [s.strip().upper() for s in raw.split(",")
               if s.strip().upper() in SYMBOL_MAP][:20]
    if not symbols:
        return jsonify({})
    result = {}
    for sym in symbols:
        try:
            result[sym] = get_price(sym)
        except Exception:
            pass
    return jsonify(result)


@app.route("/api/config")
def api_config():
    """Tells the client which real-time mode to use."""
    return jsonify({
        "realtime":     not IS_VERCEL,   # True → Socket.IO; False → HTTP polling
        "pollInterval": 4000,            # ms between price polls in polling mode
    })


# ---------------------------------------------------------------------------
# WebSocket events
# ---------------------------------------------------------------------------
@socketio.on("connect")
def on_connect():
    logger.info("Client connected: %s", request.sid)


@socketio.on("disconnect")
def on_disconnect():
    logger.info("Client disconnected: %s", request.sid)


@socketio.on("subscribe")
def on_subscribe(data):
    symbol = (data.get("symbol") or "").upper().strip()
    if symbol and symbol in SYMBOL_MAP:
        with _watch_lock:
            _watched.add(symbol)
        logger.debug("Subscribed → %s  (watching %d)", symbol, len(_watched))


@socketio.on("unsubscribe")
def on_unsubscribe(data):
    symbol = (data.get("symbol") or "").upper().strip()
    with _watch_lock:
        _watched.discard(symbol)
    logger.debug("Unsubscribed → %s", symbol)


@socketio.on("get_ohlcv")
def on_get_ohlcv(data):
    """Client can also request OHLCV over the socket for lower latency."""
    symbol    = (data.get("symbol")    or "EURUSD").upper()
    timeframe = data.get("timeframe") or "1h"
    limit     = min(int(data.get("limit") or 300), 500)
    candles   = get_ohlcv(symbol, timeframe, limit)
    emit("ohlcv_data", {"symbol": symbol, "timeframe": timeframe, "data": candles})


# ---------------------------------------------------------------------------
# Background price broadcast loop
# ---------------------------------------------------------------------------
_POLL_INTERVAL = 4   # seconds between price refreshes per symbol

def _broadcast_loop():
    """
    Polls prices for every subscribed symbol and emits price_update
    events to all connected clients.
    """
    while True:
        time.sleep(_POLL_INTERVAL)
        with _watch_lock:
            symbols_snapshot = set(_watched)

        for sym in symbols_snapshot:
            try:
                snap = get_price(sym)
                price = snap.get("price", 0)

                # Determine tick direction against last broadcast
                prev = _last_price.get(sym, price)
                if price > prev:
                    snap["tick"] = "up"
                elif price < prev:
                    snap["tick"] = "down"
                else:
                    snap["tick"] = "flat"

                _last_price[sym] = price
                socketio.emit("price_update", snap)

            except Exception as exc:
                logger.error("Broadcast error for %s: %s", sym, exc)


# Background threads only make sense on a persistent server.
# Vercel serverless functions are stateless; each invocation is independent,
# so threads started here would die immediately and serve no purpose.
if not IS_VERCEL:
    _broadcast_thread = threading.Thread(target=_broadcast_loop, daemon=True)
    _broadcast_thread.start()
    logger.info("Price broadcast loop started (interval=%ds)", _POLL_INTERVAL)

    _warm_thread = threading.Thread(target=_pre_warm_cache, daemon=True)
    _warm_thread.start()
else:
    logger.info("Vercel environment detected — Socket.IO push and cache pre-warm disabled."
                " Client will use HTTP polling.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.getenv("PORT", 5001))
    logger.info("=" * 60)
    logger.info("  KofiFX Terminal  →  http://localhost:%d", port)
    if OANDA_API_KEY:
        logger.info("  Data source      →  OANDA (forex/metals) + yfinance (indices)")
    else:
        logger.info("  Data source      →  yfinance (all instruments)")
        logger.info("  Tip: set OANDA_API_KEY in .env for live forex data from OANDA")
    logger.info("=" * 60)
    socketio.run(app, host="0.0.0.0", port=port, debug=False,
                 use_reloader=False, allow_unsafe_werkzeug=True)
