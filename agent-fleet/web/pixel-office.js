'use strict';
// vt-0369 / vt-0371 / vt-0372: pixel-office SPA module.
//
// Phase 2 (vt-0371): SPA shell + feature flag + skeleton canvas.
// Phase 3 (vt-0372): avatars + room layout + 5s state poll.
//
// Single canvas, no engine, no sprites. Avatars are drawn from canvas
// primitives — head/torso/legs blocks colored deterministically from a
// 4-byte hash of host.id (4 bits hat hue, 4 bits shirt hue, 4 bits skin
// tone, 4 bits accessory).
//
// State refresh: poll /fleet/hosts + /fleet/sessions?status=running every
// 5 s while the view is open. Cheap, no new server-side roles required.
// A WS-driven path can be added if/when latency matters (the existing
// fleet WS subscriptions are scoped to individual session/run/host ids,
// not fleet-wide events).
(function () {
  function token() { return localStorage.fleetToken || ''; }
  async function api(path) {
    const r = await fetch('/fleet' + path, {
      headers: { authorization: `Bearer ${token()}` },
    });
    if (!r.ok) throw new Error(`${r.status}: ${path}`);
    return r.json();
  }
  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  // --- Layout constants -----------------------------------------------------
  const CANVAS_W = 960;
  const CANVAS_H = 540;
  const TILE = 32;
  const AVATAR_W = 16;
  const AVATAR_H = 24;
  const DESK_W = 48;
  const DESK_H = 24;
  // Desk grid: rows of 4 desks, evenly spaced. Computed at view-open time
  // from host count so we don't waste space.
  const DESKS_PER_ROW = 4;
  const ROW_GAP_Y = 96;
  const COL_GAP_X = 192;
  const OFFICE_TOP = 96;   // leave space for header band

  // --- Module state ---------------------------------------------------------
  let _ctx = null;          // CanvasRenderingContext2D
  let _running = false;
  let _pollTimer = null;
  let _hosts = [];          // [{ id, name, display_name, status, ... }]
  let _runningById = {};    // host_id → count of running sessions

  // -------------------------------------------------------------------------

  async function openPixelOfficeView() {
    document.getElementById('pixelofficeview-close').onclick = closePixelOfficeView;

    const canvas = document.getElementById('po-canvas');
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = CANVAS_W * dpr;
    canvas.height = CANVAS_H * dpr;
    canvas.style.width  = `${CANVAS_W}px`;
    canvas.style.height = `${CANVAS_H}px`;
    _ctx = canvas.getContext('2d');
    _ctx.imageSmoothingEnabled = false;
    _ctx.scale(dpr, dpr);

    // vt-0373 (Phase 4): left-click → prompt bubble.
    // vt-0374 (Phase 5): right-click (contextmenu) → role picker.
    function hitForEvent(ev) {
      const rect = canvas.getBoundingClientRect();
      const x = (ev.clientX - rect.left) * (CANVAS_W / rect.width);
      const y = (ev.clientY - rect.top)  * (CANVAS_H / rect.height);
      return {
        host: hostAt(x, y),
        bubbleX: ev.clientX - rect.left,
        bubbleY: ev.clientY - rect.top,
      };
    }
    canvas.onclick = (ev) => {
      const { host, bubbleX, bubbleY } = hitForEvent(ev);
      if (host) openPromptBubble(host, bubbleX, bubbleY);
    };
    canvas.oncontextmenu = (ev) => {
      const { host, bubbleX, bubbleY } = hitForEvent(ev);
      if (host) {
        ev.preventDefault();
        openRolePickerBubble(host, bubbleX, bubbleY);
      }
    };

    updateStatus('— loading —');
    await refreshState();
    render();

    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(async () => {
      try { await refreshState(); render(); } catch (e) { /* swallow */ }
    }, 5000);
    _running = true;
  }

  function closePixelOfficeView() {
    _running = false;
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    location.hash = '#/dashboard';
  }

  function updateStatus(text) {
    const el = document.getElementById('pixel-office-status');
    if (el) el.textContent = text;
  }

  async function refreshState() {
    const [hosts, sessions] = await Promise.all([
      api('/hosts'),
      api('/sessions?status=running'),
    ]);
    // Stable order — keeps each host on the same desk between polls. Sort by
    // name so a fresh-up host slots in alphabetically rather than jumping.
    _hosts = hosts.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    _runningById = {};
    for (const s of sessions) {
      _runningById[s.host_id] = (_runningById[s.host_id] || 0) + 1;
    }
    const online = _hosts.filter(h => h.status === 'online').length;
    const working = _hosts.filter(h => (_runningById[h.id] || 0) > 0).length;
    updateStatus(`${_hosts.length} hosts · ${online} online · ${working} working`);
  }

  // --- Drawing -------------------------------------------------------------

  // 32-bit deterministic hash of a string. Simple FNV-1a — enough to
  // generate stable palette indices, not security-grade.
  function hash32(s) {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // Palette derived from hash. Returns hex strings for hat/shirt/skin/accent.
  function paletteFor(hostId) {
    const h = hash32(hostId);
    const hats   = ['#e74c3c','#f39c12','#27ae60','#2980b9','#8e44ad','#d35400','#16a085','#c0392b','#7f8c8d','#34495e'];
    const shirts = ['#3498db','#2ecc71','#e67e22','#9b59b6','#1abc9c','#e91e63','#ff5722','#607d8b','#795548','#009688'];
    const skins  = ['#fce4c4','#f1c27d','#e0ac69','#c68642','#8d5524'];
    const accents = ['#f1c40f','#ecf0f1','#bdc3c7','#1abc9c'];
    return {
      hat:    hats   [(h >>>  0) & 0x0f] || '#777',
      shirt:  shirts [(h >>>  4) & 0x0f] || '#888',
      skin:   skins  [(h >>>  8) % skins.length],
      accent: accents[(h >>> 12) % accents.length],
      hasHat: ((h >>> 16) & 0x07) > 1,   // ~75% of avatars wear a hat
    };
  }

  // Desk + avatar position for host at index i.
  function deskPos(i) {
    const row = Math.floor(i / DESKS_PER_ROW);
    const col = i % DESKS_PER_ROW;
    const totalWidthForRow = (DESKS_PER_ROW - 1) * COL_GAP_X + DESK_W;
    const startX = Math.floor((CANVAS_W - totalWidthForRow) / 2);
    return {
      x: startX + col * COL_GAP_X,
      y: OFFICE_TOP + row * ROW_GAP_Y,
    };
  }

  function drawRoom(ctx) {
    // Background: dark office floor.
    ctx.fillStyle = '#1a1f2c';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    // Tile grid for visual rhythm.
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= CANVAS_W; x += TILE) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke();
    }
    for (let y = 0; y <= CANVAS_H; y += TILE) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke();
    }
    // Top header band — gives a "window" feel to the floor.
    ctx.fillStyle = '#0e1320';
    ctx.fillRect(0, 0, CANVAS_W, 64);
    ctx.fillStyle = '#506075';
    ctx.font = '11px "JetBrains Mono", "Courier New", monospace';
    ctx.fillText('— FLEET OFFICE —', 16, 24);
    ctx.fillText('avatars per host · darker = offline · monitor lit = working', 16, 42);
  }

  function drawDesk(ctx, x, y, working) {
    // Desktop slab.
    ctx.fillStyle = '#3e2a1a';
    ctx.fillRect(x, y + AVATAR_H + 4, DESK_W, 6);
    // Legs.
    ctx.fillRect(x + 2, y + AVATAR_H + 10, 4, 10);
    ctx.fillRect(x + DESK_W - 6, y + AVATAR_H + 10, 4, 10);
    // Monitor.
    ctx.fillStyle = '#222';
    ctx.fillRect(x + 8, y + AVATAR_H - 14, 20, 16);
    // Screen (green if working, dark if idle).
    ctx.fillStyle = working ? '#3affb0' : '#0a1a18';
    ctx.fillRect(x + 10, y + AVATAR_H - 12, 16, 12);
    // Keyboard.
    ctx.fillStyle = '#555';
    ctx.fillRect(x + 8, y + AVATAR_H + 2, 20, 3);
  }

  function drawAvatar(ctx, x, y, palette, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    // Head.
    ctx.fillStyle = palette.skin;
    ctx.fillRect(x + 4, y, 8, 8);
    // Eyes.
    ctx.fillStyle = '#000';
    ctx.fillRect(x + 6, y + 4, 1, 1);
    ctx.fillRect(x + 9, y + 4, 1, 1);
    // Hat.
    if (palette.hasHat) {
      ctx.fillStyle = palette.hat;
      ctx.fillRect(x + 3, y - 2, 10, 3);
      ctx.fillRect(x + 5, y - 4, 6, 2);
    }
    // Torso.
    ctx.fillStyle = palette.shirt;
    ctx.fillRect(x + 2, y + 8, 12, 10);
    // Accent stripe across chest.
    ctx.fillStyle = palette.accent;
    ctx.fillRect(x + 2, y + 13, 12, 1);
    // Arms.
    ctx.fillStyle = palette.shirt;
    ctx.fillRect(x, y + 9, 2, 7);
    ctx.fillRect(x + 14, y + 9, 2, 7);
    // Legs.
    ctx.fillStyle = '#222';
    ctx.fillRect(x + 4, y + 18, 3, 6);
    ctx.fillRect(x + 9, y + 18, 3, 6);
    ctx.restore();
  }

  function drawNameTag(ctx, x, y, name, badge) {
    ctx.fillStyle = '#c8d4e2';
    ctx.font = '10px "JetBrains Mono", "Courier New", monospace';
    ctx.textAlign = 'center';
    const t = (name || '').slice(0, 14);
    ctx.fillText(t, x + AVATAR_W / 2, y + AVATAR_H + 32);
    if (badge) {
      ctx.fillStyle = '#3affb0';
      ctx.fillText(badge, x + AVATAR_W / 2, y + AVATAR_H + 44);
    }
    ctx.textAlign = 'left';
  }

  function render() {
    if (!_ctx) return;
    const ctx = _ctx;
    drawRoom(ctx);
    _hosts.forEach((h, i) => {
      const pos = deskPos(i);
      const running = _runningById[h.id] || 0;
      const isOnline = h.status === 'online';
      const isWorking = isOnline && running > 0;
      drawDesk(ctx, pos.x + 0, pos.y, isWorking);
      const palette = paletteFor(h.id);
      drawAvatar(ctx, pos.x + (DESK_W - AVATAR_W) / 2, pos.y, palette,
        isOnline ? 1.0 : 0.35);
      const badge = isWorking ? `${running} session${running > 1 ? 's' : ''}` : '';
      drawNameTag(ctx, pos.x + (DESK_W - AVATAR_W) / 2, pos.y,
        h.display_name || h.name, badge);
    });
  }

  // --- Click hit-test + prompt bubble (vt-0373) ----------------------------

  function hostAt(x, y) {
    // Hit-rect = avatar block + desk block, both centred on deskPos.x.
    for (let i = 0; i < _hosts.length; i++) {
      const pos = deskPos(i);
      const ax = pos.x + (DESK_W - AVATAR_W) / 2;
      // y-range covers avatar head down through desk + name tag.
      if (x >= pos.x && x <= pos.x + DESK_W &&
          y >= pos.y - 4 && y <= pos.y + AVATAR_H + 48) {
        return _hosts[i];
      }
    }
    return null;
  }

  function openPromptBubble(host, anchorX, anchorY) {
    const overlay = document.getElementById('po-overlay');
    if (!overlay) return;
    // Drop any prior bubble — only one open at a time.
    overlay.innerHTML = '';
    const bubble = document.createElement('div');
    bubble.className = 'po-bubble';
    // Position relative to the overlay (which is .inset:0 over the canvas).
    bubble.style.left = `${Math.min(anchorX + 12, CANVAS_W - 280)}px`;
    bubble.style.top  = `${Math.min(anchorY + 12, CANVAS_H - 200)}px`;
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
        statusEl.innerHTML = j.session_id
          ? `done · exit=${j.exit_code ?? '?'} · <a href="#/sessions/${esc(j.session_id)}" style="color:var(--accent)">full session</a>`
          : `done · exit=${j.exit_code ?? '?'}`;
        resultEl.textContent = out;
        resultEl.style.display = 'block';
      } catch (e) {
        statusEl.textContent = `error: ${e.message}`;
      } finally {
        sendBtn.disabled = false;
      }
    };
  }

  // --- Role picker bubble (vt-0374) ----------------------------------------

  async function openRolePickerBubble(host, anchorX, anchorY) {
    const overlay = document.getElementById('po-overlay');
    if (!overlay) return;
    overlay.innerHTML = '';
    const bubble = document.createElement('div');
    bubble.className = 'po-bubble';
    bubble.style.left = `${Math.min(anchorX + 12, CANVAS_W - 320)}px`;
    bubble.style.top  = `${Math.min(anchorY + 12, CANVAS_H - 280)}px`;
    bubble.innerHTML = `
      <div style="display:flex;align-items:center;gap:.5em;margin-bottom:.4em">
        <strong>${esc(host.display_name || host.name)}</strong>
        <span style="flex:1"></span>
        <span style="font-size:11px;color:var(--text-dim)">roles</span>
        <button class="btn-ghost" data-po-close style="font-size:11px">×</button>
      </div>
      <div id="po-roles-body" style="font-size:11px;color:var(--text-dim)">loading…</div>
      <div style="margin-top:.4em;font-size:10px;color:var(--text-faint)">
        Group roles override host roles at spawn. /roles/effective shows what
        will actually be applied.
      </div>
    `;
    overlay.appendChild(bubble);
    bubble.querySelector('[data-po-close]').onclick = () => { overlay.innerHTML = ''; };
    await renderRolePickerBody(host, bubble);
  }

  async function renderRolePickerBody(host, bubble) {
    const body = bubble.querySelector('#po-roles-body');
    try {
      const [all, assigned, effective] = await Promise.all([
        api('/agent-roles'),
        api(`/hosts/${host.id}/roles`),
        api(`/hosts/${host.id}/roles/effective`),
      ]);
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
            // Re-render to refresh the effective dot.
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
