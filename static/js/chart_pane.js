/**
 * KofiFX Terminal — ChartPane  (v2)
 * ===================================
 * Each pane manages:
 *   • LWC candlestick / line chart with auto-resize
 *   • Live ticker bar with flash animations
 *   • KofiNoWick indicator overlay
 *   • IndicatorManager  (SMA, EMA, BB, VWAP, RSI, MACD)
 *   • DrawingManager    (hline, trendline, rect, long/short positions)
 *   • Date navigator    (jump to any date)
 */

class ChartPane {
  constructor(id, rootEl, opts = {}) {
    this.id         = id;
    this.el         = rootEl;
    this.symbol     = opts.symbol    || 'EURUSD';
    this.timeframe  = opts.timeframe || '1h';
    this._chartType = 'candle';

    this._chart      = null;
    this._series     = null;
    this._indicator  = null;   // KofiNoWick
    this._indMgr     = null;   // IndicatorManager
    this._drawMgr    = null;   // DrawingManager
    this._lastPrice  = null;
    this._lastCandle = null;
    this._resizeObs  = null;

    this._init(opts);
  }

  _q(sel) { return this.el.querySelector(sel); }

  // ── Init ──────────────────────────────────────────────────────────────────
  _init(opts) {
    // Populate symbol dropdown
    const symSel = this._q('.symbol-select');
    opts.symbols.forEach(s => {
      const o = document.createElement('option');
      o.value = s; o.textContent = s;
      if (s === this.symbol) o.selected = true;
      symSel.appendChild(o);
    });

    symSel.addEventListener('change', e => {
      this.symbol = e.target.value;
      this._saveState();
      if (window._kofifxSubscribe) window._kofifxSubscribe(this.symbol);
      if (this._indicator) this._indicator.updateSymbol(this.symbol);
      this.reload();
    });

    this._q('.tf-select').value = this.timeframe;
    this._q('.tf-select').addEventListener('change', e => {
      this.timeframe = e.target.value;
      this._saveState();
      this.reload();
    });

    this._q('.pane-btn--refresh').addEventListener('click', () => this.reload());
    this._q('.pane-btn--chart-type').addEventListener('click', () => this._toggleChartType());
    this._q('.pane-btn--indicator').addEventListener('click', e => {
      e.stopPropagation();
      if (this._indicator) this._indicator.toggleSettings();
    });

    // Indicator "+" button
    this._q('.pane-btn--add-ind').addEventListener('click', e => {
      e.stopPropagation();
      this._toggleIndMenu();
    });

    this._q('.retry-btn')?.addEventListener('click', () => this.reload());

    this._q('.ticker-symbol').textContent = this.symbol;

    this._createChart();
    this._createIndicator();
    this._createIndMgr();
    this._createDrawMgr();
    this._setupIndMenu();
    this._setupDateNav();

    this.reload();
    this._subscribeHyperliquid();
  }

  // ── Chart ─────────────────────────────────────────────────────────────────
  _createChart() {
    const container = this._q('.chart-container');

    this._chart = LightweightCharts.createChart(container, {
      layout: {
        background: { type: 'solid', color: '#0e1117' },
        textColor: '#7a8499',
        fontFamily: "'JetBrains Mono','Fira Code',monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1a1f2e', style: 1 },
        horzLines: { color: '#1a1f2e', style: 1 },
      },
      crosshair: {
        vertLine: { color: '#444c6a', labelBackgroundColor: '#1e2535' },
        horzLine: { color: '#444c6a', labelBackgroundColor: '#1e2535' },
      },
      rightPriceScale: { borderColor: '#1e2535', textColor: '#7a8499' },
      timeScale: {
        borderColor: '#1e2535', textColor: '#7a8499',
        timeVisible: true, secondsVisible: false,
        rightOffset: 8, barSpacing: 8,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale:  { mouseWheel: true, pinch: true },
      width:  container.clientWidth  || 400,
      height: container.clientHeight || 300,
    });

    this._addSeries();

    this._resizeObs = new ResizeObserver(() => {
      const w = container.clientWidth, h = container.clientHeight;
      if (w > 0 && h > 0) this._chart.resize(w, h);
    });
    this._resizeObs.observe(container);
  }

  _addSeries() {
    if (this._chartType === 'candle') {
      this._series = this._chart.addCandlestickSeries({
        upColor: '#00c97a', downColor: '#ff4560',
        borderUpColor: '#00c97a', borderDownColor: '#ff4560',
        wickUpColor: '#00c97a',   wickDownColor: '#ff4560',
        borderVisible: true, wickVisible: true,
      });
    } else {
      this._series = this._chart.addLineSeries({
        color: '#00d4aa', lineWidth: 2,
        crosshairMarkerVisible: true, crosshairMarkerRadius: 4,
        crosshairMarkerBorderColor: '#00d4aa',
        crosshairMarkerBackgroundColor: '#0e1117',
      });
    }
  }

  _toggleChartType() {
    this._chartType = this._chartType === 'candle' ? 'line' : 'candle';
    const btn = this._q('.pane-btn--chart-type');
    btn.dataset.type = this._chartType;
    if (this._series) { this._chart.removeSeries(this._series); this._series = null; }
    this._addSeries();
    if (this._indicator) this._indicator.series = this._series;
    if (this._drawMgr)   this._drawMgr.series   = this._series;
    this.reload();
  }

  // ── KofiNoWick ────────────────────────────────────────────────────────────
  _createIndicator() {
    const container = this._q('.chart-container');
    const saved     = KofiNoWick.loadSettings(this.id);
    this._indicator = new KofiNoWick(container, this._chart, this._series, this.symbol, saved);
  }

  // ── IndicatorManager ──────────────────────────────────────────────────────
  _createIndMgr() {
    this._indMgr = new IndicatorManager(this.el, this._chart, this._series);
  }

  _setupIndMenu() {
    const menu = this._q('.ind-menu');
    if (!menu) return;
    menu.addEventListener('click', e => {
      const item = e.target.closest('[data-ind]');
      if (!item) return;
      const type   = item.dataset.ind;
      const period = parseInt(item.dataset.period || '0', 10) || undefined;
      const stddev = parseFloat(item.dataset.std  || '0')   || undefined;
      const params = {};
      if (period) params.period = period;
      if (stddev) params.stddev = stddev;
      this._indMgr.add(type, params);
      menu.classList.add('hidden');
      if (this._candles) this._indMgr.setData(this._candles);
    });

    // Close on outside click
    document.addEventListener('click', () => menu.classList.add('hidden'));
  }

  _toggleIndMenu() {
    const menu = this._q('.ind-menu');
    if (menu) {
      menu.classList.toggle('hidden');
      // Stop propagation to prevent immediate close
      setTimeout(() => {}, 0);
    }
  }

  // ── DrawingManager ────────────────────────────────────────────────────────
  _createDrawMgr() {
    const container = this._q('.chart-container');
    this._drawMgr   = new DrawingManager(container, this._chart, this._series);
    this._drawMgr.setContext(this.symbol, this.timeframe);

    // Listen for active-pane drawing mode changes from the global toolbar
    this.el.addEventListener('pane-focus', () => {
      window._activePaneId = this.id;
    });
    this.el.addEventListener('mousedown', () => {
      window._activePaneId = this.id;
      if (window._activeDrawingMode) {
        this._drawMgr.setMode(window._activeDrawingMode);
      }
    }, true);
  }

  // ── Date navigator ────────────────────────────────────────────────────────
  _setupDateNav() {
    const dateInput = this._q('.date-nav-input');
    const goBtn     = this._q('.date-nav-go');
    if (!dateInput || !goBtn) return;

    goBtn.addEventListener('click', () => {
      const val = dateInput.value;
      if (!val) return;
      const ts = Math.floor(new Date(val).getTime() / 1000);
      if (isNaN(ts)) return;
      const half = this._visibleHalfRange();
      try {
        this._chart.timeScale().setVisibleRange({ from: ts - half, to: ts + half });
      } catch (_) {
        this._chart.timeScale().scrollToPosition(0, false);
      }
    });
  }

  _visibleHalfRange() {
    const tfSeconds = {
      '1m': 60, '5m': 300, '15m': 900, '30m': 1800,
      '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
    };
    return (tfSeconds[this.timeframe] || 3600) * 50;
  }

  // ── Data loading ──────────────────────────────────────────────────────────
  reload() {
    this._showLoading(true);
    this._showError(false);
    this._q('.ticker-symbol').textContent = this.symbol;
    this._unsubscribeHyperliquid();
    this._subscribeHyperliquid();
    if (this._drawMgr) this._drawMgr.setContext(this.symbol, this.timeframe);

    fetch(`/api/ohlcv?symbol=${this.symbol}&timeframe=${this.timeframe}&limit=300`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(({ data }) => {
        if (!data?.length) throw new Error('No data');
        this._setData(data);
        this._showLoading(false);
        this._fetchPrice();
      })
      .catch(err => {
        console.error(`[Pane ${this.id}]`, err);
        this._showLoading(false);
        this._showError(true);
      });
  }

  _setData(candles) {
    if (!this._series) return;
    this._candles = candles;

    if (this._chartType === 'candle') {
      this._series.setData(candles);
    } else {
      this._series.setData(candles.map(c => ({ time: c.time, value: c.close })));
    }
    this._lastCandle = candles[candles.length - 1] || null;
    this._chart.timeScale().scrollToRealTime();

    if (this._indicator) this._indicator.setData(candles, this.symbol);
    if (this._indMgr)    this._indMgr.setData(candles);
  }

  // ── Live prices ───────────────────────────────────────────────────────────
  updatePrice(snap) {
    const { price, change, change_pct, tick } = snap;
    if (!price) return;
    const prevPrice = this._lastPrice;
    this._lastPrice = price;
    const dir = tick || (prevPrice === null ? 'flat'
              : price > prevPrice ? 'up' : price < prevPrice ? 'down' : 'flat');
    this._updateTickerBar(price, change, change_pct, dir);

    if (this._series && this._lastCandle) {
      const updated = { ...this._lastCandle, close: price };
      if (price > this._lastCandle.high) updated.high = price;
      if (price < this._lastCandle.low)  updated.low  = price;
      if (this._chartType === 'candle') this._series.update(updated);
      else this._series.update({ time: this._lastCandle.time, value: price });
      this._lastCandle = updated;
    }
  }

  _updateTickerBar(price, change, changePct, dir) {
    const priceEl  = this._q('.ticker-price');
    const changeEl = this._q('.ticker-change');
    const pctEl    = this._q('.ticker-pct');
    const ticker   = this._q('.pane-ticker');
    const dec = this._priceDecimals();
    priceEl.textContent  = price.toFixed(dec);
    changeEl.textContent = (change >= 0 ? '+' : '') + change.toFixed(dec);
    pctEl.textContent    = (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%';
    [changeEl, pctEl].forEach(el => {
      el.classList.remove('up','down','flat');
      el.classList.add(change > 0 ? 'up' : change < 0 ? 'down' : 'flat');
    });
    if (dir !== 'flat') {
      ticker.classList.remove('flash-up','flash-down');
      void ticker.offsetWidth;
      ticker.classList.add(dir === 'up' ? 'flash-up' : 'flash-down');
      priceEl.classList.remove('tick-up','tick-down');
      void priceEl.offsetWidth;
      priceEl.classList.add(dir === 'up' ? 'tick-up' : 'tick-down');
    }
  }

  _fetchPrice() {
    fetch(`/api/price?symbol=${this.symbol}`)
      .then(r => r.json()).then(s => this.updatePrice(s)).catch(() => {});
  }

  // ── Hyperliquid ───────────────────────────────────────────────────────────
  _subscribeHyperliquid() {
    if (!window._hlWS || !HyperliquidWS.supports(this.symbol)) return;
    window._hlWS.subscribeToTrades(this.symbol, trade => {
      this.updatePrice({
        price: trade.price,
        change: trade.price - (this._lastPrice || trade.price),
        change_pct: 0,
        tick: trade.side === 'buy' ? 'up' : 'down',
      });
    });
  }
  _unsubscribeHyperliquid() { window._hlWS?.unsubscribe(this.symbol); }

  // ── Persistence ───────────────────────────────────────────────────────────
  _saveState() {
    try {
      localStorage.setItem(`kofifx_pane_${this.id}`,
        JSON.stringify({ symbol: this.symbol, timeframe: this.timeframe }));
    } catch (_) {}
  }
  static loadState(id) {
    try { const r = localStorage.getItem(`kofifx_pane_${id}`); return r ? JSON.parse(r) : null; }
    catch (_) { return null; }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  _priceDecimals() {
    const s = this.symbol.toUpperCase();
    if (/JPY|HUF/.test(s)) return 3;
    if (/DXY|US100|SP500|GER40|UK100|JP225|HK50|XAUUSD|OIL|BTC|ETH/.test(s)) return 2;
    return 5;
  }
  _showLoading(show) { this._q('.pane-loading')?.classList.toggle('hidden', !show); }
  _showError(show)   { this._q('.pane-error')?.classList.toggle('hidden', !show); }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  destroy() {
    this._unsubscribeHyperliquid();
    this._resizeObs?.disconnect();
    this._indicator?.destroy();
    this._chart?.remove();
    this._chart = this._series = this._indicator = this._indMgr = this._drawMgr = null;
  }

  get currentSymbol()    { return this.symbol;    }
  get currentTimeframe() { return this.timeframe; }
}
