'use strict';
// agent-fleet web client.
// Tactical command console. Vanilla JS, no framework. xterm.js for terminals.
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    token: null,
    hosts: [],
    sessions: [],
    cost: null,           // { days, hosts: [{host_id, host, usd, msgs}] }
    selected: null,       // session_id (when viewMode='session')
    selectedHost: null,   // host_id (when viewMode='host')
    viewMode: 'session',  // 'session' | 'host'
    ws: null,
    term: null,
    fit: null,
    pollTimer: null,
    backoff: 800,
    bootedAt: Date.now(),
  };

  // ============ Auth ============
  function readToken() {
    const frag = location.hash.match(/token=([^&]+)/);
    if (frag) {
      localStorage.fleetToken = decodeURIComponent(frag[1]);
      history.replaceState(null, '', location.pathname);
    }
    state.token = localStorage.fleetToken || null;
  }
  function showAuth() {
    $('auth').hidden = false; $('app').hidden = true;
    $('token-save').onclick = () => {
      const v = $('token-input').value.trim();
      if (v) { localStorage.fleetToken = v; location.reload(); }
    };
    $('token-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('token-save').click();
    });
    setTimeout(() => $('token-input').focus(), 50);
  }
  function showApp() {
    $('auth').hidden = true; $('app').hidden = false;
    $('logout').onclick = () => {
      if (!confirm('clear local token?')) return;
      localStorage.removeItem('fleetToken'); location.reload();
    };
  }

  // ============ API ============
  async function api(method, path, body) {
    const r = await fetch('/api/fleet' + path, {
      method, headers: {
        'authorization': 'Bearer ' + state.token,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) {
      localStorage.removeItem('fleetToken'); location.reload(); throw new Error('auth');
    }
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
    if (r.status === 204) return null;
    return r.json();
  }

  // ============ Render ============
  function ageStr(iso) {
    if (!iso) return '—';
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return `${Math.floor(d)}s`;
    if (d < 3600) return `${Math.floor(d/60)}m`;
    if (d < 86400) return `${Math.floor(d/3600)}h${Math.floor((d%3600)/60).toString().padStart(2,'0')}`;
    return `${Math.floor(d/86400)}d`;
  }
  function humanSeconds(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const d = Math.floor(s / 86400); s %= 86400;
    const h = Math.floor(s / 3600);  s %= 3600;
    const m = Math.floor(s / 60);
    const parts = [];
    if (d) parts.push(d + 'd');
    if (h) parts.push(h + 'h');
    if (m && !d) parts.push(m + 'm');
    if (!parts.length) parts.push((s % 60) + 's');
    return parts.join(' ');
  }
  function tFromBoot() {
    const d = Math.floor((Date.now() - state.bootedAt) / 1000);
    const h = Math.floor(d / 3600).toString().padStart(2, '0');
    const m = Math.floor((d % 3600) / 60).toString().padStart(2, '0');
    const s = (d % 60).toString().padStart(2, '0');
    return `T+${h}:${m}:${s}`;
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function dotClass(status, kind) {
    if (kind === 'host') return status === 'online' ? 'on' : 'off';
    if (status === 'running') return 'on';
    if (status === 'orphaned' || status === 'pending') return 'warn';
    if (status === 'killed') return 'err';
    return 'off';
  }
  function short(id) { return id ? id.slice(0, 8) : '—'; }

  function render() {
    const online = state.hosts.filter(h => h.status === 'online').length;
    const active = state.sessions.filter(s => s.status === 'running').length;
    $('stat-hosts').textContent = state.hosts.length || '0';
    $('stat-online').textContent = online || '0';
    $('stat-active').textContent = active || '0';
    $('hosts-count').textContent = state.hosts.length;
    $('sessions-count').textContent = state.sessions.length;

    const hostsUl = $('hosts');
    const costByHost = {};
    if (state.cost) for (const h of state.cost.hosts) costByHost[h.host_id] = h.usd;
    hostsUl.innerHTML = state.hosts.length === 0
      ? `<li class="empty"><span class="dot off"></span><span class="host-name" style="color:var(--text-faint)">no hosts registered</span></li>`
      : state.hosts.map(h => {
          const n = state.sessions.filter(s => s.host_id === h.id && s.status === 'running').length;
          const cost = costByHost[h.id];
          const costStr = (cost != null) ? `$${cost.toFixed(2)}` : '—';
          const label = h.display_name || h.name;
          const active = (state.viewMode === 'host' && h.id === state.selectedHost) ? ' class="active"' : '';
          return `<li data-host="${h.id}"${active}>
            <span class="dot ${dotClass(h.status, 'host')}"></span>
            <span class="host-name">${esc(label)} <span class="host-count">· ${costStr}/7d</span></span>
            <span class="host-actions">
              <span class="host-count">${n} sess</span>
            </span>
          </li>`;
        }).join('');
    hostsUl.querySelectorAll('li[data-host]').forEach(li => {
      li.onclick = () => openHostDetail(li.dataset.host);
    });

    const sessUl = $('sessions');
    const showClosed = $('show-closed')?.checked;
    const sessVisible = state.sessions.filter(s => showClosed || (s.status !== 'exited' && s.status !== 'killed'));
    sessUl.innerHTML = sessVisible.length === 0
      ? `<li class="empty"><span class="dot off"></span><span class="sess-id" style="color:var(--text-faint)">no ${showClosed?'':'active '}sessions</span><span></span><span></span></li>`
      : sessVisible.slice(0, 40).map(s => {
          const host = state.hosts.find(h => h.id === s.host_id);
          const active = (state.viewMode === 'session' && s.id === state.selected) ? ' class="active"' : '';
          return `<li data-session="${s.id}"${active}>
            <span class="dot ${dotClass(s.status, 'session')}"></span>
            <span class="sess-id">${short(s.id)}</span>
            <span class="sess-host">${esc(host?.display_name || host?.name || '?')}</span>
            <span class="sess-age">${ageStr(s.started_at)}</span>
          </li>`;
        }).join('');

    // wire clicks
    sessUl.querySelectorAll('li[data-session]').forEach(li => {
      li.onclick = () => attachSession(li.dataset.session);
    });

    // spawn host options
    const hostSel = $('spawn-host');
    const cur = hostSel.value;
    hostSel.innerHTML = state.hosts
      .filter(h => h.status === 'online')
      .map(h => `<option value="${h.id}">${esc(h.display_name || h.name)}</option>`).join('')
      || `<option value="">no online hosts</option>`;
    if (cur && [...hostSel.options].some(o => o.value === cur)) hostSel.value = cur;

    // footbar
    $('footstat').textContent = `${state.hosts.length} hosts · ${state.sessions.length} sessions · ${active} active`;
  }

  // ============ Poll ============
  async function refresh() {
    try {
      const [hosts, sessions] = await Promise.all([api('GET', '/hosts'), api('GET', '/sessions')]);
      state.hosts = hosts;
      state.sessions = sessions;
      // cost is best-effort (503 if tokmon down); don't break refresh
      try {
        const cost = await api('GET', '/cost/summary?days=7');
        state.cost = cost;
        const total = cost.hosts.reduce((n, h) => n + (h.usd || 0), 0);
        $('stat-cost').textContent = `$${total.toFixed(2)}`;
      } catch (e) {
        state.cost = null;
        $('stat-cost').textContent = '—';
      }
      render();
    } catch (e) {
      if (e.message !== 'auth') console.warn('refresh', e);
    }
  }
  function startPolling() {
    refresh();
    state.pollTimer = setInterval(refresh, 5000);
    setInterval(() => { $('stat-clock').textContent = tFromBoot(); }, 1000);
  }

  // ============ Terminal + WS ============
  function setViewerStatus(s) {
    const map = { running: 'val-ok', exited: '', killed: 'val-danger', orphaned: 'val-warn', pending: 'val-warn' };
    const el = $('v-status');
    el.textContent = s || 'idle';
    el.className = 'val ' + (map[s] || '');
    state.viewerStatusValue = s;
  }
  function setOverlay(visible, msg, sub) {
    const o = $('term-overlay');
    if (visible) {
      $('ovl-msg').textContent = msg || '—';
      o.hidden = false;
    } else {
      o.hidden = true;
    }
  }

  function setViewMode(mode) {
    state.viewMode = mode;
    document.querySelector('.viewer').hidden = (mode !== 'session');
    document.querySelector('.host-detail').hidden = (mode !== 'host');
  }

  function attachSession(id) {
    if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
    if (state.term) { try { state.term.dispose(); } catch {} state.term = null; }
    if (state.sessionCostTimer) { clearInterval(state.sessionCostTimer); state.sessionCostTimer = null; }
    state.selected = id;
    state.selectedHost = null;
    setViewMode('session');
    document.querySelector('.viewer').classList.remove('exited');
    render();

    $('v-id').textContent = short(id);
    $('v-host').textContent = '…';
    $('v-cwd').textContent = '…';
    $('v-cost').textContent = '—';
    setViewerStatus('attaching');
    setOverlay(false);

    // Per-session cost: refresh every 10s while attached
    const refreshSessCost = async () => {
      try {
        const c = await api('GET', `/sessions/${id}/cost`);
        const usd = (c.usd || 0).toFixed(4);
        const tag = c.attribution === 'approximate' ? ' ~' : '';
        let tip = `attribution: ${c.attribution || 'unknown'}`;
        if (c.by_model) {
          for (const [m, v] of Object.entries(c.by_model)) {
            tip += `\n${m}: $${v.usd.toFixed(4)} (${v.msgs} msgs, in=${v.input_tokens}, out=${v.output_tokens}, cache_w=${v.cache_creation_5m}, cache_r=${v.cache_read})`;
          }
        }
        const el = $('v-cost');
        el.textContent = `$${usd}${tag} · ${c.msgs} msgs`;
        el.title = tip;
      } catch { $('v-cost').textContent = '—'; }
    };
    refreshSessCost();
    state.sessionCostTimer = setInterval(refreshSessCost, 10_000);

    $('v-kill').disabled = false;
    $('v-kill').onclick = async () => {
      if (!confirm('terminate this session?')) return;
      try { await api('POST', `/sessions/${id}/kill`, {}); } catch (e) { alert(e.message); }
    };

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      // batch terminal writes for throughput; default is too eager for fast claude output
      windowsMode: false,
      convertEol: false,
      theme: {
        background: '#0a0a0c',
        foreground: '#e8e6e1',
        cursor: '#5cf08c',
        cursorAccent: '#0a0a0c',
        black: '#0a0a0c',     brightBlack:   '#5a5550',
        red:   '#ff4d5e',     brightRed:     '#ff7d8b',
        green: '#5cf08c',     brightGreen:   '#86ffac',
        yellow:'#ffb547',     brightYellow:  '#ffd07a',
        blue:  '#6fd5ff',     brightBlue:    '#9be4ff',
        magenta:'#ff79c6',    brightMagenta: '#ffaae0',
        cyan:  '#8be9fd',     brightCyan:    '#bbf3ff',
        white: '#e8e6e1',     brightWhite:   '#ffffff',
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open($('term'));
    // Canvas renderer: ~5-10× faster than DOM for bursty TUI output (claude).
    try {
      if (window.CanvasAddon && CanvasAddon.CanvasAddon) {
        term.loadAddon(new CanvasAddon.CanvasAddon());
      }
    } catch (e) { console.warn('canvas addon failed, falling back to DOM:', e); }
    state.term = term; state.fit = fit;
    setTimeout(() => { try { fit.fit(); sendResize(); } catch {} }, 60);

    // Debounce resize observer; rapid fires were causing layout thrash.
    let resizeT = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => { try { fit.fit(); sendResize(); } catch {} }, 120);
    });
    ro.observe($('term'));

    term.onData(d => {
      if (state.ws && state.ws.readyState === 1) {
        state.ws.send(JSON.stringify({ type: 'input', data: d }));
      }
    });

    connectWs(id);
  }
  function sendResize() {
    if (!state.term || !state.ws || state.ws.readyState !== 1) return;
    const cols = state.term.cols, rows = state.term.rows;
    state.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  function connectWs(id) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/api/fleet/ws?role=viewer&session_id=${id}`;
    const ws = new WebSocket(url, ['bearer.' + state.token]);
    state.ws = ws;
    ws.onopen = () => { state.backoff = 800; };
    // Coalesce rapid pty_data frames into one term.write per animation frame.
    // The default per-frame write was the bottleneck on bursty claude output.
    let pendingChunks = [];
    let rafScheduled = false;
    let receivedAnyData = false;
    const flushPending = () => {
      rafScheduled = false;
      if (!pendingChunks.length || !state.term) return;
      let total = 0;
      for (const c of pendingChunks) total += c.length;
      const merged = new Uint8Array(total);
      let o = 0;
      for (const c of pendingChunks) { merged.set(c, o); o += c.length; }
      pendingChunks = [];
      try { state.term.write(merged); } catch (e) { console.warn('term.write failed', e); }
    };
    const writeChunk = (u8) => {
      if (u8.length > 0) receivedAnyData = true;
      pendingChunks.push(u8);
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(flushPending);
      }
    };

    ws.onmessage = (e) => {
      let f;
      try { f = JSON.parse(e.data); } catch { return; }
      if (f.type === 'hello') {
        const host = state.hosts.find(h => h.id === f.host_id);
        $('v-host').textContent = host?.name || short(f.host_id);
        $('v-cwd').textContent = f.cwd || '—';
        setViewerStatus(f.status);
      } else if (f.type === 'backfill') {
        // Reset xterm to clean state before replaying historical escape sequences.
        // Without this, cursor positions accumulated over a long TUI session drift
        // when the terminal is re-attached.
        try { state.term.write('\x1bc'); state.term.reset?.(); } catch {}
        writeChunk(b64ToBytes(f.data));
        // After replay, ask the live process for a fresh redraw (Ctrl+L).
        // Most TUIs (including claude/Ink) handle it as repaint.
        if (state.viewerStatusValue === 'running' && state.ws && state.ws.readyState === 1) {
          setTimeout(() => {
            try { state.ws.send(JSON.stringify({ type: 'input', data: '\x0c' })); } catch {}
          }, 80);
        }
      } else if (f.type === 'pty_data') {
        writeChunk(b64ToBytes(f.data));
      } else if (f.type === 'session_exit') {
        document.querySelector('.viewer').classList.add('exited');
        setViewerStatus(f.exit_code === 0 ? 'exited' : 'killed');
        // Flush any pending writes before adding the exit marker so order is right.
        try { flushPending(); } catch {}
        try {
          if (!receivedAnyData) {
            state.term.write('\x1b[2m─── (no transcript captured for this session — likely a legacy run before persisted-flush) ───\x1b[0m\r\n');
          }
          state.term.write(`\r\n\x1b[2m─── session exit code=${f.exit_code} ───\x1b[0m\r\n`);
        } catch {}
      } else if (f.type === 'session_started') {
        setViewerStatus('running');
      }
    };
    ws.onclose = (ev) => {
      if (ev.code === 4001) {
        localStorage.removeItem('fleetToken'); location.reload(); return;
      }
      if (state.selected === id) {
        const wait = Math.min(state.backoff *= 1.7, 8000);
        setTimeout(() => connectWs(id), wait);
      } else {
        state.backoff = 800;
      }
    };
    ws.onerror = () => { /* let close handler retry */ };
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  // ============ Spawn ============
  function parseArgs(s) {
    if (!s) return [];
    const out = []; const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
    let m; while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
    return out;
  }
  async function spawn() {
    const host_id = $('spawn-host').value;
    if (!host_id) { alert('no host selected'); return; }
    const cwd = $('spawn-cwd').value || '~';
    const args = parseArgs($('spawn-args').value);
    try {
      const r = await api('POST', '/sessions', { host_id, cwd, args });
      await refresh();
      attachSession(r.session_id);
    } catch (e) { alert('spawn failed: ' + e.message); }
  }
  function wireSpawn() {
    $('spawn-btn').onclick = spawn;
    $('spawn-args').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') spawn();
    });
    $('show-closed').addEventListener('change', render);
    $('cleanup-btn').onclick = async () => {
      if (!confirm('delete all exited/killed sessions older than 1h? this is permanent.')) return;
      try {
        const r = await api('POST', '/sessions/cleanup', { older_than: '1 hour' });
        await refresh();
        alert(`deleted ${r.deleted} session(s)`);
      } catch (e) { alert('cleanup failed: ' + e.message); }
    };
  }

  // ============ Host detail ============
  function openHostDetail(hostId) {
    const h = state.hosts.find(x => x.id === hostId);
    if (!h) return;
    state.selectedHost = hostId;
    state.selected = null;
    setViewMode('host');
    render();
    renderHostDetail(h);
  }

  function renderHostDetail(h) {
    $('hd-display').textContent = h.display_name || h.name;
    $('hd-name').textContent = h.name;
    $('hd-os').textContent = h.os || '—';
    $('hd-arch').textContent = h.arch || '—';
    $('hd-status').textContent = h.status;
    $('hd-status').className = 'val ' + (h.status === 'online' ? 'val-ok' : 'val-danger');
    $('hd-dver').textContent = h.daemon_version || '—';
    $('hd-cver').textContent = h.claude_version || '—';
    $('hd-seen').textContent = h.last_seen ? ageStr(h.last_seen) + ' ago' : '—';
    const meta = h.metadata || {};
    $('hd-node').textContent = meta.node_version || '—';
    $('hd-cpu').textContent = meta.cpu_model || '—';
    $('hd-cores').textContent = meta.cpu_cores || '—';
    $('hd-ram').textContent = meta.ram_total_bytes
      ? `${(meta.ram_total_bytes / 1024 ** 3).toFixed(1)} GiB` + (meta.ram_free_bytes ? ` (${(meta.ram_free_bytes / 1024 ** 3).toFixed(1)} free)` : '')
      : '—';
    $('hd-uptime').textContent = meta.uptime_seconds
      ? humanSeconds(meta.uptime_seconds) : '—';
    $('hd-hostname').textContent = meta.hostname || '—';

    // tags
    const tagsEl = $('hd-tags');
    const caps = h.capabilities || [];
    tagsEl.innerHTML = caps.length === 0
      ? `<span class="lbl" style="color:var(--text-faint)">no tags</span>`
      : caps.map((c, i) => `<span class="chip">${esc(c)}<button data-rm-tag="${i}">×</button></span>`).join('');
    tagsEl.querySelectorAll('button[data-rm-tag]').forEach(btn => {
      btn.onclick = async () => {
        const newCaps = caps.filter((_, i) => i !== Number(btn.dataset.rmTag));
        await patchHost(h.id, { capabilities: newCaps });
      };
    });

    // sessions for this host
    const ul = $('hd-sessions');
    const list = state.sessions.filter(s => s.host_id === h.id).slice(0, 20);
    ul.innerHTML = list.length === 0
      ? `<li class="empty"><span class="dot off"></span><span class="sess-id" style="color:var(--text-faint)">no sessions</span><span></span><span></span></li>`
      : list.map(s => {
          const icon = { running:'▶', exited:'◇', killed:'✕', orphaned:'?', pending:'·' }[s.status] || '·';
          return `<li data-session="${s.id}">
            <span class="dot ${dotClass(s.status, 'session')}"></span>
            <span class="sess-id">${icon} ${short(s.id)}</span>
            <span class="sess-host">${s.status}</span>
            <span class="sess-age">${ageStr(s.started_at)}</span>
          </li>`;
        }).join('');
    ul.querySelectorAll('li[data-session]').forEach(li => {
      li.onclick = () => attachSession(li.dataset.session);
    });

    // wire actions
    $('hd-md').onclick   = () => openEditor(h.id, 'CLAUDE.md');
    $('hd-json').onclick = () => openEditor(h.id, 'settings.json');
    $('hd-close-detail').onclick = () => {
      state.selectedHost = null;
      setViewMode('session');
      render();
    };
    // editable display_name
    $('hd-display').onblur = async () => {
      const v = $('hd-display').textContent.trim();
      if (v === (h.display_name || h.name)) return;
      await patchHost(h.id, { display_name: v || null });
    };
    $('hd-display').onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('hd-display').blur(); }
    };
    // tag input
    const inp = $('hd-tag-input');
    inp.value = '';
    inp.onkeydown = async (e) => {
      if (e.key !== 'Enter') return;
      const v = inp.value.trim();
      if (!v) return;
      const updated = Array.from(new Set([...(h.capabilities || []), v]));
      await patchHost(h.id, { capabilities: updated });
      inp.value = '';
    };
  }

  async function patchHost(hostId, patch) {
    try {
      const r = await fetch('/api/fleet/hosts/' + hostId, {
        method: 'PATCH',
        headers: { 'authorization': 'Bearer ' + state.token, 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const updated = await r.json();
      // replace in state
      const idx = state.hosts.findIndex(x => x.id === hostId);
      if (idx >= 0) state.hosts[idx] = updated;
      render();
      if (state.viewMode === 'host' && state.selectedHost === hostId) renderHostDetail(updated);
    } catch (e) { alert('patch failed: ' + e.message); }
  }

  // ============ File editor ============
  async function openEditor(hostId, filePath) {
    const host = state.hosts.find(h => h.id === hostId);
    if (!host) return;
    if (host.status !== 'online') { alert(`host ${host.name} is offline`); return; }
    $('editor').hidden = false;
    $('editor-path').textContent = filePath;
    $('editor-host').textContent = host.name;
    $('editor-content').value = '';
    $('editor-content').disabled = true;
    $('editor-status').textContent = 'loading…';
    try {
      const r = await api('GET', `/hosts/${hostId}/file?path=${encodeURIComponent(filePath)}`);
      $('editor-content').value = r.content || '';
      $('editor-status').textContent = r.exists ? `loaded ${(r.content || '').length} bytes` : 'file does not exist (will create on save)';
    } catch (e) {
      $('editor-status').textContent = 'load failed: ' + e.message;
    } finally {
      $('editor-content').disabled = false;
      $('editor-content').focus();
    }
    $('editor-cancel').onclick = () => { $('editor').hidden = true; };
    $('editor-save').onclick = async () => {
      $('editor-save').disabled = true;
      $('editor-status').textContent = 'saving…';
      try {
        const r = await fetch('/api/fleet/hosts/' + hostId + '/file', {
          method: 'PUT',
          headers: { 'authorization': 'Bearer ' + state.token, 'content-type': 'application/json' },
          body: JSON.stringify({ path: filePath, content: $('editor-content').value }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        $('editor-status').textContent = `saved ${j.bytes} bytes`;
        setTimeout(() => { $('editor').hidden = true; }, 600);
      } catch (e) {
        $('editor-status').textContent = 'save failed: ' + e.message;
      } finally {
        $('editor-save').disabled = false;
      }
    };
  }

  // ============ Boot ============
  function boot() {
    readToken();
    if (!state.token) { showAuth(); return; }
    showApp();
    wireSpawn();
    $('reload').onclick = refresh;
    setOverlay(true, 'STANDBY', 'select a session');
    startPolling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();
