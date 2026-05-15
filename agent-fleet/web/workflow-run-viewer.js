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

  let activeWs = null;

  async function openWorkflowRunViewer(runId) {
    if (activeWs) { try { activeWs.close(); } catch {} activeWs = null; }
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
      if (!run.workflow_id) return alert('workflow deleted; cannot re-run');
      try {
        const r = await api(`/workflows/${run.workflow_id}/run`, { method: 'POST', body: '{}' });
        location.hash = `#/workflow-runs/${r.run_id}`;
      } catch (e) { alert(e.message); }
    };

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/fleet/ws?role=workflow_viewer&run_id=${runId}`;
    activeWs = new WebSocket(url, [`bearer.${token()}`]);
    activeWs.onmessage = (ev) => {
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
    activeWs.onerror = () => {};
    const closeWs = () => { try { activeWs && activeWs.close(); } catch {} activeWs = null; };
    window.addEventListener('hashchange', closeWs, { once: true });
  }

  function setStatus(s) {
    const el = document.getElementById('wf-run-status');
    if (!el) return;
    el.textContent = s;
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
    if (!node) { d.innerHTML = 'Click a node for details.'; return; }
    const out = (run.state && run.state.outputs && run.state.outputs[node.id]) || null;
    let body = `<h3>${esc(node.id)} (${esc(node.type)})</h3>`;
    if (node.type === 'claude') {
      const t = node.target || {};
      const target = t.group ? `group: ${t.group}` : t.host_name ? `host: ${t.host_name}` : t.capability ? `cap: ${t.capability}` : '(no target)';
      body += `<label>target</label><pre>${esc(target)}</pre>`;
      body += `<label>prompt</label><pre>${esc(node.prompt || '')}</pre>`;
    } else if (node.type === 'branch') {
      body += `<label>condition</label><pre>${esc(node.condition || '')}</pre>`;
    } else if (node.type === 'delay') {
      body += `<label>seconds</label><pre>${node.seconds || 0}</pre>`;
    }
    if (out) {
      if (out.error) {
        body += `<label>error</label><pre style="color:var(--danger)">${esc(out.error)}</pre>`;
      } else {
        body += `<label>output</label><pre style="max-height:300px; overflow:auto">${esc((out.output || '').slice(0, 5000))}</pre>`;
        if (out.exit_code !== undefined && out.exit_code !== null) {
          body += `<label>exit_code</label><pre>${out.exit_code}</pre>`;
        }
        if (out.session_id) {
          body += `<a href="#/sessions/${out.session_id}">Open session →</a>`;
        }
      }
    } else {
      body += `<p style="color:var(--text-dim)"><i>not yet executed</i></p>`;
    }
    d.innerHTML = body;
  }

  window.openWorkflowRunViewer = openWorkflowRunViewer;
})();
