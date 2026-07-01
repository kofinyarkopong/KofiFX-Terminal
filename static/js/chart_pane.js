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
    this._stylePanel = null;   // Chart style floating panel
    this._style      = this._loadStyle(); // Per-pane colour settings

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
      // Re-filter news events for the new pair
      ChartPane._fetchSharedCalendar().then(ev => this._applyNewsEvents(ev));
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
    this._q('.pane-btn--style')?.addEventListener('click', e => {
      e.stopPropagation();
      this._toggleStylePanel();
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

    // Fetch high-impact calendar events and overlay them on the chart.
    // Share the cached result across all panes via a module-level promise.
    ChartPane._fetchSharedCalendar().then(events => this._applyNewsEvents(events));
  }

  // ── Chart ─────────────────────────────────────────────────────────────────
  _createChart() {
    const container = this._q('.chart-container');
    const s = this._style;

    this._chart = LightweightCharts.createChart(container, {
      layout: {
        background: { type: 'solid', color: s.bg },
        textColor: s.textColor,
        fontFamily: "'JetBrains Mono','Fira Code',monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: s.gridColor, style: 1 },
        horzLines: { color: s.gridColor, style: 1 },
      },
      crosshair: {
        vertLine: { color: s.crossColor, labelBackgroundColor: s.labelBg },
        horzLine: { color: s.crossColor, labelBackgroundColor: s.labelBg },
      },
      rightPriceScale: { borderColor: s.borderColor, textColor: s.textColor },
      timeScale: {
        borderColor: s.borderColor, textColor: s.textColor,
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
    const s = this._style;
    if (this._chartType === 'candle') {
      this._series = this._chart.addCandlestickSeries({
        upColor:        s.upColor,
        downColor:      s.downColor,
        borderUpColor:  s.upColor,
        borderDownColor:s.downColor,
        wickUpColor:    s.wickUpColor   || s.upColor,
        wickDownColor:  s.wickDownColor || s.downColor,
        borderVisible: true,
        wickVisible:   true,
      });
    } else {
      this._series = this._chart.addLineSeries({
        color: s.upColor, lineWidth: 2,
        crosshairMarkerVisible: true, crosshairMarkerRadius: 4,
        crosshairMarkerBorderColor: s.upColor,
        crosshairMarkerBackgroundColor: s.bg,
      });
    }
  }

  // ── Chart style: presets + per-pane persistence ───────────────────────────
  static STYLE_PRESETS = {
    'Evedex': {
      label: 'Evedex (Default)',
      bg: '#080c12', gridColor: '#0f1a28', crossColor: '#2a3d5a',
      labelBg: '#111926', borderColor: '#1c2840', textColor: '#7a8fa6',
      upColor: '#26a69a', downColor: '#ef5350',
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    },
    'TradingView': {
      label: 'TradingView',
      bg: '#131722', gridColor: '#1c2333', crossColor: '#3d4b6b',
      labelBg: '#1c2333', borderColor: '#2a3250', textColor: '#b2b5be',
      upColor: '#26a69a', downColor: '#ef5350',
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    },
    'KofiFX': {
      label: 'KofiFX Classic',
      bg: '#0e1117', gridColor: '#1a1f2e', crossColor: '#444c6a',
      labelBg: '#1e2535', borderColor: '#1e2535', textColor: '#7a8499',
      upColor: '#00c97a', downColor: '#ff4560',
      wickUpColor: '#00c97a', wickDownColor: '#ff4560',
    },
    'Midnight': {
      label: 'Midnight',
      bg: '#0a0a12', gridColor: '#131320', crossColor: '#363660',
      labelBg: '#16162a', borderColor: '#1e1e38', textColor: '#8080b0',
      upColor: '#4caf9f', downColor: '#e05c7a',
      wickUpColor: '#4caf9f', wickDownColor: '#e05c7a',
    },
  };

  _loadStyle() {
    const key = `kofifx_chart_style_${this.id ?? 0}`;
    try {
      const raw = localStorage.getItem(key);
      if (raw) return { ...ChartPane.STYLE_PRESETS['Evedex'], ...JSON.parse(raw) };
    } catch (_) {}
    // Default: Evedex palette
    return { ...ChartPane.STYLE_PRESETS['Evedex'] };
  }

  _saveStyle() {
    const key = `kofifx_chart_style_${this.id ?? 0}`;
    try { localStorage.setItem(key, JSON.stringify(this._style)); } catch (_) {}
  }

  _applyStyle(patch) {
    Object.assign(this._style, patch);
    // Live-update chart and series without reload
    const s = this._style;
    this._chart?.applyOptions({
      layout: {
        background: { type: 'solid', color: s.bg },
        textColor: s.textColor,
      },
      grid: {
        vertLines: { color: s.gridColor },
        horzLines: { color: s.gridColor },
      },
      crosshair: {
        vertLine: { color: s.crossColor, labelBackgroundColor: s.labelBg },
        horzLine: { color: s.crossColor, labelBackgroundColor: s.labelBg },
      },
      rightPriceScale: { borderColor: s.borderColor, textColor: s.textColor },
      timeScale: { borderColor: s.borderColor, textColor: s.textColor },
    });
    if (this._chartType === 'candle') {
      this._series?.applyOptions({
        upColor:         s.upColor,
        downColor:       s.downColor,
        borderUpColor:   s.upColor,
        borderDownColor: s.downColor,
        wickUpColor:     s.wickUpColor   || s.upColor,
        wickDownColor:   s.wickDownColor || s.downColor,
      });
    }
    this._saveStyle();
    this._updateStylePanel();
  }

  // ── Chart style floating panel ────────────────────────────────────────────
  _toggleStylePanel() {
    if (!this._stylePanel) this._buildStylePanel();
    const visible = this._stylePanel.style.display !== 'none';
    this._stylePanel.style.display = visible ? 'none' : 'block';
  }

  _buildStylePanel() {
    const panel = document.createElement('div');
    panel.className = 'chart-style-panel';
    this._q('.chart-container').appendChild(panel);
    this._stylePanel = panel;
    this._updateStylePanel();

    // Delegate all input events
    panel.addEventListener('input',  e => this._onStyleInput(e));
    panel.addEventListener('change', e => this._onStyleInput(e));
    panel.addEventListener('click',  e => {
      const preset = e.target.closest('[data-preset]');
      if (preset) this._applyStyle({ ...ChartPane.STYLE_PRESETS[preset.dataset.preset] });
    });
    // Close when clicking outside
    document.addEventListener('click', e => {
      if (!panel.contains(e.target) && !this._q('.pane-btn--style').contains(e.target)) {
        panel.style.display = 'none';
      }
    });
  }

  _updateStylePanel() {
    if (!this._stylePanel) return;
    const s = this._style;
    const presetBtns = Object.entries(ChartPane.STYLE_PRESETS).map(([k, p]) =>
      `<button class="csp-preset-btn" data-preset="${k}"
               style="border-color:${p.upColor}22;"
               title="${p.label}">
         <span style="background:${p.bg};border:1px solid ${p.upColor}33;"></span>
         ${p.label}
       </button>`
    ).join('');

    const col = (key, label, val) =>
      `<label class="csp-row">
         <span>${label}</span>
         <input type="color" data-key="${key}" value="${val}"/>
       </label>`;

    this._stylePanel.innerHTML = `
      <div class="csp-header">
        <span>Chart Style</span>
        <button onclick="this.closest('.chart-style-panel').style.display='none'"
                style="background:none;border:none;color:#7a8499;cursor:pointer;font-size:14px;">✕</button>
      </div>
      <div class="csp-presets">${presetBtns}</div>
      <div class="csp-divider"></div>
      <div class="csp-section">CANDLES</div>
      ${col('upColor',   'Bull colour',  s.upColor)}
      ${col('downColor', 'Bear colour',  s.downColor)}
      ${col('wickUpColor',   'Bull wick',  s.wickUpColor   || s.upColor)}
      ${col('wickDownColor', 'Bear wick',  s.wickDownColor || s.downColor)}
      <div class="csp-section">BACKGROUND</div>
      ${col('bg',        'Background',   s.bg)}
      ${col('gridColor', 'Grid lines',   s.gridColor)}
      ${col('crossColor','Crosshair',    s.crossColor)}
      ${col('textColor', 'Text',         s.textColor)}
    `;
  }

  _onStyleInput(e) {
    const key = e.target.dataset?.key;
    if (!key || e.target.type !== 'color') return;
    this._applyStyle({ [key]: e.target.value });
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

  // ── High-impact news event overlay ───────────────────────────────────────

  /**
   * Shared calendar cache — fetched once, reused by all panes.
   * Returns a Promise<Array> of ALL this-week events.
   */
  static _calendarPromise = null;
  static _calendarFetchedAt = 0;

  static _fetchSharedCalendar() {
    const AGE_MS = 30 * 60 * 1000; // re-fetch after 30 min
    if (ChartPane._calendarPromise && Date.now() - ChartPane._calendarFetchedAt < AGE_MS) {
      return ChartPane._calendarPromise;
    }
    ChartPane._calendarFetchedAt = Date.now();
    ChartPane._calendarPromise = fetch('/api/calendar')
      .then(r => r.ok ? r.json() : [])
      .catch(() => []);
    return ChartPane._calendarPromise;
  }

  /**
   * Extract the two ISO-4217 currency codes from a symbol string.
   * USDJPY → ['USD','JPY']   XAUUSD → ['XAU','USD']
   */
  static _pairCurrencies(symbol) {
    const s = symbol.replace('/', '').toUpperCase();
    if (s.length === 6) return [s.slice(0, 3), s.slice(3, 6)];
    return [];
  }

  /**
   * Filter the full calendar to HIGH-impact events relevant to this pane's
   * pair currencies and pass them to the KofiNoWick overlay.
   */
  _applyNewsEvents(allEvents) {
    if (!this._indicator || !Array.isArray(allEvents)) return;

    const currencies = ChartPane._pairCurrencies(this.symbol);
    if (!currencies.length) { this._indicator.setNewsEvents([]); return; }

    const todayUTC = new Date().toISOString().slice(0, 10);

    const filtered = allEvents
      .filter(ev => {
        const ccy    = (ev.currency || ev.country || '').toUpperCase();
        const impact = (ev.impact   || '').toLowerCase();
        // Only HIGH impact, only today (UTC), only pair's currencies
        if (impact !== 'high') return false;
        if (!currencies.includes(ccy)) return false;
        const evDate = new Date(ev.date || ev.datetime || '').toISOString().slice(0, 10);
        return evDate === todayUTC;
      })
      .map(ev => ({
        time:     Math.floor(new Date(ev.date || ev.datetime || '').getTime() / 1000),
        currency: (ev.currency || ev.country || '').toUpperCase(),
        title:    (ev.title || ev.event || ev.name || '').trim(),
      }))
      .filter(ev => ev.time > 0);

    this._indicator.setNewsEvents(filtered);
  }

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
