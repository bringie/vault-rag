'use strict';
// vt-0146: vault tab logic — read-only viewer over /api/notes/list + /api/get.
// vt-0147 will layer edit + secrets sub-tab on top.

(function () {
  const $ = (id) => document.getElementById(id);
  const state = { token: null, isAdmin: false, currentTree: [], currentPath: null };

  // app.js fires this event after the bearer + admin probe finish.
  window.addEventListener('fleet-token-ready', (ev) => {
    state.token = ev.detail.token;
    state.isAdmin = !!ev.detail.isAdmin;
  });

  function esc(s) {
    return String(s ?? '').replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
  }

  async function api(method, path, body) {
    const headers = { authorization: 'Bearer ' + state.token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch('/api' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (!r.ok) {
      const t = await r.text();
      throw Object.assign(new Error(`${method} ${path}: ${r.status} ${t.slice(0,200)}`), { status: r.status });
    }
    return r.json();
  }

  async function loadTree(prefix = '') {
    return api('GET', `/notes/list?prefix=${encodeURIComponent(prefix)}&depth=2`);
  }

  async function loadNote(p) {
    return api('POST', '/get', { path: p });
  }

  function renderMd(text) {
    if (!window.marked || !window.DOMPurify) return esc(text || '');
    const html = window.marked.parse(text || '');
    return window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  }

  function renderTree(entries) {
    const treeEl = $('vault-tree');
    treeEl.textContent = '';
    if (!entries.length) {
      treeEl.textContent = '(empty)';
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'vault-tree-ul';
    // Build a flat sorted list — dirs first.
    const sorted = entries.slice().sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    for (const e of sorted) {
      const li = document.createElement('li');
      li.className = e.kind === 'dir' ? 'vault-row vault-dir' : 'vault-row vault-file';
      li.dataset.path = e.path;
      li.dataset.kind = e.kind;
      // NEVER innerHTML the path — use textContent.
      const tagsSuffix = (e.tags && e.tags.length) ? ` [${e.tags.join(', ')}]` : '';
      const sizeSuffix = e.kind === 'file' ? ` (${e.size}b)` : '';
      li.textContent = (e.kind === 'dir' ? '📁 ' : '📄 ') + e.path + sizeSuffix + tagsSuffix;
      ul.appendChild(li);
    }
    treeEl.appendChild(ul);
  }

  async function open() {
    if (!state.token) {
      $('vault-tree').textContent = 'auth required';
      return;
    }
    $('vault-tree').textContent = 'loading…';
    try {
      const r = await loadTree();
      state.currentTree = r.entries || [];
      renderTree(state.currentTree);
    } catch (e) {
      $('vault-tree').textContent = 'error: ' + e.message;
    }
    $('vault-tree').onclick = onTreeClick;
    const reload = $('vault-reload');
    if (reload) reload.onclick = () => open();
  }

  async function onTreeClick(ev) {
    const row = ev.target.closest('.vault-row');
    if (!row) return;
    const p = row.dataset.path;
    const viewer = $('vault-viewer');
    if (row.dataset.kind === 'dir') {
      // Drill in: re-list this dir at depth 2.
      $('vault-tree').textContent = 'loading…';
      try {
        const r = await loadTree(p.replace(/\/$/, ''));
        state.currentTree = r.entries || [];
        renderTree(state.currentTree);
      } catch (e) {
        $('vault-tree').textContent = 'error: ' + e.message;
      }
      return;
    }
    // File: load + render markdown.
    state.currentPath = p;
    viewer.innerHTML = '<em>loading…</em>';
    try {
      const r = await api('POST', '/get', { path: p });
      // vt-0146: render with DOMPurify; path shown as plain text in header.
      const text = r.text || r.content || '';
      viewer.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'vault-viewer-head';
      head.textContent = p;
      const body = document.createElement('div');
      body.className = 'vault-md';
      body.innerHTML = renderMd(text);
      viewer.appendChild(head);
      viewer.appendChild(body);
    } catch (e) {
      viewer.innerHTML = '';
      viewer.textContent = 'error: ' + e.message;
    }
  }

  window.openVaultView = open;
})();
