'use strict';
// chat-view.js — fleet chat-UI renderer (vt-0392, Phase 1C).
// Consumes daemon's structured frames (claude_msg / compact_boundary /
// session_lifecycle / replay_batch) and renders message bubbles, tool
// cards, subagent blocks, and compact dividers into a scrollable list.
//
// Read-only. Composer + interactive input ships in Phase 2.
//
// Public API:
//   mount(containerEl)              — bind to a DOM element once.
//   attach(sessionId, ws)           — wire to a WS connection for this session.
//   detach()                        — clear DOM, drop state.
//   handleFrame(frame)              — route a single WS frame.
//   getLastOffset()                 — for caller-side persistence (localStorage).
//   setLastOffset(n)                — restore on reconnect.
//
// Frame shapes match spec § "Frame schemas" (daemon → viewer flatten):
//   { type:'claude_msg', session_id, jsonl_sid, seq, ts, raw, extracted }
//   { type:'compact_boundary', session_id, jsonl_sid, seq, ts, metadata }
//   { type:'session_lifecycle', session_id, state, code?, signal? }
//   { type:'replay_batch', session_id, from_offset, to_offset, is_last, lines }

(function () {
  const STATE = {
    container: null,
    list: null,
    statusBar: null,
    sessionId: null,
    ws: null,
    lastOffset: 0,
    seenUuids: new Set(),
    replayDone: false,
    stickToBottom: true,
    nodeBySeq: new Map(),
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function escapeHtml(s) {
    if (typeof s !== 'string') s = String(s == null ? '' : s);
    return s.replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // Lightweight markdown: code fences, inline code, line breaks. No external
  // dep — full markdown later if needed.
  function renderMarkdown(text) {
    if (!text) return '';
    const escaped = escapeHtml(text);
    // Triple-backtick code blocks.
    let out = escaped.replace(/```([\s\S]*?)```/g, (_, body) =>
      `<pre class="chat-codeblock"><code>${body}</code></pre>`);
    // Inline code.
    out = out.replace(/`([^`\n]+)`/g, '<code class="chat-inline-code">$1</code>');
    // Newlines.
    out = out.replace(/\n/g, '<br>');
    return out;
  }

  function fmtTokens(usage) {
    if (!usage) return '';
    const inT = usage.input_tokens || 0;
    const outT = usage.output_tokens || 0;
    const cr  = usage.cache_read || usage.cache_read_input_tokens || 0;
    const cc5 = usage.cache_creation_5m || usage.cache_creation_input_tokens || 0;
    return `in=${inT} · out=${outT} · cache_r=${cr} · cache_w5m=${cc5}`;
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

  // vt-0392 (MED fix): soft cap on mounted DOM nodes. Full virtualization
  // is vt-0392-followup (react-virtuoso). For now drop oldest nodes when
  // the list grows past CAP — sessions with 10k+ turns no longer freeze
  // the page. User can re-replay via reload (chat tab fires replay_request
  // from offset 0 if localStorage cleared).
  const MAX_MOUNTED_NODES = 2000;
  function appendNode(node, seq) {
    if (!STATE.list) return;
    const stick = STATE.stickToBottom && isAtBottom();
    STATE.list.appendChild(node);
    if (seq != null) STATE.nodeBySeq.set(seq, node);
    // Trim oldest when over cap.
    while (STATE.list.childElementCount > MAX_MOUNTED_NODES) {
      const first = STATE.list.firstElementChild;
      if (!first) break;
      // Sync nodeBySeq map (find + delete the matching entry).
      for (const [k, v] of STATE.nodeBySeq) {
        if (v === first) { STATE.nodeBySeq.delete(k); break; }
      }
      STATE.list.removeChild(first);
    }
    if (stick) scrollToBottom();
  }

  function renderAssistant(payload) {
    const ex = payload.extracted;
    const root = el('div', 'chat-msg chat-msg-assistant');
    if (ex.is_sidechain) root.classList.add('chat-msg-sidechain');
    const head = el('div', 'chat-msg-head');
    head.appendChild(el('span', 'chat-msg-role', ex.is_sidechain ? 'subagent' : 'claude'));
    if (ex.model) head.appendChild(el('span', 'chat-msg-model', ex.model));
    if (ex.usage) head.appendChild(el('span', 'chat-msg-usage', fmtTokens(ex.usage)));
    if (ex.stop_reason) head.appendChild(el('span', 'chat-msg-stop', ex.stop_reason));
    root.appendChild(head);
    const body = el('div', 'chat-msg-body');
    if (ex.thinking_blocks && ex.thinking_blocks.length) {
      const th = el('details', 'chat-thinking');
      th.appendChild(el('summary', null, `thinking (${ex.thinking_blocks.length} block)`));
      const pre = el('pre', 'chat-thinking-text');
      pre.textContent = ex.thinking_blocks.map(b => b.text).join('\n\n---\n\n');
      th.appendChild(pre);
      body.appendChild(th);
    }
    for (const block of (ex.text_blocks || [])) {
      const div = el('div', 'chat-text');
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
    const root = el('div', 'chat-msg chat-msg-user');
    if (ex.is_sidechain) root.classList.add('chat-msg-sidechain');
    if (ex.tool_results && ex.tool_results.length) {
      // tool_result-only user turns render as tool-result cards, not as a
      // separate "user said" bubble (they are produced by claude itself
      // when feeding tool output back into the model).
      root.classList.add('chat-msg-toolresult-only');
      const head = el('div', 'chat-msg-head');
      head.appendChild(el('span', 'chat-msg-role', 'tool result'));
      root.appendChild(head);
      for (const tr of ex.tool_results) {
        root.appendChild(renderToolResult(tr));
      }
      return root;
    }
    const head = el('div', 'chat-msg-head');
    head.appendChild(el('span', 'chat-msg-role', ex.is_sidechain ? 'subagent input' : 'you'));
    root.appendChild(head);
    if (ex.text_in) {
      const div = el('div', 'chat-text');
      div.innerHTML = renderMarkdown(ex.text_in);
      root.appendChild(div);
    }
    return root;
  }

  function renderSystem(payload) {
    const ex = payload.extracted;
    const root = el('div', 'chat-msg chat-msg-system');
    const head = el('div', 'chat-msg-head');
    const label = ex.subtype === 'permission-mode'
      ? 'permission mode'
      : (ex.subtype || 'system');
    head.appendChild(el('span', 'chat-msg-role', label));
    root.appendChild(head);
    if (ex.text) {
      root.appendChild(el('div', 'chat-text', ex.text));
    }
    return root;
  }

  function renderToolCall(tu) {
    const card = el('details', 'chat-tool-card');
    const sum = el('summary', 'chat-tool-summary');
    sum.appendChild(el('span', 'chat-tool-icon', '⚙'));
    sum.appendChild(el('span', 'chat-tool-name', tu.name || '<tool>'));
    const input = tu.input || {};
    // One-line preview of args (truncated).
    const inputPreview = Object.entries(input)
      .map(([k, v]) => {
        const sv = typeof v === 'string' ? v : JSON.stringify(v);
        return `${k}=${sv.length > 60 ? sv.slice(0, 60) + '…' : sv}`;
      })
      .join(' · ');
    if (inputPreview) sum.appendChild(el('span', 'chat-tool-args', inputPreview));
    card.appendChild(sum);
    const body = el('div', 'chat-tool-body');
    const pre = el('pre', 'chat-tool-input');
    pre.textContent = JSON.stringify(input, null, 2);
    body.appendChild(pre);
    card.appendChild(body);
    return card;
  }

  function renderToolResult(tr) {
    const card = el('details', 'chat-tool-result' + (tr.is_error ? ' chat-tool-error' : ''));
    const sum = el('summary');
    sum.appendChild(el('span', 'chat-tool-icon', tr.is_error ? '✗' : '↳'));
    sum.appendChild(el('span', 'chat-tool-label', tr.is_error ? 'tool error' : 'tool output'));
    const content = typeof tr.content === 'string' ? tr.content
      : (Array.isArray(tr.content) ? tr.content.map(c => c.text || JSON.stringify(c)).join('\n') : JSON.stringify(tr.content));
    const truncated = content.length > 200 ? content.slice(0, 200) + '…' : content;
    sum.appendChild(el('span', 'chat-tool-preview', truncated.replace(/\n/g, ' ')));
    card.appendChild(sum);
    const pre = el('pre', 'chat-tool-output');
    pre.textContent = content;
    card.appendChild(pre);
    return card;
  }

  function renderCompactBoundary(payload) {
    const md = payload.metadata || {};
    const root = el('div', 'chat-compact-boundary');
    const txt = el('span', 'chat-compact-label');
    const trigger = md.trigger || 'auto';
    const pre = md.preTokens != null ? md.preTokens : '?';
    const post = md.postTokens != null ? md.postTokens : '?';
    txt.textContent = `↺ compact (${trigger}): ${pre} → ${post} tokens`;
    if (md.durationMs) txt.textContent += ` · ${md.durationMs}ms`;
    root.appendChild(txt);
    return root;
  }

  function renderLifecycle(state, extras) {
    const root = el('div', 'chat-lifecycle chat-lifecycle-' + state);
    let txt;
    if (state === 'ready') txt = '● session ready';
    else if (state === 'exit') txt = `■ session exit · code=${extras?.code ?? '?'}${extras?.signal ? ' · ' + extras.signal : ''}`;
    else if (state === 'crash') txt = '✗ session crash';
    else if (state === 'spawn') txt = '○ spawning…';
    else txt = '· ' + state;
    root.textContent = txt;
    return root;
  }

  function setStatus(text, cls) {
    if (!STATE.statusBar) return;
    STATE.statusBar.textContent = text;
    STATE.statusBar.className = 'chat-status ' + (cls || '');
  }

  function renderFrame(frame) {
    // Dedup by raw.uuid (jsonl every line has one). Same line replayed +
    // live = single render. If no uuid (system/permission-mode without
    // explicit uuid), fall back to seq.
    const ex = frame.extracted;
    const dedupKey = (frame.raw && frame.raw.uuid) || `seq:${frame.seq}`;
    if (STATE.seenUuids.has(dedupKey)) return null;
    STATE.seenUuids.add(dedupKey);

    if (frame.type === 'compact_boundary') return renderCompactBoundary(frame);
    if (ex && ex.role === 'assistant') return renderAssistant(frame);
    if (ex && ex.role === 'user') return renderUser(frame);
    if (ex && ex.role === 'system') return renderSystem(frame);
    return null;
  }

  function ingestClaudeMsg(frame) {
    if (typeof frame.seq === 'number' && frame.seq > STATE.lastOffset) {
      STATE.lastOffset = frame.seq;
    }
    const node = renderFrame(frame);
    if (node) appendNode(node, frame.seq);
  }

  function ingestReplayBatch(frame) {
    for (const payload of (frame.lines || [])) {
      ingestClaudeMsg(payload);
    }
    if (typeof frame.to_offset === 'number' && frame.to_offset > STATE.lastOffset) {
      STATE.lastOffset = frame.to_offset;
    }
    if (frame.is_last) {
      STATE.replayDone = true;
      setStatus('live', 'chat-status-live');
    } else {
      // Request next batch from where we left off.
      requestReplay(STATE.lastOffset);
    }
  }

  function requestReplay(fromOffset) {
    if (!STATE.ws || STATE.ws.readyState !== 1) return;
    try {
      STATE.ws.send(JSON.stringify({
        type: 'replay_request',
        session_id: STATE.sessionId,
        from_offset: fromOffset || 0,
        // vt-0392 (MED fix): use the daemon's hard cap to minimise
        // round-trip count on large sessions (was 500 → ~20 RT on a
        // 10k-turn session; now ~5 RT).
        max_messages: 2000,
      }));
    } catch {}
  }

  function mount(containerEl) {
    STATE.container = containerEl;
    containerEl.innerHTML = '';
    const wrap = el('div', 'chat-wrap');
    const scroller = el('div', 'chat-scroller');
    const list = el('div', 'chat-list');
    scroller.appendChild(list);
    wrap.appendChild(scroller);
    const status = el('div', 'chat-status', 'idle');
    wrap.appendChild(status);
    containerEl.appendChild(wrap);
    STATE.list = list;
    STATE.statusBar = status;
  }

  function attach(sessionId, ws, opts = {}) {
    STATE.sessionId = sessionId;
    STATE.ws = ws;
    STATE.replayDone = false;
    STATE.seenUuids.clear();
    STATE.nodeBySeq.clear();
    STATE.lastOffset = Math.max(0, Number(opts.fromOffset) || 0);
    if (STATE.list) STATE.list.innerHTML = '';
    setStatus('replaying…', 'chat-status-loading');
    // Wait for ws open if not ready, then request initial replay.
    const fire = () => requestReplay(STATE.lastOffset);
    if (ws.readyState === 1) fire();
    else ws.addEventListener('open', fire, { once: true });
  }

  function detach() {
    STATE.ws = null;
    STATE.sessionId = null;
    STATE.replayDone = false;
    STATE.seenUuids.clear();
    STATE.nodeBySeq.clear();
    if (STATE.list) STATE.list.innerHTML = '';
    setStatus('idle', '');
  }

  function handleFrame(frame) {
    if (!frame || !frame.type) return;
    if (STATE.sessionId && frame.session_id && frame.session_id !== STATE.sessionId) return;
    if (frame.type === 'claude_msg') {
      ingestClaudeMsg(frame);
    } else if (frame.type === 'compact_boundary') {
      ingestClaudeMsg(frame);
    } else if (frame.type === 'replay_batch') {
      ingestReplayBatch(frame);
    } else if (frame.type === 'session_lifecycle') {
      appendNode(renderLifecycle(frame.state, frame));
      if (frame.state === 'exit' || frame.state === 'crash') {
        setStatus(`exited code=${frame.code ?? '?'}`, 'chat-status-exited');
      } else if (frame.state === 'ready') {
        setStatus(STATE.replayDone ? 'live' : 'replaying…',
          STATE.replayDone ? 'chat-status-live' : 'chat-status-loading');
      }
    }
  }

  function getLastOffset() { return STATE.lastOffset; }
  function setLastOffset(n) { STATE.lastOffset = Math.max(0, Number(n) || 0); }

  window.chatView = {
    mount, attach, detach, handleFrame, getLastOffset, setLastOffset,
  };
})();
