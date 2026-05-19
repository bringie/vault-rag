'use strict';
// prices: #/prices page logic. Global: window.openPricesView.
(function () {
  function token() { return localStorage.fleetToken || ''; }
  async function api(path, opts = {}) {
    const headers = { 'authorization': `Bearer ${token()}` };
    if (opts.body) headers['content-type'] = 'application/json';
    const res = await fetch('/fleet' + path, { ...opts, headers });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { const j = await res.json(); msg += ' ' + (j.error || ''); } catch {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }
  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  async function openPricesView() {
    const histEl = document.getElementById('px-history');
    document.getElementById('pricesview-close').onclick = () => location.hash = '#/dashboard';
    histEl.onchange = openPricesView;
    document.getElementById('px-new').onclick = () => openEditModal(null);
    await loadPrices(histEl.checked);
  }

  async function loadPrices(showHistory) {
    let rows;
    try { rows = await api('/prices' + (showHistory ? '?history=1' : '')); }
    catch (e) {
      document.getElementById('px-rows').innerHTML = `<tr><td colspan="9" style="color:var(--danger); padding:1em">Error: ${esc(e.message)}</td></tr>`;
      return;
    }
    document.getElementById('prices-count').textContent = `${rows.length} rules`;
    const body = document.getElementById('px-rows');
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:2em;color:var(--text-faint)">no pricing rules</td></tr>';
      return;
    }
    body.innerHTML = rows.map(r => {
      const dimmed = r.deleted_at ? 'opacity:0.4' : '';
      return `<tr class="row-clickable" data-edit="${r.id}" style="${dimmed}">
        <td><strong>${esc(r.match_pattern)}</strong></td>
        <td>${r.priority}</td>
        <td>${new Date(r.valid_from).toISOString().slice(0,10)}</td>
        <td>${Number(r.input_per_mtok).toFixed(2)}</td>
        <td>${Number(r.output_per_mtok).toFixed(2)}</td>
        <td>${Number(r.cache_create_per_mtok).toFixed(2)}</td>
        <td>${Number(r.cache_read_per_mtok).toFixed(2)}</td>
        <td>${r.flagged ? '<span class="chip chip-warn">⚠ fallback</span>' : ''}</td>
        <td>
          ${r.deleted_at ? '' : `<button class="btn-row" data-del="${r.id}" title="delete">×</button>`}
        </td>
      </tr>`;
    }).join('');
    body.querySelectorAll('tr[data-edit]').forEach(tr => tr.onclick = (ev) => {
      // ignore clicks on inner controls (delete button)
      if (ev.target.closest('[data-del]')) return;
      const row = rows.find(x => String(x.id) === tr.dataset.edit);
      openEditModal(row);
    });
    body.querySelectorAll('[data-del]').forEach(b => b.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm('soft-delete this price row?')) return;
      try { await api(`/prices/${b.dataset.del}`, { method: 'DELETE' }); }
      catch (e) { alert(e.message); }
      await loadPrices(document.getElementById('px-history').checked);
    });
  }

  function openEditModal(existing) {
    const modal = document.getElementById('price-modal');
    if (!modal) return alert('price-modal element missing');
    modal.hidden = false;
    const r = existing || { match_pattern: '', priority: 100, input_per_mtok: 0, output_per_mtok: 0, cache_create_per_mtok: 0, cache_read_per_mtok: 0, note: '' };
    modal.innerHTML = `
      <div class="gd-frame" style="width:520px">
        <div class="gd-head">
          <span class="display" style="font-size:1.1em">${existing ? 'NEW SNAPSHOT // ' + esc(r.match_pattern) : 'NEW PRICING RULE'}</span>
          <span style="flex:1"></span>
          <button class="btn-ghost" data-pm-close>× close</button>
        </div>
        <div class="gd-body">
          <p style="color:var(--text-dim); font-size:11px; margin-top:0">
            ${existing
              ? 'Saving creates a NEW row with valid_from=now. Old row stays for history.'
              : 'Pattern uses Postgres LIKE: % = any chars, _ = single. Examples: claude-opus-%, gpt-4o%, %'}
          </p>
          <label class="lbl">pattern</label><input id="pm-pattern" type="text" value="${esc(r.match_pattern)}"/>
          <label class="lbl">priority (higher wins)</label><input id="pm-priority" type="number" value="${r.priority}"/>
          <label class="lbl">input $/Mtok</label><input id="pm-input" type="number" step="0.0001" value="${Number(r.input_per_mtok)}"/>
          <label class="lbl">output $/Mtok</label><input id="pm-output" type="number" step="0.0001" value="${Number(r.output_per_mtok)}"/>
          <label class="lbl">cache_create $/Mtok</label><input id="pm-cc" type="number" step="0.0001" value="${Number(r.cache_create_per_mtok || 0)}"/>
          <label class="lbl">cache_read $/Mtok</label><input id="pm-cr" type="number" step="0.0001" value="${Number(r.cache_read_per_mtok || 0)}"/>
          <label class="lbl">note (optional)</label><input id="pm-note" type="text" value="${esc(r.note || '')}"/>
          <div style="margin-top:1em; display:flex; gap:.5em">
            <button class="btn-ghost" data-pm-save>save (new snapshot)</button>
            <button class="btn-ghost" data-pm-close>cancel</button>
          </div>
          <div id="pm-error" style="color:var(--danger); margin-top:.5em; min-height:1em"></div>
        </div>
      </div>
    `;
    modal.querySelectorAll('[data-pm-close]').forEach(b => b.onclick = () => { modal.hidden = true; });
    modal.querySelector('[data-pm-save]').onclick = async () => {
      const body = {
        match_pattern: document.getElementById('pm-pattern').value.trim(),
        priority: parseInt(document.getElementById('pm-priority').value, 10),
        input_per_mtok: parseFloat(document.getElementById('pm-input').value),
        output_per_mtok: parseFloat(document.getElementById('pm-output').value),
        cache_create_per_mtok: parseFloat(document.getElementById('pm-cc').value),
        cache_read_per_mtok: parseFloat(document.getElementById('pm-cr').value),
        note: document.getElementById('pm-note').value.trim() || undefined,
      };
      try {
        await api('/prices', { method: 'POST', body: JSON.stringify(body) });
        modal.hidden = true;
        await loadPrices(document.getElementById('px-history').checked);
      } catch (e) {
        document.getElementById('pm-error').textContent = e.message;
      }
    };
  }

  window.openPricesView = openPricesView;
})();
