/**
 * KofiFX Terminal — Hyperliquid WebSocket Handler
 * ================================================
 * Connects directly to wss://api.hyperliquid.xyz/ws for real-time
 * crypto perpetuals data (no API key required).
 *
 * Usage:
 *   const hl = new HyperliquidWS();
 *   hl.subscribeToTrades('BTC', (trade) => console.log(trade));
 *   hl.subscribeToL2('ETH', (book) => console.log(book));
 *   hl.unsubscribe('BTC');
 */

class HyperliquidWS {
  static WS_URL = 'wss://api.hyperliquid.xyz/ws';

  // Symbols that should route through Hyperliquid rather than yfinance
  static SUPPORTED = new Set([
    'BTC','ETH','SOL','ARB','AVAX','DOGE','MATIC','OP','APT','LTC',
    'LINK','UNI','AAVE','MKR','SNX','CRV','1INCH','GMX','DYDX',
    'BTCUSD','ETHUSD','SOLUSD',
  ]);

  constructor() {
    this._ws         = null;
    this._callbacks  = {};   // symbol → { trades: fn, l2: fn }
    this._reconnect  = 0;
    this._pingTimer  = null;
    this._alive      = false;
    this._connect();
  }

  /** Normalise symbol: "BTCUSD" → "BTC", "ETH" → "ETH" */
  static normalise(sym) {
    return sym.replace(/USD$/, '').replace(/-USD$/, '').toUpperCase();
  }

  static supports(sym) {
    return HyperliquidWS.SUPPORTED.has(HyperliquidWS.normalise(sym));
  }

  // ── Internal connection ──────────────────────────────────────────────────
  _connect() {
    try {
      this._ws = new WebSocket(HyperliquidWS.WS_URL);
      this._ws.onopen    = () => this._onOpen();
      this._ws.onmessage = (e) => this._onMessage(e);
      this._ws.onclose   = () => this._onClose();
      this._ws.onerror   = (e) => console.warn('[HL] WS error', e);
    } catch (err) {
      console.warn('[HL] Could not open WebSocket:', err);
    }
  }

  _onOpen() {
    console.info('[HL] Connected to Hyperliquid WebSocket');
    this._alive     = true;
    this._reconnect = 0;

    // Re-subscribe to anything already registered
    Object.keys(this._callbacks).forEach((sym) => this._sendSub(sym));

    // Heartbeat every 25 s
    clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ method: 'ping' }));
      }
    }, 25_000);
  }

  _onMessage(event) {
    try {
      const msg = JSON.parse(event.data);

      // Pong
      if (msg.channel === 'pong') return;

      // Trade subscription
      if (msg.channel === 'trades' && Array.isArray(msg.data)) {
        const raw  = msg.data[0];
        const sym  = (raw.coin || '').toUpperCase();
        const norm = HyperliquidWS.normalise(sym);
        const cb   = this._callbacks[sym]?.trades || this._callbacks[norm]?.trades;
        if (cb) {
          cb({
            symbol:    sym,
            price:     parseFloat(raw.px),
            size:      parseFloat(raw.sz),
            side:      raw.side === 'B' ? 'buy' : 'sell',
            timestamp: raw.time,
          });
        }
      }

      // L2 book (best bid/ask)
      if (msg.channel === 'l2Book' && msg.data) {
        const raw  = msg.data;
        const sym  = (raw.coin || '').toUpperCase();
        const norm = HyperliquidWS.normalise(sym);
        const cb   = this._callbacks[sym]?.l2 || this._callbacks[norm]?.l2;
        if (cb) {
          const bid = raw.levels?.[0]?.[0]?.px;
          const ask = raw.levels?.[1]?.[0]?.px;
          cb({ symbol: sym, bid: parseFloat(bid), ask: parseFloat(ask), time: raw.time });
        }
      }
    } catch (err) {
      console.warn('[HL] Parse error', err);
    }
  }

  _onClose() {
    this._alive = false;
    clearInterval(this._pingTimer);
    const delay = Math.min(1000 * 2 ** this._reconnect++, 30_000);
    console.info(`[HL] Disconnected. Reconnecting in ${delay / 1000}s…`);
    setTimeout(() => this._connect(), delay);
  }

  _sendSub(coin) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'trades', coin },
    }));
  }

  _sendUnsub(coin) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({
      method: 'unsubscribe',
      subscription: { type: 'trades', coin },
    }));
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Subscribe to live trades for a coin.
   * @param {string} symbol  e.g. 'BTC', 'ETHUSD'
   * @param {Function} callback  called with { symbol, price, size, side, timestamp }
   */
  subscribeToTrades(symbol, callback) {
    const coin = HyperliquidWS.normalise(symbol);
    if (!this._callbacks[coin]) this._callbacks[coin] = {};
    this._callbacks[coin].trades = callback;
    this._sendSub(coin);
  }

  /**
   * Subscribe to best bid/ask updates.
   * @param {string} symbol
   * @param {Function} callback  called with { symbol, bid, ask, time }
   */
  subscribeToL2(symbol, callback) {
    const coin = HyperliquidWS.normalise(symbol);
    if (!this._callbacks[coin]) this._callbacks[coin] = {};
    this._callbacks[coin].l2 = callback;
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'l2Book', coin },
      }));
    }
  }

  /** Remove all subscriptions for a symbol. */
  unsubscribe(symbol) {
    const coin = HyperliquidWS.normalise(symbol);
    delete this._callbacks[coin];
    this._sendUnsub(coin);
  }

  get isConnected() { return this._alive; }
}

// Singleton — shared across all chart panes
window._hlWS = new HyperliquidWS();
