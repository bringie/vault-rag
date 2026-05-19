'use strict';
// vt-0367: agent-roles page logic — aligned with prices.js / groups
// pattern. Row-clickable list, single × delete action, pop-up modal
// for create/edit. Global: window.openAgentRolesView.
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

  async function openAgentRolesView() {
    document.getElementById('agentrolesview-close').onclick = () => location.hash = '#/dashboard';
    document.getElementById('ar-new').onclick = () => openEditModal(null);
    await loadRoles();
  }

  async function loadRoles() {
    const body = document.getElementById('agent-roles-rows');
    const countEl = document.getElementById('agent-roles-count');
    body.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:1em;color:var(--text-dim)">loading…</td></tr>`;
    let roles;
    try { roles = await api('/agent-roles'); }
    catch (e) {
      body.innerHTML = `<tr><td colspan="4" style="color:var(--danger); padding:1em">Error: ${esc(e.message)}</td></tr>`;
      countEl.textContent = '—';
      return;
    }
    countEl.textContent = `${roles.length} roles`;
    if (!roles.length) {
      body.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:2em;color:var(--text-faint)">no roles yet — create one</td></tr>';
      return;
    }

    // vt-0435: folder-tree by category. Each category renders as a
    // toggleable header row; clicking the header collapses/expands its
    // role rows. Active category state survives reloads via localStorage.
    const groups = new Map();  // category → roles[]
    for (const r of roles) {
      const cat = r.category || 'general';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(r);
    }
    const sortedCats = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    let openCats;
    try {
      const stored = localStorage.getItem('arOpenCats');
      openCats = stored ? new Set(JSON.parse(stored)) : new Set(sortedCats);
    } catch { openCats = new Set(sortedCats); }

    const html = [];
    for (const cat of sortedCats) {
      const items = groups.get(cat);
      const open = openCats.has(cat);
      html.push(`<tr class="ar-cat-header" data-cat="${esc(cat)}" data-open="${open ? '1' : '0'}">
        <td colspan="4" style="padding:6px 10px; background:rgba(255,255,255,0.025); cursor:pointer; user-select:none; letter-spacing:.05em">
          <span class="ar-cat-chevron" style="display:inline-block; transition:transform 120ms; transform:rotate(${open ? '90' : '0'}deg)">▸</span>
          <strong style="margin-left:8px; text-transform:uppercase">${esc(cat)}</strong>
          <span class="lbl" style="margin-left:8px; color:var(--text-faint)">${items.length} role${items.length === 1 ? '' : 's'}</span>
        </td>
      </tr>`);
      for (const r of items) {
        html.push(`<tr class="row-clickable ar-cat-row" data-cat-row="${esc(cat)}" data-edit="${esc(r.id)}" style="${open ? '' : 'display:none'}">
          <td style="padding-left:32px"><strong>${esc(r.name)}</strong></td>
          <td>${esc(r.description || '—')}</td>
          <td><code>${esc(r.default_model || '—')}</code></td>
          <td><button class="btn-row" data-del="${esc(r.id)}" title="delete">×</button></td>
        </tr>`);
      }
    }
    body.innerHTML = html.join('');

    function persistOpenCats() {
      try { localStorage.setItem('arOpenCats', JSON.stringify([...openCats])); } catch {}
    }
    body.querySelectorAll('.ar-cat-header').forEach(hdr => {
      hdr.onclick = () => {
        const cat = hdr.dataset.cat;
        const wasOpen = hdr.dataset.open === '1';
        const willOpen = !wasOpen;
        hdr.dataset.open = willOpen ? '1' : '0';
        const ch = hdr.querySelector('.ar-cat-chevron');
        if (ch) ch.style.transform = `rotate(${willOpen ? '90' : '0'}deg)`;
        body.querySelectorAll(`[data-cat-row="${CSS.escape(cat)}"]`).forEach(r => {
          r.style.display = willOpen ? '' : 'none';
        });
        if (willOpen) openCats.add(cat); else openCats.delete(cat);
        persistOpenCats();
      };
    });
    body.querySelectorAll('tr[data-edit]').forEach(tr => tr.onclick = (ev) => {
      // Row-click → edit; the × button stops propagation so it doesn't bubble here.
      if (ev.target.closest('[data-del]')) return;
      const r = roles.find(x => x.id === tr.dataset.edit);
      if (r) openEditModal(r);
    });
    body.querySelectorAll('[data-del]').forEach(b => b.onclick = async (ev) => {
      ev.stopPropagation();
      const r = roles.find(x => x.id === b.dataset.del);
      if (!confirm(`delete role "${r?.name}"?`)) return;
      try { await api(`/agent-roles/${b.dataset.del}`, { method: 'DELETE' }); }
      catch (e) { alert(e.message); }
      await loadRoles();
    });
  }

  function openEditModal(existing) {
    const modal = document.getElementById('agent-role-modal');
    if (!modal) return alert('agent-role-modal element missing');
    modal.hidden = false;
    const r = existing || { name: '', description: '', prompt: '', default_model: '' };
    const isNew = !existing;
    modal.innerHTML = `
      <div class="gd-frame" style="width:640px">
        <div class="gd-head">
          <span class="display" style="font-size:1.1em">${isNew ? 'NEW AGENT ROLE' : 'AGENT ROLE // ' + esc(r.name)}</span>
          <span style="flex:1"></span>
          <button class="btn-ghost" data-ar-close>× close</button>
        </div>
        <div class="gd-body">
          <p style="color:var(--text-dim); font-size:11px; margin-top:0">
            Reusable prompt persona. Attach to a group and every session spawned
            in that group gets the role's prompt prepended to its system prompt.
          </p>
          <label class="lbl">name</label>
          <input id="ar-modal-name" type="text" value="${esc(r.name)}" maxlength="64"/>
          <label class="lbl">category (folder)</label>
          <input id="ar-modal-category" type="text" value="${esc(r.category || 'general')}" maxlength="32" placeholder="engineering, marketing, general …"/>
          <label class="lbl">description</label>
          <input id="ar-modal-description" type="text" value="${esc(r.description || '')}"/>
          <label class="lbl">system prompt</label>
          <textarea id="ar-modal-prompt" rows="10" maxlength="32768">${esc(r.prompt || '')}</textarea>
          <label class="lbl">default model (optional)</label>
          <input id="ar-modal-model" type="text" value="${esc(r.default_model || '')}" placeholder="claude-sonnet-4-6"/>
          <div style="margin-top:1em; display:flex; gap:.5em">
            <button class="btn-ghost" data-ar-save>${isNew ? 'create' : 'save'}</button>
            <button class="btn-ghost" data-ar-close>cancel</button>
          </div>
          <div id="ar-modal-error" style="color:var(--danger); margin-top:.5em; min-height:1em"></div>
        </div>
      </div>
    `;
    modal.querySelectorAll('[data-ar-close]').forEach(b => b.onclick = () => { modal.hidden = true; });
    modal.querySelector('[data-ar-save]').onclick = async () => {
      const payload = {
        name:          document.getElementById('ar-modal-name').value.trim(),
        category:      document.getElementById('ar-modal-category').value.trim() || 'general',
        description:   document.getElementById('ar-modal-description').value.trim(),
        prompt:        document.getElementById('ar-modal-prompt').value,
        default_model: document.getElementById('ar-modal-model').value.trim() || null,
      };
      const errEl = document.getElementById('ar-modal-error');
      if (!payload.name) { errEl.textContent = 'name required'; return; }
      if (!payload.prompt) { errEl.textContent = 'prompt required'; return; }
      try {
        if (isNew) await api('/agent-roles', { method: 'POST', body: JSON.stringify(payload) });
        else       await api(`/agent-roles/${existing.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        modal.hidden = true;
        await loadRoles();
      } catch (e) { errEl.textContent = e.message; }
    };
  }

  window.openAgentRolesView = openAgentRolesView;
})();
