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

# MetaAPI credentials — set in .env (never commit .env to git)
METAAPI_TOKEN      = os.getenv('METAAPI_TOKEN',      '').strip()
METAAPI_ACCOUNT_ID = os.getenv('METAAPI_ACCOUNT_ID', '').strip()

# ---------------------------------------------------------------------------
# Symbols to pre-warm on startup (the default pane symbols + common extras)
# ---------------------------------------------------------------------------
_PRE_WARM: list[tuple[str, str]] = [
    ("EURUSD", "1h"), ("GBPUSD", "1h"), ("USDJPY", "1h"), ("XAUUSD",  "1h"),
    ("AUDUSD", "1h"), ("USDCAD", "1h"), ("SP500",  "1d"), ("US100",   "1d"),
    ("GBPJPY", "1h"), ("AUDJPY", "1h"), ("CADJPY", "1h"), ("USDCHF",  "1h"),
    ("NZDJPY", "1h"), ("DXY",    "1d"), ("GER40",  "1d"),
    ("EURCHF", "1h"), ("CADCHF", "1h"), ("GBPNZD", "1h"), ("AUDNZD",  "1h"),
    ("EURUSD", "4h"), ("GBPUSD", "4h"), ("XAUUSD", "4h"),
    ("EURUSD", "1d"), ("USDJPY", "4h"),
    # New instruments
    ("US30",    "1d"), ("US30",   "1h"),
    ("XAGUSD",  "1d"), ("XAGUSD", "1h"),
    ("BTCUSDT", "1d"), ("BTCUSDT","1h"),
    ("ETHUSDT", "1d"), ("ETHUSDT","1h"),
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


@app.route("/macro")
def macro_dashboard():
    """Macro Intelligence Dashboard."""
    return render_template("macro_dashboard.html")


@app.route("/api/calendar")
def api_calendar():
    """Proxy ForexFactory economic calendar JSON (avoids browser CORS).
    Returns the full week; clients filter to today."""
    try:
        resp = requests.get(
            "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
            timeout=8,
            headers={"User-Agent": "Mozilla/5.0 KofiFX-Terminal/1.0"},
        )
        resp.raise_for_status()
        return jsonify(resp.json())
    except Exception as exc:
        logger.error("Calendar fetch failed: %s", exc)
        return jsonify([])


@app.route("/api/news")
def api_news():
    """Proxy ForexFactory and FXStreet news RSS feeds, return as JSON array.
    Each item: {title, link, pubDate, source}"""
    import xml.etree.ElementTree as ET

    feeds = [
        ("ForexFactory", "https://www.forexfactory.com/rss.php?news"),
        ("FXStreet",     "https://www.fxstreet.com/rss/news"),
    ]
    articles = []
    for source, url in feeds:
        try:
            resp = requests.get(
                url, timeout=8,
                headers={"User-Agent": "Mozilla/5.0 KofiFX-Terminal/1.0"},
            )
            resp.raise_for_status()
            root = ET.fromstring(resp.content)
            for item in root.iter("item"):
                title   = item.findtext("title",   "").strip()
                link    = item.findtext("link",    "").strip()
                pubDate = item.findtext("pubDate", "").strip()
                if title:
                    articles.append({
                        "title":   title,
                        "link":    link,
                        "pubDate": pubDate,
                        "source":  source,
                    })
        except Exception as exc:
            logger.warning("News feed %s failed: %s", source, exc)

    # Return newest-first, cap at 40
    return jsonify(articles[:40])


# ---------------------------------------------------------------------------
# Broker / MetaAPI endpoints  (Exness MT4/MT5 via MetaAPI.cloud)
# ---------------------------------------------------------------------------
METAAPI_BASE   = "https://mt-client-api-v1.london.agiliumtrade.ai"
METAAPI_MGMT   = "https://trading-account-management-api.agiliumtrade.ai"


def _meta_headers(token: str) -> dict:
    return {"auth-token": token, "Content-Type": "application/json"}


def _resolve_token(request_data: dict) -> str:
    """Return token from request body, falling back to .env METAAPI_TOKEN."""
    return (request_data.get("token") or METAAPI_TOKEN or "").strip()


def _resolve_account(request_data: dict) -> str:
    """Return accountId from request body, falling back to .env METAAPI_ACCOUNT_ID."""
    return (request_data.get("accountId") or METAAPI_ACCOUNT_ID or "").strip()


@app.route("/api/broker/token-status")
def broker_token_status():
    """Tell the frontend whether a server-side token is already configured."""
    return jsonify({
        "hasToken":     bool(METAAPI_TOKEN),
        "hasAccountId": bool(METAAPI_ACCOUNT_ID),
    })


@app.route("/api/broker/accounts-list")
def broker_accounts_list():
    """List all MT accounts registered in this MetaAPI user account."""
    token = request.args.get("token", "").strip() or METAAPI_TOKEN
    if not token:
        return jsonify({"error": "token required"}), 400
    url = f"{METAAPI_MGMT}/users/current/accounts"
    try:
        resp = requests.get(url, headers=_meta_headers(token), timeout=12)
        resp.raise_for_status()
        accounts = resp.json()
        out = []
        for a in (accounts if isinstance(accounts, list) else []):
            out.append({
                "id":       a.get("_id",    a.get("id", "")),
                "name":     a.get("name",   ""),
                "server":   a.get("server", ""),
                "platform": a.get("platform", ""),
                "state":    a.get("state",  ""),
                "broker":   a.get("broker", ""),
            })
        return jsonify(out)
    except requests.RequestException as exc:
        logger.error("MetaAPI accounts-list error: %s", exc)
        return jsonify({"error": str(exc)}), 502


@app.route("/api/broker/connect", methods=["POST"])
def broker_connect():
    """Test MetaAPI connection and return account summary."""
    data    = request.get_json(force=True) or {}
    token   = _resolve_token(data)
    acct_id = _resolve_account(data)

    if not token or not acct_id:
        return jsonify({"error": "token and accountId are required"}), 400

    url = f"{METAAPI_BASE}/users/current/accounts/{acct_id}/account-information"
    try:
        resp = requests.get(url, headers=_meta_headers(token), timeout=12)
        if resp.status_code == 401:
            return jsonify({"error": "Invalid MetaAPI token"}), 401
        if resp.status_code == 404:
            return jsonify({"error": "Account not found — check Account ID"}), 404
        resp.raise_for_status()
        info = resp.json()
        return jsonify({
            "broker":      info.get("broker",    "—"),
            "name":        info.get("name",      "—"),
            "balance":     info.get("balance",   0),
            "equity":      info.get("equity",    0),
            "margin":      info.get("margin",    0),
            "freeMargin":  info.get("freeMargin",0),
            "marginLevel": info.get("marginLevel", 0),
            "currency":    info.get("currency",  "USD"),
            "leverage":    info.get("leverage",  100),
            "platform":    info.get("platform",  "mt5"),
            "server":      info.get("server",    "—"),
        })
    except requests.exceptions.Timeout:
        return jsonify({"error": "Connection timed out — check your token and account ID"}), 504
    except requests.RequestException as exc:
        logger.error("MetaAPI connect error: %s", exc)
        return jsonify({"error": f"Connection failed: {exc}"}), 502


@app.route("/api/broker/account")
def broker_account():
    """Return live account info for a connected MetaAPI account."""
    token   = (request.args.get("token",     "") or METAAPI_TOKEN).strip()
    acct_id = (request.args.get("accountId", "") or METAAPI_ACCOUNT_ID).strip()
    if not token or not acct_id:
        return jsonify({"error": "token and accountId required"}), 400

    url = f"{METAAPI_BASE}/users/current/accounts/{acct_id}/account-information"
    try:
        resp = requests.get(url, headers=_meta_headers(token), timeout=10)
        resp.raise_for_status()
        return jsonify(resp.json())
    except requests.RequestException as exc:
        logger.error("MetaAPI account fetch error: %s", exc)
        return jsonify({"error": str(exc)}), 502


@app.route("/api/broker/positions")
def broker_positions():
    """Return open positions for a connected MetaAPI account."""
    token   = (request.args.get("token",     "") or METAAPI_TOKEN).strip()
    acct_id = (request.args.get("accountId", "") or METAAPI_ACCOUNT_ID).strip()
    if not token or not acct_id:
        return jsonify({"error": "token and accountId required"}), 400

    url = f"{METAAPI_BASE}/users/current/accounts/{acct_id}/positions"
    try:
        resp = requests.get(url, headers=_meta_headers(token), timeout=10)
        resp.raise_for_status()
        positions = resp.json()
        # Normalise field names MetaAPI returns
        out = []
        for p in (positions if isinstance(positions, list) else []):
            out.append({
                "id":         p.get("id",          ""),
                "symbol":     p.get("symbol",      ""),
                "type":       p.get("type",        ""),   # POSITION_TYPE_BUY / SELL
                "volume":     p.get("volume",      0),
                "openPrice":  p.get("openPrice",   0),
                "currentPrice": p.get("currentPrice", 0),
                "profit":     p.get("profit",      0),
                "swap":       p.get("swap",        0),
                "openTime":   p.get("time",        ""),
            })
        return jsonify(out)
    except requests.RequestException as exc:
        logger.error("MetaAPI positions fetch error: %s", exc)
        return jsonify({"error": str(exc)}), 502


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
