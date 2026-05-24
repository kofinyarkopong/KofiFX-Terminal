/**
 * KofiFX Terminal — DrawingManager  (v2)
 * ========================================
 * Canvas-based drawing tools that overlay the LWC chart.
 *
 * Tools:
 *   select    — default (chart pan/scroll enabled)
 *   hline     — horizontal price level line (click)
 *   trendline — diagonal line (click + drag)
 *   rect      — price / time box (click + drag)
 *   longpos   — long position (click + drag, 2:1 R:R)
 *   shortpos  — short position (click + drag, 2:1 R:R)
 *   eraser    — click drawing to delete
 *
 * v2 additions:
 *   • Per-tool style panel (colour picker + line width) — appears in pane toolbar
 *     when a drawing tool is active
 *   • Right-click on any drawing — context popup with colour / width edit + delete
 *   • All per-tool styles saved to localStorage
 */

class DrawingManager {
  static TOOLS = ['select','hline','trendline','rect','longpos','shortpos','eraser'];

  // Default styles per tool
  static DEFAULT_STYLES = {
    hline:     { color: '#00d4aa', lineWidth: 1   },
    trendline: { color: '#00d4aa', lineWidth: 1.5 },
    rect:      { color: '#00d4aa', lineWidth: 1   },
    longpos:   { color: '#26a69a', lineWidth: 1.5 },
    shortpos:  { color: '#ef5350', lineWidth: 1.5 },
    eraser:    { color: '#7a8499', lineWidth: 1   },
  };

  constructor(chartContainer, chart, series) {
    this.container  = chartContainer;
    this.chart      = chart;
    this.series     = series;

    this.mode       = 'select';
    this.symbol     = '';
    this.timeframe  = '';

    this._drawings  = [];
    this._preview   = null;
    this._dragging  = false;
    this._startPt   = null;

    this._canvas    = null;
    this._ctx       = null;
    this._animId    = null;

    // Per-tool style settings (persisted)
    this._toolStyles = this._loadStyles();

    this._setup();
    this._createStylePanel();
  }

  // ── Setup ─────────────────────────────────────────────────────────────────
  _setup() {
    this._createCanvas();
    this._bindEvents();
    this.chart.timeScale().subscribeVisibleTimeRangeChange(() => this._scheduleDraw());
    this.chart.subscribeCrosshairMove(() => this._scheduleDraw());
    new ResizeObserver(() => { this._resizeCanvas(); this._scheduleDraw(); }).observe(this.container);
  }

  _createCanvas() {
    this._canvas = document.createElement('canvas');
    Object.assign(this._canvas.style, {
      position:      'absolute',
      inset:         '0',
      zIndex:        '8',
      pointerEvents: 'none',
      cursor:        'default',
    });
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

  // ── Style panel (per-tool colour + width) ─────────────────────────────────
  _createStylePanel() {
    this._stylePanel = document.createElement('div');
    this._stylePanel.className = 'draw-style-panel hidden';

    // Find the pane root (chart-container → chart-pane)
    const pane = this.container.closest('.chart-pane');
    if (pane) {
      const toolbar = pane.querySelector('.pane-toolbar');
      if (toolbar) toolbar.parentNode.insertBefore(this._stylePanel, toolbar.nextSibling);
      else pane.insertBefore(this._stylePanel, pane.firstChild);
    }
  }

  _updateStylePanel() {
    if (!this._stylePanel) return;
    const isDrawingTool = this.mode !== 'select' && this.mode !== 'eraser';
    if (!isDrawingTool) {
      this._stylePanel.classList.add('hidden');
      return;
    }
    this._stylePanel.classList.remove('hidden');
    const style = this._toolStyles[this.mode] || DrawingManager.DEFAULT_STYLES[this.mode] || {};

    this._stylePanel.innerHTML = `
      <span class="draw-style-label">${this.mode}</span>
      <label class="draw-style-row" title="Line colour">
        <input type="color" class="draw-style-color" value="${style.color || '#00d4aa'}"/>
      </label>
      <label class="draw-style-row" title="Line width">
        <span class="draw-style-w-label">W</span>
        <div class="draw-style-widths">
          ${[1, 2, 3].map(w => `
            <button class="draw-style-w-btn ${(style.lineWidth || 1) >= w && (style.lineWidth || 1) < w + 1 ? 'active' : ''}"
                    data-w="${w}">${w}</button>`).join('')}
        </div>
      </label>`;

    // Colour change
    const colorInp = this._stylePanel.querySelector('.draw-style-color');
    colorInp.addEventListener('input', () => {
      this._toolStyles[this.mode] = { ...this._toolStyles[this.mode], color: colorInp.value };
      this._saveStyles();
      this._scheduleDraw();
    });

    // Width buttons
    this._stylePanel.querySelectorAll('.draw-style-w-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const w = parseFloat(btn.dataset.w);
        this._toolStyles[this.mode] = { ...this._toolStyles[this.mode], lineWidth: w };
        this._saveStyles();
        this._stylePanel.querySelectorAll('.draw-style-w-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._scheduleDraw();
      });
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  setMode(mode) {
    this.mode = mode;
    const isDrawing = mode !== 'select';
    this._canvas.style.pointerEvents = isDrawing ? 'all' : 'none';
    this._canvas.style.cursor = this._cursor(mode);

    try {
      this.chart.applyOptions({
        handleScroll: { mouseWheel: !isDrawing, pressedMouseMove: !isDrawing },
        handleScale:  { mouseWheel: !isDrawing, pinch: !isDrawing },
      });
    } catch (_) {}

    this._updateStylePanel();
  }

  setContext(symbol, timeframe) {
    this.symbol    = symbol;
    this.timeframe = timeframe;
    this._drawings = this._load();
    this._scheduleDraw();
  }

  clearAll() {
    this._drawings = [];
    this._save();
    this._scheduleDraw();
  }

  // Get current tool's style (with fallback to defaults)
  _currentStyle() {
    const mode    = this.mode;
    const stored  = this._toolStyles[mode] || {};
    const dflt    = DrawingManager.DEFAULT_STYLES[mode] || { color: '#00d4aa', lineWidth: 1 };
    return { ...dflt, ...stored };
  }

  // ── Mouse events ──────────────────────────────────────────────────────────
  _bindEvents() {
    this._canvas.addEventListener('mousedown',   e => this._onDown(e));
    this._canvas.addEventListener('mousemove',   e => this._onMove(e));
    this._canvas.addEventListener('mouseup',     e => this._onUp(e));
    this._canvas.addEventListener('contextmenu', e => { e.preventDefault(); this._onRightClick(e); });
    this._canvas.addEventListener('touchstart',  e => this._onDown(this._touch(e)), { passive: false });
    this._canvas.addEventListener('touchmove',   e => this._onMove(this._touch(e)), { passive: false });
    this._canvas.addEventListener('touchend',    e => this._onUp(this._touch(e)));
  }

  _touch(e) {
    e.preventDefault();
    const t = e.touches[0] || e.changedTouches[0];
    return { clientX: t.clientX, clientY: t.clientY };
  }

  _onDown(e) {
    const pt = this._toChartPt(e);
    if (!pt) return;
    if (this.mode === 'hline') {
      const s = this._currentStyle();
      this._commit({ type: 'hline', price: pt.price, color: s.color, lineWidth: s.lineWidth });
      return;
    }
    if (this.mode === 'eraser') {
      this._eraseAt(pt);
      return;
    }
    this._dragging = true;
    this._startPt  = pt;
    this._preview  = null;
  }

  _onMove(e) {
    if (!this._dragging || !this._startPt) return;
    const pt = this._toChartPt(e);
    if (!pt) return;
    this._preview = this._buildPreview(this._startPt, pt);
    this._scheduleDraw();
  }

  _onUp(e) {
    if (!this._dragging) return;
    this._dragging = false;
    const pt = this._toChartPt(e);
    if (pt && this._preview) this._commit(this._preview);
    this._preview  = null;
    this._startPt  = null;
    this._scheduleDraw();
  }

  _onRightClick(e) {
    const pt = this._toChartPt(e);
    if (!pt) return;
    const hit = this._findDrawingAt(pt);
    if (hit !== null) {
      this._showEditPopup(hit, e.clientX, e.clientY);
    } else {
      this._eraseAt(pt);
    }
  }

  // ── Context popup (right-click edit) ──────────────────────────────────────
  _showEditPopup(drawingIdx, clientX, clientY) {
    this._closeEditPopup();
    const d = this._drawings[drawingIdx];
    if (!d) return;

    const popup = document.createElement('div');
    popup.className = 'draw-edit-popup';
    popup.innerHTML = `
      <div class="draw-edit-header">${d.type.toUpperCase()}</div>
      ${d.type !== 'longpos' && d.type !== 'shortpos' ? `
      <label class="draw-edit-row">
        <span>Colour</span>
        <input type="color" class="draw-edit-color" value="${d.color || '#00d4aa'}"/>
      </label>
      <label class="draw-edit-row">
        <span>Width</span>
        <div class="draw-style-widths">
          ${[1, 2, 3].map(w => `
            <button class="draw-style-w-btn ${Math.round(d.lineWidth || 1) === w ? 'active' : ''}"
                    data-w="${w}">${w}</button>`).join('')}
        </div>
      </label>` : ''}
      <button class="draw-edit-delete">Delete</button>`;

    popup.style.position = 'fixed';
    popup.style.left = clientX + 'px';
    popup.style.top  = clientY + 'px';
    document.body.appendChild(popup);
    this._editPopup = popup;

    // Live apply colour
    const colorInp = popup.querySelector('.draw-edit-color');
    colorInp?.addEventListener('input', () => {
      d.color = colorInp.value;
      this._save();
      this._scheduleDraw();
    });

    // Width buttons
    popup.querySelectorAll('.draw-style-w-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        d.lineWidth = parseFloat(btn.dataset.w);
        this._save();
        this._scheduleDraw();
        popup.querySelectorAll('.draw-style-w-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Delete
    popup.querySelector('.draw-edit-delete').addEventListener('click', () => {
      this._drawings.splice(drawingIdx, 1);
      this._save();
      this._scheduleDraw();
      this._closeEditPopup();
    });

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', this._closeEditPopupBound = () => this._closeEditPopup(), { once: true });
    }, 100);
  }

  _closeEditPopup() {
    this._editPopup?.remove();
    this._editPopup = null;
  }

  // ── Building drawings ─────────────────────────────────────────────────────
  _buildPreview(start, end) {
    const s = this._currentStyle();
    switch (this.mode) {
      case 'trendline':
        return { type: 'trendline', p1: start, p2: end,
                 color: s.color, lineWidth: s.lineWidth };
      case 'rect':
        return { type: 'rect', p1: start, p2: end,
                 fillColor:   this._hexToRgba(s.color, 0.08),
                 borderColor: s.color,
                 lineWidth:   s.lineWidth };
      case 'longpos':
        return this._buildPos(start, end, true);
      case 'shortpos':
        return this._buildPos(start, end, false);
      default: return null;
    }
  }

  _buildPos(start, end, isLong) {
    const entry  = start.price;
    const stop   = end.price;
    const risk   = Math.abs(entry - stop);
    const target = isLong ? entry + risk * 2 : entry - risk * 2;
    const rr     = risk > 0 ? (Math.abs(target - entry) / risk).toFixed(1) : '—';
    return {
      type:   isLong ? 'longpos' : 'shortpos',
      time:   start.time,
      entry, stop, target, rr,
      color:  isLong ? '#26a69a' : '#ef5350',
    };
  }

  _commit(drawing) {
    this._drawings.push(drawing);
    this._save();
    this._scheduleDraw();
  }

  // ── Hit detection ─────────────────────────────────────────────────────────
  _findDrawingAt(pt) {
    const px = this._toPx(pt.time, pt.price);
    if (!px) return null;
    for (let i = this._drawings.length - 1; i >= 0; i--) {
      if (this._drawingDistance(this._drawings[i], px) <= 8) return i;
    }
    return null;
  }

  _eraseAt(pt) {
    const idx = this._findDrawingAt(pt);
    if (idx !== null) {
      this._drawings.splice(idx, 1);
      this._save();
      this._scheduleDraw();
    }
  }

  _drawingDistance(d, px) {
    switch (d.type) {
      case 'hline': {
        const y = this.series.priceToCoordinate(d.price);
        return y === null ? Infinity : Math.abs(px.y - y);
      }
      case 'trendline': {
        const a = this._toPx(d.p1.time, d.p1.price);
        const b = this._toPx(d.p2.time, d.p2.price);
        if (!a || !b) return Infinity;
        return this._ptLineDistance(px, a, b);
      }
      case 'rect': {
        const a = this._toPx(d.p1.time, d.p1.price);
        const b = this._toPx(d.p2.time, d.p2.price);
        if (!a || !b) return Infinity;
        const inX = px.x >= Math.min(a.x, b.x) && px.x <= Math.max(a.x, b.x);
        const inY = px.y >= Math.min(a.y, b.y) && px.y <= Math.max(a.y, b.y);
        return (inX && inY) ? 0 : Infinity;
      }
      case 'longpos':
      case 'shortpos': {
        const eY = this.series.priceToCoordinate(d.entry);
        return eY === null ? Infinity : (Math.abs(px.y - eY) < 12 ? 0 : Infinity);
      }
      default: return Infinity;
    }
  }

  _ptLineDistance(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  // ── Drawing ───────────────────────────────────────────────────────────────
  _draw() {
    const ctx = this._ctx;
    const W   = this.container.clientWidth;
    const H   = this.container.clientHeight;
    if (W <= 0 || H <= 0) return;
    ctx.clearRect(0, 0, W, H);

    const all = this._preview ? [...this._drawings, this._preview] : this._drawings;
    for (const d of all) {
      switch (d.type) {
        case 'hline':     this._drawHLine(ctx, d, W); break;
        case 'trendline': this._drawTrendLine(ctx, d); break;
        case 'rect':      this._drawRect(ctx, d); break;
        case 'longpos':
        case 'shortpos':  this._drawPosition(ctx, d, W); break;
      }
    }
  }

  _drawHLine(ctx, d, W) {
    const y = this.series.priceToCoordinate(d.price);
    if (y === null) return;
    ctx.save();
    ctx.strokeStyle = d.color || '#00d4aa';
    ctx.lineWidth   = d.lineWidth || 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle    = d.color || '#00d4aa';
    ctx.font         = '10px "JetBrains Mono", monospace';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(d.price.toFixed(5), W - 4, y - 8);
    ctx.restore();
  }

  _drawTrendLine(ctx, d) {
    const a = this._toPx(d.p1.time, d.p1.price);
    const b = this._toPx(d.p2.time, d.p2.price);
    if (!a || !b) return;
    ctx.save();
    ctx.strokeStyle = d.color   || '#00d4aa';
    ctx.lineWidth   = d.lineWidth || 1.5;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    [a, b].forEach(pt => {
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = d.color || '#00d4aa'; ctx.fill();
    });
    ctx.restore();
  }

  _drawRect(ctx, d) {
    const a = this._toPx(d.p1.time, d.p1.price);
    const b = this._toPx(d.p2.time, d.p2.price);
    if (!a || !b) return;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(a.x - b.x),  h = Math.abs(a.y - b.y);
    ctx.save();
    ctx.fillStyle   = d.fillColor   || 'rgba(0,212,170,0.08)';
    ctx.strokeStyle = d.borderColor || d.color || '#00d4aa';
    ctx.lineWidth   = d.lineWidth   || 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  _drawPosition(ctx, d, W) {
    const isLong  = d.type === 'longpos';
    const colMain = isLong ? '#26a69a' : '#ef5350';
    const eY = this.series.priceToCoordinate(d.entry);
    const sY = this.series.priceToCoordinate(d.stop);
    const tY = this.series.priceToCoordinate(d.target);
    const xL = this._toPxFromTime(d.time);
    if (eY === null || sY === null || tY === null || xL === null) return;

    ctx.save();

    // Stop zone (red fill)
    ctx.fillStyle = 'rgba(239,83,80,0.12)';
    ctx.fillRect(xL, Math.min(eY, sY), W - xL, Math.abs(eY - sY));

    // Target zone (green fill)
    ctx.fillStyle = 'rgba(38,166,154,0.12)';
    ctx.fillRect(xL, Math.min(eY, tY), W - xL, Math.abs(eY - tY));

    // Lines
    const drawLine = (y, color, dash, lw = 1) => {
      ctx.strokeStyle = color; ctx.lineWidth = lw;
      ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(xL, y); ctx.lineTo(W, y); ctx.stroke();
    };
    drawLine(eY, colMain, [],     1.5);
    drawLine(sY, '#ef5350', [4,3], 1);
    drawLine(tY, '#26a69a', [4,3], 1);
    ctx.setLineDash([]);

    // Labels
    const fmt = p => typeof p === 'number' ? p.toFixed(p > 100 ? 2 : 5) : String(p);
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';

    ctx.fillStyle = colMain;    ctx.textBaseline = 'middle';
    ctx.fillText(`${isLong ? '▲ LONG' : '▼ SHORT'}  ${fmt(d.entry)}`, xL + 4, eY - 8);
    ctx.fillStyle = '#ef5350';
    ctx.fillText(`SL  ${fmt(d.stop)}`, xL + 4, sY + (isLong ? 8 : -8));
    ctx.fillStyle = '#26a69a';
    ctx.fillText(`TP  ${fmt(d.target)}  R:R ${d.rr}`, xL + 4, tY + (isLong ? -8 : 8));

    // Entry tag
    const tagW = 52, tagH = 16;
    ctx.fillStyle = colMain;
    ctx.fillRect(xL - tagW, eY - tagH / 2, tagW, tagH);
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(isLong ? 'LONG' : 'SHORT', xL - tagW / 2, eY);

    ctx.restore();
  }

  // ── Coordinate helpers ────────────────────────────────────────────────────
  _toChartPt(e) {
    const rect  = this._canvas.getBoundingClientRect();
    const x     = e.clientX - rect.left;
    const y     = e.clientY - rect.top;
    const time  = this.chart.timeScale().coordinateToTime(x);
    const price = this.series.coordinateToPrice(y);
    if (time === null || price === null) return null;
    return { x, y, time, price };
  }

  _toPx(time, price) {
    const x = this.chart.timeScale().timeToCoordinate(time);
    const y = this.series.priceToCoordinate(price);
    if (x === null || y === null) return null;
    return { x, y };
  }

  _toPxFromTime(time) {
    return this.chart.timeScale().timeToCoordinate(time);
  }

  _cursor(mode) {
    if (mode === 'eraser') return 'not-allowed';
    if (mode === 'select') return 'default';
    return 'crosshair';
  }

  // ── Colour utility ────────────────────────────────────────────────────────
  _hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // ── Persistence ───────────────────────────────────────────────────────────
  _key()       { return `kofifx_drawings_${this.symbol}_${this.timeframe}`; }
  _stylesKey() { return `kofifx_draw_styles`; }

  _save() {
    try { localStorage.setItem(this._key(), JSON.stringify(this._drawings)); } catch (_) {}
  }
  _load() {
    try { const r = localStorage.getItem(this._key()); return r ? JSON.parse(r) : []; }
    catch (_) { return []; }
  }

  _saveStyles() {
    try { localStorage.setItem(this._stylesKey(), JSON.stringify(this._toolStyles)); } catch (_) {}
  }
  _loadStyles() {
    try {
      const r = localStorage.getItem(this._stylesKey());
      const saved = r ? JSON.parse(r) : {};
      // Merge with defaults so new tools always have a style
      const merged = {};
      for (const [k, dflt] of Object.entries(DrawingManager.DEFAULT_STYLES)) {
        merged[k] = { ...dflt, ...(saved[k] || {}) };
      }
      return merged;
    } catch (_) {
      return { ...DrawingManager.DEFAULT_STYLES };
    }
  }
}
