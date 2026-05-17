'use strict';
// vt-0222: Cmd+K / Ctrl+K command palette. Quick-switcher across:
//   • nav routes (dashboard, archive, cost, groups, workflows, prices,
//     vault, health, audit)
//   • notes (uses /api/notes/index — already cached by vault tab)
//   • secrets (loads names on demand)
//   • hosts (state.hosts)
//   • sessions (state.sessions, recent only)
//   • workflows (loaded on first open)
//
// Hot keys:
//   Cmd/Ctrl+K  → open
//   Esc         → close
//   ↑/↓         → navigate
//   Enter       → activate

(function () {
  let openState = false;
  let allItems = [];
  let filtered = [];
  let cursor = 0;
  let dialog = null;

  async function loadItems() {
    const items = [];
    // Routes
    const routes = [
      ['Dashboard',  '/dashboard',  '⊞'],
      ['Archive',    '/archive',    '📜'],
      ['Cost',       '/cost',       '$'],
      ['Groups',     '/groups',     '⌘'],
      ['Workflows',  '/workflows',  '⎇'],
      ['Prices',     '/prices',     '$'],
      ['Vault',      '/vault',      '📓'],
      ['Health',     '/health',     '🩺'],
      ['Audit',      '/audit',      '📋'],
    ];
    for (const [name, route, icon] of routes) {
      items.push({ kind: 'route', label: name, sub: route, icon, action: () => location.hash = '#' + route });
    }
    // Hosts (from state if available)
    const st = window.fleetState || {};
    for (const h of (st.hosts || [])) {
      const name = h.display_name || h.name || h.id;
      items.push({ kind: 'host', label: name, sub: `host · ${h.status}`, icon: '▣',
        action: () => { st.selectedHost = h.id; location.hash = '#/dashboard'; } });
    }
    // Sessions (recent N)
    for (const s of (st.sessions || []).slice(0, 50)) {
      items.push({ kind: 'session', label: (s.label || s.id.slice(0,8)), sub: `session · ${s.status}`, icon: '▶',
        action: () => location.hash = '#/sessions/' + s.id });
    }
    // Notes (use /api/notes/index if cached on the vault state)
    const vs = window.__vaultState || {};
    if (vs.indexAll && vs.indexAll.length) {
      for (const p of vs.indexAll.slice(0, 500)) {
        items.push({ kind: 'note', label: p.split('/').pop().replace(/\.md$/, ''), sub: p, icon: '📄',
          action: () => { location.hash = '#/vault'; setTimeout(() => window.openVaultNote?.(p), 100); } });
      }
    }
    return items;
  }

  function score(item, q) {
    if (!q) return 1;
    const ql = q.toLowerCase();
    const ll = item.label.toLowerCase();
    const sl = (item.sub || '').toLowerCase();
    if (ll === ql) return 1000;
    if (ll.startsWith(ql)) return 500;
    if (ll.includes(ql)) return 100;
    if (sl.includes(ql)) return 50;
    // subsequence match
    let i = 0;
    for (const ch of ll) { if (ch === ql[i]) i++; if (i === ql.length) return 25; }
    return 0;
  }
  function filter(q) {
    return allItems.map(it => ({ it, s: score(it, q) })).filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map(x => x.it);
  }

  function render() {
    if (!dialog) return;
    const listEl = dialog.querySelector('.palette-list');
    listEl.innerHTML = filtered.map((it, i) => `
      <li class="palette-item${i === cursor ? ' active' : ''}" data-idx="${i}">
        <span class="palette-icon">${it.icon || ''}</span>
        <span class="palette-label">${(it.label).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}</span>
        <span class="palette-sub">${(it.sub || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}</span>
      </li>
    `).join('');
    listEl.querySelectorAll('.palette-item').forEach(el => {
      el.onclick = () => { cursor = parseInt(el.dataset.idx, 10); activate(); };
    });
    listEl.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  function activate() {
    const it = filtered[cursor];
    if (!it) return;
    close();
    try { it.action(); } catch (e) { window.toast?.error(e.message); }
  }

  async function open() {
    if (openState) return;
    openState = true;
    allItems = await loadItems();
    filtered = allItems;
    cursor = 0;
    dialog = document.createElement('div');
    dialog.className = 'palette-overlay';
    dialog.innerHTML = `
      <div class="palette-frame" role="dialog" aria-modal="true" aria-label="Command palette">
        <input class="palette-input" type="search" placeholder="search routes, hosts, sessions, notes…" autocomplete="off"/>
        <ul class="palette-list"></ul>
        <div class="palette-foot">↑↓ navigate · Enter open · Esc close · ${allItems.length} items</div>
      </div>
    `;
    document.body.appendChild(dialog);
    const inp = dialog.querySelector('.palette-input');
    inp.oninput = () => { filtered = filter(inp.value); cursor = 0; render(); };
    inp.onkeydown = (ev) => {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); cursor = Math.min(cursor + 1, filtered.length - 1); render(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); cursor = Math.max(cursor - 1, 0); render(); }
      else if (ev.key === 'Enter')   { ev.preventDefault(); activate(); }
      else if (ev.key === 'Escape')  { close(); }
    };
    dialog.onclick = (ev) => { if (ev.target === dialog) close(); };
    render();
    inp.focus();
  }

  function close() {
    openState = false;
    dialog?.remove();
    dialog = null;
  }

  function onGlobalKey(ev) {
    const isMod = ev.metaKey || ev.ctrlKey;
    if (isMod && ev.key === 'k') {
      ev.preventDefault();
      if (openState) close(); else open();
    }
  }
  document.addEventListener('keydown', onGlobalKey);
  window.openPalette = open;
})();
