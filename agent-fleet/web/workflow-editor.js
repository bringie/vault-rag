'use strict';
// workflow-editor: list page + edit page.
// Exposes: window.openWorkflowsList, window.openWorkflowEditor.
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

  async function openWorkflowsList() {
    const view = document.getElementById('workflowsview');
    if (!view) return;
    const body = document.getElementById('wf-list-body');
    body.textContent = t('workflows.loading');
    try {
      const list = await api('/workflows');
      if (!list || !list.length) {
        body.innerHTML = `<p style="padding:1em;color:var(--text-dim)">${esc(t('workflows.empty'))}</p>`;
      } else {
        body.innerHTML = `<table class="wf-runs-table">
          <thead><tr><th>${esc(t('workflows.col.name'))}</th><th>${esc(t('workflows.col.nodes'))}</th><th>${esc(t('workflows.col.updated'))}</th><th>${esc(t('workflows.col.actions'))}</th></tr></thead>
          <tbody>${list.map(w => `
            <tr>
              <td>${esc(w.name)}</td>
              <td>${w.n_nodes || 0}</td>
              <td>${new Date(w.updated_at).toLocaleString()}</td>
              <td>
                <button data-edit="${w.id}">${esc(t('workflows.btn.edit'))}</button>
                <button data-run="${w.id}">${esc(t('workflows.btn.run'))}</button>
                <button data-del="${w.id}">${esc(t('workflows.btn.delete'))}</button>
              </td>
            </tr>`).join('')}</tbody></table>`;
        body.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => location.hash = `#/workflows/${b.dataset.edit}/edit`);
        body.querySelectorAll('[data-run]').forEach(b => b.onclick = async () => {
          try {
            const r = await api(`/workflows/${b.dataset.run}/run`, { method: 'POST', body: '{}' });
            location.hash = `#/workflow-runs/${r.run_id}`;
          } catch (e) { alert(e.message); }
        });
        body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
          if (!confirm(t('workflows.delete_confirm'))) return;
          try { await api(`/workflows/${b.dataset.del}`, { method: 'DELETE' }); openWorkflowsList(); }
          catch (e) { alert(e.message); }
        });
      }
    } catch (e) {
      body.textContent = t('workflows.error_prefix', { msg: e.message });
    }
  }

  async function openWorkflowEditor(id) {
    const errEl = document.getElementById('wf-errors');
    errEl.textContent = '';
    let wf;
    if (id === 'new') {
      const name = prompt(t('workflows.name_prompt'), `wf-${Date.now()}`);
      if (!name) { location.hash = '#/workflows'; return; }
      try {
        wf = await api('/workflows', {
          method: 'POST',
          body: JSON.stringify({
            name,
            definition: {
              start: 'n1',
              nodes: [{ id: 'n1', type: 'delay', seconds: 1, position: { x: 200, y: 200 } }],
              edges: [],
            },
          }),
        });
      } catch (e) { errEl.textContent = e.message; location.hash = '#/workflows'; return; }
      location.hash = `#/workflows/${wf.id}/edit`;
      return;
    } else {
      try { wf = await api(`/workflows/${id}`); }
      catch (e) { errEl.textContent = e.message; return; }
    }

    let definition = wf.definition;
    const pane = document.getElementById('wf-canvas-pane');
    let canvas = window.WorkflowCanvas.create({
      mount: pane,
      definition,
      interactive: true,
      onSelect: renderInspector,
      onDefinitionChange: (d) => { definition = d; },
    });

    document.getElementById('wf-add-claude').onclick = () => canvas.addNode(newNode('claude'));
    document.getElementById('wf-add-branch').onclick = () => canvas.addNode(newNode('branch'));
    document.getElementById('wf-add-delay').onclick  = () => canvas.addNode(newNode('delay'));
    document.getElementById('wf-back').onclick       = () => location.hash = '#/workflows';

    document.getElementById('wf-save').onclick = async () => {
      definition = canvas.getDefinition();
      // Auto-set start if missing
      if (!definition.start && definition.nodes.length) definition.start = definition.nodes[0].id;
      try {
        await api(`/workflows/${id}`, { method: 'PATCH', body: JSON.stringify({ definition }) });
        errEl.textContent = t('workflows.saved');
        errEl.style.color = 'var(--ok)';
        setTimeout(() => { errEl.textContent = ''; errEl.style.color = 'var(--danger)'; }, 1500);
      } catch (e) {
        errEl.textContent = e.message;
        errEl.style.color = 'var(--danger)';
      }
    };

    document.getElementById('wf-run').onclick = async () => {
      definition = canvas.getDefinition();
      if (!definition.start && definition.nodes.length) definition.start = definition.nodes[0].id;
      try {
        await api(`/workflows/${id}`, { method: 'PATCH', body: JSON.stringify({ definition }) });
        const r = await api(`/workflows/${id}/run`, { method: 'POST', body: '{}' });
        location.hash = `#/workflow-runs/${r.run_id}`;
      } catch (e) {
        errEl.textContent = e.message;
      }
    };

    function newNode(type) {
      const d = canvas.getDefinition();
      const idx = d.nodes.length + 1;
      const newId = `n${idx}`;
      const x = 120 + (d.nodes.length % 5) * 200;
      const y = 100 + Math.floor(d.nodes.length / 5) * 120;
      const base = { id: newId, type, position: { x, y } };
      if (type === 'claude') return { ...base, target: { group: '' }, prompt: '', timeout_s: 300, headless: true };
      if (type === 'branch') return { ...base, condition: 'true' };
      if (type === 'delay')  return { ...base, seconds: 10 };
      return base;
    }

    function renderInspector(node) {
      const insp = document.getElementById('wf-inspector');
      if (!node) { insp.textContent = t('workflows.select_node'); return; }
      const d = canvas.getDefinition();
      const cur = d.nodes.find(n => n.id === node.id);
      if (!cur) return;
      if (cur.type === 'claude') {
        insp.innerHTML = `
          <h3>${esc(cur.id)} (claude)</h3>
          <label>${esc(t('wf_inspect.group'))}</label><input id="i-group" value="${esc((cur.target||{}).group || '')}" placeholder="e.g. backend">
          <label>${esc(t('wf_inspect.host_name'))}</label><input id="i-host" value="${esc((cur.target||{}).host_name || '')}">
          <label>${esc(t('wf_inspect.capability'))}</label><input id="i-cap" value="${esc((cur.target||{}).capability || '')}">
          <label>${esc(t('wf_inspect.prompt_hint'))}</label>
          <textarea id="i-prompt">${esc(cur.prompt || '')}</textarea>
          <label>${esc(t('wf_inspect.timeout_s'))}</label><input id="i-timeout" type="number" value="${cur.timeout_s || 300}">
          <label><input id="i-headless" type="checkbox" ${cur.headless !== false ? 'checked' : ''}> ${esc(t('wf_inspect.headless'))}</label>
        `;
        wireInputs(cur.id, ['group','host','cap','prompt','timeout','headless']);
      } else if (cur.type === 'branch') {
        insp.innerHTML = `
          <h3>${esc(cur.id)} (branch)</h3>
          <label>${esc(t('wf_inspect.condition_hint'))}</label>
          <textarea id="i-cond">${esc(cur.condition || '')}</textarea>
          <p style="color:var(--text-dim); font-size:11px">${esc(t('wf_inspect.condition_two_edges'))}</p>
        `;
        wireInputs(cur.id, ['cond']);
      } else if (cur.type === 'delay') {
        insp.innerHTML = `
          <h3>${esc(cur.id)} (delay)</h3>
          <label>${esc(t('wf_inspect.seconds'))}</label><input id="i-sec" type="number" value="${cur.seconds || 0}">
        `;
        wireInputs(cur.id, ['sec']);
      }
    }

    function wireInputs(nodeId, keys) {
      for (const k of keys) {
        const elInp = document.getElementById(`i-${k}`);
        if (!elInp) continue;
        elInp.onblur = elInp.onchange = () => {
          const d = canvas.getDefinition();
          const cur = d.nodes.find(n => n.id === nodeId);
          if (!cur) return;
          if (k === 'group')    { cur.target = cur.target || {}; cur.target.group    = elInp.value || undefined; }
          if (k === 'host')     { cur.target = cur.target || {}; cur.target.host_name = elInp.value || undefined; }
          if (k === 'cap')      { cur.target = cur.target || {}; cur.target.capability = elInp.value || undefined; }
          if (k === 'prompt')   cur.prompt = elInp.value;
          if (k === 'timeout')  cur.timeout_s = parseInt(elInp.value, 10) || 300;
          if (k === 'headless') cur.headless = elInp.checked;
          if (k === 'cond')     cur.condition = elInp.value;
          if (k === 'sec')      cur.seconds = parseInt(elInp.value, 10) || 0;
          canvas.replaceDefinition(d);
          definition = d;
        };
      }
    }
  }

  window.openWorkflowsList = openWorkflowsList;
  window.openWorkflowEditor = openWorkflowEditor;
})();
