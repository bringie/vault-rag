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
  // vt-0252: expose for palette autocomplete (indexAll is populated by
  // openNotesMode → /api/notes/index).
  window.__vaultState = state;
  window.openVaultNote = (p) => openNote(p);  // called by palette

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

  // vt-0158: post-process Obsidian wiki-links before passing to marked.
  // Forms handled:
  //   [[name]]             → link by basename
  //   [[name|alias]]       → link by basename, anchor text = alias
  //   [[folder/name]]      → explicit rel-path (slashes preserved)
  //   [[name#heading]]     → resolved by basename, anchor text shows heading
  // Resolution happens client-side against state.indexByBase (loaded once
  // per session). Unresolved links render as a muted span — clicking them
  // does nothing (matches Obsidian's "unresolved" affordance).
  function expandWikiLinks(md) {
    if (!md) return '';
    const idx = state.indexByBase || {};
    const idxLc = state.indexByBaseLower || {};
    return md.replace(/\[\[([^\]\n]+)\]\]/g, (_full, inner) => {
      let target = inner.trim(), alias = null;
      const pipe = target.indexOf('|');
      if (pipe >= 0) { alias = target.slice(pipe + 1).trim(); target = target.slice(0, pipe).trim(); }
      const hash = target.indexOf('#');
      let heading = null;
      if (hash >= 0) { heading = target.slice(hash + 1); target = target.slice(0, hash).trim(); }
      let resolved = null;
      if (target.includes('/')) {
        // explicit path; allow with or without .md
        resolved = target.endsWith('.md') ? target : target + '.md';
      } else {
        const base = target.endsWith('.md') ? target.slice(0, -3) : target;
        resolved = idx[base] || idxLc[base.toLowerCase()] || null;
        // Fallback: prefix-match against indexAll. Useful for task IDs
        // ([[vt-0158]] where the file is vt-0158-long-slug.md). First
        // match wins after sort by path length — shortest path = closest
        // to a "canonical" home, since deep buried duplicates lose.
        if (!resolved && state.indexAll && state.indexAll.length) {
          const baseLc = base.toLowerCase();
          const candidates = state.indexAll.filter(p => {
            const fname = p.split('/').pop().toLowerCase();
            return fname.startsWith(baseLc + '-') || fname === baseLc + '.md';
          });
          if (candidates.length) {
            candidates.sort((a, b) => a.length - b.length);
            resolved = candidates[0];
          }
        }
      }
      // vt-0181: escape ALL interpolations. DOMPurify is the last barrier
      // (and it currently strips on*-handlers), but a future config change
      // or a malformed wiki-link target with a quote should not be the
      // only thing standing between us and XSS.
      const display = esc(alias || (heading ? `${target}#${heading}` : target));
      const eTarget = esc(target);
      if (!resolved) {
        return `<span class="vault-wiki-unresolved" title="unresolved: ${eTarget}">${display}</span>`;
      }
      // Custom anchor — onTreeClick equivalent for inline navigation.
      return `<a href="#" class="vault-wiki" data-vault-link="${esc(resolved)}">${display}</a>`;
    });
  }

  function renderMd(text) {
    const expanded = expandWikiLinks(text);
    if (!window.marked || !window.DOMPurify) return esc(expanded || '');
    const html = window.marked.parse(expanded || '');
    return window.DOMPurify.sanitize(html, {
      ADD_ATTR: ['target', 'data-vault-link'],
      ADD_CLASSES: ['vault-wiki', 'vault-wiki-unresolved'],
    });
  }

  // -------- notes mode --------
  // Tree state: { 'dirPath/': { loaded: bool, expanded: bool, entries: [...] }}
  // Root key is '' (empty string). Entries on disk shape: {path, kind, size,
  // tags?}. Paths are already prefixed with their parent's dirPath.
  function dirCache() {
    if (!state.dirCache) state.dirCache = {};
    return state.dirCache;
  }

  async function fetchDir(prefix) {
    // depth=0 = only immediate children (dirs + files), no recursion.
    // Sub-dirs lazy-load on their own click via toggleDir().
    const r = await api('GET', `/notes/list?prefix=${encodeURIComponent(prefix)}&depth=0`);
    return r.entries || [];
  }

  function sortEntries(entries, parentPrefix) {
    // Strip the parentPrefix so the displayed name is the basename only.
    const stripped = entries.map(e => {
      const rel = parentPrefix && e.path.startsWith(parentPrefix)
        ? e.path.slice(parentPrefix.length).replace(/^\//, '')
        : e.path;
      return { ...e, name: rel };
    });
    return stripped.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  function rowEl(entry) {
    const li = document.createElement('li');
    li.className = entry.kind === 'dir' ? 'vault-row vault-dir' : 'vault-row vault-file';
    li.dataset.path = entry.path;
    li.dataset.kind = entry.kind;
    const caret = document.createElement('span');
    caret.className = 'vault-caret';
    caret.textContent = entry.kind === 'dir' ? '▶' : ' ';
    const icon = document.createElement('span');
    icon.className = 'vault-icon';
    icon.textContent = entry.kind === 'dir' ? '📁' : '📄';
    const label = document.createElement('span');
    label.className = 'vault-label';
    // vt-0160: drop tag suffix + size — name only, with .md stripped on files
    // to match Obsidian's display style. Full path stays in dataset.path.
    let display = entry.name || entry.path;
    if (entry.kind === 'file' && display.endsWith('.md')) display = display.slice(0, -3);
    if (entry.kind === 'dir') display = display.replace(/\/$/, '');
    label.textContent = display;
    li.appendChild(caret);
    li.appendChild(document.createTextNode(' '));
    li.appendChild(icon);
    li.appendChild(document.createTextNode(' '));
    li.appendChild(label);
    if (entry.kind === 'dir') {
      const children = document.createElement('ul');
      children.className = 'vault-tree-ul vault-children';
      children.hidden = true;
      li.appendChild(children);
    }
    return li;
  }

  async function toggleDir(li, dirPath) {
    const prefix = dirPath.replace(/\/$/, '');
    const cache = dirCache();
    const childrenUl = li.querySelector(':scope > .vault-children');
    if (!cache[prefix]) cache[prefix] = { loaded: false, expanded: false };
    const entry = cache[prefix];
    const caret = li.querySelector(':scope > .vault-caret');
    const icon = li.querySelector(':scope > .vault-icon');
    if (!entry.loaded) {
      childrenUl.innerHTML = '<li class="vault-row vault-loading"><em>loading…</em></li>';
      childrenUl.hidden = false;
      try {
        const items = await fetchDir(prefix);
        entry.entries = sortEntries(items, prefix + '/');
        entry.loaded = true;
        childrenUl.innerHTML = '';
        for (const child of entry.entries) childrenUl.appendChild(rowEl(child));
      } catch (e) {
        childrenUl.innerHTML = `<li class="vault-row"><em>error: ${esc(e.message)}</em></li>`;
        return;
      }
    }
    entry.expanded = !entry.expanded;
    childrenUl.hidden = !entry.expanded;
    if (caret) caret.textContent = entry.expanded ? '▼' : '▶';
    if (icon) icon.textContent = entry.expanded ? '📂' : '📁';
  }

  async function openNote(p) {
    // vt-0252 review: palette can call openNote BEFORE openNotesMode
    // initialized state.token via the fleet-token-ready event. Pull from
    // localStorage if needed so the first call doesn't 401.
    ensureToken();
    state.currentPath = p;
    state.editing = false;
    const viewer = $('vault-viewer');
    viewer.innerHTML = '<em>loading…</em>';
    try {
      const r = await api('POST', '/get', { path: p });
      state.currentText = r.text || r.content || '';
      state.currentSha = r.sha || null;
      renderNote();
      // vt-0161: reveal in tree — expand parent dirs, scroll into view,
      // highlight active row. Best-effort: silently no-ops if the tree
      // isn't visible (e.g. user is in search results mode).
      revealInTree(p).catch(() => {});
    } catch (e) {
      viewer.textContent = 'error: ' + e.message;
    }
  }

  async function revealInTree(filePath) {
    if (!filePath) return;
    const treeEl = $('vault-tree');
    if (!treeEl) return;
    // If the tree is currently showing search results, restore the real
    // tree so we can drill into it.
    const inSearch = !!treeEl.querySelector('.vault-search-results');
    const inp = $('vault-search-input');
    if (inSearch) {
      if (inp) inp.value = '';
      reopenTree();
    }
    // Walk the path segments, expanding each ancestor dir on the way.
    const parts = filePath.split('/');
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      const dirPath = acc + '/';
      const li = treeEl.querySelector(`li.vault-dir[data-path="${cssEscape(dirPath)}"]`);
      if (!li) return; // parent not in current tree view — give up quietly
      const cache = dirCache()[acc];
      if (!cache || !cache.expanded) {
        // toggleDir loads + expands (or toggles — but if not expanded yet,
        // first call expands).
        await toggleDir(li, dirPath);
      }
    }
    // Highlight the file row.
    treeEl.querySelectorAll('.vault-row.active').forEach(r => r.classList.remove('active'));
    const fileLi = treeEl.querySelector(`li.vault-file[data-path="${cssEscape(filePath)}"]`);
    if (fileLi) {
      fileLi.classList.add('active');
      fileLi.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // Minimal CSS.escape polyfill — querySelector with paths containing '/'
  // works but '"' or escape-sensitive chars would break. Vault paths are
  // already safe (no quotes, no brackets), but escape defensively.
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_\-\/.]/g, ch => '\\' + ch);
  }

  function renderNote() {
    const viewer = $('vault-viewer');
    viewer.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'vault-viewer-head';
    const pathSpan = document.createElement('span');
    pathSpan.textContent = state.currentPath;
    head.appendChild(pathSpan);
    // vt-0161: admin can edit any file. WRITABLE_PREFIXES still apply for
    // non-admin agents (rag-api enforces server-side); for the human in the
    // Fleet UI, having an admin bearer is enough.
    if (state.isAdmin && !state.editing) {
      const btn = document.createElement('button');
      btn.className = 'btn-ghost';
      btn.style.marginLeft = '1em';
      btn.textContent = 'edit';
      btn.onclick = () => startEdit();
      head.appendChild(btn);
    }
    // vt-0158: history button — available to any viewer, read-only.
    if (!state.editing) {
      const hBtn = document.createElement('button');
      hBtn.className = 'btn-ghost';
      hBtn.style.marginLeft = '.5em';
      hBtn.textContent = 'history';
      hBtn.onclick = () => showHistory(state.currentPath);
      head.appendChild(hBtn);
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
      // vt-0161: autosave checkbox — when on, debounces a PUT 2 s after the
      // last keystroke. Each PUT also auto-commits via vault-rag-api's git
      // hook, so toggling this on effectively makes every pause a commit.
      // Default off so accidental edits don't ship without an explicit save.
      const autosaveOn = localStorage.fleetVaultAutosave === '1';
      bar.innerHTML = `<button id="vault-save" class="btn-primary">save</button>
                       <button id="vault-cancel" class="btn-ghost">cancel</button>
                       <label class="vault-autosave">
                         <input type="checkbox" id="vault-autosave" ${autosaveOn ? 'checked' : ''}/>
                         autosave (2s)
                       </label>
                       <span id="vault-save-status" class="lbl"></span>`;
      viewer.appendChild(bar);
      $('vault-save').onclick = () => saveNote(ta.value);
      $('vault-cancel').onclick = () => {
        if (_autosaveTimer) { clearTimeout(_autosaveTimer); _autosaveTimer = null; }
        state.editing = false;
        renderNote();
      };
      $('vault-autosave').onchange = (ev) => {
        localStorage.fleetVaultAutosave = ev.target.checked ? '1' : '0';
      };
      ta.addEventListener('input', () => {
        if (!$('vault-autosave').checked) return;
        if (_autosaveTimer) clearTimeout(_autosaveTimer);
        const status = $('vault-save-status');
        if (status) status.textContent = 'autosave pending…';
        _autosaveTimer = setTimeout(() => {
          _autosaveTimer = null;
          autosaveSnapshot(ta);
        }, 2000);
      });
    } else {
      const body = document.createElement('div');
      body.className = 'vault-md';
      body.innerHTML = renderMd(state.currentText);
      viewer.appendChild(body);
      // vt-0158: intercept wiki-link clicks → openNote.
      body.querySelectorAll('a.vault-wiki[data-vault-link]').forEach(a => {
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          openNote(a.dataset.vaultLink);
        });
      });
    }
  }

  // vt-0158: history modal — pulled fresh per click. Renders a list of
  // commits; clicking a commit row shows that revision's content in a
  // read-only pre. No diff view yet (keep MVP small).
  async function showHistory(p) {
    const viewer = $('vault-viewer');
    const overlay = document.createElement('div');
    overlay.className = 'vault-history-overlay';
    overlay.innerHTML = `<div class="vault-history-frame">
      <div class="vault-history-head">
        <span class="lbl">HISTORY //</span>
        <span class="callsign">${esc(p)}</span>
        <span style="flex:1"></span>
        <button class="btn-ghost" data-close>× close</button>
      </div>
      <div class="vault-history-body">
        <div class="vault-history-list"><em>loading…</em></div>
        <div class="vault-history-preview"><em>pick a commit to preview</em></div>
      </div>
    </div>`;
    overlay.querySelector('[data-close]').onclick = () => overlay.remove();
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) overlay.remove();
    });
    viewer.parentNode.appendChild(overlay);
    let commits = [];
    try {
      const r = await api('GET', `/notes/history?path=${encodeURIComponent(p)}&limit=100`);
      commits = r.commits || [];
    } catch (e) {
      overlay.querySelector('.vault-history-list').innerHTML = `<em>error: ${esc(e.message)}</em>`;
      return;
    }
    const listEl = overlay.querySelector('.vault-history-list');
    const previewEl = overlay.querySelector('.vault-history-preview');
    if (!commits.length) { listEl.innerHTML = '<em>(no commits)</em>'; return; }
    listEl.innerHTML = '';
    for (const c of commits) {
      const row = document.createElement('div');
      row.className = 'vault-history-row';
      row.dataset.sha = c.sha;
      const when = new Date(c.ts).toLocaleString();
      row.innerHTML = `<span class="vault-history-sha">${esc(c.sha.slice(0,8))}</span>
                       <span class="vault-history-when">${esc(when)}</span>
                       <span class="vault-history-author">${esc(c.author || '')}</span>
                       <span class="vault-history-subject">${esc(c.subject || '')}</span>`;
      row.onclick = async () => {
        listEl.querySelectorAll('.vault-history-row.active').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        await renderHistoryPreview(previewEl, p, c, 'blob');
      };
      listEl.appendChild(row);
    }
  }

  // vt-0159: history preview supports three modes:
  //   blob       — full file content at this revision (Markdown rendered)
  //   patch      — `git show sha -- path` (this commit vs its parent)
  //   vs-current — `git diff sha WORK -- path` (this commit vs working tree)
  // vt-0183: _previewSeq guards against out-of-order completion when the
  // user clicks commits faster than the network round-trip — only the
  // latest click renders.
  let _previewSeq = 0;
  async function renderHistoryPreview(previewEl, p, c, mode) {
    const seq = ++_previewSeq;
    const isStale = () => seq !== _previewSeq;
    previewEl.innerHTML = '<em>loading…</em>';
    const meta = document.createElement('div');
    meta.className = 'vault-history-meta';
    meta.textContent = `${c.sha.slice(0,8)} · ${new Date(c.ts).toLocaleString()} · ${c.author}`;
    // Mode switcher buttons.
    const modes = document.createElement('div');
    modes.className = 'vault-history-modes';
    for (const m of [
      { id: 'blob',       label: 'blob' },
      { id: 'patch',      label: 'patch (vs parent)' },
      { id: 'vs-current', label: 'diff vs current' },
    ]) {
      const b = document.createElement('button');
      b.className = 'btn-ghost' + (m.id === mode ? ' active-nav' : '');
      b.textContent = m.label;
      b.onclick = () => renderHistoryPreview(previewEl, p, c, m.id);
      modes.appendChild(b);
    }
    try {
      if (mode === 'blob') {
        const s = await api('GET', `/notes/show?path=${encodeURIComponent(p)}&sha=${encodeURIComponent(c.sha)}`);
        if (isStale()) return;
        const wrap = document.createElement('div');
        wrap.className = 'vault-md';
        // Don't pass through expandWikiLinks — historic state may reference
        // renamed/gone files; raw markdown is truthful.
        wrap.innerHTML = window.marked && window.DOMPurify
          ? window.DOMPurify.sanitize(window.marked.parse(s.text || ''), { ADD_ATTR: ['target'] })
          : esc(s.text || '');
        previewEl.innerHTML = '';
        previewEl.appendChild(modes);
        previewEl.appendChild(meta);
        previewEl.appendChild(wrap);
      } else {
        const url = mode === 'patch'
          ? `/notes/diff?path=${encodeURIComponent(p)}&sha=${encodeURIComponent(c.sha)}`
          : `/notes/diff?path=${encodeURIComponent(p)}&from=${encodeURIComponent(c.sha)}&to=WORK`;
        const r = await api('GET', url);
        if (isStale()) return;
        previewEl.innerHTML = '';
        previewEl.appendChild(modes);
        previewEl.appendChild(meta);
        if (!r.diff || !r.diff.trim()) {
          const empty = document.createElement('div');
          empty.innerHTML = '<em>no differences</em>';
          previewEl.appendChild(empty);
        } else {
          previewEl.appendChild(renderDiff(r.diff));
        }
      }
    } catch (e) {
      if (isStale()) return;
      previewEl.innerHTML = '';
      previewEl.appendChild(modes);
      previewEl.appendChild(meta);
      const err = document.createElement('div');
      err.innerHTML = `<em>error: ${esc(e.message)}</em>`;
      previewEl.appendChild(err);
    }
  }

  // Minimal colorizer for unified diff. Classifies each line by leading
  // char and wraps in a span — no parsing of hunks beyond the visual cue.
  function renderDiff(text) {
    const pre = document.createElement('pre');
    pre.className = 'vault-diff';
    const out = String(text || '').split('\n').map(line => {
      if (line.startsWith('+++') || line.startsWith('---')) {
        return `<span class="diff-meta">${esc(line)}</span>`;
      }
      if (line.startsWith('@@')) return `<span class="diff-hunk">${esc(line)}</span>`;
      if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('commit ') || line.startsWith('Author:') || line.startsWith('Date:')) {
        return `<span class="diff-meta">${esc(line)}</span>`;
      }
      if (line.startsWith('+')) return `<span class="diff-add">${esc(line)}</span>`;
      if (line.startsWith('-')) return `<span class="diff-del">${esc(line)}</span>`;
      return esc(line);
    }).join('\n');
    pre.innerHTML = out;
    return pre;
  }

  function startEdit() {
    // vt-0161: admin gate only — server enforces the rest.
    if (!state.isAdmin) return;
    state.editing = true;
    renderNote();
  }

  // vt-0161: autosave timer is module-scoped so cancel/openNote/render
  // can reset it from anywhere.
  let _autosaveTimer = null;
  async function autosaveSnapshot(ta) {
    // Skip if the textarea is somehow gone (re-render mid-flight).
    if (!ta || !document.contains(ta)) return;
    // Snapshot of in-flight text so a slow PUT doesn't get overwritten by
    // a still-typing user (saveNote re-fetches sha after success).
    const txt = ta.value;
    await saveNote(txt, false, /*autosave=*/true);
  }

  async function saveNote(text, force = false, autosave = false) {
    const status = $('vault-save-status');
    if (status) status.textContent = autosave ? 'autosaving…' : 'saving…';
    // vt-0183: cancel any pending autosave when an explicit save fires —
    // otherwise the timer fires 2s later and produces a duplicate commit
    // against the just-updated sha.
    if (!autosave && _autosaveTimer) { clearTimeout(_autosaveTimer); _autosaveTimer = null; }
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
      if (autosave) {
        // Stay in edit mode — just refresh status. User keeps typing.
        if (status) status.textContent = `autosaved · ${new Date().toLocaleTimeString()}`;
        return;
      }
      state.editing = false;
      renderNote();
    } catch (e) {
      if (e.status === 412) {
        // vt-0190: native confirm() had OK = "force overwrite" as Enter
        // default — hostile asymmetric destruction. Now a styled dialog
        // with the non-destructive choice as primary (Enter = reload).
        const force = await window.confirmDialog({
          title: 'Conflict',
          message: `Someone else edited "${state.currentPath}" since you loaded it.\n\nForce overwrite will lose their changes.`,
          confirmLabel: 'force overwrite',
          cancelLabel: 'reload from server',
          danger: true,
        });
        if (force) await saveNote(text, true);
        else await openNote(state.currentPath);
      } else {
        if (status) status.textContent = 'error: ' + e.message;
      }
    }
  }

  // vt-0316: helper to switch between notes / graph / secrets panes.
  function _showVaultPane(mode) {
    const split = document.querySelector('.vault-split');
    const graph = document.getElementById('vault-graph-pane');
    if (split)  split.hidden = (mode === 'graph');
    if (graph)  graph.hidden = (mode !== 'graph');
    // Active-nav class on tabs
    const tabs = { notes: 'vault-tab-notes', graph: 'vault-tab-graph', secrets: 'vault-tab-secrets' };
    for (const [m, id] of Object.entries(tabs)) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('active-nav', m === mode);
    }
  }

  async function openNotesMode() {
    state.mode = 'notes';
    _showVaultPane('notes');
    const treeEl = $('vault-tree');
    treeEl.textContent = 'loading…';
    // Reset cache so a reload sees fresh data.
    state.dirCache = {};
    // Wiki-link resolution index — best-effort, render still works without it.
    api('GET', '/notes/index').then(r => {
      state.indexByBase = r.byBase || {};
      state.indexByBaseLower = r.byBaseLower || {};
      state.indexAll = r.all || [];
    }).catch(() => { /* ignore — links just render as unresolved */ });
    try {
      const items = await fetchDir('');
      const rootUl = document.createElement('ul');
      rootUl.className = 'vault-tree-ul vault-root';
      for (const e of sortEntries(items, '')) rootUl.appendChild(rowEl(e));
      treeEl.innerHTML = '';
      treeEl.appendChild(rootUl);
      // Seed root cache so reload behaviour is consistent with sub-dirs.
      dirCache()[''] = { loaded: true, expanded: true, entries: items };
    } catch (e) {
      treeEl.textContent = 'error: ' + e.message;
    }
  }

  async function onTreeClick(ev) {
    const row = ev.target.closest('.vault-row');
    if (!row) return;
    ev.stopPropagation();
    if (state.mode === 'notes') {
      if (row.dataset.kind === 'dir') {
        await toggleDir(row, row.dataset.path);
      } else {
        await openNote(row.dataset.path);
      }
    } else if (state.mode === 'secrets') {
      const name = row.dataset.path;
      if (row.dataset.kind === 'reveal') await revealSecret(name);
    }
  }

  // -------- graph mode (vt-0316) --------
  async function openGraphMode() {
    state.mode = 'graph';
    _showVaultPane('graph');
    if (typeof window.openVaultGraph === 'function') {
      window.openVaultGraph();
    }
  }

  // -------- secrets mode --------
  async function openSecretsMode() {
    state.mode = 'secrets';
    _showVaultPane('secrets');
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
        // vt-0183: null-guard — if user navigated away (hash router
        // re-rendered) the timer element is gone; bail instead of
        // crashing and leaking the interval.
        const timerEl = $('secret-reveal-timer');
        if (!timerEl) { clearInterval(tick); return; }
        remaining -= 1;
        timerEl.textContent = remaining + 's';
        if (remaining <= 0) { clearInterval(tick); closeReveal(); }
      }, 1000);
      function closeReveal() {
        clearInterval(tick);
        const valEl = $('secret-reveal-value');
        if (valEl) valEl.textContent = '';
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
      window.toast.error('reveal failed: ' + e.message);
    }
  }

  // vt-0190: secret prompts use the in-app dialog. Critically, the
  // VALUE input is masked={true} → type=password — native prompt()
  // showed secret values in plaintext to anyone shoulder-surfing.
  async function secretSetPrompt(presetName) {
    const name = presetName || await window.inputDialog({
      title: 'New secret', message: 'Secret name (UPPER_SNAKE convention):',
      placeholder: 'GH_TOKEN', confirmLabel: 'next',
    });
    if (!name) return;
    const value = await window.inputDialog({
      title: `Value for ${name}`, message: 'Will be sent over HTTPS and stored age-encrypted.',
      masked: true, confirmLabel: 'save',
    });
    if (value == null) return;
    try {
      await api('POST', '/secrets/set', { name, value });
      window.toast.success(`secret "${name}" saved`);
      await openSecretsMode();
    } catch (e) { window.toast.error('set failed: ' + e.message); }
  }
  async function secretRotatePrompt() {
    const name = await window.inputDialog({
      title: 'Rotate secret', message: 'Which secret?',
      placeholder: 'GH_TOKEN', confirmLabel: 'next',
    });
    if (!name) return;
    const value = await window.inputDialog({
      title: `New value for ${name}`,
      message: 'Empty = server-generated 32-byte hex.',
      masked: true, confirmLabel: 'rotate',
    });
    try {
      await api('POST', '/secrets/rotate', { name, value: value || null });
      window.toast.success(`secret "${name}" rotated`);
      await openSecretsMode();
    } catch (e) { window.toast.error('rotate failed: ' + e.message); }
  }
  async function secretDeletePrompt() {
    const name = await window.inputDialog({
      title: 'Delete secret', message: 'Which secret? (irreversible)',
      placeholder: 'GH_TOKEN', confirmLabel: 'next',
    });
    if (!name) return;
    const ok = await window.confirmDialog({
      title: 'Confirm delete',
      message: `Permanently delete secret "${name}"? This cannot be undone.`,
      confirmLabel: 'delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('POST', '/secrets/delete', { name });
      window.toast.success(`secret "${name}" deleted`);
      await openSecretsMode();
    } catch (e) { window.toast.error('delete failed: ' + e.message); }
  }

  // -------- search (vt-0160) --------
  // Two modes share one input:
  //   typing       → live name-filter against state.indexAll (no round-trip)
  //   Enter        → semantic content search via POST /api/search (pgvector)
  // Esc / × clear → restore tree.
  let _searchDebounce = null;
  function renderNameFilter(query) {
    const treeEl = $('vault-tree');
    if (!query) { reopenTree(); return; }
    const q = query.toLowerCase();
    const matches = (state.indexAll || []).filter(p => p.toLowerCase().includes(q));
    treeEl.innerHTML = '';
    const meta = document.createElement('div');
    meta.className = 'vault-search-meta';
    meta.textContent = matches.length
      ? `${matches.length} file${matches.length === 1 ? '' : 's'} matching "${query}"`
      : `no matches for "${query}"`;
    treeEl.appendChild(meta);
    if (!matches.length) return;
    const ul = document.createElement('ul');
    ul.className = 'vault-tree-ul vault-search-results';
    for (const p of matches.slice(0, 200)) {
      const li = document.createElement('li');
      li.className = 'vault-row vault-file';
      li.dataset.path = p;
      li.dataset.kind = 'file';
      const icon = document.createElement('span');
      icon.className = 'vault-icon'; icon.textContent = '📄';
      const label = document.createElement('span');
      label.className = 'vault-label';
      label.textContent = p.replace(/\.md$/, '');
      li.appendChild(icon);
      li.appendChild(document.createTextNode(' '));
      li.appendChild(label);
      ul.appendChild(li);
    }
    treeEl.appendChild(ul);
    if (matches.length > 200) {
      const more = document.createElement('div');
      more.className = 'vault-search-meta';
      more.textContent = `…(${matches.length - 200} more — refine the query)`;
      treeEl.appendChild(more);
    }
  }

  async function runContentSearch(query) {
    const treeEl = $('vault-tree');
    treeEl.innerHTML = '<em>searching content…</em>';
    try {
      const r = await api('POST', '/search', { query, k: 25 });
      treeEl.innerHTML = '';
      const meta = document.createElement('div');
      meta.className = 'vault-search-meta';
      meta.textContent = (r.results || []).length
        ? `${r.results.length} chunks matching "${query}" (semantic)`
        : `no semantic matches for "${query}"`;
      treeEl.appendChild(meta);
      const ul = document.createElement('ul');
      ul.className = 'vault-tree-ul vault-search-results';
      for (const row of r.results || []) {
        const li = document.createElement('li');
        li.className = 'vault-row vault-file vault-search-hit';
        li.dataset.path = row.path;
        li.dataset.kind = 'file';
        const head = document.createElement('div');
        head.className = 'vault-search-hit-head';
        head.innerHTML = `<span class="vault-icon">📄</span> <span class="vault-label">${esc(row.path.replace(/\.md$/, ''))}</span>
          <span class="vault-search-score">${(row.score * 100).toFixed(0)}%</span>`;
        const snippet = document.createElement('div');
        snippet.className = 'vault-search-snippet';
        const txt = String(row.text || '').slice(0, 240);
        snippet.textContent = txt + (row.text && row.text.length > 240 ? '…' : '');
        li.appendChild(head);
        li.appendChild(snippet);
        ul.appendChild(li);
      }
      treeEl.appendChild(ul);
    } catch (e) {
      treeEl.innerHTML = `<em>search failed: ${esc(e.message)}</em>`;
    }
  }

  function reopenTree() {
    // Re-render last-loaded root from cache (no fetch unless cache empty).
    const treeEl = $('vault-tree');
    const root = (state.dirCache && state.dirCache[''] && state.dirCache[''].entries) || null;
    if (!root) { openNotesMode(); return; }
    const ul = document.createElement('ul');
    ul.className = 'vault-tree-ul vault-root';
    for (const e of sortEntries(root, '')) ul.appendChild(rowEl(e));
    treeEl.innerHTML = '';
    treeEl.appendChild(ul);
  }

  function wireSearch() {
    const inp = $('vault-search-input');
    const clear = $('vault-search-clear');
    if (!inp) return;
    inp.oninput = () => {
      const q = inp.value.trim();
      if (_searchDebounce) clearTimeout(_searchDebounce);
      _searchDebounce = setTimeout(() => renderNameFilter(q), 120);
    };
    inp.onkeydown = (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const q = inp.value.trim();
        if (q) runContentSearch(q);
      } else if (ev.key === 'Escape') {
        inp.value = '';
        reopenTree();
      }
    };
    if (clear) clear.onclick = () => { inp.value = ''; reopenTree(); inp.focus(); };
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
    $('vault-tab-graph').onclick = () => openGraphMode();
    $('vault-tab-secrets').onclick = () => openSecretsMode();
    // vt-0316: reload graph on toolbar button + Enter in root input
    const gReload = document.getElementById('vault-graph-reload');
    if (gReload) gReload.onclick = () => window.openVaultGraph?.();
    const gRoot = document.getElementById('vault-graph-root');
    if (gRoot) gRoot.onkeydown = (e) => { if (e.key === 'Enter') window.openVaultGraph?.(); };
    wireSearch();
    await openNotesMode();
  }

  window.openVaultView = open;
})();
