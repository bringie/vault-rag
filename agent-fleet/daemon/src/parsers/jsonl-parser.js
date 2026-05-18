'use strict';

// parseJsonlLine(text, byteOffset) → { type, payload } | null
// Stateless parser: returns the structured frame payload for ONE line.
// Returns null for lines we do not want to surface to the UI (unknown
// top-level type, unparseable JSON, etc.).
//
// makeStatefulParser() → fn(text, byteOffset) → ...
// Wraps parseJsonlLine with a per-session filter that drops permission-mode
// no-op repeats (sample data has ~1,368 of these lines per session, almost
// all default→default; only mode transitions are worth broadcasting).
function parseJsonlLine(text, byteOffset) {
  let raw;
  try { raw = JSON.parse(text); }
  catch { return null; }
  if (!raw || typeof raw !== 'object') return null;

  const seq = byteOffset;
  const ts = raw.ts || raw.timestamp || null;
  const jsonl_sid = raw.sessionId || null;

  // compact_boundary — Claude Code emits these as system events on /compact
  // or auto-compact. Don't bury them inside claude_msg; render as a clear
  // visual boundary in the chat.
  if (raw.type === 'system' && raw.subtype === 'compact_boundary') {
    return {
      type: 'compact_boundary',
      payload: {
        jsonl_sid, seq, ts,
        metadata: raw.compactMetadata || {},
      }
    };
  }

  // Top-level types we surface as claude_msg.
  const HANDLED_TOPLEVEL = new Set([
    'assistant', 'user', 'system', 'permission-mode'
  ]);
  if (!HANDLED_TOPLEVEL.has(raw.type)) return null;

  const extracted = {
    role: roleFor(raw),
    is_sidechain: raw.isSidechain === true,
    parent_uuid: raw.parentUuid || null,
    uuid: raw.uuid || null,
    subtype: raw.type === 'permission-mode' ? 'permission-mode' : (raw.subtype || null),
  };

  if (raw.type === 'assistant') {
    const msg = raw.message || {};
    extracted.model = msg.model || null;
    extracted.text_blocks = [];
    extracted.tool_uses = [];
    extracted.thinking_blocks = [];
    for (const block of (msg.content || [])) {
      if (block.type === 'text') extracted.text_blocks.push(block);
      else if (block.type === 'tool_use') {
        extracted.tool_uses.push({
          id: block.id, name: block.name, input: block.input
        });
      }
      else if (block.type === 'thinking') {
        extracted.thinking_blocks.push({ text: block.thinking || block.text || '' });
      }
    }
    extracted.usage = msg.usage || null;
    extracted.stop_reason = msg.stop_reason || null;
  } else if (raw.type === 'user') {
    const msg = raw.message || {};
    extracted.tool_results = [];
    extracted.text_in = null;
    // Real Claude Code writes user-turn message.content in two shapes:
    //   string  — when the user typed a plain prompt into Ink and submitted
    //   array   — when the daemon-mode CLI invoked claude with structured
    //             content (text + tool_result blocks). Handle both.
    if (typeof msg.content === 'string') {
      extracted.text_in = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          extracted.text_in = (extracted.text_in || '') + (block.text || '');
        } else if (block.type === 'tool_result') {
          extracted.tool_results.push({
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error === true,
          });
        }
      }
    }
  } else if (raw.type === 'system') {
    extracted.text = raw.text || raw.message || '';
  } else if (raw.type === 'permission-mode') {
    extracted.text = `Permission mode: ${raw.permissionMode || 'unknown'}`;
  }

  return {
    type: 'claude_msg',
    payload: { jsonl_sid, seq, ts, raw, extracted }
  };
}

function roleFor(raw) {
  if (raw.type === 'assistant') return 'assistant';
  if (raw.type === 'user') return 'user';
  return 'system';
}

function makeStatefulParser() {
  let lastPermissionMode = null;
  return function(text, byteOffset) {
    const parsed = parseJsonlLine(text, byteOffset);
    if (!parsed) return null;
    // permission-mode dedupe — only emit on transitions.
    if (parsed.type === 'claude_msg'
        && parsed.payload.raw.type === 'permission-mode') {
      const mode = parsed.payload.raw.permissionMode;
      if (mode === lastPermissionMode) return null;
      lastPermissionMode = mode;
    }
    return parsed;
  };
}

module.exports = { parseJsonlLine, makeStatefulParser };
