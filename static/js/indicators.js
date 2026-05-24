/**
 * KofiFX Terminal — IndicatorManager  (v2)
 * ==========================================
 * Overlay indicators (on the main price chart):
 *   SMA, EMA, BB, VWAP
 *
 * Sub-chart indicators (synced oscillator panel below):
 *   RSI, MACD
 *
 * v2 additions:
 *   • Eye-toggle  — show / hide each indicator without removing it
 *   • Settings popup — click ⚙ on any chip to edit period / colour / stddev
 *                      changes apply live without reloading the chart
 */

// ── Maths helpers ────────────────────────────────────────────────────────────
const Calc = {
  sma(closes, period) {
    const out = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += closes[i - j];
      out[i] = sum / period;
    }
    return out;
  },

  ema(closes, period) {
    const out  = new Array(closes.length).fill(null);
    const k    = 2 / (period + 1);
    let   prev = null;
    for (let i = 0; i < closes.length; i++) {
      if (prev === null) {
        if (i === period - 1) {
          let sum = 0;
          for (let j = 0; j < period; j++) sum += closes[j];
          prev   = sum / period;
          out[i] = prev;
        }
      } else {
        prev   = closes[i] * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  },

  stddev(closes, period, means) {
    const out = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i++) {
      if (means[i] === null) continue;
      let variance = 0;
      for (let j = 0; j < period; j++) {
        const diff = closes[i - j] - means[i];
        variance += diff * diff;
      }
      out[i] = Math.sqrt(variance / period);
    }
    return out;
  },

  rsi(closes, period = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < period + 1) return out;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gains  += d;
      else       losses -= d;
    }
    let avgGain = gains  / period;
    let avgLoss = losses / period;
    for (let i = period; i < closes.length; i++) {
      if (i > period) {
        const d = closes[i] - closes[i - 1];
        avgGain  = (avgGain  * (period - 1) + (d > 0 ? d : 0)) / period;
        avgLoss  = (avgLoss  * (period - 1) + (d < 0 ? -d : 0)) / period;
      }
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      out[i]   = 100 - 100 / (1 + rs);
    }
    return out;
  },

  macd(closes, fast = 12, slow = 26, signal = 9) {
    const emaFast  = Calc.ema(closes, fast);
    const emaSlow  = Calc.ema(closes, slow);
    const macdLine = closes.map((_, i) =>
      emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null);
    const signalArr = new Array(macdLine.length).fill(null);
    const k   = 2 / (signal + 1);
    let   prev = null, count = 0;
    for (let i = 0; i < macdLine.length; i++) {
      if (macdLine[i] === null) continue;
      if (prev === null) {
        if (count === signal - 1) { prev = macdLine[i]; signalArr[i] = prev; }
        else count++;
      } else {
        prev = macdLine[i] * k + prev * (1 - k);
        signalArr[i] = prev;
      }
    }
    const hist = macdLine.map((v, i) =>
      v !== null && signalArr[i] !== null ? v - signalArr[i] : null);
    return { macd: macdLine, signal: signalArr, hist };
  },

  vwap(candles) {
    const out = new Array(candles.length).fill(null);
    let cumPV = 0, cumVol = 0, lastDate = null;
    for (let i = 0; i < candles.length; i++) {
      const c    = candles[i];
      const date = new Date(c.time * 1000).toDateString();
      if (date !== lastDate) { cumPV = 0; cumVol = 0; lastDate = date; }
      const typ  = (c.high + c.low + c.close) / 3;
      const vol  = c.volume || 1;
      cumPV  += typ * vol;
      cumVol += vol;
      out[i]  = cumVol > 0 ? cumPV / cumVol : null;
    }
    return out;
  },
};

// ── Colour palette ────────────────────────────────────────────────────────────
const PALETTE = [
  '#f6c90e','#00d4aa','#4e8ef7','#ff6b6b','#a29bfe',
  '#fd79a8','#74b9ff','#55efc4','#fdcb6e','#e17055',
];
let _paletteIdx = 0;
const nextColor = () => PALETTE[_paletteIdx++ % PALETTE.length];

// ── IndicatorManager ─────────────────────────────────────────────────────────
class IndicatorManager {
  constructor(paneEl, mainChart, mainSeries) {
    this.paneEl     = paneEl;
    this.mainChart  = mainChart;
    this.mainSeries = mainSeries;
    this._candles   = [];
    this._active    = [];   // indicator descriptors
    this._subChart  = null;
    this._subSeries = {};

    this._setupSubChartArea();
    this._setupChipsBar();
    this._closeSettingsOnOutsideClick();
    this._restoreState();
  }

  // ── Sub-chart area ────────────────────────────────────────────────────────
  _setupSubChartArea() {
    this._subContainer = document.createElement('div');
    this._subContainer.className = 'indicator-sub-chart hidden';
    const cc = this.paneEl.querySelector('.chart-container');
    cc.parentNode.insertBefore(this._subContainer, cc.nextSibling);
  }

  _ensureSubChart() {
    if (this._subChart) return;
    this._subContainer.classList.remove('hidden');
    this._subChart = LightweightCharts.createChart(this._subContainer, {
      layout: { background: { type: 'solid', color: '#090b0f' },
                textColor: '#7a8499', fontSize: 10,
                fontFamily: "'JetBrains Mono', monospace" },
      grid:   { vertLines: { color: '#1a1f2e' }, horzLines: { color: '#1a1f2e' } },
      rightPriceScale: { borderColor: '#1e2535', textColor: '#7a8499',
                         scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: '#1e2535', textColor: '#7a8499',
                   timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: '#444c6a' }, horzLine: { color: '#444c6a' } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale:  { mouseWheel: true, pinch: true },
      width:  this._subContainer.clientWidth  || 400,
      height: this._subContainer.clientHeight || 90,
    });
    this.mainChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range && this._subChart) this._subChart.timeScale().setVisibleLogicalRange(range);
    });
    this._subChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range && this.mainChart) this.mainChart.timeScale().setVisibleLogicalRange(range);
    });
    new ResizeObserver(() => {
      const w = this._subContainer.clientWidth;
      const h = this._subContainer.clientHeight;
      if (w > 0 && h > 0) this._subChart.resize(w, h);
    }).observe(this._subContainer);
  }

  _hideSubChart() {
    const hasOsc = this._active.some(a => ['rsi','macd'].includes(a.type));
    if (!hasOsc) this._subContainer.classList.add('hidden');
  }

  // ── Chips bar ─────────────────────────────────────────────────────────────
  _setupChipsBar() {
    // Reuse the .indicator-chips already stamped by the pane template, if present.
    // This avoids a duplicate element and ensures the bar is in the right DOM position.
    this._chipsBar = this.paneEl.querySelector('.indicator-chips');
    if (!this._chipsBar) {
      this._chipsBar = document.createElement('div');
      this._chipsBar.className = 'indicator-chips hidden';
      const toolbar = this.paneEl.querySelector('.pane-toolbar');
      toolbar.parentNode.insertBefore(this._chipsBar, toolbar.nextSibling);
    }

    // ONE delegated listener — survives every innerHTML replacement in _refreshChips.
    // Per-button listeners break because rebuilding innerHTML removes the old nodes.
    this._chipsBar.addEventListener('click', e => {
      const removeBtn   = e.target.closest('.ind-chip-remove');
      const eyeBtn      = e.target.closest('.ind-chip-eye');
      const settingsBtn = e.target.closest('.ind-chip-settings');
      if (removeBtn)   { e.stopPropagation(); this.remove(removeBtn.dataset.id); }
      else if (eyeBtn) { e.stopPropagation(); this._toggleVisibility(eyeBtn.dataset.id); }
      else if (settingsBtn) { e.stopPropagation(); this._openSettings(settingsBtn.dataset.id, settingsBtn); }
    });
  }

  _refreshChips() {
    if (this._active.length === 0) {
      this._chipsBar.classList.add('hidden');
      this._chipsBar.innerHTML = '';
      return;
    }
    this._chipsBar.classList.remove('hidden');
    // Render chips — no per-button event binding needed; the delegated listener handles it.
    this._chipsBar.innerHTML = this._active.map(a => `
      <span class="ind-chip ${a.visible === false ? 'ind-chip--hidden' : ''}" data-id="${a.id}" style="border-color:${a.color}">
        <span class="ind-chip-dot" style="background:${a.color}"></span>
        <span class="ind-chip-label">${a.label}</span>
        <button class="ind-chip-eye" data-id="${a.id}" title="${a.visible === false ? 'Show' : 'Hide'}">
          ${a.visible === false ? _eyeOffSvg() : _eyeSvg()}
        </button>
        <button class="ind-chip-settings" data-id="${a.id}" title="Settings">
          ${_gearSvg()}
        </button>
        <button class="ind-chip-remove" data-id="${a.id}" title="Remove">×</button>
      </span>`).join('');
  }

  // ── Eye toggle ────────────────────────────────────────────────────────────
  _toggleVisibility(id) {
    const ind = this._active.find(a => a.id === id);
    if (!ind) return;
    ind.visible = ind.visible === false ? true : false;
    const hidden = ind.visible === false;

    // Toggle main-chart series
    ind.series.forEach(s => {
      try { s.applyOptions({ visible: !hidden }); } catch (_) {}
    });
    // Toggle sub-chart series
    const sub = this._subSeries[id];
    if (sub) {
      Object.values(sub).forEach(s => {
        try { s.applyOptions({ visible: !hidden }); } catch (_) {}
      });
    }
    this._refreshChips();
    this._saveState();
  }

  // ── Settings popup ────────────────────────────────────────────────────────
  _openSettings(id, anchorBtn) {
    // Close any open popup first
    this._closeAllSettings();

    const ind = this._active.find(a => a.id === id);
    if (!ind) return;

    const popup = document.createElement('div');
    popup.className = 'ind-settings-popup';
    popup.dataset.forId = id;
    popup.innerHTML = this._settingsHTML(ind);

    // Position below the chip
    const chipRect = anchorBtn.closest('.ind-chip').getBoundingClientRect();
    const barRect  = this._chipsBar.getBoundingClientRect();
    popup.style.left = (chipRect.left - barRect.left) + 'px';
    popup.style.top  = chipRect.height + 4 + 'px';

    this._chipsBar.style.position = 'relative';
    this._chipsBar.appendChild(popup);

    // Live-apply listeners
    popup.querySelectorAll('input').forEach(input => {
      input.addEventListener('input', () => this._applySettings(id, popup));
    });
    popup.querySelector('.ind-settings-close')?.addEventListener('click', () => {
      popup.remove();
    });
  }

  _settingsHTML(ind) {
    const hasP   = ['sma','ema','bb','rsi'].includes(ind.type);
    const hasDev = ind.type === 'bb';
    const isMacd = ind.type === 'macd';
    let html = `<div class="ind-settings-header">
      <span>${ind.label}</span>
      <button class="ind-settings-close" title="Close">×</button>
    </div>`;

    if (hasP) {
      html += `<label class="ind-settings-row">
        <span>Period</span>
        <input type="number" class="ind-settings-input" data-key="period"
               value="${ind.params.period || ''}" min="1" max="500" step="1"/>
      </label>`;
    }
    if (hasDev) {
      html += `<label class="ind-settings-row">
        <span>Std Dev</span>
        <input type="number" class="ind-settings-input" data-key="stddev"
               value="${ind.params.stddev || 2}" min="0.5" max="5" step="0.5"/>
      </label>`;
    }
    if (isMacd) {
      html += `
      <label class="ind-settings-row">
        <span>Fast</span>
        <input type="number" class="ind-settings-input" data-key="fast"
               value="${ind.params.fast || 12}" min="1" max="100"/>
      </label>
      <label class="ind-settings-row">
        <span>Slow</span>
        <input type="number" class="ind-settings-input" data-key="slow"
               value="${ind.params.slow || 26}" min="1" max="200"/>
      </label>
      <label class="ind-settings-row">
        <span>Signal</span>
        <input type="number" class="ind-settings-input" data-key="signal"
               value="${ind.params.signal || 9}" min="1" max="50"/>
      </label>`;
    }

    html += `<label class="ind-settings-row">
      <span>Colour</span>
      <input type="color" class="ind-settings-color" data-key="color" value="${ind.color}"/>
    </label>`;
    return html;
  }

  _applySettings(id, popup) {
    const ind = this._active.find(a => a.id === id);
    if (!ind) return;

    popup.querySelectorAll('.ind-settings-input').forEach(inp => {
      const key = inp.dataset.key;
      const val = parseFloat(inp.value);
      if (!isNaN(val) && val > 0) ind.params[key] = val;
    });
    const colorInp = popup.querySelector('.ind-settings-color');
    if (colorInp) ind.color = colorInp.value;

    ind.label = this._makeLabel(ind.type, ind.params);
    this._renderOne(ind);
    this._refreshChips();
    this._saveState();

    // Re-apply visibility state after re-render
    if (ind.visible === false) {
      ind.series.forEach(s => { try { s.applyOptions({ visible: false }); } catch (_) {} });
      const sub = this._subSeries[id];
      if (sub) Object.values(sub).forEach(s => { try { s.applyOptions({ visible: false }); } catch (_) {} });
    }
  }

  _closeAllSettings() {
    this._chipsBar.querySelectorAll('.ind-settings-popup').forEach(p => p.remove());
  }

  _closeSettingsOnOutsideClick() {
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.ind-settings-popup') && !e.target.closest('.ind-chip-settings')) {
        this._closeAllSettings();
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────
  setData(candles) {
    this._candles = candles || [];
    this._recomputeAll();
  }

  add(type, params = {}, color, visible = true) {
    color = color || nextColor();
    const id    = `${type}_${Date.now()}`;
    const label = this._makeLabel(type, params);
    const ind   = { id, type, params, color, label, series: [], visible };
    this._active.push(ind);
    this._renderOne(ind);
    this._refreshChips();
    this._saveState();
    return id;
  }

  remove(id) {
    const idx = this._active.findIndex(a => a.id === id);
    if (idx === -1) return;
    const ind = this._active[idx];
    ind.series.forEach(s => { try { this.mainChart.removeSeries(s); } catch (_) {} });
    if (this._subChart && this._subSeries[id]) {
      Object.values(this._subSeries[id]).forEach(s => {
        try { this._subChart.removeSeries(s); } catch (_) {}
      });
      delete this._subSeries[id];
    }
    this._active.splice(idx, 1);
    this._refreshChips();
    this._hideSubChart();
    this._saveState();
  }

  removeAll() {
    [...this._active].forEach(a => this.remove(a.id));
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  _recomputeAll() {
    this._active.forEach(ind => {
      this._renderOne(ind);
      if (ind.visible === false) {
        ind.series.forEach(s => { try { s.applyOptions({ visible: false }); } catch (_) {} });
        const sub = this._subSeries[ind.id];
        if (sub) Object.values(sub).forEach(s => { try { s.applyOptions({ visible: false }); } catch (_) {} });
      }
    });
  }

  _toTimedData(times, values) {
    return values.map((v, i) => v !== null ? { time: times[i], value: v } : null).filter(Boolean);
  }

  _renderOne(ind) {
    const c = this._candles;
    if (!c.length) return;
    const times  = c.map(x => x.time);
    const closes = c.map(x => x.close);

    // Remove previous series for this indicator
    ind.series.forEach(s => { try { this.mainChart.removeSeries(s); } catch (_) {} });
    ind.series = [];
    if (this._subSeries[ind.id]) {
      Object.values(this._subSeries[ind.id]).forEach(s => {
        try { this._subChart?.removeSeries(s); } catch (_) {}
      });
    }
    this._subSeries[ind.id] = {};

    const addLine = (data, color, lineWidth = 1, extra = {}) => {
      const s = this.mainChart.addLineSeries({
        color, lineWidth,
        priceLineVisible:       false,
        lastValueVisible:       true,
        crosshairMarkerVisible: false,
        ...extra,
      });
      s.setData(data);
      ind.series.push(s);
      return s;
    };

    switch (ind.type) {
      case 'sma': {
        const p = ind.params.period || 20;
        addLine(this._toTimedData(times, Calc.sma(closes, p)), ind.color, 1.5);
        ind.label = `SMA(${p})`;
        break;
      }
      case 'ema': {
        const p = ind.params.period || 21;
        addLine(this._toTimedData(times, Calc.ema(closes, p)), ind.color, 1.5);
        ind.label = `EMA(${p})`;
        break;
      }
      case 'bb': {
        const p   = ind.params.period || 20;
        const std = ind.params.stddev || 2;
        const mid = Calc.sma(closes, p);
        const dev = Calc.stddev(closes, p, mid);
        addLine(this._toTimedData(times, mid.map((m, i) => m !== null ? m + std * dev[i] : null)), ind.color, 1);
        addLine(this._toTimedData(times, mid), ind.color, 1);
        addLine(this._toTimedData(times, mid.map((m, i) => m !== null ? m - std * dev[i] : null)), ind.color, 1);
        ind.label = `BB(${p},${std})`;
        break;
      }
      case 'vwap': {
        addLine(this._toTimedData(times, Calc.vwap(c)), ind.color, 1.5);
        ind.label = 'VWAP';
        break;
      }
      case 'rsi': {
        const p = ind.params.period || 14;
        this._ensureSubChart();
        const rsiS = this._subChart.addLineSeries({ color: ind.color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
        const obS  = this._subChart.addLineSeries({ color: 'rgba(255,69,96,0.4)',  lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        const osS  = this._subChart.addLineSeries({ color: 'rgba(0,201,122,0.4)',  lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        rsiS.setData(this._toTimedData(times, Calc.rsi(closes, p)));
        obS.setData(times.map(t => ({ time: t, value: 70 })));
        osS.setData(times.map(t => ({ time: t, value: 30 })));
        this._subSeries[ind.id] = { rsi: rsiS, ob: obS, os: osS };
        ind.label = `RSI(${p})`;
        break;
      }
      case 'macd': {
        const f = ind.params.fast   || 12;
        const s = ind.params.slow   || 26;
        const g = ind.params.signal || 9;
        const { macd, signal, hist } = Calc.macd(closes, f, s, g);
        this._ensureSubChart();
        const mL = this._subChart.addLineSeries({ color: ind.color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
        const sL = this._subChart.addLineSeries({ color: '#f6c90e', lineWidth: 1,   priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        const hS = this._subChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
        mL.setData(this._toTimedData(times, macd));
        sL.setData(this._toTimedData(times, signal));
        hS.setData(hist.map((v, i) => v !== null
          ? { time: times[i], value: v, color: v >= 0 ? '#26a69a88' : '#ef535088' }
          : null).filter(Boolean));
        this._subSeries[ind.id] = { macd: mL, signal: sL, hist: hS };
        ind.label = `MACD(${f},${s},${g})`;
        break;
      }
    }
  }

  _makeLabel(type, params) {
    switch (type) {
      case 'sma':  return `SMA(${params.period || 20})`;
      case 'ema':  return `EMA(${params.period || 21})`;
      case 'bb':   return `BB(${params.period || 20},${params.stddev || 2})`;
      case 'vwap': return 'VWAP';
      case 'rsi':  return `RSI(${params.period || 14})`;
      case 'macd': return `MACD(${params.fast || 12},${params.slow || 26},${params.signal || 9})`;
      default:     return type.toUpperCase();
    }
  }

  // ── Persistence ───────────────────────────────────────────────────────────
  _key() { return `kofifx_indicators_${this.paneEl.dataset.paneId || '0'}`; }

  _saveState() {
    try {
      localStorage.setItem(this._key(), JSON.stringify(
        this._active.map(a => ({ type: a.type, params: a.params, color: a.color, visible: a.visible }))
      ));
    } catch (_) {}
  }

  _restoreState() {
    try {
      const raw = localStorage.getItem(this._key());
      if (!raw) return;
      JSON.parse(raw).forEach(({ type, params, color, visible }) =>
        this.add(type, params, color, visible !== false));
    } catch (_) {}
  }
}

// ── SVG helpers ───────────────────────────────────────────────────────────────
function _eyeSvg() {
  return `<svg viewBox="0 0 16 16" fill="none" width="12" height="12">
    <ellipse cx="8" cy="8" rx="6" ry="4" stroke="currentColor" stroke-width="1.4"/>
    <circle cx="8" cy="8" r="1.8" fill="currentColor"/>
  </svg>`;
}
function _eyeOffSvg() {
  return `<svg viewBox="0 0 16 16" fill="none" width="12" height="12">
    <ellipse cx="8" cy="8" rx="6" ry="4" stroke="currentColor" stroke-width="1.4" opacity="0.4"/>
    <line x1="3" y1="3" x2="13" y2="13" stroke="currentColor" stroke-width="1.4"/>
  </svg>`;
}
function _gearSvg() {
  return `<svg viewBox="0 0 16 16" fill="none" width="11" height="11">
    <circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.3"/>
    <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.1 3.1l1.1 1.1M11.8 11.8l1.1 1.1M11.8 4.2l1.1-1.1M3.1 12.9l1.1-1.1"
          stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
  </svg>`;
}
