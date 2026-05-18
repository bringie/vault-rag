'use strict';
// vt-0369 Pixel-Office canvas SPA module.
//
// Phase a (vt-0379): responsive canvas that fills the panel like the
// terminal viewer + ¾-isometric projection + iso-drawn primitives. The
// 960×540 hardcoded canvas is gone — JS reads clientWidth/Height every
// frame so resizing the browser, switching themes, or any future layout
// change Just Works. Cubicles laid out on an iso tile grid.
//
// Later phases (vt-0381+): atlas-driven sprites, walking AI, dispatch
// choreography.
//
// Existing contract preserved: window.openPixelOfficeView/closePixelOfficeView,
// 5 s poll with AbortController + visibilitychange + in-flight guard.
(function () {
  function token() { return localStorage.fleetToken || ''; }
  async function api(path, { signal } = {}) {
    const r = await fetch('/fleet' + path, {
      headers: { authorization: `Bearer ${token()}` },
      signal,
    });
    if (!r.ok) throw new Error(`${r.status}: ${path}`);
    return r.json();
  }
  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  // --- Layout constants ---------------------------------------------------
  // ¾-iso (dimetric) tile dims: 2:1 ratio, classic SNES office angle.
  const TILE_W = 64;
  const TILE_H = 32;
  // Cubicle footprint in tile coords (2×2 + walkway).
  const CUBICLE_TW = 3;
  const CUBICLE_TH = 3;
  // Avatar block-sprite size (still primitives in phase a).
  const AV_W = 18;
  const AV_H = 28;

  // --- Module state -------------------------------------------------------
  let _canvas = null;        // <canvas>
  let _ctx = null;           // 2d context
  let _wrap = null;          // .pixel-office-wrap
  let _w = 0, _h = 0;        // current canvas backing-store size (CSS px)
  let _dpr = 1;
  let _running = false;
  let _pollTimer = null;
  let _rafId = null;
  let _resizeObs = null;
  let _hosts = [];
  let _runningById = {};
  let _animState = {};       // host_id → { emoji?, emojiUntil? }
  let _inFlight = false;
  let _pollAbort = null;
  let _lastSuccess = 0;
  let _visHandler = null;
  // Cached layout (recomputed on resize / host-count change).
  let _layout = null;
  const NOW = () => performance.now();

  // -------------------------------------------------------------------------

  async function openPixelOfficeView() {
    document.getElementById('pixelofficeview-close').onclick = closePixelOfficeView;
    _canvas = document.getElementById('po-canvas');
    _wrap = document.querySelector('.pixel-office-wrap');
    if (!_canvas || !_wrap) return;
    resizeCanvas();

    _canvas.onclick = (ev) => {
      const { host, bubbleX, bubbleY } = hitForEvent(ev);
      if (host) openPromptBubble(host, bubbleX, bubbleY);
    };
    _canvas.oncontextmenu = (ev) => {
      const { host, bubbleX, bubbleY } = hitForEvent(ev);
      if (host) { ev.preventDefault(); openRolePickerBubble(host, bubbleX, bubbleY); }
    };

    // ResizeObserver re-paints when the panel changes size (theme switch,
    // window resize, dev-tools opening, etc).
    if (window.ResizeObserver) {
      _resizeObs = new ResizeObserver(() => { resizeCanvas(); render(); });
      _resizeObs.observe(_wrap);
    } else {
      window.addEventListener('resize', resizeCanvas);
    }

    updateStatus('— loading —');
    await refreshState();

    startPolling();
    _running = true;
    const tick = () => {
      if (!_running) return;
      if (!document.hidden) render();
      _rafId = requestAnimationFrame(tick);
    };
    _rafId = requestAnimationFrame(tick);

    _visHandler = () => {
      if (document.hidden) stopPolling();
      else if (_running && !_pollTimer) { startPolling(); refreshState(); }
    };
    document.addEventListener('visibilitychange', _visHandler);
  }

  function closePixelOfficeView() {
    _running = false;
    stopPolling();
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_visHandler) {
      document.removeEventListener('visibilitychange', _visHandler);
      _visHandler = null;
    }
    if (_resizeObs) { _resizeObs.disconnect(); _resizeObs = null; }
    else window.removeEventListener('resize', resizeCanvas);
    location.hash = '#/dashboard';
  }

  function startPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => refreshState(), 5000);
  }
  function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    if (_pollAbort) { try { _pollAbort.abort(); } catch {} _pollAbort = null; }
  }

  function resizeCanvas() {
    if (!_canvas || !_wrap) return;
    _dpr = window.devicePixelRatio || 1;
    const cssW = _wrap.clientWidth || 960;
    const cssH = _wrap.clientHeight || 540;
    _canvas.width  = Math.floor(cssW * _dpr);
    _canvas.height = Math.floor(cssH * _dpr);
    _ctx = _canvas.getContext('2d');
    _ctx.imageSmoothingEnabled = false;
    _ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
    _w = cssW; _h = cssH;
    _layout = null;  // invalidated — rebuilt on next render
  }

  function updateStatus(text) {
    const el = document.getElementById('pixel-office-status');
    if (el) el.textContent = text;
  }

  async function refreshState() {
    if (_inFlight) return;
    _inFlight = true;
    _pollAbort = new AbortController();
    const { signal } = _pollAbort;
    try {
      const [hosts, sessions] = await Promise.all([
        api('/hosts', { signal }),
        api('/sessions?status=running', { signal }),
      ]);
      _hosts = hosts.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      const liveIds = new Set(_hosts.map(h => h.id));
      const newRunning = {};
      for (const s of sessions) {
        newRunning[s.host_id] = (newRunning[s.host_id] || 0) + 1;
      }
      const now = NOW();
      for (const h of _hosts) {
        const prev = _runningById[h.id] || 0;
        const cur  = newRunning[h.id] || 0;
        const st = _animState[h.id] || (_animState[h.id] = { startedAt: now });
        if (prev === 0 && cur > 0) { st.emoji = '💭'; st.emojiUntil = now + 4000; }
        else if (prev > 0 && cur === 0) { st.emoji = '✅'; st.emojiUntil = now + 4000; }
      }
      for (const id of Object.keys(_animState)) {
        if (!liveIds.has(id)) delete _animState[id];
      }
      _runningById = newRunning;
      _lastSuccess = now;
      _layout = null;  // host-count may have changed → re-layout
      const online = _hosts.filter(h => h.status === 'online').length;
      const working = _hosts.filter(h => (_runningById[h.id] || 0) > 0).length;
      updateStatus(`${_hosts.length} hosts · ${online} online · ${working} working`);
    } catch (e) {
      if (e.name === 'AbortError') return;
      const ageS = _lastSuccess ? Math.round((NOW() - _lastSuccess) / 1000) : -1;
      updateStatus(ageS >= 0
        ? `(stale · last update ${ageS}s ago) ${e.message}`
        : `(poll error) ${e.message}`);
    } finally {
      _inFlight = false;
      _pollAbort = null;
    }
  }

  // --- Iso projection -----------------------------------------------------

  // Tile coords (tx, ty) → screen coords. Origin at canvas top-center +
  // an offset so the floor sits nicely under the header band.
  function isoToScreen(tx, ty) {
    const ox = _w / 2;
    const oy = 72;  // header band below status line
    return {
      x: ox + (tx - ty) * (TILE_W / 2),
      y: oy + (tx + ty) * (TILE_H / 2),
    };
  }

  // --- Layout (cubicle grid) ----------------------------------------------

  // Compute a square-ish tile grid sized to fit the current canvas.
  // Each cubicle is 3×3 tiles (desk + chair + walkway). We want host count
  // to fit on screen — so cubiclesPerRow scales with canvas width.
  function computeLayout() {
    const n = Math.max(_hosts.length, 1);
    // Diamond projection width per cubicle: cubicle is 3 tiles wide,
    // iso-projected horizontal span ≈ CUBICLE_TW * TILE_W. Add 1 tile gap.
    const cubScreenW = (CUBICLE_TW + 1) * TILE_W;
    const cubScreenH = (CUBICLE_TH + 1) * TILE_H;
    // How many fit horizontally? Use canvas width with margin.
    const perRow = Math.max(2, Math.min(8,
      Math.floor((_w - 80) / cubScreenW)));
    const rows = Math.ceil(n / perRow);
    // Build a list of cubicle tile-origin (tx, ty) per host index.
    const cubicles = [];
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      // Stagger rows so iso projection lays them in a grid (not a diamond).
      // Each row drops by CUBICLE_TH tiles in BOTH tx and ty so the rows
      // visually march down-right.
      const tx = col * CUBICLE_TW + row * CUBICLE_TH;
      const ty = col * CUBICLE_TW - row * 0;  // keep ty aligned per col for now
      cubicles.push({ tx, ty });
    }
    return { cubicles, perRow, rows, cubScreenW, cubScreenH };
  }

  // Avatar screen position for host index i.
  function avatarPos(i) {
    if (!_layout) _layout = computeLayout();
    const c = _layout.cubicles[i];
    // Place avatar 1 tile in from the cubicle corner (the "chair" spot).
    return isoToScreen(c.tx + 1, c.ty + 1);
  }

  // --- Drawing ------------------------------------------------------------

  function hash32(s) {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }
  function paletteFor(hostId) {
    const h = hash32(hostId);
    const hats   = ['#e74c3c','#f39c12','#27ae60','#2980b9','#8e44ad','#d35400','#16a085','#c0392b','#7f8c8d','#34495e'];
    const shirts = ['#3498db','#2ecc71','#e67e22','#9b59b6','#1abc9c','#e91e63','#ff5722','#607d8b','#795548','#009688'];
    const skins  = ['#fce4c4','#f1c27d','#e0ac69','#c68642','#8d5524'];
    return {
      hat:    hats   [(h >>>  0) % hats.length],
      shirt:  shirts [(h >>>  4) % shirts.length],
      skin:   skins  [(h >>>  8) % skins.length],
      hasHat: ((h >>> 16) & 0x07) > 1,
    };
  }

  // Draw a single iso floor tile (diamond) at tile coords.
  function drawFloorTile(ctx, tx, ty, fill) {
    const { x, y } = isoToScreen(tx, ty);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(x,            y);
    ctx.lineTo(x + TILE_W/2, y + TILE_H/2);
    ctx.lineTo(x,            y + TILE_H);
    ctx.lineTo(x - TILE_W/2, y + TILE_H/2);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Draw an iso desk + monitor on the tile (tx, ty). working=true lights the screen.
  function drawDesk(ctx, tx, ty, working) {
    const { x, y } = isoToScreen(tx, ty);
    // Desk top (diamond).
    ctx.fillStyle = '#5a3a1d';
    ctx.beginPath();
    ctx.moveTo(x,             y - 6);
    ctx.lineTo(x + TILE_W/2,  y - 6 + TILE_H/2);
    ctx.lineTo(x,             y - 6 + TILE_H);
    ctx.lineTo(x - TILE_W/2,  y - 6 + TILE_H/2);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 1; ctx.stroke();
    // Front face (gives 3D feel).
    ctx.fillStyle = '#3e2614';
    ctx.beginPath();
    ctx.moveTo(x + TILE_W/2,  y - 6 + TILE_H/2);
    ctx.lineTo(x + TILE_W/2,  y + TILE_H/2);
    ctx.lineTo(x,             y + TILE_H);
    ctx.lineTo(x,             y - 6 + TILE_H);
    ctx.closePath();
    ctx.fill();
    // Monitor.
    const mx = x - 8, my = y - 24;
    ctx.fillStyle = '#1a1a1f';
    ctx.fillRect(mx, my, 16, 12);
    ctx.fillStyle = working ? '#3affb0' : '#0a1a18';
    ctx.fillRect(mx + 2, my + 2, 12, 8);
    // Stand.
    ctx.fillStyle = '#222';
    ctx.fillRect(mx + 6, my + 12, 4, 3);
  }

  // Iso-draw the avatar block. (tx, ty) is the chair tile; we offset the
  // block up so the feet land on the tile center.
  function drawAvatar(ctx, sx, sy, palette, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    const x = Math.round(sx - AV_W / 2);
    const y = Math.round(sy - AV_H);
    // Shadow.
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(sx, sy + 1, AV_W / 2, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    // Head.
    ctx.fillStyle = palette.skin;
    ctx.fillRect(x + 5, y + 0, 8, 8);
    // Eyes.
    ctx.fillStyle = '#000';
    ctx.fillRect(x + 7, y + 4, 1, 1);
    ctx.fillRect(x + 10, y + 4, 1, 1);
    // Hat.
    if (palette.hasHat) {
      ctx.fillStyle = palette.hat;
      ctx.fillRect(x + 4, y - 2, 10, 3);
      ctx.fillRect(x + 6, y - 4, 6, 2);
    }
    // Torso.
    ctx.fillStyle = palette.shirt;
    ctx.fillRect(x + 3, y + 8, 12, 12);
    // Arms.
    ctx.fillRect(x + 1, y + 9, 2, 8);
    ctx.fillRect(x + 15, y + 9, 2, 8);
    // Legs.
    ctx.fillStyle = '#1a1f2c';
    ctx.fillRect(x + 5, y + 20, 3, 8);
    ctx.fillRect(x + 10, y + 20, 3, 8);
    ctx.restore();
  }

  function drawNameTag(ctx, sx, sy, name, badge, emoji) {
    ctx.fillStyle = '#c8d4e2';
    ctx.font = '10px "JetBrains Mono", "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText((name || '').slice(0, 16), sx, sy + 14);
    if (badge) {
      ctx.fillStyle = '#3affb0';
      ctx.fillText(badge, sx, sy + 26);
    }
    if (emoji) {
      ctx.font = '14px serif';
      ctx.fillText(emoji, sx, sy - AV_H - 4);
    }
    ctx.textAlign = 'left';
  }

  function drawHeaderBand(ctx) {
    ctx.fillStyle = '#0e1320';
    ctx.fillRect(0, 0, _w, 56);
    ctx.fillStyle = '#506075';
    ctx.font = '12px "JetBrains Mono", "Courier New", monospace';
    ctx.fillText('FLEET // OFFICE', 16, 22);
    ctx.font = '10px "JetBrains Mono", "Courier New", monospace';
    ctx.fillText('left-click → prompt · right-click → roles · brighter = working · dim = offline',
      16, 40);
  }

  function drawEmptyState(ctx) {
    ctx.fillStyle = '#8ab4f8';
    ctx.font = 'bold 22px "JetBrains Mono", "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('no hosts registered', _w / 2, _h / 2 - 12);
    ctx.fillStyle = '#506075';
    ctx.font = '13px "JetBrains Mono", "Courier New", monospace';
    ctx.fillText('install agent-fleet daemon on a host to populate the office',
      _w / 2, _h / 2 + 16);
    ctx.textAlign = 'left';
  }

  function render() {
    if (!_ctx || !_w || !_h) return;
    const ctx = _ctx;
    const now = NOW();

    // Floor wash.
    ctx.fillStyle = '#1a1f2c';
    ctx.fillRect(0, 0, _w, _h);

    if (!_hosts.length) {
      drawHeaderBand(ctx);
      drawEmptyState(ctx);
      return;
    }

    if (!_layout) _layout = computeLayout();

    // Draw floor for the bounding region.
    const { perRow, rows } = _layout;
    const maxCol = perRow * CUBICLE_TW + rows * CUBICLE_TH + 2;
    const maxRow = perRow * CUBICLE_TW + rows * CUBICLE_TH + 2;
    for (let tx = -1; tx < maxCol; tx++) {
      for (let ty = -1; ty < maxRow; ty++) {
        // Alternate tile shades for a checker hint.
        const fill = ((tx + ty) & 1) ? '#252b3a' : '#2a3144';
        const { x, y } = isoToScreen(tx, ty);
        // Cull tiles outside the visible viewport (cheap).
        if (x < -TILE_W || x > _w + TILE_W || y < -TILE_H || y > _h + TILE_H) continue;
        drawFloorTile(ctx, tx, ty, fill);
      }
    }

    // Build a draw list of (host index, screen-y) for y-sort so avatars in
    // back rows draw behind desks in front rows.
    const drawList = _hosts.map((h, i) => {
      const cub = _layout.cubicles[i];
      const dt = isoToScreen(cub.tx + 1, cub.ty + 1);
      return { i, h, dt };
    }).sort((a, b) => a.dt.y - b.dt.y);

    for (const { i, h, dt } of drawList) {
      const cub = _layout.cubicles[i];
      const running = _runningById[h.id] || 0;
      const isOnline = h.status === 'online';
      const isWorking = isOnline && running > 0;

      // Desk on (tx, ty); chair/avatar one tile in.
      drawDesk(ctx, cub.tx, cub.ty, isWorking);

      // Idle bob: small ±1 px y offset, per-host phase so they're not synced.
      const phase = (hash32(h.id) % 1000) / 1000;
      let dy = 0;
      if (isOnline) {
        if (isWorking) dy = Math.round(Math.sin(now / 90 + phase * 6.28) * 1.2);
        else dy = Math.round(Math.sin(now / 700 + phase * 6.28));
      }
      const palette = paletteFor(h.id);
      drawAvatar(ctx, dt.x, dt.y + dy, palette, isOnline ? 1.0 : 0.35);

      // Status emoji bubble.
      const st = _animState[h.id];
      let emoji = null;
      if (st && st.emoji && st.emojiUntil > now) emoji = st.emoji;
      else if (isWorking && running >= 3) emoji = '🔥';
      const badge = isWorking ? `${running} session${running > 1 ? 's' : ''}` : '';
      drawNameTag(ctx, dt.x, dt.y + 4, h.display_name || h.name, badge, emoji);
    }

    drawHeaderBand(ctx);

    // "All offline" strip below the header.
    const online = _hosts.filter(h => h.status === 'online').length;
    if (online === 0) {
      ctx.fillStyle = '#f6a96a';
      ctx.font = 'bold 14px "JetBrains Mono", "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`all ${_hosts.length} host(s) offline — avatars greyed out`,
        _w / 2, 72);
      ctx.textAlign = 'left';
    }
  }

  // --- Click hit-test -----------------------------------------------------

  function hitForEvent(ev) {
    const rect = _canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * (_w / rect.width);
    const y = (ev.clientY - rect.top)  * (_h / rect.height);
    return { host: hostAt(x, y), bubbleX: ev.clientX - rect.left, bubbleY: ev.clientY - rect.top };
  }

  function hostAt(x, y) {
    if (!_layout) _layout = computeLayout();
    // Hit test: distance from cursor to avatar foot-point.
    for (let i = 0; i < _hosts.length; i++) {
      const cub = _layout.cubicles[i];
      const dt = isoToScreen(cub.tx + 1, cub.ty + 1);
      const dx = x - dt.x;
      const dy = y - dt.y;
      // Generous oval hitbox covering avatar + name tag.
      if (Math.abs(dx) < AV_W && (dy < 4 && dy > -AV_H - 8)) return _hosts[i];
      // Also accept clicks on the name tag below.
      if (Math.abs(dx) < 60 && dy > 0 && dy < 32) return _hosts[i];
    }
    return null;
  }

  // --- Prompt bubble + role picker (unchanged from prior phases) ----------

  function openPromptBubble(host, anchorX, anchorY) {
    const overlay = document.getElementById('po-overlay');
    if (!overlay) return;
    overlay.innerHTML = '';
    const bubble = document.createElement('div');
    bubble.className = 'po-bubble';
    bubble.style.left = `${Math.min(anchorX + 12, _w - 280)}px`;
    bubble.style.top  = `${Math.min(anchorY + 12, _h - 200)}px`;
    bubble.innerHTML = `
      <div style="display:flex;align-items:center;gap:.5em;margin-bottom:.4em">
        <strong>${esc(host.display_name || host.name)}</strong>
        <span style="flex:1"></span>
        <button class="btn-ghost" data-po-close style="font-size:11px">×</button>
      </div>
      <div style="color:var(--text-dim);font-size:11px;margin-bottom:.4em">
        ${host.status === 'online' ? 'send a one-shot prompt → claude --print on this host' : '<span style="color:var(--danger)">host offline</span>'}
      </div>
      <textarea id="po-prompt" rows="4" style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--line);padding:.4em;font:12px monospace" placeholder="ask something…" ${host.status === 'online' ? '' : 'disabled'}></textarea>
      <div style="display:flex;gap:.5em;margin-top:.4em;align-items:center">
        <button class="btn-ghost" data-po-send ${host.status === 'online' ? '' : 'disabled'}>send</button>
        <span id="po-status" style="font-size:11px;color:var(--text-dim);flex:1"></span>
      </div>
      <pre id="po-result" style="margin-top:.6em;max-height:160px;overflow:auto;background:var(--bg);padding:.4em;border:1px solid var(--line);font:11px monospace;color:var(--text);display:none;white-space:pre-wrap"></pre>
    `;
    overlay.appendChild(bubble);
    bubble.querySelector('[data-po-close]').onclick = () => { overlay.innerHTML = ''; };
    const sendBtn = bubble.querySelector('[data-po-send]');
    const statusEl = bubble.querySelector('#po-status');
    const resultEl = bubble.querySelector('#po-result');
    const promptEl = bubble.querySelector('#po-prompt');
    if (promptEl && !promptEl.disabled) setTimeout(() => promptEl.focus(), 0);
    if (sendBtn) sendBtn.onclick = async () => {
      const prompt = promptEl.value.trim();
      if (!prompt) { statusEl.textContent = 'prompt required'; return; }
      sendBtn.disabled = true;
      statusEl.textContent = 'sending…';
      resultEl.style.display = 'none';
      try {
        const r = await fetch('/fleet/exec', {
          method: 'POST',
          headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
          body: JSON.stringify({ host_id: host.id, prompt }),
        });
        if (!r.ok) {
          let msg = `${r.status}`;
          try { const j = await r.json(); msg += ' ' + (j.error || ''); } catch {}
          throw new Error(msg);
        }
        const j = await r.json();
        const out = (j.output || '(no output)').slice(0, 6000);
        const exitCode = (j.exit_code == null) ? '?' : Number(j.exit_code);
        statusEl.textContent = '';
        statusEl.appendChild(document.createTextNode(`done · exit=${exitCode}`));
        if (j.session_id && /^[0-9a-f-]{36}$/i.test(j.session_id)) {
          statusEl.appendChild(document.createTextNode(' · '));
          const a = document.createElement('a');
          a.href = `#/sessions/${j.session_id}`;
          a.textContent = 'full session';
          a.style.color = 'var(--accent)';
          statusEl.appendChild(a);
        }
        const retry = r.headers.get('retry-after');
        if (r.status === 429 && retry) {
          statusEl.appendChild(document.createTextNode(` (retry in ${retry}s)`));
        }
        resultEl.textContent = out;
        resultEl.style.display = 'block';
      } catch (e) {
        statusEl.textContent = `error: ${e.message}`;
      } finally {
        sendBtn.disabled = false;
      }
    };
  }

  async function openRolePickerBubble(host, anchorX, anchorY) {
    const overlay = document.getElementById('po-overlay');
    if (!overlay) return;
    overlay.innerHTML = '';
    const bubble = document.createElement('div');
    bubble.className = 'po-bubble';
    bubble.style.left = `${Math.min(anchorX + 12, _w - 320)}px`;
    bubble.style.top  = `${Math.min(anchorY + 12, _h - 280)}px`;
    bubble.innerHTML = `
      <div style="display:flex;align-items:center;gap:.5em;margin-bottom:.4em">
        <strong>${esc(host.display_name || host.name)}</strong>
        <span style="flex:1"></span>
        <span style="font-size:11px;color:var(--text-dim)">roles</span>
        <button class="btn-ghost" data-po-close style="font-size:11px">×</button>
      </div>
      <div id="po-roles-body" style="font-size:11px;color:var(--text-dim)">loading…</div>
      <div style="margin-top:.4em;font-size:10px;color:var(--text-faint)">
        Group roles override host roles at spawn.
      </div>
    `;
    overlay.appendChild(bubble);
    bubble.querySelector('[data-po-close]').onclick = () => { overlay.innerHTML = ''; };
    await renderRolePickerBody(host, bubble);
  }

  async function renderRolePickerBody(host, bubble) {
    const body = bubble.querySelector('#po-roles-body');
    try {
      let all = bubble._cachedAllRoles;
      const allPromise = all ? Promise.resolve(all) : api('/agent-roles');
      const [allFresh, assigned, effective] = await Promise.all([
        allPromise,
        api(`/hosts/${host.id}/roles`),
        api(`/hosts/${host.id}/roles/effective`),
      ]);
      bubble._cachedAllRoles = all = allFresh;
      const assignedIds = new Set((assigned || []).map(r => r.id));
      const effectiveIds = new Set((effective || []).map(r => r.id));
      const groupOverrides = effective.length && assigned.length && (effective[0].id !== (assigned[0] && assigned[0].id));
      const rows = (all || []).map(r => {
        const checked = assignedIds.has(r.id) ? 'checked' : '';
        const eff = effectiveIds.has(r.id);
        const effLabel = eff ? '<span title="will be applied at spawn" style="color:#3affb0">●</span>' : '<span style="color:#506075">○</span>';
        return `<label style="display:flex;align-items:center;gap:.5em;padding:.25em 0;cursor:pointer">
          <input type="checkbox" data-po-role="${esc(r.id)}" ${checked}>
          <span>${esc(r.name)}</span>
          <span style="flex:1"></span>
          ${effLabel}
        </label>`;
      }).join('');
      body.innerHTML = `
        <div style="max-height:220px;overflow:auto">${rows || '<em>(no roles defined — create some in /agent-roles)</em>'}</div>
        ${groupOverrides ? '<div style="margin-top:.4em;color:var(--accent);font-size:10px">group roles currently override this host\'s assignment</div>' : ''}
      `;
      body.querySelectorAll('[data-po-role]').forEach(cb => {
        cb.onchange = async () => {
          const roleId = cb.dataset.poRole;
          cb.disabled = true;
          try {
            if (cb.checked) {
              const r = await fetch(`/fleet/hosts/${host.id}/roles`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
                body: JSON.stringify({ role_id: roleId }),
              });
              if (!r.ok) {
                let msg = `${r.status}`;
                try { const j = await r.json(); msg += ' ' + (j.error || ''); } catch {}
                throw new Error(msg);
              }
            } else {
              const r = await fetch(`/fleet/hosts/${host.id}/roles/${roleId}`, {
                method: 'DELETE',
                headers: { authorization: `Bearer ${token()}` },
              });
              if (!r.ok && r.status !== 204) throw new Error(`${r.status}`);
            }
            await renderRolePickerBody(host, bubble);
          } catch (e) {
            cb.checked = !cb.checked;
            alert('role change failed: ' + e.message);
          } finally {
            cb.disabled = false;
          }
        };
      });
    } catch (e) {
      body.innerHTML = `<span style="color:var(--danger)">error: ${esc(e.message)}</span>`;
    }
  }

  window.openPixelOfficeView = openPixelOfficeView;
  window.closePixelOfficeView = closePixelOfficeView;
})();
