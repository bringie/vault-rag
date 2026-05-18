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
  // Avatar block-sprite footprint. Phase b: full pixel-art body (24×34),
  // 1px dark outline, 2-tone shading per surface, distinct head/hair/torso/
  // limbs. Detail level matches early Stardew Valley / Pokemon-Crystal NPCs.
  const AV_W = 22;
  const AV_H = 34;

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
  // vt-0381 Phase c: per-host actor state — position in fractional tile
  // coords, current target, walk phase, etc. Persists across polls so an
  // avatar mid-stroll doesn't snap back to its chair on every 5 s refresh.
  let _actors = {};          // host_id → Actor
  let _lastTickMs = 0;
  // Walk speed in tile-units / second (1 tile/s ≈ 32 px/s in screen iso).
  const WALK_SPEED = 1.4;
  const IDLE_MIN_S = 2.5;
  const IDLE_MAX_S = 7;
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
    _lastTickMs = NOW();
    const tick = () => {
      if (!_running) return;
      const now = NOW();
      const dt = Math.min(0.1, (now - _lastTickMs) / 1000);  // cap dt at 100ms
      _lastTickMs = now;
      if (!document.hidden) {
        tickActors(dt);
        render();
      }
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
      // vt-0381: reap actors for vanished hosts; new hosts get an actor
      // seeded at their chair tile when the next layout passes through.
      for (const id of Object.keys(_actors)) {
        if (!liveIds.has(id)) delete _actors[id];
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

  // Tile coords (tx, ty) → screen coords. Origin is recomputed at layout
  // time to center the office bounding-box in the canvas under the header.
  let _isoOx = 0, _isoOy = 0;
  function isoToScreen(tx, ty) {
    return {
      x: _isoOx + (tx - ty) * (TILE_W / 2),
      y: _isoOy + (tx + ty) * (TILE_H / 2),
    };
  }

  // --- Layout (cubicle grid) ----------------------------------------------

  // Compute cubicle tile-coords per host. Cubicles tile down in BOTH tx
  // and ty for new rows, so iso projection lays rows as visible horizontal
  // bands (not a single diagonal). Then derive the bounding box of the
  // whole office and re-center the iso origin so it fits under the header.
  function computeLayout() {
    const n = Math.max(_hosts.length, 1);
    // Diamond projection width per cubicle: iso span = (CUBICLE_TW+CUBICLE_TH)
    // tiles wide and tall, so each cubicle visually occupies that much.
    const cubScreenW = (CUBICLE_TW + 1) * (TILE_W / 2);
    // Cubicles per row scales with canvas width — leave 80 px margin.
    const perRow = Math.max(1, Math.min(8,
      Math.floor((_w - 80) / cubScreenW)));
    const rows = Math.ceil(n / perRow);

    const cubicles = [];
    let minTx = Infinity, maxTx = -Infinity, minTy = Infinity, maxTy = -Infinity;
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      // Within a row: walk +tx. Between rows: drop +ty. That makes each
      // row a diagonal "wave" of cubicles going down-right; multi-row
      // layouts then stack one below the other in screen-y.
      const tx = col * (CUBICLE_TW + 1) + row * 0;
      const ty = row * (CUBICLE_TH + 1);
      cubicles.push({ tx, ty });
      // Cubicle occupies (tx..tx+CUBICLE_TW-1, ty..ty+CUBICLE_TH-1).
      if (tx < minTx) minTx = tx;
      if (ty < minTy) minTy = ty;
      if (tx + CUBICLE_TW > maxTx) maxTx = tx + CUBICLE_TW;
      if (ty + CUBICLE_TH > maxTy) maxTy = ty + CUBICLE_TH;
    }
    // Floor pad: extend bounds by 1 tile on each side so cubicles sit on
    // a rug, not the bare wall.
    const floorMinTx = minTx - 1, floorMinTy = minTy - 1;
    const floorMaxTx = maxTx + 1, floorMaxTy = maxTy + 1;

    // Center the floor bbox in the canvas under the 56 px header band.
    const headerH = 64;
    const bboxCenterScreenX = ((floorMinTx + floorMaxTx) / 2 - (floorMinTy + floorMaxTy) / 2) * (TILE_W / 2);
    const bboxCenterScreenY = ((floorMinTx + floorMaxTx) / 2 + (floorMinTy + floorMaxTy) / 2) * (TILE_H / 2);
    _isoOx = Math.round(_w / 2 - bboxCenterScreenX);
    _isoOy = Math.round(headerH + (_h - headerH) / 2 - bboxCenterScreenY);

    return { cubicles, perRow, rows, floorMinTx, floorMinTy, floorMaxTx, floorMaxTy };
  }

  // Avatar screen position for host index i. Uses the actor's current
  // fractional tile coords if one exists (so walking animation moves the
  // avatar between tiles); otherwise falls back to the chair tile.
  function avatarPos(i) {
    if (!_layout) _layout = computeLayout();
    const c = _layout.cubicles[i];
    const host = _hosts[i];
    const actor = host && _actors[host.id];
    if (actor) return isoToScreen(actor.px, actor.py);
    return isoToScreen(c.tx + 1, c.ty + 1);
  }

  // Re-seed actor pos at chair tile for hosts that just appeared. Called
  // each frame after layout is rebuilt.
  function syncActors() {
    if (!_layout) return;
    for (let i = 0; i < _hosts.length; i++) {
      const h = _hosts[i];
      if (_actors[h.id]) continue;
      const c = _layout.cubicles[i];
      _actors[h.id] = {
        px: c.tx + 1, py: c.ty + 1,                 // chair tile
        chairTx: c.tx + 1, chairTy: c.ty + 1,
        cubBounds: {
          minTx: c.tx + 0.2, maxTx: c.tx + CUBICLE_TW - 0.6,
          minTy: c.ty + 0.2, maxTy: c.ty + CUBICLE_TH - 0.6,
        },
        targetTx: null, targetTy: null,
        state: 'idle',                              // idle | walk | sit
        facing: 's',
        idleUntil: NOW() + (Math.random() * 1000),
        walkPhase: 0,
      };
    }
  }

  // Per-frame actor update. dt = seconds since last tick.
  function tickActors(dt) {
    syncActors();
    const now = NOW();
    for (let i = 0; i < _hosts.length; i++) {
      const h = _hosts[i];
      const a = _actors[h.id]; if (!a) continue;
      const running = _runningById[h.id] || 0;
      const isOnline = h.status === 'online';
      const isWorking = isOnline && running > 0;

      // OFFLINE — stand still at chair, dim alpha drawn elsewhere.
      if (!isOnline) {
        a.state = 'offline';
        a.px = a.chairTx; a.py = a.chairTy; a.facing = 's';
        continue;
      }
      // WORKING — sit at chair facing north (toward monitor).
      if (isWorking) {
        a.state = 'sit';
        a.px = a.chairTx; a.py = a.chairTy; a.facing = 'n';
        a.walkPhase = (a.walkPhase + dt * 1.6) % 1;  // typing wiggle
        continue;
      }
      // IDLE / WALK loop within cubicle bounds.
      if (a.targetTx == null) {
        if (now >= a.idleUntil) {
          // Pick a new wander target inside cubicle.
          const b = a.cubBounds;
          a.targetTx = b.minTx + Math.random() * (b.maxTx - b.minTx);
          a.targetTy = b.minTy + Math.random() * (b.maxTy - b.minTy);
          a.state = 'walk';
        } else {
          a.state = 'idle';
        }
        continue;
      }
      // Walk: move toward target in tile-space.
      const dx = a.targetTx - a.px;
      const dy = a.targetTy - a.py;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.04) {
        // Arrived — pick a new idle delay.
        a.px = a.targetTx; a.py = a.targetTy;
        a.targetTx = null; a.targetTy = null;
        a.idleUntil = now + (IDLE_MIN_S + Math.random() * (IDLE_MAX_S - IDLE_MIN_S)) * 1000;
        a.state = 'idle';
        a.walkPhase = 0;
        continue;
      }
      // Direction-of-motion → facing.
      if (Math.abs(dx) > Math.abs(dy)) a.facing = dx > 0 ? 'e' : 'w';
      else                              a.facing = dy > 0 ? 's' : 'n';
      const step = WALK_SPEED * dt;
      a.px += (dx / dist) * step;
      a.py += (dy / dist) * step;
      a.walkPhase = (a.walkPhase + dt * 4) % 1;  // 4-frame cycle / sec
      a.state = 'walk';
    }
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
  // 16-bit palette ramps: each base color has a dark + light shade derived
  // by tweaking HSL. Keeps the office coherent (no neon clashes) and gives
  // every sprite proper 2-tone shading.
  function shade(hex, dPct) {
    // dPct: -30 (darker) to +30 (lighter). Naive RGB nudge, plenty for pixel art.
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    const f = (c) => Math.max(0, Math.min(255, Math.round(c + (dPct/100) * 255)));
    const toHex = (c) => f(c).toString(16).padStart(2,'0');
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }
  function paletteFor(hostId) {
    const h = hash32(hostId);
    // Curated 16-bit-friendly hues: muted, slightly desaturated, no neon.
    const hairs  = ['#4a3520','#2b1d12','#6b4a2a','#8b5a3c','#a87333','#3d2c1f','#c9a679','#5a3b25','#241914','#7a5c3e'];
    const shirts = ['#3a7ad9','#2c8c63','#c45f3a','#8e57b2','#1aa39a','#c43c6e','#d97548','#5a6c80','#7a5641','#3aa288'];
    const pants  = ['#28324a','#3a2a4c','#2a3a3a','#4a3a28','#2c2c38'];
    const skins  = ['#f5d4a8','#e8c096','#d39872','#a87049','#6e4628'];
    return {
      hair:    hairs[(h >>> 0) % hairs.length],
      hairStyle: (h >>> 8) & 0x07,  // 0..7 — 4 unique silhouettes (mod 4 used below)
      shirt:   shirts[(h >>> 4) % shirts.length],
      pants:   pants[(h >>> 12) % pants.length],
      skin:    skins[(h >>> 16) % skins.length],
      hasGlasses: ((h >>> 20) & 0x07) > 4,
    };
  }

  // Pixel set helper — fills a 1×1 "pixel" at integer coords. All avatar/
  // furniture draws compose from these so everything stays grid-aligned.
  function px(ctx, x, y, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, 1, 1);
  }
  function rect(ctx, x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
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

  // Detailed pixel-art avatar (22×34). Front-facing 16-bit style:
  // 1-px dark-violet outline, 2-tone skin (light + shadow), 2-tone shirt,
  // hair silhouettes per palette.hairStyle, optional glasses.
  // Working state adds a 1-px typing-bob to forearms.
  //
  // The (sx, sy) passed in is the feet position. Draw upward from there.
  function drawAvatar(ctx, sx, sy, palette, opts) {
    const { alpha = 1, working = false, walkPhase = 0, idleBob = 0, walking = false, facing = 's' } = opts || {};
    ctx.save();
    ctx.globalAlpha = alpha;
    const x0 = Math.round(sx - AV_W / 2);
    const y0 = Math.round(sy - AV_H) + idleBob;
    // Drop shadow at feet.
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath();
    ctx.ellipse(sx, sy + 1, AV_W / 2 - 2, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();

    const OUTLINE = '#0e1018';
    const SKIN = palette.skin;
    const SKIN_S = shade(SKIN, -10);
    const HAIR = palette.hair;
    const HAIR_H = shade(HAIR, +6);
    const SHIRT = palette.shirt;
    const SHIRT_H = shade(SHIRT, +6);
    const SHIRT_S = shade(SHIRT, -10);
    const PANTS = palette.pants;
    const PANTS_S = shade(PANTS, -8);

    // Coords are RELATIVE to (x0, y0); whole sprite fits 0..22 × 0..34.
    // Hair silhouette (top of head, includes mohawk/short/long variants).
    // Outer outline.
    const X = (n) => x0 + n;
    const Y = (n) => y0 + n;

    // === HEAD (8 wide, 9 tall, centered) ===
    // Hair styles 0..3:
    //   0: short cap
    //   1: parted with cowlick
    //   2: bun on top
    //   3: long sides
    const hs = palette.hairStyle & 0x03;

    // Head outline.
    rect(ctx, X(7), Y(2), 8, 1, OUTLINE);          // top
    rect(ctx, X(6), Y(3), 1, 6, OUTLINE);          // left
    rect(ctx, X(15), Y(3), 1, 6, OUTLINE);         // right
    rect(ctx, X(7), Y(9), 8, 1, OUTLINE);          // bottom (chin)
    // Skin fill.
    rect(ctx, X(7), Y(3), 8, 6, SKIN);
    // Skin shading on right side.
    rect(ctx, X(13), Y(4), 2, 5, SKIN_S);
    // Eyes — placement varies by facing direction (4-dir hint).
    //   n: back of head, no eyes visible.
    //   s: full front (default), eyes centered.
    //   e: eyes shifted right (look that way).
    //   w: eyes shifted left.
    if (facing !== 'n') {
      const eyeOffset = facing === 'e' ? 1 : (facing === 'w' ? -1 : 0);
      rect(ctx, X(8 + eyeOffset), Y(6), 2, 1, OUTLINE);
      rect(ctx, X(12 + eyeOffset), Y(6), 2, 1, OUTLINE);
      // Glasses (only when face visible).
      if (palette.hasGlasses) {
        rect(ctx, X(8 + eyeOffset), Y(5), 2, 2, '#cdd6f5');
        rect(ctx, X(12 + eyeOffset), Y(5), 2, 2, '#cdd6f5');
        rect(ctx, X(10 + eyeOffset), Y(6), 2, 1, '#cdd6f5');
        rect(ctx, X(8 + eyeOffset), Y(6), 2, 1, OUTLINE);
        rect(ctx, X(12 + eyeOffset), Y(6), 2, 1, OUTLINE);
      }
      // Mouth (only front-facing).
      if (facing === 's') rect(ctx, X(10), Y(8), 2, 1, shade(SKIN, -25));
    } else {
      // Back of head — fill more of the head with hair color to hint
      // the avatar is facing away.
      rect(ctx, X(7), Y(3), 8, 4, HAIR);
    }
    // Hair on top of head.
    if (hs === 0) {       // short cap
      rect(ctx, X(7), Y(1), 8, 2, HAIR);
      rect(ctx, X(6), Y(2), 10, 1, HAIR);
      rect(ctx, X(7), Y(0), 8, 1, OUTLINE);
    } else if (hs === 1) { // parted
      rect(ctx, X(6), Y(1), 10, 2, HAIR);
      rect(ctx, X(7), Y(0), 8, 1, OUTLINE);
      rect(ctx, X(12), Y(3), 3, 1, HAIR);
      rect(ctx, X(9), Y(3), 2, 1, HAIR_H);
    } else if (hs === 2) { // bun on top
      rect(ctx, X(7), Y(1), 8, 2, HAIR);
      rect(ctx, X(9), Y(-1), 4, 2, HAIR);
      rect(ctx, X(9), Y(-2), 4, 1, OUTLINE);
      rect(ctx, X(7), Y(0), 8, 1, OUTLINE);
    } else {              // long sides
      rect(ctx, X(7), Y(1), 8, 2, HAIR);
      rect(ctx, X(6), Y(3), 1, 5, HAIR);
      rect(ctx, X(15), Y(3), 1, 5, HAIR);
      rect(ctx, X(7), Y(0), 8, 1, OUTLINE);
    }

    // === NECK ===
    rect(ctx, X(10), Y(10), 2, 1, SKIN_S);

    // === TORSO (12 wide, 9 tall) ===
    // Shoulders/torso outline.
    rect(ctx, X(5), Y(11), 12, 1, OUTLINE);
    rect(ctx, X(5), Y(12), 1, 8, OUTLINE);
    rect(ctx, X(16), Y(12), 1, 8, OUTLINE);
    rect(ctx, X(5), Y(20), 12, 1, OUTLINE);
    // Shirt fill.
    rect(ctx, X(6), Y(12), 11, 8, SHIRT);
    // Shoulder highlight (top-left).
    rect(ctx, X(6), Y(12), 5, 1, SHIRT_H);
    // Right-side shading.
    rect(ctx, X(14), Y(12), 2, 8, SHIRT_S);
    // Chest accent stripe (subtle).
    rect(ctx, X(7), Y(15), 9, 1, SHIRT_S);

    // === ARMS ===
    // Typing wiggle: when working, raise both arms 1 px on alternating beats.
    const armDy = working ? (Math.floor(walkPhase * 4) % 2) : 0;
    // Left arm.
    rect(ctx, X(4), Y(12 - armDy), 1, 1, OUTLINE);
    rect(ctx, X(3), Y(13 - armDy), 1, 6, OUTLINE);
    rect(ctx, X(4), Y(13 - armDy), 1, 6, SHIRT);
    rect(ctx, X(3), Y(19 - armDy), 2, 1, OUTLINE);
    // Hand (left).
    rect(ctx, X(3), Y(19 - armDy), 2, 1, SKIN_S);
    rect(ctx, X(2), Y(20 - armDy), 1, 1, OUTLINE);
    // Right arm.
    rect(ctx, X(17), Y(12 - armDy), 1, 1, OUTLINE);
    rect(ctx, X(18), Y(13 - armDy), 1, 6, OUTLINE);
    rect(ctx, X(17), Y(13 - armDy), 1, 6, SHIRT);
    rect(ctx, X(17), Y(19 - armDy), 2, 1, OUTLINE);
    // Hand (right).
    rect(ctx, X(17), Y(19 - armDy), 2, 1, SKIN_S);
    rect(ctx, X(19), Y(20 - armDy), 1, 1, OUTLINE);

    // === LEGS (6 wide × 11 tall, split into two pant legs) ===
    rect(ctx, X(5), Y(21), 12, 1, OUTLINE);
    rect(ctx, X(5), Y(22), 1, 9, OUTLINE);
    rect(ctx, X(16), Y(22), 1, 9, OUTLINE);
    rect(ctx, X(11), Y(22), 1, 9, OUTLINE);     // crotch divider
    rect(ctx, X(6), Y(22), 5, 9, PANTS);
    rect(ctx, X(12), Y(22), 4, 9, PANTS);
    rect(ctx, X(13), Y(22), 3, 9, PANTS_S);     // right-leg shading
    rect(ctx, X(5), Y(31), 12, 1, OUTLINE);
    // Walk cycle: shift one foot fwd/back by 1px per phase. 4-step cycle.
    // Frames 0,2 → both feet centered (legs together); 1 → left fwd; 3 → right fwd.
    let leftDy = 0, rightDy = 0;
    if (walking) {
      const f = Math.floor(walkPhase * 4) % 4;
      if (f === 1) { leftDy = -1; rightDy = 1; }
      else if (f === 3) { leftDy = 1; rightDy = -1; }
    }
    // Shoes (with walk offset).
    rect(ctx, X(5), Y(32 + leftDy), 6, 2, OUTLINE);
    rect(ctx, X(11), Y(32 + rightDy), 6, 2, OUTLINE);
    rect(ctx, X(6), Y(32 + leftDy), 4, 1, '#222');
    rect(ctx, X(12), Y(32 + rightDy), 4, 1, '#222');

    ctx.restore();
  }

  // Office chair behind the avatar — simple iso block in tile.
  // Drawn AFTER desk but BEFORE avatar so the avatar sits "in" the chair.
  function drawChair(ctx, tx, ty) {
    const { x, y } = isoToScreen(tx, ty);
    // Seat (diamond top).
    ctx.fillStyle = '#1a1f2c';
    ctx.beginPath();
    ctx.moveTo(x,            y + 4);
    ctx.lineTo(x + TILE_W/2 - 8, y + TILE_H/2);
    ctx.lineTo(x,            y + TILE_H - 4);
    ctx.lineTo(x - TILE_W/2 + 8, y + TILE_H/2);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#0e1018'; ctx.lineWidth = 1; ctx.stroke();
    // Backrest (small bar behind).
    rect(ctx, x - 4, y + 0, 8, 8, '#0e1320');
    rect(ctx, x - 4, y + 0, 8, 1, '#1a1f2c');
  }

  // Decorative potted plant. Placed in cubicle corner.
  function drawPlant(ctx, tx, ty) {
    const { x, y } = isoToScreen(tx, ty);
    const cx = x | 0, cy = (y + TILE_H/2) | 0;
    // Pot.
    rect(ctx, cx - 4, cy - 2, 8, 6, '#5a3a1d');
    rect(ctx, cx - 4, cy - 2, 8, 1, '#7a5530');
    rect(ctx, cx - 4, cy + 3, 8, 1, '#3a2410');
    // Leaves cluster.
    const leaf = '#2f6b3a';
    const leafH = '#52955d';
    rect(ctx, cx - 5, cy - 8, 10, 3, leaf);
    rect(ctx, cx - 3, cy - 11, 6, 3, leaf);
    rect(ctx, cx - 5, cy - 8, 2, 2, leafH);
    rect(ctx, cx - 1, cy - 11, 2, 2, leafH);
  }

  // Server rack — the "fleet" totem. Sits at the back of the office.
  // Blinking LEDs animate from rAF time so we never recompute geometry.
  function drawServerRack(ctx, tx, ty, t) {
    const { x, y } = isoToScreen(tx, ty);
    const cx = x | 0, cy = (y - 14) | 0;
    // Outline body.
    rect(ctx, cx - 9, cy, 18, 32, '#0e1018');
    rect(ctx, cx - 8, cy + 1, 16, 30, '#1d2230');
    // U-slot horizontal stripes.
    for (let i = 0; i < 6; i++) {
      const sy = cy + 3 + i * 5;
      rect(ctx, cx - 7, sy, 14, 3, '#11141c');
      rect(ctx, cx - 7, sy, 14, 1, '#272c3a');
      // LED dots — blink at different rates per slot, deterministic from i.
      const phase = (t / (300 + i * 70)) + i;
      const onA = (Math.floor(phase) & 1) === 0;
      const onB = (Math.floor(phase / 1.7) & 1) === 0;
      rect(ctx, cx - 5, sy + 1, 1, 1, onA ? '#3affb0' : '#0a1d18');
      rect(ctx, cx - 3, sy + 1, 1, 1, onB ? '#ffb13a' : '#1d1a08');
      rect(ctx, cx + 5, sy + 1, 1, 1, onA ? '#6fd5ff' : '#0a1820');
    }
    // Cable tray on top.
    rect(ctx, cx - 9, cy - 2, 18, 2, '#0e1018');
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

    // Draw floor for the cubicle bounding box. Tight bounds = cubicles
    // sit on a rug-sized floor, not a huge meaningless diamond.
    const { floorMinTx, floorMinTy, floorMaxTx, floorMaxTy } = _layout;
    for (let tx = floorMinTx; tx < floorMaxTx; tx++) {
      for (let ty = floorMinTy; ty < floorMaxTy; ty++) {
        const fill = ((tx + ty) & 1) ? '#252b3a' : '#2a3144';
        drawFloorTile(ctx, tx, ty, fill);
      }
    }

    // Build a draw list of (host index, screen-y) for y-sort so avatars in
    // back rows draw behind desks in front rows. Use actor's CURRENT
    // position (post-tick) so walking avatars sort correctly as they move.
    const drawList = _hosts.map((h, i) => {
      const cub = _layout.cubicles[i];
      const sp = avatarPos(i);
      return { i, h, cub, sp };
    }).sort((a, b) => a.sp.y - b.sp.y);

    for (const { i, h, cub, sp } of drawList) {
      const running = _runningById[h.id] || 0;
      const isOnline = h.status === 'online';
      const isWorking = isOnline && running > 0;
      const actor = _actors[h.id];

      // Layer order: desk → plant → chair → avatar.
      drawDesk(ctx, cub.tx, cub.ty, isWorking);
      if ((hash32(h.id) >>> 24) & 0x01) {
        drawPlant(ctx, cub.tx + CUBICLE_TW, cub.ty - 1);
      }
      drawChair(ctx, cub.tx + 1, cub.ty + 1);

      // Idle bob: small ±1 px y offset, per-host phase so they're not synced.
      const phase = (hash32(h.id) % 1000) / 1000;
      let idleBob = 0;
      if (isOnline && (!actor || actor.state !== 'walk')) {
        if (isWorking) idleBob = Math.round(Math.sin(now / 90 + phase * 6.28) * 1.2);
        else           idleBob = Math.round(Math.sin(now / 700 + phase * 6.28));
      }
      const palette = paletteFor(h.id);
      drawAvatar(ctx, sp.x, sp.y + 1, palette, {
        alpha: isOnline ? 1.0 : 0.4,
        working: isWorking,
        walkPhase: actor ? actor.walkPhase : 0,
        idleBob,
        walking: actor ? actor.state === 'walk' : false,
        facing: actor ? actor.facing : 's',
      });

      // Status emoji bubble.
      const st = _animState[h.id];
      let emoji = null;
      if (st && st.emoji && st.emojiUntil > now) emoji = st.emoji;
      else if (isWorking && running >= 3) emoji = '🔥';
      const badge = isWorking ? `${running} session${running > 1 ? 's' : ''}` : '';
      // Name tag goes UNDER the chair (fixed position) so it doesn't move
      // around with the avatar walking.
      const tagAnchor = isoToScreen(cub.tx + 1, cub.ty + 1);
      drawNameTag(ctx, tagAnchor.x, tagAnchor.y + 6, h.display_name || h.name, badge, emoji);
    }

    // Server rack — sits at the back-right of the floor bbox.
    const rackTx = _layout.floorMaxTx + 1;
    const rackTy = _layout.floorMinTy - 1;
    drawServerRack(ctx, rackTx, rackTy, now);

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
