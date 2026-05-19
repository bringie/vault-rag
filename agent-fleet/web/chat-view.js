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
    _slashCommands: [],
    _slashDropdown: null,
    _slashFiltered: [],
    _slashIndex: 0,
    _slashRafPending: false,
    // vt-0397 virtualization: mounted = nodes currently in DOM (ordered
    // oldest→newest, claude_msg/compact only). unmounted = detached
    // nodes after eviction; the DOM tree stays alive in memory so we
    // re-attach instead of re-render on scroll-up. Top sentinel +
    // IntersectionObserver triggers the re-mount.
    _mountedMsgNodes: [],
    _unmountedMsgNodes: [],
    _topSentinel: null,
    _topObserver: null,
    _loadOlderBtn: null,
    _chainNode: null,  // vt-0430: active <details class=cv-chain>
    _systemDedup: new Set(),  // vt-0430 round 2: 'subtype:value' seen
  };

  const MAX_MOUNTED_NODES = 500;
  const LOAD_OLDER_BATCH = 200;
  // vt-0400: cap detached-node retention so a 10k-turn session can't pin
  // 9.5k DOM subtrees in memory forever. Past this depth, scrolling back
  // requires a replay_request from disk (daemon path).
  const MAX_UNMOUNTED_NODES = 2 * LOAD_OLDER_BATCH;
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

  // vt-0396 NIT fix / vt-0410 NIT 4: grapheme-aware truncation. The
  // initial implementation iterated by code point with for..of, which
  // handles surrogate pairs but still splits ZWJ sequences (e.g.
  // 👨‍👩‍👧 = 5 code points). Use Intl.Segmenter where available so
  // family emoji, flag pairs, skin-tone selectors, etc. stay intact.
  // Fall back to a code-point loop on older targets.
  // O(n²) concat is fine here — caller caps n at 60/140.
  const _SEGMENTER = (typeof Intl !== 'undefined' && Intl.Segmenter)
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  function truncateCp(s, maxCp) {
    if (typeof s !== 'string') return '';
    let out = '';
    let count = 0;
    if (_SEGMENTER) {
      for (const seg of _SEGMENTER.segment(s)) {
        if (count >= maxCp) return out + '…';
        out += seg.segment;
        count++;
      }
      return out;
    }
    for (const ch of s) {
      if (count >= maxCp) return out + '…';
      out += ch;
      count++;
    }
    return out;
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
    // vt-0397 virtualization: track this node in the mounted-msgs array
    // when it's a real conversation node (msg/compact/system/lifecycle).
    // The thinking + perm + empty + sentinel nodes are managed outside
    // and never enter the virtualization arrays.
    if (opts.virtualize !== false && isVirtualizableNode(node)) {
      STATE._mountedMsgNodes.push(node);
      evictExcess();
    }
    if (stick) scrollToBottom();
  }

  function isVirtualizableNode(node) {
    if (!node || !node.classList) return false;
    return node.classList.contains('cv-msg')
        || node.classList.contains('cv-compact')
        || node.classList.contains('cv-system-line')
        || node.classList.contains('cv-lifecycle')
        || node.classList.contains('cv-chain');  // vt-0430
  }

  function evictExcess() {
    // vt-0397 perf: skip O(n) eviction during replay — ingestReplayBatch
    // calls flushEvictionAfterReplay() once when the batch is fully drained.
    if (STATE.replayInFlight) return;
    while (STATE._mountedMsgNodes.length > MAX_MOUNTED_NODES) {
      const oldest = STATE._mountedMsgNodes.shift();
      if (oldest.parentNode) oldest.parentNode.removeChild(oldest);
      // vt-0397 MED fix: drop the nodeBySeq mapping for evicted nodes so
      // the map can't grow unboundedly across long sessions.
      dropFromNodeBySeq(oldest);
      STATE._unmountedMsgNodes.push(oldest);
    }
    // vt-0400 fix: cap detached-node retention. Once we're past the
    // re-mountable window, drop the oldest unmounted DOM subtree outright.
    while (STATE._unmountedMsgNodes.length > MAX_UNMOUNTED_NODES) {
      STATE._unmountedMsgNodes.shift();
    }
    updateLoadOlderUi();
  }

  // vt-0399 fix: symmetric eviction for the *bottom* of the mounted
  // window. After loadOlderBatch prepends 200 older nodes, the live tail
  // becomes excess; without this trim the mounted count grows by
  // LOAD_OLDER_BATCH every click, defeating MAX_MOUNTED_NODES.
  function evictTail() {
    if (STATE.replayInFlight) return;
    while (STATE._mountedMsgNodes.length > MAX_MOUNTED_NODES) {
      const newest = STATE._mountedMsgNodes.pop();
      if (newest.parentNode) newest.parentNode.removeChild(newest);
      dropFromNodeBySeq(newest);
      // Detached newest goes back into unmounted at the *tail* — those
      // are the live messages the user just scrolled away from.
      STATE._unmountedMsgNodes.push(newest);
    }
    while (STATE._unmountedMsgNodes.length > MAX_UNMOUNTED_NODES) {
      STATE._unmountedMsgNodes.shift();
    }
    updateLoadOlderUi();
  }

  function dropFromNodeBySeq(node) {
    for (const [k, v] of STATE.nodeBySeq) {
      if (v === node) { STATE.nodeBySeq.delete(k); return; }
    }
  }

  // vt-0410 NIT 1: simplified — invariant is that ingestReplayBatch's
  // finally block has already cleared replayInFlight before this runs.
  // Just trigger the deferred eviction pass.
  function flushEvictionAfterReplay() { evictExcess(); }

  // vt-0397: re-attach the most-recently-evicted batch on scroll-up.
  // Preserves scroll position by anchoring on the previously-top node's
  // bounding rect (avoids viewport jump).
  function loadOlderBatch() {
    if (!STATE.list || !STATE._unmountedMsgNodes.length) return;
    const scroller = STATE.list.parentElement;
    if (!scroller) return;
    // vt-0403 fix: disable smooth-scroll BEFORE any DOM mutation so a
    // mid-flight animation from a prior scrollToBottom can't interfere
    // with the anchor delta. Restored at the end.
    const prevBehavior = scroller.style.scrollBehavior;
    scroller.style.scrollBehavior = 'auto';
    const oldFirst = STATE._mountedMsgNodes[0] || null;
    const anchorRect = oldFirst ? oldFirst.getBoundingClientRect() : null;
    const batch = STATE._unmountedMsgNodes.splice(
      Math.max(0, STATE._unmountedMsgNodes.length - LOAD_OLDER_BATCH));
    const insertBeforeRef = oldFirst || pinnedBottomNode();
    for (const node of batch) {
      if (insertBeforeRef) STATE.list.insertBefore(node, insertBeforeRef);
      else STATE.list.appendChild(node);
    }
    STATE._mountedMsgNodes = batch.concat(STATE._mountedMsgNodes);
    if (anchorRect && oldFirst) {
      const newRect = oldFirst.getBoundingClientRect();
      scroller.scrollTop += (newRect.top - anchorRect.top);
    }
    scroller.style.scrollBehavior = prevBehavior;
    // vt-0399 fix: trim the tail so the net mounted count stays ≤
    // MAX_MOUNTED_NODES. The newest mounted nodes become unmounted —
    // they're the live messages the user just scrolled away from.
    evictTail();
    updateLoadOlderUi();
  }

  function setupTopSentinel() {
    if (!STATE.list || STATE._topSentinel) return;
    const sentinel = el('div', 'cv-load-older-sentinel');
    sentinel.style.minHeight = '1px';
    STATE.list.insertBefore(sentinel, STATE.list.firstChild);
    STATE._topSentinel = sentinel;
    if (typeof IntersectionObserver === 'function') {
      const scroller = STATE.list.parentElement;
      // vt-0410 NIT 2: warn instead of silently falling back to viewport
      // root. attach() should always be called after mount(), so a null
      // scroller means the public API was misused.
      if (!scroller) {
        console.warn('[chat-view] setupTopSentinel: list has no parent; ' +
          'attach() must run after mount(). Falling back to viewport root.');
      }
      STATE._topObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) loadOlderBatch();
        }
      }, { root: scroller || null, rootMargin: '300px 0px 0px 0px' });
      STATE._topObserver.observe(sentinel);
    }
  }

  function teardownTopSentinel() {
    if (STATE._topObserver) {
      try { STATE._topObserver.disconnect(); } catch {}
      STATE._topObserver = null;
    }
    STATE._topSentinel = null;
  }

  function updateLoadOlderUi() {
    if (!STATE._loadOlderBtn) return;
    const has = STATE._unmountedMsgNodes.length > 0;
    STATE._loadOlderBtn.style.display = has ? '' : 'none';
    if (has) {
      STATE._loadOlderBtn.textContent =
        `↑ load ${Math.min(LOAD_OLDER_BATCH, STATE._unmountedMsgNodes.length)} older messages`;
    }
  }

  function renderAssistant(payload) {
    const ex = payload.extracted;
    const root = el('div', 'cv-msg cv-assistant');
    if (ex.is_sidechain) root.classList.add('cv-sidechain');

    // vt-0430 (round 2): only render the ⓘ meta badge for TERMINAL turns
    // with actual usage data. Per-turn ⓘ on every intermediate tool_use
    // turn produced a cluster of empty badges between user prompt and
    // final answer.
    const isFinal = !ex.stop_reason || ex.stop_reason === 'end_turn'
      || ex.stop_reason === 'stop_sequence' || ex.stop_reason === 'max_tokens';
    if (isFinal && ex.usage && (ex.usage.input_tokens || ex.usage.output_tokens)) {
      const meta = document.createElement('details');
      meta.className = 'cv-meta';
      const sum = el('summary', 'cv-meta-trigger', 'ⓘ');
      meta.appendChild(sum);
      const inner = el('span', 'cv-meta-inner');
      if (ex.model) inner.appendChild(el('span', 'cv-meta-model', ex.model.replace(/^claude-/, '')));
      inner.appendChild(el('span', 'cv-meta-tokens', fmtTokens(ex.usage)));
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

    // vt-0430: tool calls render flat — the chain-level wrapper (cv-chain)
    // applied in ingestClaudeMsg collects ALL tool calls + results across
    // all turns of an agent processing chain into one collapsible. v1 per-
    // turn grouping was confusing — every Claude turn shipped its own
    // <details>, so a 5-step chain looked like 5 separate collapsibles.
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
      // vt-0430: results render flat — cv-chain in ingestClaudeMsg wraps
      // the whole chain. v1 per-turn grouping defeated the point: 5
      // tool_result turns produced 5 separate collapsibles.
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
        return `${k}:${truncateCp(sv, 60)}`;
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
    const truncated = truncateCp(content, 140);
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

    // vt-0430: collapse the entire agent processing chain (tool_uses +
    // tool_results AND any intermediate thinking-only assistant turns,
    // PLUS system events that fire while the chain is open) into ONE
    // <details>. Two signals open/extend the chain:
    //   - assistant turn whose stop_reason='tool_use' (Claude is mid-loop,
    //     even if THIS turn carries only thinking/text and no tool_use)
    //   - user turn with tool_results
    // Chain closes when an assistant terminal stop_reason arrives without
    // any tool_uses queued, OR a plain user text turn appears.
    const isAssistant = ex && ex.role === 'assistant';
    const isUser = ex && ex.role === 'user';
    const isSystem = ex && ex.role === 'system';
    const TERMINAL = new Set(['end_turn', 'stop_sequence', 'max_tokens']);
    const intermediateAssistant = isAssistant && ex.stop_reason === 'tool_use';
    const toolResultUser = isUser && (ex.tool_results || []).length;
    const inChain = intermediateAssistant || toolResultUser
      // System events while chain is open belong inside it — otherwise
      // operator sees "permission mode → default" orphaned between user
      // prompt and final assistant answer.
      || (isSystem && STATE._chainNode);
    const closesChain =
      (isAssistant && TERMINAL.has(ex.stop_reason || '') && !(ex.tool_uses || []).length)
      || (isUser && ex.text_in && !(ex.tool_results || []).length);

    // vt-0430 (round 2): dedup system permission-mode + session_start.
    // Claude emits these on every tool_use turn → operator sees three or
    // four identical lines. Show once per distinct value across the
    // session.
    if (isSystem && (ex.subtype === 'permission-mode' || ex.subtype === 'session_start')) {
      const key = ex.subtype + ':' +
        ((frame.raw && frame.raw.permissionMode) || ex.text || '');
      if (STATE._systemDedup.has(key)) return;
      STATE._systemDedup.add(key);
    }

    if (inChain) {
      const wrap = ensureChainOpen();
      const node = renderFrame(frame);
      if (node) {
        wrap.appendChild(node);
        refreshChainSummary(wrap);
      }
      return;
    }

    if (closesChain) closeChain();

    const node = renderFrame(frame);
    if (node) { clearEmpty(); appendNode(node, frame.seq); }
  }

  // vt-0430: chain wrapper helpers.
  function ensureChainOpen() {
    if (STATE._chainNode && STATE._chainNode.parentNode === STATE.list) return STATE._chainNode;
    const wrap = document.createElement('details');
    wrap.className = 'cv-chain';
    const sum = el('summary', 'cv-chain-summary');
    sum.appendChild(el('span', 'cv-chain-chevron', '▸'));
    sum.appendChild(el('span', 'cv-chain-label', '…working'));
    sum.appendChild(el('span', 'cv-chain-meta', ''));
    wrap.appendChild(sum);
    STATE._chainNode = wrap;
    clearEmpty();
    appendNode(wrap);
    return wrap;
  }
  function refreshChainSummary(wrap) {
    if (!wrap) return;
    const tools = wrap.querySelectorAll('.cv-tool:not(.cv-tool-result)').length;
    const results = wrap.querySelectorAll('.cv-tool-result').length;
    const errors = wrap.querySelectorAll('.cv-tool-error').length;
    const lbl = wrap.querySelector('.cv-chain-label');
    const meta = wrap.querySelector('.cv-chain-meta');
    if (lbl) {
      const steps = Math.max(tools, results);
      lbl.textContent = STATE._chainNode === wrap
        ? `…${steps} step${steps === 1 ? '' : 's'}`
        : `${steps} step${steps === 1 ? '' : 's'}`;
    }
    if (meta) {
      const parts = [];
      if (tools) parts.push(`${tools} call${tools === 1 ? '' : 's'}`);
      if (errors) parts.push(`${errors} err`);
      meta.textContent = parts.join(' · ');
    }
  }
  function closeChain() {
    if (!STATE._chainNode) return;
    refreshChainSummary(STATE._chainNode);
    STATE._chainNode = null;
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
    // vt-0397 perf: batch-evict once per replay tranche.
    flushEvictionAfterReplay();
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

    // vt-0397: explicit fallback button for browsers without IntersectionObserver
    // or when fast-scroll skips past the sentinel before it can fire.
    const loadOlder = document.createElement('button');
    loadOlder.type = 'button';
    loadOlder.className = 'cv-load-older-btn';
    loadOlder.textContent = '↑ load older messages';
    loadOlder.style.display = 'none';
    loadOlder.addEventListener('click', loadOlderBatch);
    scroller.insertBefore(loadOlder, list);
    STATE._loadOlderBtn = loadOlder;

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
    ta.addEventListener('input', () => { autosizeComposer(); updateSlashDropdown(); });
    // vt-0398 MED fix: close on blur immediately — pointerdown handlers on
    // dropdown items call preventDefault, so blur won't fire when clicking
    // a suggestion. The old 120ms setTimeout was a fragile bandage that
    // raced touch input on mobile.
    ta.addEventListener('blur', () => closeSlashDropdown());
    ta.addEventListener('keydown', (e) => {
      // Slash autocomplete navigation
      if (STATE._slashDropdown) {
        if (e.key === 'ArrowDown') {
          e.preventDefault(); moveSlashCursor(1); return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault(); moveSlashCursor(-1); return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault(); acceptSlashCompletion(); return;
        }
        if (e.key === 'Escape') {
          e.preventDefault(); closeSlashDropdown(); return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        sendCurrentText();
      }
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // slash autocomplete
  // ────────────────────────────────────────────────────────────────────
  function getSlashQueryAtCursor() {
    const ta = STATE.composerInput;
    if (!ta) return null;
    const val = ta.value;
    const pos = ta.selectionStart || 0;
    // Look back for `/` at start of line or after whitespace.
    let i = pos - 1;
    while (i >= 0 && /[\w\-]/.test(val[i])) i--;
    if (i < 0) return null;
    if (val[i] !== '/') return null;
    if (i > 0 && !/\s/.test(val[i - 1])) return null;
    const query = val.slice(i + 1, pos);
    return { start: i, end: pos, query };
  }

  function updateSlashDropdown() {
    const q = getSlashQueryAtCursor();
    if (!q || !STATE._slashCommands.length) { closeSlashDropdown(); return; }
    const needle = q.query.toLowerCase();
    const filtered = STATE._slashCommands.filter(c =>
      c.name.toLowerCase().includes('/' + needle) || c.name.toLowerCase().slice(1).startsWith(needle)
    ).slice(0, 8);
    if (!filtered.length) { closeSlashDropdown(); return; }
    STATE._slashFiltered = filtered;
    STATE._slashIndex = 0;
    renderSlashDropdown();
  }

  // vt-0398 MED fix: RAF-throttle. Held arrow keys + rapid 'input' events
  // would otherwise rebuild dropdown DOM O(n_items) times per frame.
  function renderSlashDropdown() {
    if (STATE._slashRafPending) return;
    STATE._slashRafPending = true;
    requestAnimationFrame(() => {
      STATE._slashRafPending = false;
      _renderSlashDropdownNow();
    });
  }

  function _renderSlashDropdownNow() {
    if (!STATE._slashFiltered.length) { closeSlashDropdown(); return; }
    closeSlashDropdown(true);
    const drop = el('div', 'cv-slash-dropdown');
    STATE._slashFiltered.forEach((c, i) => {
      const item = el('div', 'cv-slash-item');
      if (i === STATE._slashIndex) item.classList.add('cv-slash-active');
      item.appendChild(el('span', 'cv-slash-name', c.name));
      if (c.description) item.appendChild(el('span', 'cv-slash-desc', c.description));
      // vt-0398 MED fix: pointerdown covers mouse + touch + pen; preventDefault
      // stops the textarea from blurring → no race with blur-close.
      item.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        STATE._slashIndex = i;
        acceptSlashCompletion();
      });
      drop.appendChild(item);
    });
    if (STATE.composer) STATE.composer.appendChild(drop);
    STATE._slashDropdown = drop;
  }

  function moveSlashCursor(delta) {
    if (!STATE._slashFiltered.length) return;
    STATE._slashIndex = (STATE._slashIndex + delta + STATE._slashFiltered.length)
      % STATE._slashFiltered.length;
    renderSlashDropdown();
  }

  function acceptSlashCompletion() {
    const q = getSlashQueryAtCursor();
    const cmd = STATE._slashFiltered[STATE._slashIndex];
    if (!q || !cmd || !STATE.composerInput) { closeSlashDropdown(); return; }
    const ta = STATE.composerInput;
    const before = ta.value.slice(0, q.start);
    const after = ta.value.slice(q.end);
    ta.value = before + cmd.name + ' ' + after;
    const caret = (before + cmd.name + ' ').length;
    ta.setSelectionRange(caret, caret);
    closeSlashDropdown();
    // vt-0398 MED fix: dispatch input event so the autosize +
    // dropdown re-eval listener runs (programmatic .value=...
    // doesn't fire input automatically).
    try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
  }

  function closeSlashDropdown(silent) {
    if (STATE._slashDropdown && STATE._slashDropdown.parentNode) {
      STATE._slashDropdown.parentNode.removeChild(STATE._slashDropdown);
    }
    STATE._slashDropdown = null;
    if (!silent) {
      STATE._slashFiltered = [];
      STATE._slashIndex = 0;
    }
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
    teardownTopSentinel();
    STATE._mountedMsgNodes = [];
    STATE._unmountedMsgNodes = [];
    STATE._chainNode = null;  // vt-0430
    STATE._systemDedup = new Set();  // vt-0430 round 2
    if (STATE.list) STATE.list.innerHTML = '';
    setupTopSentinel();
    updateLoadOlderUi();
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
    teardownTopSentinel();
    STATE._mountedMsgNodes = [];
    STATE._unmountedMsgNodes = [];
    STATE._chainNode = null;  // vt-0430
    STATE._systemDedup = new Set();  // vt-0430 round 2
    if (STATE.list) STATE.list.innerHTML = '';
    updateLoadOlderUi();
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
    else if (frame.type === 'slash_inventory') {
      if (Array.isArray(frame.commands)) {
        STATE._slashCommands = frame.commands.slice();
      }
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
