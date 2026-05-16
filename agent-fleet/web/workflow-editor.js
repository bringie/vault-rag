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
  function relTime(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return new Date(iso).toLocaleString();
    const s = Math.floor(ms / 1000);
    if (s < 60)    return s + 's ago';
    if (s < 3600)  return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

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
        body.innerHTML = `<table class="wf-runs-table archive-table">
          <thead><tr>
            <th>${esc(t('workflows.col.name'))}</th>
            <th>${esc(t('workflows.col.nodes'))}</th>
            <th>${esc(t('workflows.col.updated'))}</th>
            <th>${esc(t('workflows.col.last_run'))}</th>
            <th>${esc(t('workflows.col.status'))}</th>
            <th>${esc(t('workflows.col.failed_at'))}</th>
            <th>${esc(t('workflows.col.actions'))}</th>
          </tr></thead>
          <tbody>${list.map(w => `
            <tr class="row-clickable" data-edit="${w.id}">
              <td>${esc(w.name)}</td>
              <td>${w.n_nodes || 0}</td>
              <td>${new Date(w.updated_at).toLocaleString()}</td>
              <td class="nowrap">${w.last_finished ? esc(relTime(w.last_finished)) : '—'}</td>
              <td>${w.last_status ? `<span class="wf-run-status-${esc(w.last_status)}">${esc(t('workflows.run_status.' + w.last_status))}</span>` : '—'}</td>
              <td>${w.last_failed_node ? `<code>${esc(w.last_failed_node)}</code>` : '—'}</td>
              <td>
                <button class="btn-row" data-run="${w.id}">${esc(t('workflows.btn.run'))}</button>
                <button class="btn-row" data-del="${w.id}">${esc(t('workflows.btn.delete'))}</button>
              </td>
            </tr>`).join('')}</tbody></table>`;
        body.querySelectorAll('tr[data-edit]').forEach(tr => {
          tr.onclick = (ev) => {
            if (ev.target.closest('[data-run]') || ev.target.closest('[data-del]')) return;
            location.hash = `#/workflows/${tr.dataset.edit}/edit`;
          };
        });
        body.querySelectorAll('[data-run]').forEach(b => b.onclick = async (ev) => {
          ev.stopPropagation();
          try {
            const r = await api(`/workflows/${b.dataset.run}/run`, { method: 'POST', body: '{}' });
            location.hash = `#/workflow-runs/${r.run_id}`;
          } catch (e) { alert(e.message); }
        });
        body.querySelectorAll('[data-del]').forEach(b => b.onclick = async (ev) => {
          ev.stopPropagation();
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
    document.getElementById('wf-add-transform')   ?.addEventListener('click', () => canvas.addNode(newNode('transform')));
    document.getElementById('wf-add-http')        ?.addEventListener('click', () => canvas.addNode(newNode('http_request')));
    document.getElementById('wf-add-notify')      ?.addEventListener('click', () => canvas.addNode(newNode('notify')));
    document.getElementById('wf-add-set-variable')?.addEventListener('click', () => canvas.addNode(newNode('set_variable')));
    document.getElementById('wf-add-fan-out')     ?.addEventListener('click', () => canvas.addNode(newNode('fan_out')));
    document.getElementById('wf-add-aggregate')   ?.addEventListener('click', () => canvas.addNode(newNode('aggregate')));
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
      if (type === 'claude')       return { ...base, target: { group: '' }, prompt: '', timeout_s: 300, headless: true };
      if (type === 'branch')       return { ...base, condition: 'true' };
      if (type === 'delay')        return { ...base, seconds: 10 };
      if (type === 'transform')    return { ...base, expr: 'ctx => ctx.n1 && ctx.n1.output' };
      if (type === 'http_request') return { ...base, method: 'GET', url: 'https://', headers: {}, body: null, timeout_ms: 30000 };
      if (type === 'notify')       return { ...base, webhook_url: '', message_template: '' };
      if (type === 'set_variable') return { ...base, key: 'name', value_expr: '"value"' };
      if (type === 'fan_out')      return { ...base, targets: [], prompt: '', model: '', timeout_s: 300, headless: true };
      if (type === 'aggregate')    return { ...base, input_ref: '', op: 'concat' };
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
      } else if (cur.type === 'transform') {
        insp.innerHTML = `
          <h3>${esc(cur.id)} (transform)</h3>
          <label>${esc(t('wf_inspect.expr_hint'))}</label>
          <textarea id="i-expr">${esc(cur.expr || '')}</textarea>
        `;
        wireInputs(cur.id, ['expr']);
      } else if (cur.type === 'http_request') {
        insp.innerHTML = `
          <h3>${esc(cur.id)} (http_request)</h3>
          <label>method</label>
          <select id="i-method">
            ${['GET','POST','PUT','PATCH','DELETE'].map(m =>
              `<option value="${m}" ${cur.method===m?'selected':''}>${m}</option>`).join('')}
          </select>
          <label>url (supports {{n1.output}})</label><input id="i-url" value="${esc(cur.url || '')}">
          <label>headers (JSON)</label>
          <textarea id="i-headers" rows="2">${esc(JSON.stringify(cur.headers || {}))}</textarea>
          <label>body (string or JSON; templated)</label>
          <textarea id="i-body" rows="3">${esc(typeof cur.body === 'string' ? cur.body : JSON.stringify(cur.body || ''))}</textarea>
          <label>timeout_ms</label><input id="i-timeout-ms" type="number" value="${cur.timeout_ms || 30000}">
        `;
        wireInputs(cur.id, ['method','url','headers','body','timeout-ms']);
      } else if (cur.type === 'notify') {
        insp.innerHTML = `
          <h3>${esc(cur.id)} (notify)</h3>
          <label>webhook_url</label><input id="i-webhook" value="${esc(cur.webhook_url || '')}">
          <label>message_template (supports {{n1.output}})</label>
          <textarea id="i-msg" rows="3">${esc(cur.message_template || '')}</textarea>
        `;
        wireInputs(cur.id, ['webhook','msg']);
      } else if (cur.type === 'set_variable') {
        insp.innerHTML = `
          <h3>${esc(cur.id)} (set_variable)</h3>
          <label>key (becomes inputs.<i>key</i>)</label><input id="i-key" value="${esc(cur.key || '')}">
          <label>value_expr (JS; sees ctx vars)</label>
          <textarea id="i-value-expr" rows="2">${esc(cur.value_expr || '')}</textarea>
        `;
        wireInputs(cur.id, ['key','value-expr']);
      } else if (cur.type === 'fan_out') {
        insp.innerHTML = `
          <h3>${esc(cur.id)} (fan_out)</h3>
          <label>targets (JSON array of {group}|{host_name}|{capability})</label>
          <textarea id="i-targets" rows="3">${esc(JSON.stringify(cur.targets || [], null, 2))}</textarea>
          <label>prompt (sent to each target; templated)</label>
          <textarea id="i-prompt-fan">${esc(cur.prompt || '')}</textarea>
          <label>model (optional)</label><input id="i-model" value="${esc(cur.model || '')}">
          <label>timeout_s (per child)</label><input id="i-timeout-fan" type="number" value="${cur.timeout_s || 300}">
        `;
        wireInputs(cur.id, ['targets','prompt-fan','model','timeout-fan']);
      } else if (cur.type === 'aggregate') {
        insp.innerHTML = `
          <h3>${esc(cur.id)} (aggregate)</h3>
          <label>input_ref (id of a fan_out node, e.g. n2)</label>
          <input id="i-ref" value="${esc(cur.input_ref || '')}">
          <label>op</label>
          <select id="i-op">
            ${['concat','count_exit','first_success','all_outputs'].map(o =>
              `<option value="${o}" ${cur.op===o?'selected':''}>${o}</option>`).join('')}
          </select>
        `;
        wireInputs(cur.id, ['ref','op']);
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
          if (k === 'cond')         cur.condition = elInp.value;
          if (k === 'sec')          cur.seconds = parseInt(elInp.value, 10) || 0;
          // transform
          if (k === 'expr')         cur.expr = elInp.value;
          // http_request
          if (k === 'method')       cur.method = elInp.value;
          if (k === 'url')          cur.url = elInp.value;
          if (k === 'headers')      { try { cur.headers = JSON.parse(elInp.value || '{}'); } catch {} }
          if (k === 'body')         { try { cur.body = JSON.parse(elInp.value); } catch { cur.body = elInp.value; } }
          if (k === 'timeout-ms')   cur.timeout_ms = parseInt(elInp.value, 10) || 30000;
          // notify
          if (k === 'webhook')      cur.webhook_url = elInp.value;
          if (k === 'msg')          cur.message_template = elInp.value;
          // set_variable
          if (k === 'key')          cur.key = elInp.value;
          if (k === 'value-expr')   cur.value_expr = elInp.value;
          // fan_out
          if (k === 'targets')      { try { cur.targets = JSON.parse(elInp.value || '[]'); } catch {} }
          if (k === 'prompt-fan')   cur.prompt = elInp.value;
          if (k === 'model')        cur.model = elInp.value || undefined;
          if (k === 'timeout-fan')  cur.timeout_s = parseInt(elInp.value, 10) || 300;
          // aggregate
          if (k === 'ref')          cur.input_ref = elInp.value;
          if (k === 'op')           cur.op = elInp.value;
          canvas.replaceDefinition(d);
          definition = d;
        };
      }
    }
  }

  window.openWorkflowsList = openWorkflowsList;
  window.openWorkflowEditor = openWorkflowEditor;
})();
