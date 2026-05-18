'use strict';
// chat-view.js — fleet phosphor-console chat (vt-0392 v6, redesign).
// Drop-in replacement. Public API preserved:
//   chatView.mount(el) / attach(sid, ws, opts) / detach()
//   chatView.handleFrame(frame) / getLastOffset() / setLastOffset(n)

(function () {
  const STATE = {
    container: null,
    list: null,
    statusBar: null,
    composer: null,
    composerInput: null,
    composerSend: null,
    composerStop: null,
    composerEsc: null,
    sessionId: null,
    ws: null,
    lastOffset: 0,
    seenUuids: new Set(),
    replayDone: false,
    replayInFlight: false,
    nodeBySeq: new Map(),
    _pendingUserNode: null,
    _pendingUserText: null,
    _pendingTimer: null,
    _thinkingNode: null,
    _thinkingTimerId: null,
    _thinkingExpectMore: false,
    _emptyNode: null,
    _permCards: new Set(),
    _busy: false,
  };

  const MAX_MOUNTED_NODES = 2000;
  const PENDING_TIMEOUT_MS = 30_000;

  const SYSTEM_SUBTYPES_VISIBLE = new Set([
    'permission-mode', 'session_start',
  ]);

  const TOOL_GLYPH = {
    Bash: '$_',
    Read: '◉', Write: '✎', Edit: '✎', NotebookEdit: '✎',
    Grep: '⌕', Glob: '⌘', LS: '▤',
    Task: '⇲', Agent: '⇲', Skill: '◈',
    WebFetch: '⇆', WebSearch: '⌕',
    TodoWrite: '☐', ScheduleWakeup: '⏲',
    ToolSearch: '⌕', AskUserQuestion: '?',
  };
  const TOOL_GLYPH_DEFAULT = '⚙';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function escapeHtml(s) {
    if (typeof s !== 'string') s = String(s == null ? '' : s);
    return s.replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function renderMarkdown(text) {
    if (!text) return '';
    const esc = escapeHtml(text);
    return esc
      .replace(/```([\s\S]*?)```/g,
        (_, body) => `<pre class="cv-code"><code>${body}</code></pre>`)
      .replace(/`([^`\n]+)`/g, '<code class="cv-inline-code">$1</code>')
      .replace(/\n/g, '<br>');
  }

  function fmtTokens(u) {
    if (!u) return '';
    const i = u.input_tokens || 0;
    const o = u.output_tokens || 0;
    const cr = u.cache_read || u.cache_read_input_tokens || 0;
    const cw = u.cache_creation_5m || u.cache_creation_input_tokens || 0;
    return `↓${i} ↑${o} ◀${cr} ▶${cw}`;
  }

  function isAtBottom() {
    if (!STATE.list) return true;
    const c = STATE.list.parentElement;
    if (!c) return true;
    return (c.scrollHeight - c.scrollTop - c.clientHeight) < 60;
  }

  function scrollToBottom() {
    if (!STATE.list) return;
    const c = STATE.list.parentElement;
    if (!c) return;
    c.scrollTop = c.scrollHeight;
  }

  function applyCascade(container) {
    if (!container) return;
    if (STATE.replayInFlight) return;
    const targets = container.querySelectorAll('.cv-text');
    targets.forEach(t => {
      if (t.dataset.cascadeApplied) return;
      t.dataset.cascadeApplied = '1';
      t.classList.add('cv-cascading');
      wrapTextNodes(t);
    });
  }

  function wrapTextNodes(root) {
    let i = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const texts = [];
    let n;
    while ((n = walker.nextNode())) texts.push(n);
    for (const tn of texts) {
      const parts = tn.nodeValue.split(/(\s+)/);
      if (parts.length === 1) continue;
      const frag = document.createDocumentFragment();
      for (const p of parts) {
        if (!p.length) continue;
        if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(p)); continue; }
        const w = document.createElement('span');
        w.className = 'cv-w';
        w.style.setProperty('--i', String(i++));
        w.textContent = p;
        frag.appendChild(w);
      }
      tn.parentNode.replaceChild(frag, tn);
      if (i > 200) break;
    }
  }

  function pinnedBottomNode() {
    if (STATE._thinkingNode && STATE._thinkingNode.parentNode === STATE.list)
      return STATE._thinkingNode;
    if (STATE._permCards && STATE._permCards.size && STATE.list) {
      for (const node of STATE._permCards) {
        if (node.parentNode === STATE.list) return node;
      }
    }
    return null;
  }

  function appendNode(node, seq, opts = {}) {
    if (!STATE.list) return;
    const stick = isAtBottom();
    const before = pinnedBottomNode();
    if (before) STATE.list.insertBefore(node, before);
    else STATE.list.appendChild(node);
    if (seq != null) STATE.nodeBySeq.set(seq, node);
    if (opts.live !== false && !STATE.replayInFlight) {
      node.classList.add('cv-fresh');
      requestAnimationFrame(() => applyCascade(node));
    }
    while (STATE.list.childElementCount > MAX_MOUNTED_NODES) {
      const first = STATE.list.firstElementChild;
      if (!first || first === before) break;
      for (const [k, v] of STATE.nodeBySeq) {
        if (v === first) { STATE.nodeBySeq.delete(k); break; }
      }
      STATE.list.removeChild(first);
    }
    if (stick) scrollToBottom();
  }

  function renderAssistant(payload) {
    const ex = payload.extracted;
    const root = el('div', 'cv-msg cv-assistant');
    if (ex.is_sidechain) root.classList.add('cv-sidechain');

    if (ex.model || ex.usage || (ex.stop_reason && ex.stop_reason !== 'end_turn')) {
      const meta = document.createElement('details');
      meta.className = 'cv-meta';
      const sum = el('summary', 'cv-meta-trigger', 'ⓘ');
      meta.appendChild(sum);
      const inner = el('span', 'cv-meta-inner');
      if (ex.model) inner.appendChild(el('span', 'cv-meta-model', ex.model.replace(/^claude-/, '')));
      if (ex.usage) inner.appendChild(el('span', 'cv-meta-tokens', fmtTokens(ex.usage)));
      if (ex.stop_reason && ex.stop_reason !== 'end_turn')
        inner.appendChild(el('span', 'cv-meta-stop', ex.stop_reason));
      meta.appendChild(inner);
      root.appendChild(meta);
    }

    const body = el('div', 'cv-body');

    if (ex.thinking_blocks && ex.thinking_blocks.length) {
      const th = document.createElement('details');
      th.className = 'cv-thought';
      th.appendChild(el('summary', null, `‹thinking·${ex.thinking_blocks.length}›`));
      const pre = el('pre', 'cv-thought-text');
      pre.textContent = ex.thinking_blocks.map(b => b.text).join('\n\n───\n\n');
      th.appendChild(pre);
      body.appendChild(th);
    }

    for (const block of (ex.text_blocks || [])) {
      const div = el('div', 'cv-text');
      div.innerHTML = renderMarkdown(block.text || '');
      body.appendChild(div);
    }

    for (const tu of (ex.tool_uses || [])) {
      body.appendChild(renderToolCall(tu));
    }

    root.appendChild(body);
    return root;
  }

  function renderUser(payload) {
    const ex = payload.extracted;
    const root = el('div', 'cv-msg cv-user');
    if (ex.is_sidechain) root.classList.add('cv-sidechain');

    if (ex.tool_results && ex.tool_results.length) {
      root.classList.add('cv-toolresult-frame');
      for (const tr of ex.tool_results) root.appendChild(renderToolResult(tr));
      return root;
    }

    const body = el('div', 'cv-body');
    if (ex.text_in) {
      const div = el('div', 'cv-text');
      div.innerHTML = renderMarkdown(ex.text_in);
      body.appendChild(div);
    }
    root.appendChild(body);
    return root;
  }

  function renderSystem(payload) {
    const ex = payload.extracted;
    const root = el('div', 'cv-system-line');
    root.appendChild(el('span', 'cv-system-dot', '·'));
    const lbl = ex.subtype === 'permission-mode'
      ? `permission mode → ${(payload.raw && payload.raw.permissionMode) || '?'}`
      : (ex.text || ex.subtype || 'system');
    root.appendChild(el('span', 'cv-system-text', lbl));
    return root;
  }

  function renderToolCall(tu) {
    const glyph = TOOL_GLYPH[tu.name] || TOOL_GLYPH_DEFAULT;
    const card = document.createElement('details');
    card.className = 'cv-tool';
    const sum = document.createElement('summary');
    sum.appendChild(el('span', 'cv-tool-bracket', '['));
    sum.appendChild(el('span', 'cv-tool-glyph', glyph));
    sum.appendChild(el('span', 'cv-tool-name', tu.name || 'tool'));
    sum.appendChild(el('span', 'cv-tool-arrow', '→'));
    const input = tu.input || {};
    const preview = Object.entries(input)
      .map(([k, v]) => {
        const sv = typeof v === 'string' ? v : JSON.stringify(v);
        return `${k}:${sv.length > 60 ? sv.slice(0, 60) + '…' : sv}`;
      })
      .join(' ');
    sum.appendChild(el('span', 'cv-tool-args', preview || '∅'));
    sum.appendChild(el('span', 'cv-tool-bracket-close', ']'));
    card.appendChild(sum);
    const pre = el('pre', 'cv-tool-input');
    pre.textContent = JSON.stringify(input, null, 2);
    card.appendChild(pre);
    return card;
  }

  function renderToolResult(tr) {
    const card = document.createElement('details');
    card.className = 'cv-tool cv-tool-result' + (tr.is_error ? ' cv-tool-error' : '');
    const sum = document.createElement('summary');
    sum.appendChild(el('span', 'cv-tool-bracket', '['));
    sum.appendChild(el('span', 'cv-tool-glyph', tr.is_error ? '✗' : '↳'));
    sum.appendChild(el('span', 'cv-tool-name', tr.is_error ? 'error' : 'result'));
    sum.appendChild(el('span', 'cv-tool-arrow', '·'));
    const content = typeof tr.content === 'string' ? tr.content
      : (Array.isArray(tr.content)
        ? tr.content.map(c => c.text || JSON.stringify(c)).join('\n')
        : JSON.stringify(tr.content));
    const truncated = content.length > 140 ? content.slice(0, 140) + '…' : content;
    sum.appendChild(el('span', 'cv-tool-args', truncated.replace(/\n/g, ' ')));
    sum.appendChild(el('span', 'cv-tool-bracket-close', ']'));
    card.appendChild(sum);
    const pre = el('pre', 'cv-tool-output');
    pre.textContent = content;
    card.appendChild(pre);
    return card;
  }

  function renderCompactBoundary(payload) {
    const md = payload.metadata || {};
    const root = el('div', 'cv-compact');
    root.appendChild(el('span', 'cv-compact-line'));
    const label = el('span', 'cv-compact-label');
    label.appendChild(el('span', 'cv-compact-glyph', '↻'));
    const text = `${md.trigger || 'auto'} · ${md.preTokens ?? '?'} → ${md.postTokens ?? '?'} tokens${md.durationMs ? ` · ${md.durationMs}ms` : ''}`;
    label.appendChild(el('span', null, text));
    root.appendChild(label);
    root.appendChild(el('span', 'cv-compact-line'));
    return root;
  }

  function renderLifecycle(state, extras) {
    const root = el('div', 'cv-lifecycle cv-lifecycle-' + state);
    let glyph, txt;
    if (state === 'ready')      { glyph = '◉'; txt = 'session ready'; }
    else if (state === 'exit')  { glyph = '■'; txt = `exit · code ${extras?.code ?? '?'}${extras?.signal ? ' · ' + extras.signal : ''}`; }
    else if (state === 'crash') { glyph = '⚠'; txt = 'crash'; }
    else if (state === 'spawn') { glyph = '○'; txt = 'spawning'; }
    else { glyph = '·'; txt = state; }
    root.appendChild(el('span', 'cv-lifecycle-glyph', glyph));
    root.appendChild(el('span', null, txt));
    return root;
  }

  function renderFrame(frame) {
    const ex = frame.extracted;
    const dedupKey = (frame.raw && frame.raw.uuid) || `seq:${frame.seq}`;
    if (STATE.seenUuids.has(dedupKey)) return null;
    STATE.seenUuids.add(dedupKey);

    if (frame.type === 'compact_boundary') return renderCompactBoundary(frame);
    if (ex && ex.role === 'assistant') return renderAssistant(frame);
    if (ex && ex.role === 'user') {
      if ((!ex.text_in || !ex.text_in.trim())
          && (!ex.tool_results || !ex.tool_results.length)) return null;
      return renderUser(frame);
    }
    if (ex && ex.role === 'system') {
      if (!SYSTEM_SUBTYPES_VISIBLE.has(ex.subtype)) return null;
      return renderSystem(frame);
    }
    return null;
  }

  function ingestClaudeMsg(frame) {
    if (typeof frame.seq === 'number' && frame.seq > STATE.lastOffset)
      STATE.lastOffset = frame.seq;

    const ex = frame.extracted;

    if (ex && ex.role === 'user' && STATE._pendingUserNode
        && ex.text_in && STATE._pendingUserText
        && (ex.text_in.trim() === STATE._pendingUserText.trim()
            || ex.text_in.includes(STATE._pendingUserText.trim()))) {
      clearOptimisticUser();
    }
    if (ex && ex.role === 'assistant') {
      // Clear pending optimistic in any case — claude responded.
      clearOptimisticUser();
      // Thinking indicator: keep alive if claude is mid-loop (tool_use
      // stop_reason means more turns coming); clear only on terminal
      // stop_reason. vt-0392 v6 fix.
      const terminalReasons = new Set(['end_turn', 'stop_sequence', 'max_tokens']);
      if (ex.stop_reason && terminalReasons.has(ex.stop_reason)) {
        clearThinkingIndicator();
      }
      // If still working (tool_use), re-show thinking when it cleared.
      else if (ex.stop_reason === 'tool_use' && !STATE._thinkingNode && STATE._busy !== false) {
        showThinkingIndicator();
      }
    }
    // User tool_result during a tool chain → keep thinking up.
    if (ex && ex.role === 'user' && ex.tool_results && ex.tool_results.length) {
      if (!STATE._thinkingNode) showThinkingIndicator();
    }

    const node = renderFrame(frame);
    if (node) { clearEmpty(); appendNode(node, frame.seq); }
  }

  function ingestReplayBatch(frame) {
    STATE.replayInFlight = true;
    try {
      for (const p of (frame.lines || [])) ingestClaudeMsg(p);
      if (typeof frame.to_offset === 'number' && frame.to_offset > STATE.lastOffset)
        STATE.lastOffset = frame.to_offset;
      if (frame.is_last) {
        STATE.replayDone = true;
        setStatus('live', 'live');
        if (STATE.list && STATE.list.childElementCount === 0) showEmpty();
      } else {
        requestReplay(STATE.lastOffset);
      }
    } finally {
      STATE.replayInFlight = false;
    }
  }

  function requestReplay(fromOffset) {
    if (!STATE.ws || STATE.ws.readyState !== 1) return;
    // vt-0392 v6: request_id round-trip so hub can route the resulting
    // replay_batch to THIS viewer only instead of broadcasting to all
    // viewers attached to the session.
    STATE._replayRequestId = `rr-${STATE.sessionId}-${Date.now()}`;
    try {
      STATE.ws.send(JSON.stringify({
        type: 'replay_request',
        session_id: STATE.sessionId,
        request_id: STATE._replayRequestId,
        from_offset: fromOffset || 0,
        max_messages: 2000,
      }));
    } catch {}
  }

  function showEmpty() {
    if (!STATE.list || STATE.list.childElementCount > 0) return;
    const empty = el('div', 'cv-empty');
    empty.appendChild(el('div', 'cv-empty-glyph', '◌'));
    empty.appendChild(el('div', 'cv-empty-title', 'standing by'));
    empty.appendChild(el('div', 'cv-empty-sub',
      'session attached · type below to engage'));
    STATE.list.appendChild(empty);
    STATE._emptyNode = empty;
  }

  function clearEmpty() {
    if (STATE._emptyNode && STATE._emptyNode.parentNode === STATE.list)
      STATE.list.removeChild(STATE._emptyNode);
    STATE._emptyNode = null;
  }

  function showOptimisticUser(text) {
    if (!STATE.list) return;
    clearEmpty();
    const root = el('div', 'cv-msg cv-user cv-pending');
    const body = el('div', 'cv-body');
    const div = el('div', 'cv-text');
    div.innerHTML = renderMarkdown(text);
    body.appendChild(div);
    const tag = el('span', 'cv-pending-tag', 'tx…');
    body.appendChild(tag);
    root.appendChild(body);
    STATE._pendingUserNode = root;
    STATE._pendingUserText = text;
    const before = pinnedBottomNode();
    if (before) STATE.list.insertBefore(root, before);
    else STATE.list.appendChild(root);
    scrollToBottom();
    // Timeout safety: if no echo + no assistant in 30s, mark stale.
    if (STATE._pendingTimer) clearTimeout(STATE._pendingTimer);
    STATE._pendingTimer = setTimeout(() => {
      if (STATE._pendingUserNode === root) {
        root.classList.add('cv-pending-stale');
        const t = root.querySelector('.cv-pending-tag');
        if (t) t.textContent = 'no echo · resend?';
      }
    }, PENDING_TIMEOUT_MS);
  }

  function clearOptimisticUser() {
    if (STATE._pendingTimer) { clearTimeout(STATE._pendingTimer); STATE._pendingTimer = null; }
    if (STATE._pendingUserNode && STATE._pendingUserNode.parentNode === STATE.list)
      STATE.list.removeChild(STATE._pendingUserNode);
    STATE._pendingUserNode = null;
    STATE._pendingUserText = null;
  }

  function showThinkingIndicator() {
    if (!STATE.list || STATE._thinkingNode) return;
    const root = el('div', 'cv-thinking');
    root.appendChild(el('span', 'cv-thinking-glyph', '◆'));
    root.appendChild(el('span', null, 'claude is working'));
    const dots = el('span', 'cv-thinking-dots');
    dots.innerHTML = '<span></span><span></span><span></span>';
    root.appendChild(dots);
    const tStart = Date.now();
    const timer = el('span', 'cv-thinking-timer', '0s');
    root.appendChild(timer);
    STATE._thinkingNode = root;
    STATE._thinkingTimerId = setInterval(() => {
      const sec = Math.floor((Date.now() - tStart) / 1000);
      timer.textContent = sec >= 60 ? `${Math.floor(sec/60)}m${(sec%60).toString().padStart(2,'0')}s` : `${sec}s`;
    }, 1000);
    STATE.list.appendChild(root);
    scrollToBottom();
  }

  function clearThinkingIndicator() {
    if (STATE._thinkingTimerId) { clearInterval(STATE._thinkingTimerId); STATE._thinkingTimerId = null; }
    if (STATE._thinkingNode && STATE._thinkingNode.parentNode === STATE.list)
      STATE.list.removeChild(STATE._thinkingNode);
    STATE._thinkingNode = null;
  }

  function renderPermissionCard(frame) {
    if (!STATE.list) return;
    clearPermissionCard(frame.request_id);
    const root = el('div', 'cv-perm');
    root.dataset.requestId = frame.request_id || '';
    root.appendChild(el('span', 'cv-perm-badge', '▲ AUTH REQUIRED'));
    if (frame.context) {
      const ctx = el('pre', 'cv-perm-context');
      ctx.textContent = frame.context;
      root.appendChild(ctx);
    }
    const actions = el('div', 'cv-perm-actions');
    const options = frame.options && frame.options.length ? frame.options : ['Yes', 'No'];
    options.forEach((label, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cv-perm-btn';
      if (i === 0) btn.classList.add('cv-perm-allow');
      if (i === options.length - 1) btn.classList.add('cv-perm-deny');
      btn.innerHTML = `<span class="cv-perm-num">${i + 1}</span><span class="cv-perm-label">${escapeHtml(label)}</span>`;
      btn.addEventListener('click', () => sendPermissionChoice(i + 1));
      actions.appendChild(btn);
    });
    root.appendChild(actions);
    STATE._permCards.add(root);
    appendNode(root);
  }

  function clearPermissionCard(requestId) {
    for (const node of Array.from(STATE._permCards)) {
      if (!requestId || node.dataset.requestId === requestId) {
        if (node.parentNode === STATE.list) STATE.list.removeChild(node);
        STATE._permCards.delete(node);
      }
    }
  }

  function sendPermissionChoice(digit) {
    if (!STATE.ws || STATE.ws.readyState !== 1) return;
    try {
      STATE.ws.send(JSON.stringify({
        type: 'send_text', session_id: STATE.sessionId, text: String(digit),
      }));
    } catch {}
  }

  function setComposerEnabled(enabled) {
    if (!STATE.composerInput) return;
    STATE.composerInput.disabled = !enabled;
    if (STATE.composerSend) STATE.composerSend.disabled = !enabled;
    if (enabled) STATE.composerInput.focus();
  }

  function setBusy(busy) {
    STATE._busy = !!busy;
    if (STATE.composer) STATE.composer.classList.toggle('cv-composer-busy', !!busy);
    if (STATE.composerInput) {
      STATE.composerInput.placeholder = busy
        ? 'claude is working — message queued until ready · Shift+Enter newline'
        : 'message claude — Enter ⏎ submit · Shift+Enter newline';
    }
  }

  function sendCurrentText() {
    if (!STATE.ws || STATE.ws.readyState !== 1 || !STATE.composerInput) return;
    const text = STATE.composerInput.value;
    if (!text || !text.trim()) return;
    try {
      STATE.ws.send(JSON.stringify({
        type: 'send_text', session_id: STATE.sessionId, text,
      }));
      STATE.composerInput.value = '';
      autosizeComposer();
      showOptimisticUser(text);
      showThinkingIndicator();
    } catch (e) { console.warn('chatView.send_text failed', e); }
  }

  function sendControl(action) {
    if (!STATE.ws || STATE.ws.readyState !== 1) return;
    try {
      STATE.ws.send(JSON.stringify({
        type: 'control', session_id: STATE.sessionId, action,
      }));
    } catch {}
  }

  function autosizeComposer() {
    const ta = STATE.composerInput;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }

  function setStatus(text, state) {
    if (!STATE.statusBar) return;
    STATE.statusBar.dataset.state = state || '';
    const label = STATE.statusBar.querySelector('.cv-status-label');
    if (label) label.textContent = text;
  }

  function mount(containerEl) {
    STATE.container = containerEl;
    containerEl.innerHTML = '';
    containerEl.classList.add('cv-root');

    const wrap = el('div', 'cv-wrap');
    wrap.appendChild(el('div', 'cv-scanlines'));

    const scroller = el('div', 'cv-scroller');
    const list = el('div', 'cv-list');
    scroller.appendChild(list);
    wrap.appendChild(scroller);

    const status = el('div', 'cv-status');
    status.appendChild(el('span', 'cv-status-dot'));
    status.appendChild(el('span', 'cv-status-label', 'idle'));
    wrap.appendChild(status);

    const composer = el('div', 'cv-composer');
    const frame = el('div', 'cv-composer-frame');
    const ta = document.createElement('textarea');
    ta.className = 'cv-composer-input';
    ta.rows = 1;
    ta.placeholder = 'message claude — Enter ⏎ submit · Shift+Enter newline';
    ta.disabled = true;
    frame.appendChild(ta);

    const actions = el('div', 'cv-composer-actions');
    const escBtn = document.createElement('button');
    escBtn.type = 'button';
    escBtn.className = 'cv-action-btn cv-action-cancel';
    escBtn.textContent = 'esc';
    escBtn.title = 'cancel Ink prompt';
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'cv-action-btn cv-action-stop';
    stopBtn.textContent = 'stop';
    stopBtn.title = 'interrupt (Ctrl-C)';
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'cv-action-btn cv-action-send';
    sendBtn.textContent = '⏎ send';
    sendBtn.disabled = true;
    actions.appendChild(escBtn);
    actions.appendChild(stopBtn);
    actions.appendChild(sendBtn);
    frame.appendChild(actions);
    composer.appendChild(frame);
    wrap.appendChild(composer);

    containerEl.appendChild(wrap);

    STATE.list = list;
    STATE.statusBar = status;
    STATE.composer = composer;
    STATE.composerInput = ta;
    STATE.composerSend = sendBtn;
    STATE.composerStop = stopBtn;
    STATE.composerEsc = escBtn;

    sendBtn.addEventListener('click', sendCurrentText);
    stopBtn.addEventListener('click', () => sendControl('interrupt'));
    escBtn.addEventListener('click', () => sendControl('cancel'));
    ta.addEventListener('input', autosizeComposer);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        sendCurrentText();
      }
    });
  }

  function attach(sessionId, ws, opts = {}) {
    STATE.sessionId = sessionId;
    STATE.ws = ws;
    STATE.replayDone = false;
    STATE.replayInFlight = false;
    STATE.seenUuids.clear();
    STATE.nodeBySeq.clear();
    STATE.lastOffset = 0;
    STATE._emptyNode = null;
    STATE._busy = false;
    if (STATE.list) STATE.list.innerHTML = '';
    setStatus('replaying', 'loading');
    setComposerEnabled(false);
    setBusy(false);
    const fire = () => {
      requestReplay(0);
      setComposerEnabled(true);
    };
    if (ws.readyState === 1) fire();
    else ws.addEventListener('open', fire, { once: true });
  }

  function detach() {
    STATE.ws = null;
    STATE.sessionId = null;
    STATE.replayDone = false;
    STATE.replayInFlight = false;
    STATE.seenUuids.clear();
    STATE.nodeBySeq.clear();
    clearOptimisticUser();
    clearThinkingIndicator();
    clearPermissionCard();
    if (STATE.list) STATE.list.innerHTML = '';
    setStatus('idle', '');
    setComposerEnabled(false);
    setBusy(false);
  }

  function handleFrame(frame) {
    if (!frame || !frame.type) return;
    if (STATE.sessionId && frame.session_id && frame.session_id !== STATE.sessionId) return;
    if (frame.type === 'claude_msg' || frame.type === 'compact_boundary')
      ingestClaudeMsg(frame);
    else if (frame.type === 'replay_batch')
      ingestReplayBatch(frame);
    else if (frame.type === 'permission_request')
      renderPermissionCard(frame);
    else if (frame.type === 'permission_resolved')
      clearPermissionCard(frame.request_id);
    else if (frame.type === 'session_busy') {
      setBusy(!!frame.busy);
      if (frame.busy && !STATE._thinkingNode) showThinkingIndicator();
      else if (!frame.busy) clearThinkingIndicator();
    }
    else if (frame.type === 'session_lifecycle') {
      appendNode(renderLifecycle(frame.state, frame));
      if (frame.state === 'exit' || frame.state === 'crash')
        setStatus(`exit · ${frame.code ?? '?'}`, 'exited');
      else if (frame.state === 'ready')
        setStatus(STATE.replayDone ? 'live' : 'replaying',
          STATE.replayDone ? 'live' : 'loading');
    }
  }

  function getLastOffset() { return STATE.lastOffset; }
  function setLastOffset(n) { STATE.lastOffset = Math.max(0, Number(n) || 0); }

  window.chatView = { mount, attach, detach, handleFrame, getLastOffset, setLastOffset };
})();
