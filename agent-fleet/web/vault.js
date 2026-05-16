'use strict';
// vt-0146 + vt-0147: vault tab.
//   notes mode: tree → click dir to drill → click file to render markdown.
//   admin + writable prefix → "Edit" button → textarea + Save with
//   expected_sha (vt-0141 optimistic concurrency, 412 on conflict).
//   secrets mode: list → reveal modal (auto-hide 30s) + Set/Rotate/Delete.

(function () {
  const $ = (id) => document.getElementById(id);
  const state = {
    token: null,
    isAdmin: false,
    mode: 'notes',          // 'notes' | 'secrets'
    currentTree: [],
    currentPath: null,
    currentText: '',
    currentSha: null,
    editing: false,
  };

  const WRITABLE_PREFIXES = [
    '00-inbox/', '03-sessions/', '04-tasks/', '06-resources/notes/', 'agents/',
  ];

  window.addEventListener('fleet-token-ready', (ev) => {
    state.token = ev.detail.token;
    state.isAdmin = !!ev.detail.isAdmin;
  });

  // Token fallback: the fleet-token-ready event fires only AFTER app.js
  // finishes its admin-probe fetch, which is async. If the user clicks
  // nav-vault before that resolves, state.token is still null. Reuse
  // localStorage.fleetToken — that's exactly what app.js reads on boot,
  // and the admin probe upgrades isAdmin once it returns.
  function ensureToken() {
    if (!state.token && typeof localStorage !== 'undefined') {
      state.token = localStorage.fleetToken || null;
    }
  }

  function esc(s) {
    return String(s ?? '').replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function isWritable(p) {
    return WRITABLE_PREFIXES.some(pre => p.startsWith(pre));
  }

  async function api(method, path, body) {
    const headers = { authorization: 'Bearer ' + state.token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch('/api' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = { error: text.slice(0, 200) }; } }
    if (!r.ok) {
      const err = new Error((parsed && parsed.error) || `${method} ${path}: ${r.status}`);
      err.status = r.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }

  function renderMd(text) {
    if (!window.marked || !window.DOMPurify) return esc(text || '');
    const html = window.marked.parse(text || '');
    return window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  }

  // -------- notes mode --------
  async function loadTree(prefix = '') {
    return api('GET', `/notes/list?prefix=${encodeURIComponent(prefix)}&depth=2`);
  }

  function renderTree(entries) {
    const treeEl = $('vault-tree');
    treeEl.textContent = '';
    if (!entries.length) { treeEl.textContent = '(empty)'; return; }
    const sorted = entries.slice().sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    const ul = document.createElement('ul');
    ul.className = 'vault-tree-ul';
    for (const e of sorted) {
      const li = document.createElement('li');
      li.className = e.kind === 'dir' ? 'vault-row vault-dir' : 'vault-row vault-file';
      li.dataset.path = e.path;
      li.dataset.kind = e.kind;
      const tagsSuffix = (e.tags && e.tags.length) ? ` [${e.tags.join(', ')}]` : '';
      const sizeSuffix = e.kind === 'file' ? ` (${e.size}b)` : '';
      li.textContent = (e.kind === 'dir' ? '📁 ' : '📄 ') + e.path + sizeSuffix + tagsSuffix;
      ul.appendChild(li);
    }
    treeEl.appendChild(ul);
  }

  async function openNote(p) {
    state.currentPath = p;
    state.editing = false;
    const viewer = $('vault-viewer');
    viewer.innerHTML = '<em>loading…</em>';
    try {
      const r = await api('POST', '/get', { path: p });
      state.currentText = r.text || r.content || '';
      state.currentSha = r.sha || null;
      renderNote();
    } catch (e) {
      viewer.textContent = 'error: ' + e.message;
    }
  }

  function renderNote() {
    const viewer = $('vault-viewer');
    viewer.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'vault-viewer-head';
    head.textContent = state.currentPath;
    if (state.isAdmin && isWritable(state.currentPath) && !state.editing) {
      const btn = document.createElement('button');
      btn.className = 'btn-ghost';
      btn.style.marginLeft = '1em';
      btn.textContent = 'edit';
      btn.onclick = () => startEdit();
      head.appendChild(btn);
    }
    viewer.appendChild(head);

    if (state.editing) {
      const ta = document.createElement('textarea');
      ta.id = 'vault-edit-area';
      ta.className = 'vault-edit-textarea';
      ta.value = state.currentText;
      ta.spellcheck = false;
      viewer.appendChild(ta);
      const bar = document.createElement('div');
      bar.className = 'vault-edit-bar';
      bar.innerHTML = `<button id="vault-save" class="btn-primary">save</button>
                       <button id="vault-cancel" class="btn-ghost">cancel</button>
                       <span id="vault-save-status" class="lbl"></span>`;
      viewer.appendChild(bar);
      $('vault-save').onclick = () => saveNote(ta.value);
      $('vault-cancel').onclick = () => { state.editing = false; renderNote(); };
    } else {
      const body = document.createElement('div');
      body.className = 'vault-md';
      body.innerHTML = renderMd(state.currentText);
      viewer.appendChild(body);
    }
  }

  function startEdit() {
    if (!state.isAdmin || !isWritable(state.currentPath)) return;
    state.editing = true;
    renderNote();
  }

  async function saveNote(text, force = false) {
    const status = $('vault-save-status');
    if (status) status.textContent = 'saving…';
    const body = {
      path: state.currentPath,
      content: text,
      agent_id: 'fleet-ui',
      reindex: true,
    };
    if (!force && state.currentSha) body.expected_sha = state.currentSha;
    try {
      await api('POST', '/put', body);
      // Refresh sha for next save.
      const r = await api('POST', '/get', { path: state.currentPath });
      state.currentText = r.text || r.content || '';
      state.currentSha = r.sha || null;
      state.editing = false;
      renderNote();
    } catch (e) {
      if (e.status === 412) {
        if (confirm(`Conflict: someone else edited "${state.currentPath}" since you loaded it.\n\n` +
                    `[OK] Force overwrite (loses their changes)\n` +
                    `[Cancel] Discard your edit and reload from server`)) {
          await saveNote(text, true);
        } else {
          await openNote(state.currentPath);
        }
      } else {
        if (status) status.textContent = 'error: ' + e.message;
      }
    }
  }

  async function openNotesMode() {
    state.mode = 'notes';
    $('vault-tab-notes').classList.add('active-nav');
    $('vault-tab-secrets').classList.remove('active-nav');
    $('vault-tree').textContent = 'loading…';
    try {
      const r = await loadTree();
      state.currentTree = r.entries || [];
      renderTree(state.currentTree);
    } catch (e) {
      $('vault-tree').textContent = 'error: ' + e.message;
    }
  }

  async function onTreeClick(ev) {
    const row = ev.target.closest('.vault-row');
    if (!row) return;
    if (state.mode === 'notes') {
      if (row.dataset.kind === 'dir') {
        $('vault-tree').textContent = 'loading…';
        try {
          const r = await loadTree(row.dataset.path.replace(/\/$/, ''));
          state.currentTree = r.entries || [];
          renderTree(state.currentTree);
        } catch (e) {
          $('vault-tree').textContent = 'error: ' + e.message;
        }
      } else {
        await openNote(row.dataset.path);
      }
    } else if (state.mode === 'secrets') {
      const name = row.dataset.path;
      if (row.dataset.kind === 'reveal') await revealSecret(name);
    }
  }

  // -------- secrets mode --------
  async function openSecretsMode() {
    state.mode = 'secrets';
    $('vault-tab-secrets').classList.add('active-nav');
    $('vault-tab-notes').classList.remove('active-nav');
    $('vault-viewer').innerHTML = '<em>Click a secret to reveal (auto-hide after 30 s).</em>';
    $('vault-tree').textContent = 'loading…';
    try {
      const r = await api('POST', '/secrets/list', {});
      const names = r.names || [];
      const treeEl = $('vault-tree');
      treeEl.innerHTML = '';
      if (!names.length) { treeEl.textContent = '(no secrets)'; return; }
      const ul = document.createElement('ul');
      ul.className = 'vault-tree-ul';
      for (const n of names.sort()) {
        const li = document.createElement('li');
        li.className = 'vault-row vault-file';
        li.dataset.path = n;
        li.dataset.kind = 'reveal';
        li.textContent = '🔑 ' + n;
        ul.appendChild(li);
      }
      treeEl.appendChild(ul);

      if (state.isAdmin) {
        const adminBar = document.createElement('div');
        adminBar.style.padding = '8px';
        adminBar.style.borderTop = '1px solid var(--border, #333)';
        adminBar.innerHTML = `
          <button id="secret-new" class="btn-ghost">+ new</button>
          <button id="secret-rotate" class="btn-ghost">rotate</button>
          <button id="secret-delete" class="btn-ghost">delete</button>
        `;
        treeEl.appendChild(adminBar);
        $('secret-new').onclick = () => secretSetPrompt(null);
        $('secret-rotate').onclick = () => secretRotatePrompt();
        $('secret-delete').onclick = () => secretDeletePrompt();
      }
    } catch (e) {
      $('vault-tree').textContent = 'error: ' + e.message;
    }
  }

  async function revealSecret(name) {
    try {
      const r = await api('POST', '/secrets/get', { name });
      const dlg = $('secret-reveal');
      // vt-0155: hold the plaintext in a mutable let so closeReveal can
      // null it out — copy/dom both reference this same slot. After
      // closeReveal the closure no longer holds the secret in JS memory
      // (subject to V8 GC; can't truly purge, but no live binding remains).
      let plaintext = String(r.value || '');
      $('secret-reveal-name').textContent = name;
      $('secret-reveal-value').textContent = plaintext;
      let remaining = 30;
      $('secret-reveal-timer').textContent = remaining + 's';
      const tick = setInterval(() => {
        remaining -= 1;
        $('secret-reveal-timer').textContent = remaining + 's';
        if (remaining <= 0) { clearInterval(tick); closeReveal(); }
      }, 1000);
      function closeReveal() {
        clearInterval(tick);
        $('secret-reveal-value').textContent = '';
        plaintext = '';
        try { dlg.close(); } catch {}
      }
      $('secret-reveal-close').onclick = closeReveal;
      $('secret-reveal-copy').onclick = () => {
        if (!plaintext) return;
        try { navigator.clipboard.writeText(plaintext); } catch {}
      };
      dlg.addEventListener('close', closeReveal, { once: true });
      dlg.showModal();
    } catch (e) {
      alert('reveal failed: ' + e.message);
    }
  }

  async function secretSetPrompt(presetName) {
    const name = presetName || prompt('secret name:');
    if (!name) return;
    const value = prompt(`value for "${name}":`);
    if (value == null) return;
    try {
      await api('POST', '/secrets/set', { name, value });
      await openSecretsMode();
    } catch (e) { alert('set failed: ' + e.message); }
  }
  async function secretRotatePrompt() {
    const name = prompt('rotate which secret?');
    if (!name) return;
    const value = prompt(`new value for "${name}" (leave empty to keep existing):`);
    try {
      await api('POST', '/secrets/rotate', { name, value: value || null });
      await openSecretsMode();
    } catch (e) { alert('rotate failed: ' + e.message); }
  }
  async function secretDeletePrompt() {
    const name = prompt('delete which secret?');
    if (!name) return;
    if (!confirm(`Delete secret "${name}"? This is irreversible.`)) return;
    try {
      await api('POST', '/secrets/delete', { name });
      await openSecretsMode();
    } catch (e) { alert('delete failed: ' + e.message); }
  }

  // -------- open --------
  async function open() {
    ensureToken();
    if (!state.token) {
      $('vault-tree').textContent = 'auth required';
      return;
    }
    $('vault-tree').onclick = onTreeClick;
    const reload = $('vault-reload');
    if (reload) reload.onclick = () => (state.mode === 'secrets' ? openSecretsMode() : openNotesMode());
    $('vault-tab-notes').onclick = () => openNotesMode();
    $('vault-tab-secrets').onclick = () => openSecretsMode();
    await openNotesMode();
  }

  window.openVaultView = open;
})();
