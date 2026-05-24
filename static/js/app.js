/**
 * KofiFX Terminal — Main Application Controller
 * ===============================================
 * Manages:
 *   • Chart count selector + grid reshuffling
 *   • ChartPane instances
 *   • Real-time feed: Socket.IO (local) or HTTP polling (Vercel serverless)
 *     Boot fetches /api/config → cfg.realtime ? initSocket() : startPolling()
 *   • localStorage persistence (count + per-pane state)
 *   • Market clock
 */

(function () {
  'use strict';

  const { symbols, timeframes, defaultSymbols } = window.KOFIFX;

  // ── State ─────────────────────────────────────────────────────────────────
  let chartCount  = parseInt(localStorage.getItem('kofifx_count') || '4', 10);
  let panes       = [];   // ChartPane[]
  let socket      = null;
  let _pollTimer  = null; // setInterval handle for HTTP polling mode

  // ── DOM ───────────────────────────────────────────────────────────────────
  const grid       = document.getElementById('chartGrid');
  const countBtns  = document.getElementById('chartCountBtns');
  const clockEl    = document.getElementById('marketClock');
  const connDot    = document.querySelector('.conn-dot');
  const connLabel  = document.getElementById('connLabel');
  const paneTpl    = document.getElementById('paneTpl');

  // ── Connection status ─────────────────────────────────────────────────────
  function setConnStatus(online, label) {
    connDot.classList.toggle('connected',    online);
    connDot.classList.toggle('disconnected', !online);
    connLabel.textContent = label ?? (online ? 'Live' : 'Offline');
  }

  // ── Socket.IO (local / dedicated server) ──────────────────────────────────
  function initSocket() {
    // Guard: if Socket.IO client script was not loaded (Vercel CDN strip), fall back.
    if (typeof io === 'undefined') {
      console.warn('[KofiFX] Socket.IO unavailable — falling back to polling.');
      startPolling(4000);
      return;
    }

    socket = io({ transports: ['websocket', 'polling'], reconnectionDelay: 2000 });

    socket.on('connect', () => {
      setConnStatus(true, 'Live');
      resubscribeAll();
    });

    socket.on('disconnect', () => setConnStatus(false, 'Offline'));

    socket.on('price_update', (snap) => {
      panes.forEach((p) => {
        if (p && p.currentSymbol === snap.symbol) p.updatePrice(snap);
      });
    });
  }

  function resubscribeAll() {
    const unique = [...new Set(panes.filter(Boolean).map((p) => p.currentSymbol))];
    unique.forEach((sym) => socket?.emit('subscribe', { symbol: sym }));
  }

  /** Call when a pane changes its symbol (no-op in polling mode). */
  function subscribeSymbol(symbol) {
    socket?.emit('subscribe', { symbol });
  }

  // ── HTTP polling (Vercel serverless) ──────────────────────────────────────
  function startPolling(intervalMs) {
    setConnStatus(true, 'Polling');
    _pollPrices();                              // immediate first fetch
    _pollTimer = setInterval(_pollPrices, intervalMs || 4000);
  }

  function _pollPrices() {
    const syms = [...new Set(panes.filter(Boolean).map((p) => p.currentSymbol))];
    if (!syms.length) return;

    fetch('/api/prices?symbols=' + syms.join(','))
      .then((r) => r.json())
      .then((data) => {
        setConnStatus(true, 'Polling');
        Object.entries(data).forEach(([symbol, snap]) => {
          panes.forEach((p) => {
            if (p && p.currentSymbol === symbol) p.updatePrice(snap);
          });
        });
      })
      .catch(() => setConnStatus(false, 'Offline'));
  }

  // ── Chart count & grid ────────────────────────────────────────────────────
  function setChartCount(n) {
    chartCount = n;
    localStorage.setItem('kofifx_count', String(n));

    // Update active button
    countBtns.querySelectorAll('.count-btn').forEach((btn) => {
      btn.classList.toggle('active', parseInt(btn.dataset.count, 10) === n);
    });

    rebuildGrid();
  }

  function rebuildGrid() {
    // Destroy existing panes
    panes.forEach((p) => p?.destroy());
    panes = [];

    // Update grid class
    grid.className = `chart-grid grid-${chartCount}`;

    // Clear DOM
    grid.innerHTML = '';

    // Determine initial symbols (cycle through defaultSymbols)
    const allDefaultSymbols = [
      'EURUSD','GBPUSD','USDJPY','XAUUSD',
      'AUDUSD','USDCAD','SP500','US100',
      'GBPJPY','USDCHF','AUDJPY','CADJPY',
      'NZDJPY','DXY','GER40','EURUSD',
    ];

    for (let i = 0; i < chartCount; i++) {
      const saved = ChartPane.loadState(i);
      const sym   = saved?.symbol     || allDefaultSymbols[i % allDefaultSymbols.length];
      const tf    = saved?.timeframe  || '1h';

      const el = paneTpl.content.cloneNode(true).querySelector('.chart-pane');
      el.dataset.paneId = String(i);
      grid.appendChild(el);

      const pane = new ChartPane(i, el, { symbols, timeframes, symbol: sym, timeframe: tf });
      panes.push(pane);
    }

    // (Re-)subscribe after a tick so panes have their symbols set
    setTimeout(resubscribeAll, 200);
  }

  // ── Market clock ──────────────────────────────────────────────────────────
  function tickClock() {
    const now = new Date();
    const hh  = String(now.getUTCHours()).padStart(2, '0');
    const mm  = String(now.getUTCMinutes()).padStart(2, '0');
    const ss  = String(now.getUTCSeconds()).padStart(2, '0');
    clockEl.textContent = `${hh}:${mm}:${ss} UTC`;
  }

  // ── Bind chart-count buttons ──────────────────────────────────────────────
  function bindCountBtns() {
    countBtns.addEventListener('click', (e) => {
      const btn = e.target.closest('.count-btn');
      if (!btn) return;
      setChartCount(parseInt(btn.dataset.count, 10));
    });
  }

  // ── Global drawing toolbar ────────────────────────────────────────────────
  window._activeDrawingMode = 'select';
  window._activePaneId      = 0;

  function bindDrawingToolbar() {
    const toolbar = document.getElementById('drawingToolbar');
    if (!toolbar) return;

    toolbar.addEventListener('click', (e) => {
      const btn  = e.target.closest('.draw-btn');
      if (!btn) return;
      const tool = btn.dataset.tool;

      if (tool === 'clear') {
        const pane = panes[window._activePaneId];
        if (pane?._drawMgr) pane._drawMgr.clearAll();
        return;
      }

      // Toggle select button
      toolbar.querySelectorAll('.draw-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      window._activeDrawingMode = tool;

      // Apply to active pane immediately
      const activePane = panes[window._activePaneId];
      if (activePane?._drawMgr) activePane._drawMgr.setMode(tool);

      // Also apply to all panes so switching pane mid-draw works
      panes.forEach(p => p?._drawMgr?.setMode(tool));
    });
  }

  // ── Global date navigator ─────────────────────────────────────────────────
  function bindGlobalDateNav() {
    const input = document.getElementById('globalDateInput');
    const goBtn = document.getElementById('globalGoBtn');
    if (!input || !goBtn) return;

    goBtn.addEventListener('click', () => {
      const val = input.value;
      if (!val) return;
      const ts = Math.floor(new Date(val).getTime() / 1000);
      if (isNaN(ts)) return;
      // Navigate all panes to this date
      panes.forEach(p => {
        if (!p?._chart) return;
        try {
          const half = p._visibleHalfRange ? p._visibleHalfRange() : 86400 * 3;
          p._chart.timeScale().setVisibleRange({ from: ts - half, to: ts + half });
        } catch (_) {}
      });
    });

    // Set today's date as default
    const today = new Date().toISOString().split('T')[0];
    input.value = today;
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function boot() {
    bindCountBtns();
    bindDrawingToolbar();
    bindGlobalDateNav();
    setChartCount(chartCount);
    setInterval(tickClock, 1000);
    tickClock();
    window._kofifxSubscribe = subscribeSymbol;

    // Ask the server which real-time mode to use, then start the feed.
    fetch('/api/config')
      .then((r) => r.json())
      .then((cfg) => {
        if (cfg.realtime) {
          initSocket();
        } else {
          startPolling(cfg.pollInterval || 4000);
        }
      })
      .catch(() => {
        // If /api/config itself fails, default to Socket.IO (local dev).
        initSocket();
      });
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
