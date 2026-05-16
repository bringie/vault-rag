'use strict';
// workflow-run-viewer: live view of one fleet_workflow_runs row.
// Exposes: window.openWorkflowRunViewer(runId).
(function () {
  const API = '/fleet';

  function token() { return localStorage.fleetToken || ''; }

  async function api(path, opts = {}) {
    const headers = { 'authorization': `Bearer ${token()}` };
    if (opts.body) headers['content-type'] = 'application/json';
    const res = await fetch(API + path, { ...opts, headers });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { const j = await res.json(); msg += ' ' + (j.error || ''); } catch {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return null;
  }

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }
  function t(k, vars) { return window.fleetI18n ? window.fleetI18n.t(k, vars) : k; }

  let activeWs = null;
  // Generation counter: each open() bumps it; reconnect/timer callbacks check
  // their captured gen against current to bail out of stale loops. Prevents
  // WS leak when openWorkflowRunViewer is re-entered (e.g. fleet-langchange
  // → applyRoute → setPage re-invokes open).
  let gen = 0;
  let stopFlags = [];

  async function openWorkflowRunViewer(runId) {
    // Stop all prior reconnect loops; their setTimeout callbacks check stopped.
    for (const f of stopFlags) f.stopped = true;
    stopFlags = [];
    if (activeWs) { try { activeWs.close(); } catch {} activeWs = null; }
    const myGen = ++gen;
    let run;
    try { run = await api(`/workflow-runs/${runId}`); }
    catch (e) { document.getElementById('wf-run-detail').textContent = `Error: ${e.message}`; return; }
    let wf = null;
    if (run.workflow_id) {
      try { wf = await api(`/workflows/${run.workflow_id}`); } catch {}
    }
    document.getElementById('wf-run-title').textContent = wf ? wf.name : `RUN ${runId.slice(0, 8)}`;
    setStatus(run.status);

    const canvas = window.WorkflowCanvas.create({
      mount: document.getElementById('wf-run-canvas'),
      definition: run.snapshot,
      interactive: false,
      onSelect: (n) => renderDetail(n, run),
      statusByNode: extractStatusMap(run),
    });

    document.getElementById('wf-run-cancel').onclick = async () => {
      try { await api(`/workflow-runs/${runId}/cancel`, { method: 'POST' }); }
      catch (e) { alert(e.message); }
    };
    document.getElementById('wf-run-rerun').onclick = async () => {
      if (!run.workflow_id) return alert(t('workflows.wf_deleted_cant_rerun'));
      try {
        const r = await api(`/workflows/${run.workflow_id}/run`, { method: 'POST', body: '{}' });
        location.hash = `#/workflow-runs/${r.run_id}`;
      } catch (e) { alert(e.message); }
    };

    const flag = { stopped: false };
    stopFlags.push(flag);
    let backoff = 800;
    const connectStream = async () => {
      if (flag.stopped || gen !== myGen) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      // Use /api/fleet prefix consistently with the session viewer (see app.js).
      // The server's attachUpgrade handler accepts both, but reverse-proxy
      // deployments may only forward /api/* upstream.
      const url = `${proto}//${location.host}/api/fleet/ws?role=workflow_viewer&run_id=${runId}`;
      // vt-0136: ticket subprotocol with graceful fallback to bearer.<token>
      // for servers that haven't deployed the ticket endpoint yet.
      let subProto = [`bearer.${token()}`];
      try {
        const r = await fetch('/api/fleet/auth/ws-ticket', {
          method: 'POST',
          headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'workflow_viewer' }),
        });
        if (r.ok) {
          const j = await r.json();
          if (j.ticket) subProto = [`ticket.${j.ticket}`];
        }
      } catch {}
      if (flag.stopped || gen !== myGen) return;
      const ws = new WebSocket(url, subProto);
      activeWs = ws;
      ws.onopen = () => { backoff = 800; };
      ws.onmessage = (ev) => {
        if (flag.stopped || gen !== myGen) return;
        let f;
        try { f = JSON.parse(ev.data); } catch { return; }
        if (f.type === 'run_state') {
          setStatus(f.status);
          run.status = f.status;
        } else if (f.type === 'node_progress') {
          canvas.setNodeStatus(f.node_id, f.status);
          if (!run.state.outputs) run.state.outputs = {};
          if (f.status === 'done') {
            run.state.outputs[f.node_id] = { output: f.output, exit_code: f.exit_code, session_id: f.session_id };
          }
          if (f.status === 'failed') {
            run.state.outputs[f.node_id] = { error: f.error };
          }
        }
      };
      ws.onerror = (e) => { console.warn('[workflow-viewer] ws error:', e?.message || e); };
      ws.onclose = (ev) => {
        if (flag.stopped || gen !== myGen || ev.code === 4001) return;
        const wait = Math.min(backoff *= 1.7, 8000);
        setTimeout(async () => {
          if (flag.stopped || gen !== myGen) return;
          try {
            const fresh = await api(`/workflow-runs/${runId}`);
            run = fresh;
            setStatus(run.status);
          } catch {}
          connectStream();
        }, wait);
      };
    };
    connectStream();
    const closeWs = () => {
      flag.stopped = true;
      try { activeWs && activeWs.close(); } catch {}
      activeWs = null;
    };
    window.addEventListener('hashchange', closeWs, { once: true });
  }

  function setStatus(s) {
    const el = document.getElementById('wf-run-status');
    if (!el) return;
    el.textContent = t('workflows.run_status.' + s);
    el.className = `wf-run-status-${s}`;
    const cancelBtn = document.getElementById('wf-run-cancel');
    const rerunBtn  = document.getElementById('wf-run-rerun');
    if (cancelBtn) cancelBtn.hidden = s !== 'running' && s !== 'pending';
    if (rerunBtn)  rerunBtn.hidden  = !(s === 'done' || s === 'failed' || s === 'cancelled');
  }

  function extractStatusMap(run) {
    const out = {};
    const outputs = (run.state && run.state.outputs) || {};
    for (const id of Object.keys(outputs)) {
      out[id] = outputs[id].error ? 'failed' : 'done';
    }
    if (run.state && run.state.current_node && !out[run.state.current_node] && run.status === 'running') {
      out[run.state.current_node] = 'running';
    }
    return out;
  }

  function renderDetail(node, run) {
    const d = document.getElementById('wf-run-detail');
    if (!node) { d.textContent = t('workflows.click_node'); return; }
    const out = (run.state && run.state.outputs && run.state.outputs[node.id]) || null;
    let body = `<h3>${esc(node.id)} (${esc(node.type)})</h3>`;
    if (node.type === 'claude') {
      const tg = node.target || {};
      const target =
        tg.group     ? t('wf_inspect.target_group', { name: tg.group }) :
        tg.host_name ? t('wf_inspect.target_host',  { name: tg.host_name }) :
        tg.capability? t('wf_inspect.target_cap',   { name: tg.capability }) :
        t('wf_inspect.no_target');
      body += `<label>${esc(t('wf_inspect.target'))}</label><pre>${esc(target)}</pre>`;
      body += `<label>${esc(t('wf_inspect.prompt'))}</label><pre>${esc(node.prompt || '')}</pre>`;
    } else if (node.type === 'branch') {
      body += `<label>${esc(t('wf_inspect.condition'))}</label><pre>${esc(node.condition || '')}</pre>`;
    } else if (node.type === 'delay') {
      body += `<label>${esc(t('wf_inspect.seconds'))}</label><pre>${node.seconds || 0}</pre>`;
    }
    if (out) {
      if (out.error) {
        body += `<label>${esc(t('wf_inspect.error'))}</label><pre style="color:var(--danger)">${esc(out.error)}</pre>`;
      } else {
        body += `<label>${esc(t('wf_inspect.output'))}</label><pre style="max-height:300px; overflow:auto">${esc((out.output || '').slice(0, 5000))}</pre>`;
        if (out.exit_code !== undefined && out.exit_code !== null) {
          body += `<label>${esc(t('wf_inspect.exit_code'))}</label><pre>${out.exit_code}</pre>`;
        }
        if (out.session_id) {
          body += `<a href="#/sessions/${out.session_id}">${esc(t('workflows.open_session'))}</a>`;
        }
      }
    } else {
      body += `<p style="color:var(--text-dim)"><i>${esc(t('workflows.not_yet_executed'))}</i></p>`;
    }
    d.innerHTML = body;
  }

  window.openWorkflowRunViewer = openWorkflowRunViewer;
})();
