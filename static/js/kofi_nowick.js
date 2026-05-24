/**
 * KofiNoWick — Full Indicator Engine
 * ====================================
 * A faithful JavaScript port of the omarnowick Pine Script v6 indicator.
 * Renders directly onto a canvas overlay that sits on top of each chart pane.
 *
 * Features:
 *   • Session zones  — No Trading Zone, Asia, London, New York (ET times)
 *   • Market structure — HH / HL / LH / LL pivot labels
 *   • Break of Structure / Change of Character (BOS / CHoCH) horizontal lines
 *   • No-Wick Open Triangles  — bullish ▲ and bearish ▼
 *   • Risk Dashboard — lot-size calculator (top-right overlay)
 *   • Win Rate Dashboard — manual backtest stats (bottom-right overlay)
 *   • Settings Panel — gear icon opens live-edit popup
 */

class KofiNoWick {

  // ── Defaults (mirrors Pine Script input defaults) ─────────────────────────
  static DEFAULTS = {
    // Market structure
    pivotLength:   5,
    showStruct:    true,
    anchorType:    'Body',   // 'Body' | 'Wick'
    showBosChoch:  true,

    // Colours
    colorBullBreak: '#26a69a',
    colorBearBreak: '#ef5350',
    colorHH_HL:     '#26a69a',
    colorLH_LL:     '#ef5350',

    // No Trading Zone  (ET: 15:00 – 19:00, metals → 15:00 – 20:00)
    showZone:      true,
    showZoneText:  true,
    zoneStart:     15.0,   // decimal ET hours
    zoneEnd:       19.0,
    zoneColor:     'rgba(145,36,36,0.22)',

    // Asia session  (ET: 18:00 – 02:00)
    showAsia:      false,
    showAsiaText:  false,
    asiaStart:     18.0,
    asiaEnd:        2.0,
    asiaColor:     'rgba(33,150,243,0.13)',

    // London session  (ET: 03:00 – 09:00)
    showLondon:    false,
    showLondonText: false,
    londonStart:    3.0,
    londonEnd:      9.0,
    londonColor:   'rgba(150,150,150,0.13)',

    // New York session  (ET: 08:00 – 17:00)
    showNY:        false,
    showNYText:    false,
    nyStart:        8.0,
    nyEnd:         17.0,
    nyColor:       'rgba(76,175,80,0.13)',

    // No-Wick arrows
    showNoWick:         true,
    showBullArrows:     true,    // show bullish ▲ (open == low)
    showBearArrows:     true,    // show bearish ▼ (open == high)
    bullColor:          '#26a69a',
    bearColor:          '#ef5350',
    arrowSize:          1,
    // Sensitivity: how close open must be to low/high to count as no-wick
    // 'Strict' = near-exact match  |  'Normal' = 1 sub-pip  |  'Loose' = up to 1 pip
    noWickSensitivity:  'Normal',

    // Risk dashboard
    showRisk:       true,
    accountCurrency:'USD',   // USD | EUR | GBP | JPY | AUD | CAD | CHF
    accountBal:     100000,
    riskPct:        2.0,
    slPips:         30.6,
    goldPipSize:    'Standard',   // Standard ($10/pip) | Mini ($1/pip) | Micro ($0.10/pip)
    silverPipSize:  'Standard',   // Standard ($50/pip) | Mini ($5/pip) | Micro ($0.50/pip)

    // Win-rate dashboard
    showWinRate:   false,
    wins:          0,
    losses:        0,
  };

  // ── Constructor ──────────────────────────────────────────────────────────
  /**
   * @param {HTMLElement}  container   .chart-container div
   * @param {object}       chart       LightweightCharts chart instance
   * @param {object}       series      Candlestick (or Line) series instance
   * @param {string}       symbol      e.g. 'EURUSD'
   * @param {object}       [opts]      Override any DEFAULT key
   */
  constructor(container, chart, series, symbol = '', opts = {}) {
    this.container = container;
    this.chart     = chart;
    this.series    = series;
    this.symbol    = symbol.toUpperCase();
    this.opts      = { ...KofiNoWick.DEFAULTS, ...opts };

    this._candles        = [];
    this._pivotLabels    = [];   // { index, time, price, text, color, above }
    this._structureLines = [];   // { startTime, endTime, price, color, label, above }
    this._noWickMarkers  = [];   // { time, bull: bool }

    this._canvas     = null;
    this._ctx        = null;
    this._animId     = null;
    this._riskEl     = null;
    this._winEl      = null;
    this._settingsEl = null;
    this._settingsOpen = false;

    this._setup();
  }

  // ── Setup ─────────────────────────────────────────────────────────────────
  _setup() {
    this._createCanvas();
    this._createRiskPanel();
    this._createWinPanel();
    this._createSettingsPanel();

    // Re-render on any chart navigation
    const redraw = () => this._scheduleDraw();
    this.chart.timeScale().subscribeVisibleTimeRangeChange(redraw);
    this.chart.subscribeCrosshairMove(redraw);

    // Resize
    this._ro = new ResizeObserver(() => { this._resizeCanvas(); this._scheduleDraw(); });
    this._ro.observe(this.container);
  }

  // ── Canvas ────────────────────────────────────────────────────────────────
  _createCanvas() {
    this._canvas = document.createElement('canvas');
    Object.assign(this._canvas.style, {
      position: 'absolute', inset: '0',
      pointerEvents: 'none', zIndex: '4',
    });
    this.container.style.position = 'relative';
    this.container.appendChild(this._canvas);
    this._ctx = this._canvas.getContext('2d');
    this._resizeCanvas();
  }

  _resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w   = this.container.clientWidth  || 1;
    const h   = this.container.clientHeight || 1;
    this._canvas.width  = w * dpr;
    this._canvas.height = h * dpr;
    this._canvas.style.width  = w + 'px';
    this._canvas.style.height = h + 'px';
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _scheduleDraw() {
    if (this._animId) cancelAnimationFrame(this._animId);
    this._animId = requestAnimationFrame(() => this._draw());
  }

  // ── Public API ────────────────────────────────────────────────────────────
  setData(candles, symbol) {
    this.symbol   = (symbol || this.symbol).toUpperCase();
    this._candles = candles || [];
    this._compute();
    this._applyMarkers();
    this._scheduleDraw();
    this._updateRiskPanel();
    this._updateWinPanel();
  }

  updateSymbol(symbol) {
    this.symbol = symbol.toUpperCase();
    this._updateRiskPanel();
  }

  toggleSettings() {
    this._settingsOpen = !this._settingsOpen;
    if (this._settingsEl) {
      this._settingsEl.style.display = this._settingsOpen ? 'block' : 'none';
    }
  }

  destroy() {
    if (this._ro)        this._ro.disconnect();
    if (this._canvas)    this._canvas.remove();
    if (this._riskEl)    this._riskEl.remove();
    if (this._winEl)     this._winEl.remove();
    if (this._settingsEl) this._settingsEl.remove();
    if (this._animId)    cancelAnimationFrame(this._animId);
  }

  // ── Computation ───────────────────────────────────────────────────────────
  _compute() {
    this._pivotLabels    = [];
    this._structureLines = [];
    this._noWickMarkers  = [];

    if (this._candles.length < 3) return;

    this._computeStructure();
    this._computeNoWick();
  }

  /** Pivot-high: returns array (same length as candles); value at index i is
   *  the pivot high price if bar i is the pivot, else null. */
  _pivotHighs(candles, L) {
    const out = new Array(candles.length).fill(null);
    for (let i = L; i < candles.length - L; i++) {
      const val = candles[i].high;
      let ok = true;
      for (let j = i - L; j <= i + L; j++) {
        if (j !== i && candles[j].high >= val) { ok = false; break; }
      }
      if (ok) out[i] = val;
    }
    return out;
  }

  _pivotLows(candles, L) {
    const out = new Array(candles.length).fill(null);
    for (let i = L; i < candles.length - L; i++) {
      const val = candles[i].low;
      let ok = true;
      for (let j = i - L; j <= i + L; j++) {
        if (j !== i && candles[j].low <= val) { ok = false; break; }
      }
      if (ok) out[i] = val;
    }
    return out;
  }

  _computeStructure() {
    const c = this._candles;
    const L = Math.max(1, this.opts.pivotLength);
    const phs = this._pivotHighs(c, L);
    const pls = this._pivotLows(c,  L);

    let trend    = 0;
    let lastHigh = null, lastLow = null;
    let activeTop = null, activeTopIdx = null;
    let activeBtm = null, activeBtmIdx = null;
    let topBroken = true,  btmBroken = true;

    for (let i = 0; i < c.length; i++) {
      const bar = c[i];

      // ── Bullish pivot ──
      if (phs[i] !== null) {
        const ph    = phs[i];
        const isHH  = (lastHigh === null || ph > lastHigh);
        if (this.opts.showStruct) {
          this._pivotLabels.push({
            index: i, time: bar.time, price: ph,
            text:  isHH ? 'HH' : 'LH',
            color: isHH ? this.opts.colorHH_HL : this.opts.colorLH_LL,
            above: true,
          });
        }
        lastHigh = ph;

        // Anchor price
        let anchor = this.opts.anchorType === 'Body'
          ? Math.max(bar.open, bar.close)
          : bar.high;
        if (this.opts.anchorType === 'Body') {
          for (let j = Math.max(0, i - L * 2); j <= i; j++) {
            const body = Math.max(c[j].open, c[j].close);
            if (body > anchor) anchor = body;
          }
        }
        activeTop    = anchor;
        activeTopIdx = i;
        topBroken    = false;
      }

      // ── Bearish pivot ──
      if (pls[i] !== null) {
        const pl    = pls[i];
        const isHL  = (lastLow === null || pl > lastLow);
        if (this.opts.showStruct) {
          this._pivotLabels.push({
            index: i, time: bar.time, price: pl,
            text:  isHL ? 'HL' : 'LL',
            color: isHL ? this.opts.colorHH_HL : this.opts.colorLH_LL,
            above: false,
          });
        }
        lastLow = pl;

        let anchor = this.opts.anchorType === 'Body'
          ? Math.min(bar.open, bar.close)
          : bar.low;
        if (this.opts.anchorType === 'Body') {
          for (let j = Math.max(0, i - L * 2); j <= i; j++) {
            const body = Math.min(c[j].open, c[j].close);
            if (body < anchor) anchor = body;
          }
        }
        activeBtm    = anchor;
        activeBtmIdx = i;
        btmBroken    = false;
      }

      // ── Bullish breakout ──
      if (activeTop !== null && bar.close > activeTop && !topBroken) {
        const isBOS = (trend === 1);
        if (this.opts.showBosChoch) {
          this._structureLines.push({
            startTime: c[activeTopIdx].time,
            endTime:   bar.time,
            price:     activeTop,
            color:     this.opts.colorBullBreak,
            label:     isBOS ? 'BOS' : 'CHoCH',
            above:     false,
          });
        }
        trend     = 1;
        topBroken = true;
      }

      // ── Bearish breakout ──
      if (activeBtm !== null && bar.close < activeBtm && !btmBroken) {
        const isBOS = (trend === -1);
        if (this.opts.showBosChoch) {
          this._structureLines.push({
            startTime: c[activeBtmIdx].time,
            endTime:   bar.time,
            price:     activeBtm,
            color:     this.opts.colorBearBreak,
            label:     isBOS ? 'BOS' : 'CHoCH',
            above:     true,
          });
        }
        trend     = -1;
        btmBroken = true;
      }
    }
  }

  // Tolerance map for each sensitivity level
  static SENSITIVITY_EPS = {
    Strict: 1e-8,    // essentially exact equality (float round-trip safe)
    Normal: 1e-5,    // relative: ~0.1 pip on standard forex
    Loose:  1e-3,    // relative: up to 1 pip — catches near no-wick candles
  };

  _computeNoWick() {
    const relTol = KofiNoWick.SENSITIVITY_EPS[this.opts.noWickSensitivity] ?? 1e-5;
    for (const bar of this._candles) {
      if (bar.open === bar.close) continue;  // skip doji / inside bars

      // Use body (min/max of open,close) so detection works for both bullish
      // and bearish candles — matching the omarnowick TradingView definition:
      //   bull ▲: body bottom touches candle low  (no lower wick)
      //   bear ▼: body top   touches candle high (no upper wick)
      const eps      = Math.max(1e-9, Math.abs(bar.open) * relTol);
      const bodyLow  = Math.min(bar.open, bar.close);
      const bodyHigh = Math.max(bar.open, bar.close);
      const bull = Math.abs(bodyLow  - bar.low)  <= eps;
      const bear = Math.abs(bodyHigh - bar.high) <= eps;
      if (bull) this._noWickMarkers.push({ time: bar.time, bull: true  });
      if (bear) this._noWickMarkers.push({ time: bar.time, bull: false });
    }
  }

  /** Apply no-wick markers directly to the LWC series. */
  _applyMarkers() {
    if (!this.series) return;
    try {
      const showBull = this.opts.showNoWick && this.opts.showBullArrows;
      const showBear = this.opts.showNoWick && this.opts.showBearArrows;

      if (!showBull && !showBear) {
        this.series.setMarkers([]);
        return;
      }

      const size = Math.max(1, Math.min(4, this.opts.arrowSize || 1));
      const markers = this._noWickMarkers
        .filter(m => m.bull ? showBull : showBear)
        .map(m => ({
          time:     m.time,
          position: m.bull ? 'belowBar' : 'aboveBar',
          color:    m.bull ? this.opts.bullColor : this.opts.bearColor,
          shape:    m.bull ? 'arrowUp' : 'arrowDown',
          text:     '',
          size,
        }));

      // LWC requires markers sorted ascending by time
      markers.sort((a, b) => a.time - b.time);
      this.series.setMarkers(markers);
    } catch (err) {
      console.warn('[KofiNoWick] setMarkers failed:', err);
    }
  }

  // ── Drawing ───────────────────────────────────────────────────────────────
  _draw() {
    const ctx = this._ctx;
    const W   = this.container.clientWidth;
    const H   = this.container.clientHeight;
    if (W <= 0 || H <= 0) return;
    ctx.clearRect(0, 0, W, H);

    this._drawSessions(ctx, W, H);
    this._drawStructureLines(ctx, W, H);
    this._drawPivotLabels(ctx, W, H);
  }

  // ── Session zones ─────────────────────────────────────────────────────────
  _drawSessions(ctx, W, H) {
    const ts    = this.chart.timeScale();
    const range = ts.getVisibleRange();
    if (!range) return;

    // Auto-adjust No Trading Zone end for metals (+1 h)
    const isMetal = /XAU|GOLD|XAG|SILVER/.test(this.symbol);
    const zoneEnd = isMetal && this.opts.zoneEnd === 19.0 ? 20.0 : this.opts.zoneEnd;

    const sessions = [
      { on: this.opts.showZone,   start: this.opts.zoneStart,   end: zoneEnd,
        color: this.opts.zoneColor,   label: 'NO TRADING ZONE', showLabel: this.opts.showZoneText },
      { on: this.opts.showAsia,   start: this.opts.asiaStart,   end: this.opts.asiaEnd,
        color: this.opts.asiaColor,   label: 'ASIA',            showLabel: this.opts.showAsiaText },
      { on: this.opts.showLondon, start: this.opts.londonStart, end: this.opts.londonEnd,
        color: this.opts.londonColor, label: 'LONDON',          showLabel: this.opts.showLondonText },
      { on: this.opts.showNY,     start: this.opts.nyStart,     end: this.opts.nyEnd,
        color: this.opts.nyColor,     label: 'NEW YORK',        showLabel: this.opts.showNYText },
    ].filter((s) => s.on);

    if (sessions.length === 0) return;

    // Iterate 3 days either side of visible range
    const fromMs = range.from * 1000 - 3 * 86_400_000;
    const toMs   = range.to   * 1000 + 3 * 86_400_000;

    let day = new Date(fromMs);
    day.setUTCHours(0, 0, 0, 0);

    while (day.getTime() < toMs) {
      const skip = day.getUTCDay(); // 0=Sun, 6=Sat
      if (skip !== 0 && skip !== 6) {   // skip weekends
        for (const sess of sessions) {
          const { sMs, eMs } = this._sessionUTC(day, sess.start, sess.end);
          const x1 = ts.timeToCoordinate(sMs / 1000);
          const x2 = ts.timeToCoordinate(eMs / 1000);
          if (x1 === null || x2 === null) continue;

          const xL = Math.min(x1, x2);
          const xR = Math.max(x1, x2);
          if (xR < 0 || xL > W) continue;

          ctx.fillStyle = sess.color;
          ctx.fillRect(xL, 0, xR - xL, H);

          if (sess.showLabel && sess.label) {
            ctx.save();
            ctx.font         = 'bold 11px "Inter", "Segoe UI", sans-serif';
            ctx.fillStyle    = 'rgba(200,80,80,0.90)';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(sess.label, (xL + xR) / 2, 10);
            ctx.restore();
          }
        }
      }
      day.setUTCDate(day.getUTCDate() + 1);
    }
  }

  /** Convert decimal ET hours to UTC millisecond timestamps for a given day. */
  _sessionUTC(dayDate, etStart, etEnd) {
    const absOffset = this._isEDT(dayDate) ? 4 : 5;   // hours to add ET→UTC
    const base      = dayDate.getTime();
    let sMs = base + (etStart + absOffset) * 3_600_000;
    let eMs = base + (etEnd   + absOffset) * 3_600_000;
    if (eMs <= sMs) eMs += 86_400_000;   // overnight session
    return { sMs, eMs };
  }

  /** True if the given UTC date falls in US Eastern Daylight Time. */
  _isEDT(date) {
    const y  = date.getUTCFullYear();
    // Second Sunday in March
    const mar = new Date(Date.UTC(y, 2, 1));
    while (mar.getUTCDay() !== 0) mar.setUTCDate(mar.getUTCDate() + 1);
    mar.setUTCDate(mar.getUTCDate() + 7);
    // First Sunday in November
    const nov = new Date(Date.UTC(y, 10, 1));
    while (nov.getUTCDay() !== 0) nov.setUTCDate(nov.getUTCDate() + 1);
    return date >= mar && date < nov;
  }

  // ── Structure lines (BOS / CHoCH) ─────────────────────────────────────────
  _drawStructureLines(ctx, W, H) {
    if (!this.opts.showBosChoch) return;
    const ts = this.chart.timeScale();

    for (const sl of this._structureLines) {
      const x1 = ts.timeToCoordinate(sl.startTime);
      const x2 = ts.timeToCoordinate(sl.endTime);
      const y  = this.series.priceToCoordinate(sl.price);
      if (x1 === null || x2 === null || y === null) continue;
      if (Math.max(x1, x2) < 0 || Math.min(x1, x2) > W) continue;

      // Horizontal line
      ctx.save();
      ctx.strokeStyle = sl.color;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
      ctx.stroke();

      // Label
      const midX    = (x1 + x2) / 2;
      const labelY  = sl.above ? y - 14 : y + 4;
      ctx.font         = 'bold 10px "Inter", "Segoe UI", sans-serif';
      ctx.fillStyle    = sl.color;
      ctx.textAlign    = 'center';
      ctx.textBaseline = sl.above ? 'bottom' : 'top';
      ctx.fillText(sl.label, midX, labelY);
      ctx.restore();
    }
  }

  // ── Pivot labels (HH / HL / LH / LL) ─────────────────────────────────────
  _drawPivotLabels(ctx, W, _H) {
    if (!this.opts.showStruct) return;
    const ts = this.chart.timeScale();

    for (const pl of this._pivotLabels) {
      const x = ts.timeToCoordinate(pl.time);
      const y = this.series.priceToCoordinate(pl.price);
      if (x === null || y === null) continue;
      if (x < -20 || x > W + 20) continue;

      ctx.save();
      ctx.font         = 'bold 10px "Inter", "Segoe UI", sans-serif';
      ctx.fillStyle    = pl.color;
      ctx.textAlign    = 'center';
      ctx.textBaseline = pl.above ? 'bottom' : 'top';
      ctx.fillText(pl.text, x, pl.above ? y - 6 : y + 6);
      ctx.restore();
    }
  }

  // ── Risk Dashboard Panel ──────────────────────────────────────────────────
  _createRiskPanel() {
    this._riskEl = document.createElement('div');
    this._riskEl.className = 'knw-panel knw-risk';
    this.container.appendChild(this._riskEl);
    this._updateRiskPanel();
  }

  _updateRiskPanel() {
    if (!this._riskEl) return;
    this._riskEl.style.display = this.opts.showRisk ? 'block' : 'none';
    if (!this.opts.showRisk) return;

    const { accountBal, riskPct, slPips } = this.opts;
    const riskAmt  = accountBal * riskPct / 100;
    const lotSize  = this._calcLotSize(riskAmt, slPips);
    const sym      = this.symbol;
    const symLabel = sym || '—';

    this._riskEl.innerHTML = `
      <div class="knw-panel-title">KofiNoWick Risk</div>
      <div class="knw-row">
        <span class="knw-lbl">Symbol</span>
        <span class="knw-val">${symLabel}</span>
      </div>
      <div class="knw-row">
        <span class="knw-lbl">Balance</span>
        <span class="knw-val">$${accountBal.toLocaleString()}</span>
      </div>
      <div class="knw-row">
        <span class="knw-lbl">Risk</span>
        <span class="knw-val">${riskPct}% ($${riskAmt.toFixed(2)})</span>
      </div>
      <div class="knw-row">
        <span class="knw-lbl">SL Pips</span>
        <span class="knw-val">${slPips}</span>
      </div>
      <div class="knw-row knw-highlight">
        <span class="knw-lbl">Lot Size</span>
        <span class="knw-val knw-lot">${lotSize}</span>
      </div>`;
  }

  _calcLotSize(riskAmt, slPips) {
    const sym = this.symbol;

    // Gold / Silver pip-size multipliers (user-selectable in settings)
    const GOLD_PV   = { Standard: 10,  Mini: 1,  Micro: 0.1  };
    const SILVER_PV = { Standard: 50,  Mini: 5,  Micro: 0.5  };

    let pipValue = 10; // default: forex USD-quoted pair, 1 standard lot = $10/pip

    if (/XAU|GOLD/.test(sym)) {
      pipValue = GOLD_PV[this.opts.goldPipSize] ?? 10;
    } else if (/XAG|SILVER/.test(sym)) {
      pipValue = SILVER_PV[this.opts.silverPipSize] ?? 50;
    } else if (/JPY/.test(sym)) {
      // JPY pairs: pip = 0.01, 100,000 units → approx $9.1/pip (USD terms)
      pipValue = 9.1;
    } else if (/US100|NQ|NDX/.test(sym)) {
      pipValue = 20;
    } else if (/SP500|GSPC|ES/.test(sym)) {
      pipValue = 12.5;
    } else if (/GER40|DAX/.test(sym)) {
      pipValue = 10;
    } else if (/DXY/.test(sym)) {
      pipValue = 10;
    }

    const lots = riskAmt / (slPips * pipValue);
    return lots >= 0.01 ? lots.toFixed(2) : lots.toFixed(4);
  }

  // ── Win Rate Dashboard Panel ──────────────────────────────────────────────
  _createWinPanel() {
    this._winEl = document.createElement('div');
    this._winEl.className = 'knw-panel knw-winrate';
    this.container.appendChild(this._winEl);
    this._updateWinPanel();
  }

  _updateWinPanel() {
    if (!this._winEl) return;
    this._winEl.style.display = this.opts.showWinRate ? 'block' : 'none';
    if (!this.opts.showWinRate) return;

    const { wins, losses } = this.opts;
    const total   = wins + losses;
    const wr      = total > 0 ? (wins / total * 100) : 0;
    const wrColor = wr >= 50 ? '#26a69a' : '#ef5350';

    this._winEl.innerHTML = `
      <div class="knw-panel-title">Win Rate</div>
      <div class="knw-row">
        <span class="knw-lbl">Trades</span>
        <span class="knw-val">${total}</span>
      </div>
      <div class="knw-row">
        <span class="knw-lbl">Wins</span>
        <span class="knw-val" style="color:#26a69a">${wins}</span>
      </div>
      <div class="knw-row">
        <span class="knw-lbl">Losses</span>
        <span class="knw-val" style="color:#ef5350">${losses}</span>
      </div>
      <div class="knw-row knw-highlight">
        <span class="knw-lbl">Win Rate</span>
        <span class="knw-val" style="color:${wrColor}">${wr.toFixed(2)}%</span>
      </div>`;
  }

  // ── Settings Panel ────────────────────────────────────────────────────────
  _createSettingsPanel() {
    this._settingsEl = document.createElement('div');
    this._settingsEl.className = 'knw-settings';
    this._settingsEl.style.display = 'none';
    this._settingsEl.innerHTML = this._settingsHTML();
    this.container.appendChild(this._settingsEl);

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (this._settingsOpen && !this._settingsEl.contains(e.target)) {
        const gearBtn = this.container.closest('.chart-pane')?.querySelector('.pane-btn--indicator');
        if (gearBtn && gearBtn.contains(e.target)) return;
        this._settingsOpen = false;
        this._settingsEl.style.display = 'none';
      }
    });

    // Live binding — all inputs trigger _onSettingChange
    this._settingsEl.addEventListener('input',  (e) => this._onSettingChange(e));
    this._settingsEl.addEventListener('change', (e) => this._onSettingChange(e));
  }

  _settingsHTML() {
    const o = this.opts;

    // Helper builders
    const tog = (key, label, val) =>
      `<label class="knw-toggle"><input type="checkbox" data-key="${key}" ${val ? 'checked' : ''}/><span>${label}</span></label>`;
    const num = (key, label, val, step = 1, min = '') =>
      `<label class="knw-field"><span>${label}</span>
         <input type="number" data-key="${key}" value="${val}" step="${step}" ${min !== '' ? `min="${min}"` : ''}/>
       </label>`;
    const col = (key, label, val) =>
      `<label class="knw-field knw-field--color"><span>${label}</span>
         <input type="color" data-key="${key}" value="${val}" class="knw-color-input"/>
       </label>`;

    return `
      <div class="knw-settings-header">
        <span>⚙ KofiNoWick Settings</span>
        <button class="knw-close-btn" onclick="this.closest('.knw-settings').style.display='none'">✕</button>
      </div>
      <div class="knw-settings-body">

        <div class="knw-section">MARKET STRUCTURE</div>
        ${tog('showStruct',   'Show HH / HL / LH / LL labels', o.showStruct)}
        ${tog('showBosChoch', 'Show BOS / CHoCH lines',        o.showBosChoch)}
        ${num('pivotLength',  'Pivot Length', o.pivotLength, 1, 1)}
        <label class="knw-field"><span>Anchor From</span>
          <select data-key="anchorType">
            <option value="Body" ${o.anchorType === 'Body' ? 'selected' : ''}>Body</option>
            <option value="Wick" ${o.anchorType === 'Wick' ? 'selected' : ''}>Wick</option>
          </select>
        </label>
        ${col('colorHH_HL',     'HH / HL colour',      o.colorHH_HL)}
        ${col('colorLH_LL',     'LH / LL colour',      o.colorLH_LL)}
        ${col('colorBullBreak', 'BOS / CHoCH (bull)',   o.colorBullBreak)}
        ${col('colorBearBreak', 'BOS / CHoCH (bear)',   o.colorBearBreak)}

        <div class="knw-section">NO-WICK ARROWS</div>
        ${tog('showNoWick',    'Show No-Wick Triangles',     o.showNoWick)}
        ${tog('showBullArrows','  ▲ Bullish (open = low)',   o.showBullArrows)}
        ${tog('showBearArrows','  ▼ Bearish (open = high)',  o.showBearArrows)}
        ${col('bullColor',    'Bullish ▲ colour',            o.bullColor)}
        ${col('bearColor',    'Bearish ▼ colour',            o.bearColor)}
        ${num('arrowSize',    'Arrow size (1 – 4)',          o.arrowSize || 1, 1, 1)}
        <label class="knw-field"><span>Sensitivity</span>
          <select data-key="noWickSensitivity">
            <option value="Strict" ${o.noWickSensitivity === 'Strict' ? 'selected' : ''}>Strict — exact match</option>
            <option value="Normal" ${(o.noWickSensitivity ?? 'Normal') === 'Normal' ? 'selected' : ''}>Normal — sub-pip (recommended)</option>
            <option value="Loose"  ${o.noWickSensitivity === 'Loose'  ? 'selected' : ''}>Loose — up to 1 pip</option>
          </select>
        </label>

        <div class="knw-section">SESSIONS (ET)</div>
        ${tog('showZone',       'No Trading Zone (15:00–19:00)', o.showZone)}
        ${tog('showZoneText',   '→ Show label',                  o.showZoneText)}
        ${tog('showAsia',       'Asia (18:00–02:00)',            o.showAsia)}
        ${tog('showAsiaText',   '→ Show label',                  o.showAsiaText)}
        ${tog('showLondon',     'London (03:00–09:00)',          o.showLondon)}
        ${tog('showLondonText', '→ Show label',                  o.showLondonText)}
        ${tog('showNY',         'New York (08:00–17:00)',        o.showNY)}
        ${tog('showNYText',     '→ Show label',                  o.showNYText)}

        <div class="knw-section">RISK DASHBOARD</div>
        ${tog('showRisk',    'Show Risk Dashboard',    o.showRisk)}
        <label class="knw-field"><span>Account Currency</span>
          <select data-key="accountCurrency">
            ${['USD','EUR','GBP','JPY','AUD','CAD','CHF'].map(c =>
              `<option value="${c}" ${o.accountCurrency === c ? 'selected' : ''}>${c}</option>`
            ).join('')}
          </select>
        </label>
        ${num('accountBal',  'Account Balance',        o.accountBal, 1000)}
        ${num('riskPct',     'Percentage Risk (%)',    o.riskPct,   0.1)}
        ${num('slPips',      'Stop Loss (Pips)',       o.slPips,    0.1)}
        <label class="knw-field"><span>Gold Pip Size</span>
          <select data-key="goldPipSize">
            <option value="Standard" ${o.goldPipSize === 'Standard' ? 'selected' : ''}>Standard ($10/pip)</option>
            <option value="Mini"     ${o.goldPipSize === 'Mini'     ? 'selected' : ''}>Mini ($1/pip)</option>
            <option value="Micro"    ${o.goldPipSize === 'Micro'    ? 'selected' : ''}>Micro ($0.10/pip)</option>
          </select>
        </label>
        <label class="knw-field"><span>Silver Pip Size</span>
          <select data-key="silverPipSize">
            <option value="Standard" ${o.silverPipSize === 'Standard' ? 'selected' : ''}>Standard ($50/pip)</option>
            <option value="Mini"     ${o.silverPipSize === 'Mini'     ? 'selected' : ''}>Mini ($5/pip)</option>
            <option value="Micro"    ${o.silverPipSize === 'Micro'    ? 'selected' : ''}>Micro ($0.50/pip)</option>
          </select>
        </label>

        <div class="knw-section">WIN RATE DASHBOARD</div>
        ${tog('showWinRate', 'Show Win Rate',   o.showWinRate)}
        ${num('wins',        'Total Wins',      o.wins,   1, 0)}
        ${num('losses',      'Total Losses',    o.losses, 1, 0)}

      </div>`;
  }

  _onSettingChange(e) {
    const el  = e.target;
    const key = el.dataset.key;
    if (!key) return;

    const val = el.type === 'checkbox' ? el.checked
              : el.type === 'number'   ? parseFloat(el.value)
              : el.value;   // covers color inputs and selects

    this.opts[key] = val;

    const recomputeKeys = ['pivotLength', 'anchorType', 'showStruct', 'showBosChoch',
                           'noWickSensitivity'];
    const markerKeys    = ['showNoWick', 'showBullArrows', 'showBearArrows',
                           'bullColor', 'bearColor', 'arrowSize'];
    // These keys affect the risk panel display only
    const riskKeys      = ['accountCurrency', 'goldPipSize', 'silverPipSize'];

    if (recomputeKeys.includes(key)) {
      this._compute();
      this._applyMarkers();
    } else if (markerKeys.includes(key)) {
      this._applyMarkers();
    }

    this._scheduleDraw();
    this._updateRiskPanel();
    this._updateWinPanel();
    // Rebuild settings HTML if a selector that affects its own rendering changed
    if (riskKeys.includes(key)) {
      // Just refresh displayed values — panel HTML stays intact
    }
    this._saveSettings();
  }

  // ── Persistence ───────────────────────────────────────────────────────────
  _settingsKey() {
    // Use the parent pane ID if available
    const paneEl = this.container.closest('[data-pane-id]');
    const id     = paneEl ? paneEl.dataset.paneId : '0';
    return `knw_settings_${id}`;
  }

  _saveSettings() {
    try { localStorage.setItem(this._settingsKey(), JSON.stringify(this.opts)); } catch (_) {}
  }

  static loadSettings(paneId) {
    try {
      const raw = localStorage.getItem(`knw_settings_${paneId}`);
      return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
  }
}
