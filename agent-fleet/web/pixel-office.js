'use strict';
// vt-0369 / vt-0371 (Phase 2): pixel-office SPA module — skeleton.
// Boot-time wiring: hash route `#/pixel-office` invokes
// window.openPixelOfficeView (set at end of IIFE).
//
// This phase ships ONLY the canvas + nav routing + feature-flag gate.
// Avatar rendering and WS state come in vt-0372 (Phase 3); click-to-prompt
// in vt-0373 (Phase 4); role picker in vt-0374; animations in vt-0375.
(function () {
  function token() { return localStorage.fleetToken || ''; }
  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  // Single canvas — caller passes #po-canvas. Coordinates are absolute
  // pixels within the canvas (no scrolling viewport for v1).
  const CANVAS_W = 960;
  const CANVAS_H = 540;

  let _state = null;          // { ctx, hosts, running, raf, dpr }
  let _running = false;       // animation loop guard

  async function openPixelOfficeView() {
    document.getElementById('pixelofficeview-close').onclick = () => location.hash = '#/dashboard';
    const canvas = document.getElementById('po-canvas');
    if (!canvas) return;

    // Crisp pixel rendering on retina: scale backing store but keep CSS px.
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = CANVAS_W * dpr;
    canvas.height = CANVAS_H * dpr;
    canvas.style.width  = `${CANVAS_W}px`;
    canvas.style.height = `${CANVAS_H}px`;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.scale(dpr, dpr);

    _state = { ctx, hosts: [], running: [], dpr };

    drawPlaceholder(ctx);
    updateStatus('— booting —');

    // Skeleton: just paint once. Phase 3 will load hosts + start the rAF loop.
    if (!_running) {
      _running = true;
      // Stub frame loop so toggling the page off stops it cleanly.
      const tick = () => {
        if (!_running) return;
        // No-op for skeleton; Phase 3 fills this in.
      };
      requestAnimationFrame(tick);
    }
  }

  function closePixelOfficeView() {
    _running = false;
    _state = null;
  }

  function updateStatus(text) {
    const el = document.getElementById('pixel-office-status');
    if (el) el.textContent = text;
  }

  function drawPlaceholder(ctx) {
    // Office floor (already CSS-bg'd to #1a1f2c). Draw a grid + a "coming
    // soon" banner so the skeleton is visibly alive.
    ctx.fillStyle = '#1a1f2c';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Faint grid (32 px tile, matching what Phase 3 will use).
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= CANVAS_W; x += 32) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke();
    }
    for (let y = 0; y <= CANVAS_H; y += 32) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke();
    }

    // Centered banner — vt-style monospace, low brightness.
    ctx.fillStyle = '#8ab4f8';
    ctx.font = 'bold 24px "JetBrains Mono", "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('PIXEL OFFICE — Phase 2 skeleton', CANVAS_W / 2, CANVAS_H / 2 - 8);
    ctx.fillStyle = '#506075';
    ctx.font = '14px "JetBrains Mono", "Courier New", monospace';
    ctx.fillText('avatars + room layout land in vt-0372', CANVAS_W / 2, CANVAS_H / 2 + 16);
    ctx.textAlign = 'left';
  }

  // Export — app.js router calls this when #/pixel-office is opened.
  window.openPixelOfficeView = openPixelOfficeView;
  window.closePixelOfficeView = closePixelOfficeView;
})();
