"""
KofiFX Terminal — Pluggable Data Source
========================================
Default sources (no API keys required):
  • yfinance  — forex pairs, indices, commodities, gold
  • Hyperliquid WebSocket — handled client-side in hyperliquid.js

Optional premium sources (set env vars in .env):
  • OANDA v20 Practice API — forex pairs + metals (free practice account)
    Set OANDA_API_KEY and optionally OANDA_ACCOUNT_ID in your .env file.
    All forex pairs and XAU/XAG are routed to OANDA when the key is present;
    indices (DXY, US100, SP500, GER40…) always fall back to yfinance.

To add a new broker:
  1. Add its symbol mapping to SYMBOL_MAP (or a separate dict)
  2. Implement _get_ohlcv_<broker>(symbol, timeframe, limit) -> list[dict]
  3. Implement _get_price_<broker>(symbol) -> dict
  4. Register the routing logic inside get_ohlcv() and get_price()
"""

import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Optional

import requests
import pandas as pd
import yfinance as yf

# Load .env file if python-dotenv is installed (optional dependency)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# OANDA v20 configuration  (set OANDA_API_KEY in .env to enable)
# ---------------------------------------------------------------------------
OANDA_API_KEY   = os.getenv('OANDA_API_KEY',   '').strip()
OANDA_BASE_URL  = os.getenv('OANDA_BASE_URL',  'https://api-fxpractice.oanda.com/v3').rstrip('/')
OANDA_ACCOUNT_ID = os.getenv('OANDA_ACCOUNT_ID', '').strip()

# KofiFX label  ->  OANDA instrument name
OANDA_INSTRUMENT_MAP: dict[str, str] = {
    # Major forex pairs
    'EURUSD': 'EUR_USD', 'GBPUSD': 'GBP_USD', 'USDJPY': 'USD_JPY',
    'USDCHF': 'USD_CHF', 'USDCAD': 'USD_CAD', 'AUDUSD': 'AUD_USD',
    'NZDUSD': 'NZD_USD',
    # EUR crosses
    'EURGBP': 'EUR_GBP', 'EURJPY': 'EUR_JPY', 'EURCHF': 'EUR_CHF',
    'EURCAD': 'EUR_CAD', 'EURAUD': 'EUR_AUD', 'EURNZD': 'EUR_NZD',
    # GBP crosses
    'GBPJPY': 'GBP_JPY', 'GBPCAD': 'GBP_CAD', 'GBPCHF': 'GBP_CHF',
    'GBPAUD': 'GBP_AUD', 'GBPNZD': 'GBP_NZD',
    # AUD crosses
    'AUDJPY': 'AUD_JPY', 'AUDCAD': 'AUD_CAD', 'AUDCHF': 'AUD_CHF',
    'AUDNZD': 'AUD_NZD',
    # CAD / NZD crosses
    'CADJPY': 'CAD_JPY', 'CADCHF': 'CAD_CHF',
    'NZDJPY': 'NZD_JPY', 'NZDCAD': 'NZD_CAD', 'NZDCHF': 'NZD_CHF',
    'CHFJPY': 'CHF_JPY',
    # Metals
    'XAUUSD': 'XAU_USD', 'XAGUSD': 'XAG_USD',
}

# KofiFX timeframe  ->  OANDA granularity
OANDA_GRANULARITY: dict[str, str] = {
    '1m':  'M1',
    '5m':  'M5',
    '15m': 'M15',
    '30m': 'M30',
    '1h':  'H1',
    '4h':  'H4',
    '1d':  'D',
    '1w':  'W',
}

# ---------------------------------------------------------------------------
# In-memory TTL cache  (avoids hammering yfinance on every page load)
# ---------------------------------------------------------------------------
_cache_lock = threading.Lock()
_cache: dict = {}

# How long (seconds) each timeframe's OHLCV data stays fresh
_OHLCV_TTL: dict[str, int] = {
    '1m':  30,
    '5m':  60,
    '15m': 120,
    '30m': 180,
    '1h':  300,
    '4h':  600,
    '1d':  3600,
    '1w':  86400,
}
_PRICE_TTL = 4   # seconds — match the broadcast interval in app.py


def _cache_get(key: str, ttl: int):
    with _cache_lock:
        entry = _cache.get(key)
        if entry and (time.time() - entry['ts'] < ttl):
            return entry['data']
    return None


def _cache_set(key: str, data):
    with _cache_lock:
        _cache[key] = {'ts': time.time(), 'data': data}

# ---------------------------------------------------------------------------
# Symbol Routing Map  (our label -> yfinance ticker)
# ---------------------------------------------------------------------------
SYMBOL_MAP: dict[str, str] = {
    # Forex
    "AUDUSD": "AUDUSD=X",
    "AUDJPY": "AUDJPY=X",
    "CADJPY": "CADJPY=X",
    "USDCHF": "USDCHF=X",
    "USDCAD": "USDCAD=X",
    "GBPUSD": "GBPUSD=X",
    "GBPJPY": "GBPJPY=X",
    "USDJPY": "USDJPY=X",
    "NZDJPY": "NZDJPY=X",
    "EURUSD": "EURUSD=X",
    "NZDUSD": "NZDUSD=X",
    "EURGBP": "EURGBP=X",
    "EURJPY": "EURJPY=X",
    "EURCHF": "EURCHF=X",
    "EURCAD": "EURCAD=X",
    "GBPCAD": "GBPCAD=X",
    "GBPCHF": "GBPCHF=X",
    "GBPNZD": "GBPNZD=X",
    "EURNZD": "EURNZD=X",
    "AUDCAD": "AUDCAD=X",
    "AUDCHF": "AUDCHF=X",
    "AUDNZD": "AUDNZD=X",
    "CADCHF": "CADCHF=X",
    "NZDCAD": "NZDCAD=X",
    "NZDCHF": "NZDCHF=X",
    "CHFJPY": "CHFJPY=X",
    # Indices
    "DXY":   "DX-Y.NYB",
    "US100": "NQ=F",
    "SP500": "^GSPC",
    "GER40": "^GDAXI",
    "UK100": "^FTSE",
    "JP225": "^N225",
    "HK50":  "^HSI",
    # Commodities / Metals
    "XAUUSD": "GC=F",
    "XAGUSD": "SI=F",
    "USOIL":  "CL=F",
    "UKOIL":  "BZ=F",
    # US Stocks (examples)
    "AAPL": "AAPL",
    "TSLA": "TSLA",
    "NVDA": "NVDA",
    # Crypto via yfinance fallback (Hyperliquid WS preferred client-side)
    "BTCUSD": "BTC-USD",
    "ETHUSD": "ETH-USD",
    "SOLUSD": "SOL-USD",
}

# Symbols categorised as crypto (routed to Hyperliquid WS on the front end)
HYPERLIQUID_SYMBOLS: set[str] = {
    "BTC", "ETH", "SOL", "ARB", "AVAX", "DOGE", "MATIC", "OP",
    "BTCUSD", "ETHUSD", "SOLUSD",
}

# ---------------------------------------------------------------------------
# Timeframe Map  (our label -> (yfinance interval, yfinance period))
# ---------------------------------------------------------------------------
TIMEFRAME_MAP: dict[str, tuple[str, str]] = {
    "1m":  ("1m",  "1d"),
    "5m":  ("5m",  "5d"),
    "15m": ("15m", "5d"),
    "30m": ("30m", "5d"),
    "1h":  ("1h",  "1mo"),
    "4h":  ("1h",  "3mo"),   # will be resampled below
    "1d":  ("1d",  "1y"),
    "1w":  ("1wk", "5y"),
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _to_yf_ticker(symbol: str) -> str:
    return SYMBOL_MAP.get(symbol.upper(), symbol)


def _row_to_dict(ts, row: pd.Series) -> dict:
    """Convert a single OHLCV row to a serialisable dict."""
    if hasattr(ts, "timestamp"):
        unix_ts = int(ts.timestamp())
    else:
        unix_ts = int(pd.Timestamp(ts).timestamp())

    return {
        "time":   unix_ts,
        "open":   round(float(row["Open"]),   6),
        "high":   round(float(row["High"]),   6),
        "low":    round(float(row["Low"]),    6),
        "close":  round(float(row["Close"]),  6),
        "volume": round(float(row.get("Volume", 0) or 0), 2),
    }


# ---------------------------------------------------------------------------
# Public API  — called by app.py
# ---------------------------------------------------------------------------
def _use_oanda(symbol: str) -> bool:
    """Return True when OANDA routing is enabled for this symbol."""
    return bool(OANDA_API_KEY) and symbol.upper() in OANDA_INSTRUMENT_MAP


def get_ohlcv(symbol: str, timeframe: str = "1h", limit: int = 300) -> list[dict]:
    """
    Return a list of OHLCV candle dicts for *symbol* on *timeframe*.
    Each dict has keys: time (unix seconds), open, high, low, close, volume.
    Results are cached per (symbol, timeframe) with a TTL proportional to the
    timeframe so that repeated chart loads are instant.

    Routing:
      • Forex / metals with OANDA_API_KEY set  ->  OANDA v20 practice API
      • Everything else (indices, crypto, stocks)  ->  yfinance
    """
    key = f'ohlcv|{symbol}|{timeframe}'
    ttl = _OHLCV_TTL.get(timeframe, 300)

    cached = _cache_get(key, ttl)
    if cached is not None:
        logger.debug('Cache HIT  %s %s  (%d candles)', symbol, timeframe, len(cached))
        return cached[-limit:]

    if _use_oanda(symbol):
        logger.debug('Cache MISS %s %s — fetching from OANDA', symbol, timeframe)
        data = _get_ohlcv_oanda(symbol, timeframe, max(limit, 500))
        if not data:
            logger.warning('OANDA returned empty for %s — falling back to yfinance', symbol)
            data = _get_ohlcv_yfinance(symbol, timeframe, max(limit, 500))
    else:
        logger.debug('Cache MISS %s %s — fetching from yfinance', symbol, timeframe)
        data = _get_ohlcv_yfinance(symbol, timeframe, max(limit, 500))

    _cache_set(key, data)
    return data[-limit:]


def get_price(symbol: str) -> dict:
    """
    Return the latest price snapshot for *symbol*.
    Dict keys: symbol, price, change, change_pct, direction ('up'|'down'|'flat')

    Routing:
      • Forex / metals with OANDA_API_KEY set  ->  OANDA v20 streaming price
      • Everything else  ->  yfinance
    """
    key = f'price|{symbol}'
    cached = _cache_get(key, _PRICE_TTL)
    if cached is not None:
        return cached

    if _use_oanda(symbol):
        data = _get_price_oanda(symbol)
        if not data or data.get('price', 0) == 0:
            data = _get_price_yfinance(symbol)
    else:
        data = _get_price_yfinance(symbol)

    _cache_set(key, data)
    return data


# ---------------------------------------------------------------------------
# OANDA v20 implementation
# ---------------------------------------------------------------------------
def _oanda_headers() -> dict:
    return {
        'Authorization': f'Bearer {OANDA_API_KEY}',
        'Content-Type':  'application/json',
        'Accept-Datetime-Format': 'UNIX',
    }


def _get_ohlcv_oanda(symbol: str, timeframe: str, limit: int) -> list[dict]:
    """Fetch historical candles from OANDA v20 instruments endpoint."""
    instrument   = OANDA_INSTRUMENT_MAP[symbol.upper()]
    granularity  = OANDA_GRANULARITY.get(timeframe, 'H1')
    # OANDA caps count at 5000 per request; we cap at 500 for speed
    count = min(limit, 500)
    url   = f'{OANDA_BASE_URL}/instruments/{instrument}/candles'
    params = {
        'granularity': granularity,
        'count':       count,
        'price':       'M',   # mid-point candles (bid/ask midpoint)
    }
    try:
        resp = requests.get(url, headers=_oanda_headers(), params=params, timeout=10)
        resp.raise_for_status()
        raw = resp.json()
        candles = []
        for c in raw.get('candles', []):
            if not c.get('complete', True):
                continue   # skip incomplete (live) candle
            mid  = c.get('mid', {})
            o, h, l, cl = (float(mid.get(k, 0)) for k in ('o', 'h', 'l', 'c'))
            if o == 0 or cl == 0:
                continue
            # OANDA returns RFC3339/Unix string depending on Accept-Datetime-Format
            ts_raw = c.get('time', '0')
            try:
                unix_ts = int(float(ts_raw))
            except ValueError:
                dt = datetime.fromisoformat(ts_raw.replace('Z', '+00:00'))
                unix_ts = int(dt.timestamp())
            candles.append({
                'time':   unix_ts,
                'open':   round(o,  6),
                'high':   round(h,  6),
                'low':    round(l,  6),
                'close':  round(cl, 6),
                'volume': int(c.get('volume', 0)),
            })
        logger.info('OANDA: %d candles for %s %s', len(candles), symbol, timeframe)
        return candles
    except requests.RequestException as exc:
        logger.error('OANDA OHLCV fetch failed for %s: %s', symbol, exc)
        return []


def _get_price_oanda(symbol: str) -> dict:
    """Return the most current mid price from OANDA.

    Strategy:
      1. Fetch the last 2 S5 (5-second) candles — gives near-live price.
      2. If S5 is empty (outside market hours), fall back to M1 then H1.
      3. Use today's first H1 candle open as the 'previous close' for
         daily change so the change % feels meaningful.
    """
    instrument = OANDA_INSTRUMENT_MAP[symbol.upper()]
    url        = f'{OANDA_BASE_URL}/instruments/{instrument}/candles'
    decimals   = _decimal_places(symbol)

    def _fetch(gran: str, count: int):
        params = {'granularity': gran, 'count': count, 'price': 'M'}
        r = requests.get(url, headers=_oanda_headers(), params=params, timeout=8)
        r.raise_for_status()
        return r.json().get('candles', [])

    try:
        # --- Live price: use the most recent completed 5-second candle ---
        price = 0.0
        for gran in ('S5', 'M1', 'M5'):
            candles = _fetch(gran, 3)
            completed = [c for c in candles if c.get('complete', True)]
            # Also accept the current (incomplete) candle for a tighter quote
            all_c = completed or candles
            if all_c:
                price = float(all_c[-1]['mid']['c'])
                break

        if not price:
            return {'symbol': symbol, 'price': 0, 'change': 0,
                    'change_pct': 0, 'direction': 'flat'}

        # --- Daily change: compare against today's session open (H1 D candle) ---
        try:
            day_candles = _fetch('D', 2)
            completed_day = [c for c in day_candles if c.get('complete', True)]
            if completed_day:
                prev_close = float(completed_day[-1]['mid']['c'])
            else:
                # Use H1 open as reference
                h1 = _fetch('H1', 2)
                h1c = [c for c in h1 if c.get('complete', True)]
                prev_close = float(h1c[-1]['mid']['o']) if h1c else price
        except Exception:
            prev_close = price

        change     = price - prev_close
        change_pct = (change / prev_close * 100) if prev_close else 0
        direction  = 'up' if change > 0 else ('down' if change < 0 else 'flat')

        return {
            'symbol':     symbol,
            'price':      round(price,      decimals),
            'change':     round(change,     decimals),
            'change_pct': round(change_pct, 3),
            'direction':  direction,
        }
    except requests.RequestException as exc:
        logger.error('OANDA price fetch failed for %s: %s', symbol, exc)
        return {'symbol': symbol, 'price': 0, 'change': 0,
                'change_pct': 0, 'direction': 'flat'}


# ---------------------------------------------------------------------------
# yfinance implementation
# ---------------------------------------------------------------------------
def _get_ohlcv_yfinance(symbol: str, timeframe: str, limit: int) -> list[dict]:
    yf_ticker = _to_yf_ticker(symbol)
    interval, period = TIMEFRAME_MAP.get(timeframe, ("1h", "1mo"))

    try:
        ticker = yf.Ticker(yf_ticker)
        df = ticker.history(interval=interval, period=period, auto_adjust=True)

        if df.empty:
            logger.warning("No data returned for %s (%s)", symbol, yf_ticker)
            return []

        # Resample 1h -> 4h when timeframe == "4h"
        if timeframe == "4h":
            df = (
                df.resample("4h")
                .agg({"Open": "first", "High": "max", "Low": "min",
                      "Close": "last", "Volume": "sum"})
                .dropna()
            )

        df = df.reset_index()
        date_col = "Datetime" if "Datetime" in df.columns else "Date"

        candles = [_row_to_dict(row[date_col], row) for _, row in df.iterrows()]
        # Drop future/NaN candles, keep last *limit*
        candles = [c for c in candles if c["open"] > 0 and c["close"] > 0]
        return candles[-limit:]

    except Exception as exc:
        logger.error("OHLCV fetch failed for %s: %s", symbol, exc)
        return []


def _get_price_yfinance(symbol: str) -> dict:
    yf_ticker = _to_yf_ticker(symbol)
    try:
        ticker = yf.Ticker(yf_ticker)
        fi = ticker.fast_info

        price = fi.last_price
        prev  = fi.previous_close

        if price is None or price == 0:
            # Fallback: grab last close from 2-day 1m history
            df = ticker.history(period="2d", interval="1m")
            if not df.empty:
                price = float(df["Close"].iloc[-1])
                prev  = float(df["Close"].iloc[-2]) if len(df) > 1 else price

        price = float(price or 0)
        prev  = float(prev  or price)
        change      = price - prev
        change_pct  = (change / prev * 100) if prev else 0
        direction   = "up" if change > 0 else ("down" if change < 0 else "flat")

        # Determine decimal precision by symbol type
        decimals = _decimal_places(symbol)

        return {
            "symbol":     symbol,
            "price":      round(price,      decimals),
            "change":     round(change,     decimals),
            "change_pct": round(change_pct, 3),
            "direction":  direction,
        }

    except Exception as exc:
        logger.error("Price fetch failed for %s: %s", symbol, exc)
        return {"symbol": symbol, "price": 0, "change": 0,
                "change_pct": 0, "direction": "flat"}


def _decimal_places(symbol: str) -> int:
    sym = symbol.upper()
    if any(s in sym for s in ("JPY", "HUF", "KRW", "IDR", "VND")):
        return 3
    if sym in ("DXY", "US100", "SP500", "GER40", "UK100", "JP225",
               "HK50", "XAUUSD", "USOIL", "UKOIL"):
        return 2
    if sym in ("BTCUSD", "ETHUSD"):
        return 2
    return 5


# ---------------------------------------------------------------------------
# BROKER PLUGIN STUBS
# Add your own broker by implementing the two functions below, then routing
# through get_ohlcv() / get_price() above.
# ---------------------------------------------------------------------------

# --- ALPACA (needs ALPACA_API_KEY + ALPACA_API_SECRET env vars) ---
# def get_ohlcv_alpaca(symbol: str, timeframe: str, limit: int) -> list[dict]:
#     from alpaca.data.historical import StockHistoricalDataClient
#     from alpaca.data.requests import StockBarsRequest
#     from alpaca.data.timeframe import TimeFrame
#     import os
#     client = StockHistoricalDataClient(os.getenv("ALPACA_API_KEY"),
#                                         os.getenv("ALPACA_API_SECRET"))
#     ...

# --- BINANCE (public endpoint, no key needed for klines) ---
# def get_ohlcv_binance(symbol: str, timeframe: str, limit: int) -> list[dict]:
#     import requests
#     r = requests.get("https://api.binance.com/api/v3/klines",
#                      params={"symbol": symbol + "USDT", "interval": timeframe,
#                              "limit": limit})
#     return [{"time": int(c[0])//1000, "open": float(c[1]), "high": float(c[2]),
#              "low": float(c[3]), "close": float(c[4]), "volume": float(c[5])}
#             for c in r.json()]

# --- POLYGON.IO (needs free API key) ---
# def get_ohlcv_polygon(symbol, timeframe, limit):
#     import requests, os
#     key = os.getenv("POLYGON_API_KEY")
#     ...

# --- ZERODHA KITE (needs API key + access token) ---
# def get_ohlcv_zerodha(symbol, timeframe, limit):
#     from kiteconnect import KiteConnect
#     ...

# --- OANDA ---
# OANDA is now fully integrated above. To enable it:
#   1. Create a free practice account at https://www.oanda.com/register/
#   2. Go to Manage Funds -> API Access -> Generate Token
#   3. Copy your token into .env as OANDA_API_KEY=your_token_here
#   4. Restart the terminal — all forex pairs + XAU/XAG will load from OANDA
