# Fleet Chat-UI Phase 1A — Daemon Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Daemon-side foundation for reading Claude Code's `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl` and emitting structured frames. No hub or SPA work — Phase 1A is daemon-internal only and verified entirely by unit tests against fixture jsonl files.

**Architecture:** Three pure modules (`jsonl-path` for path encoding, `parsers/jsonl-parser` for line shaping, `session-store` extension for byte-offset durability) plus two stateful classes (`JsonlTailer` for per-session tailing, `SubagentTailer` for sidecar discovery). All emit structured payloads via an injected callback so they are tested without WS.

**Tech Stack:** Node.js 20+, `node:test` runner, `node:fs` (`fs.watch`, streams), `node:path`, `node:assert`. No new dependencies. CommonJS, `'use strict'`, single quotes, 2-space indent.

**Spec:** `docs/superpowers/specs/2026-05-18-fleet-chat-ui-design.md`

**Out of scope (deferred to Phase 1B+):** hub frame dispatch, SPA chat-view, ws-client wiring, send_text/control bridges, busy-state, slash-inventory, replay_request response.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `agent-fleet/daemon/src/jsonl-path.js` | NEW | Pure: encode `cwd` → project dir name; build expected jsonl path. |
| `agent-fleet/daemon/src/parsers/jsonl-parser.js` | NEW | Pure: parse one jsonl line → `claude_msg`, `compact_boundary`, or `null` (filtered). |
| `agent-fleet/daemon/src/jsonl-tailer.js` | NEW | `JsonlTailer` class: fs.watch + open-on-create + tail with byte-offset cursor. Emits via callback. |
| `agent-fleet/daemon/src/subagent-tailer.js` | NEW | `SubagentTailer` class: watch `<sid>/subagents/` sidecar dir, spawn sub-tailers, tag `is_sidechain=true`. |
| `agent-fleet/daemon/src/session-store.js` | EDIT | Add `getOffset(id)` / `setOffset(id, offset)` persisted to `sessions.json`. |
| `agent-fleet/daemon/test/jsonl-path.test.js` | NEW | Encoder unit tests. |
| `agent-fleet/daemon/test/parsers/jsonl-parser.test.js` | NEW | Parser shape tests against real-data fixtures. |
| `agent-fleet/daemon/test/jsonl-tailer.test.js` | NEW | Tailer behaviour tests (waiting → tailing, offset cursor, restart resume). |
| `agent-fleet/daemon/test/subagent-tailer.test.js` | NEW | Subagent discovery + sub-tailer spawn tests. |
| `agent-fleet/daemon/test/session-store.test.js` | EDIT | Cover new `getOffset` / `setOffset`. |
| `agent-fleet/daemon/test/fixtures/jsonl/simple-session.jsonl` | NEW | Minimal real-shape session (5 lines). |
| `agent-fleet/daemon/test/fixtures/jsonl/with-tool-uses.jsonl` | NEW | Assistant with tool_use + matching user with tool_result. |
| `agent-fleet/daemon/test/fixtures/jsonl/compact-mid-session.jsonl` | NEW | Includes `system / subtype:compact_boundary` event. |
| `agent-fleet/daemon/test/fixtures/jsonl/permission-mode-spam.jsonl` | NEW | 5 `permission-mode` lines, only 1 actual mode change. |

---

## Task 1: `jsonl-path` — cwd → project dir encoder

**Files:**
- Create: `agent-fleet/daemon/src/jsonl-path.js`
- Create: `agent-fleet/daemon/test/jsonl-path.test.js`

Pure function module. Two exports: `encodeProjectDir(cwd)` and `expectedJsonlPath(cwd, sessionId, home)`.

- [ ] **Step 1.1: Write the failing test**

Create `agent-fleet/daemon/test/jsonl-path.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { encodeProjectDir, expectedJsonlPath } = require('../src/jsonl-path');

test('encodeProjectDir: /root → -root', () => {
  assert.strictEqual(encodeProjectDir('/root'), '-root');
});

test('encodeProjectDir: /tmp/foo → -tmp-foo', () => {
  assert.strictEqual(encodeProjectDir('/tmp/foo'), '-tmp-foo');
});

test('encodeProjectDir: deep nested', () => {
  assert.strictEqual(
    encodeProjectDir('/root/work/vault-rag-oss'),
    '-root-work-vault-rag-oss'
  );
});

test('encodeProjectDir: trailing slash trimmed', () => {
  assert.strictEqual(encodeProjectDir('/root/'), '-root');
});

test('encodeProjectDir: throws on relative path', () => {
  assert.throws(() => encodeProjectDir('relative/path'),
    /absolute path required/);
});

test('encodeProjectDir: throws on empty', () => {
  assert.throws(() => encodeProjectDir(''), /absolute path required/);
});

test('expectedJsonlPath: composes home + project dir + sid.jsonl', () => {
  const home = '/home/test';
  const sid = '40b7e279-a7be-4952-993c-39180c1bbbcf';
  const got = expectedJsonlPath('/root', sid, home);
  assert.strictEqual(got,
    '/home/test/.claude/projects/-root/40b7e279-a7be-4952-993c-39180c1bbbcf.jsonl');
});

test('expectedJsonlPath: rejects sessionId with path separators', () => {
  assert.throws(
    () => expectedJsonlPath('/root', '../escape', '/home/test'),
    /invalid sessionId/
  );
});
```

- [ ] **Step 1.2: Run the test and watch it fail**

Run: `cd agent-fleet/daemon && node --test test/jsonl-path.test.js`

Expected: All tests fail with `Cannot find module '../src/jsonl-path'`.

- [ ] **Step 1.3: Implement the module**

Create `agent-fleet/daemon/src/jsonl-path.js`:

```javascript
'use strict';
const path = require('node:path');

// Encodes an absolute cwd into Claude Code's project dir name.
// Rule (empirically derived from ~/.claude/projects/ dir listings):
//   - Strip trailing slash
//   - Replace every '/' with '-' (so absolute paths gain a leading '-')
// Examples:
//   /root           → -root
//   /tmp/foo        → -tmp-foo
//   /root/work/vault-rag-oss → -root-work-vault-rag-oss
function encodeProjectDir(cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
    throw new Error(`absolute path required, got: ${JSON.stringify(cwd)}`);
  }
  let trimmed = cwd;
  if (trimmed.length > 1 && trimmed.endsWith('/')) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed.split('/').join('-');
}

// Builds the full path Claude Code is expected to write its jsonl to.
// home — the user's home directory ($HOME). Always passed in for testability.
// sessionId — uuid produced by the daemon (--session-id flag).
function expectedJsonlPath(cwd, sessionId, home) {
  if (typeof sessionId !== 'string' || /[\/\\\0]/.test(sessionId)) {
    throw new Error(`invalid sessionId: ${JSON.stringify(sessionId)}`);
  }
  const dir = encodeProjectDir(cwd);
  return path.join(home, '.claude', 'projects', dir, `${sessionId}.jsonl`);
}

module.exports = { encodeProjectDir, expectedJsonlPath };
```

- [ ] **Step 1.4: Run the test and watch it pass**

Run: `cd agent-fleet/daemon && node --test test/jsonl-path.test.js`

Expected: `# pass 8`, `# fail 0`.

- [ ] **Step 1.5: Commit**

```bash
cd /root/work/vault-rag-oss
git add agent-fleet/daemon/src/jsonl-path.js agent-fleet/daemon/test/jsonl-path.test.js
git commit -m "feat(chat-ui-1a): jsonl-path encoder + path builder

Pure module mapping a daemon-spawn cwd to Claude Code's project dir
under ~/.claude/projects/<enc>/<sid>.jsonl. Encoding: replace every '/'
with '-' after trimming trailing slash. Validated against the real
project dirs on host (/root/.claude/projects/-root/, -tmp-..., etc.).

8/8 unit tests passing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Fixture jsonl files

**Files:**
- Create: `agent-fleet/daemon/test/fixtures/jsonl/simple-session.jsonl`
- Create: `agent-fleet/daemon/test/fixtures/jsonl/with-tool-uses.jsonl`
- Create: `agent-fleet/daemon/test/fixtures/jsonl/compact-mid-session.jsonl`
- Create: `agent-fleet/daemon/test/fixtures/jsonl/permission-mode-spam.jsonl`

Fixtures are real-shape but minimised. Each file is a sequence of one-line JSON records ending with `\n`.

- [ ] **Step 2.1: Create `simple-session.jsonl`**

Write `agent-fleet/daemon/test/fixtures/jsonl/simple-session.jsonl` (5 lines, content below — each line is one JSON object):

```jsonl
{"type":"system","subtype":"session_start","sessionId":"sess-1","ts":"2026-05-18T12:00:00.000Z","uuid":"u-1","version":"2.1.143"}
{"type":"user","sessionId":"sess-1","ts":"2026-05-18T12:00:01.000Z","uuid":"u-2","parentUuid":null,"message":{"role":"user","content":[{"type":"text","text":"hello"}]}}
{"type":"assistant","sessionId":"sess-1","ts":"2026-05-18T12:00:02.000Z","uuid":"u-3","parentUuid":"u-2","isSidechain":false,"message":{"role":"assistant","model":"claude-opus-4-7","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
{"type":"permission-mode","sessionId":"sess-1","ts":"2026-05-18T12:00:03.000Z","uuid":"u-4","permissionMode":"default"}
{"type":"user","sessionId":"sess-1","ts":"2026-05-18T12:00:04.000Z","uuid":"u-5","parentUuid":"u-3","message":{"role":"user","content":[{"type":"text","text":"bye"}]}}
```

- [ ] **Step 2.2: Create `with-tool-uses.jsonl`**

Write `agent-fleet/daemon/test/fixtures/jsonl/with-tool-uses.jsonl` (4 lines):

```jsonl
{"type":"user","sessionId":"sess-2","ts":"2026-05-18T12:00:00.000Z","uuid":"u-1","parentUuid":null,"message":{"role":"user","content":[{"type":"text","text":"list files"}]}}
{"type":"assistant","sessionId":"sess-2","ts":"2026-05-18T12:00:01.000Z","uuid":"u-2","parentUuid":"u-1","isSidechain":false,"message":{"role":"assistant","model":"claude-opus-4-7","content":[{"type":"tool_use","id":"toolu-1","name":"Bash","input":{"command":"ls /tmp"}}],"stop_reason":"tool_use","usage":{"input_tokens":20,"output_tokens":8}}}
{"type":"user","sessionId":"sess-2","ts":"2026-05-18T12:00:02.000Z","uuid":"u-3","parentUuid":"u-2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu-1","content":"foo\nbar\n","is_error":false}]},"toolUseResult":{"stdout":"foo\nbar\n","stderr":"","interrupted":false}}
{"type":"assistant","sessionId":"sess-2","ts":"2026-05-18T12:00:03.000Z","uuid":"u-4","parentUuid":"u-3","isSidechain":false,"message":{"role":"assistant","model":"claude-opus-4-7","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn","usage":{"input_tokens":50,"output_tokens":3}}}
```

- [ ] **Step 2.3: Create `compact-mid-session.jsonl`**

Write `agent-fleet/daemon/test/fixtures/jsonl/compact-mid-session.jsonl` (3 lines):

```jsonl
{"type":"assistant","sessionId":"sess-3","ts":"2026-05-18T12:00:00.000Z","uuid":"u-1","parentUuid":null,"isSidechain":false,"message":{"role":"assistant","model":"claude-opus-4-7","content":[{"type":"text","text":"long text..."}],"stop_reason":"end_turn","usage":{"input_tokens":190000,"output_tokens":40}}}
{"type":"system","subtype":"compact_boundary","sessionId":"sess-3","ts":"2026-05-18T12:00:01.000Z","uuid":"u-2","compactMetadata":{"trigger":"auto","preTokens":195000,"postTokens":12000,"durationMs":850}}
{"type":"assistant","sessionId":"sess-3","ts":"2026-05-18T12:00:02.000Z","uuid":"u-3","parentUuid":"u-2","isSidechain":false,"message":{"role":"assistant","model":"claude-opus-4-7","content":[{"type":"text","text":"resumed"}],"stop_reason":"end_turn","usage":{"input_tokens":12010,"output_tokens":5}}}
```

- [ ] **Step 2.4: Create `permission-mode-spam.jsonl`**

Write `agent-fleet/daemon/test/fixtures/jsonl/permission-mode-spam.jsonl` (5 lines):

```jsonl
{"type":"permission-mode","sessionId":"sess-4","ts":"2026-05-18T12:00:00.000Z","uuid":"u-1","permissionMode":"default"}
{"type":"permission-mode","sessionId":"sess-4","ts":"2026-05-18T12:00:01.000Z","uuid":"u-2","permissionMode":"default"}
{"type":"permission-mode","sessionId":"sess-4","ts":"2026-05-18T12:00:02.000Z","uuid":"u-3","permissionMode":"plan"}
{"type":"permission-mode","sessionId":"sess-4","ts":"2026-05-18T12:00:03.000Z","uuid":"u-4","permissionMode":"plan"}
{"type":"permission-mode","sessionId":"sess-4","ts":"2026-05-18T12:00:04.000Z","uuid":"u-5","permissionMode":"default"}
```

- [ ] **Step 2.5: Verify fixtures parse as JSON**

Run: `for f in agent-fleet/daemon/test/fixtures/jsonl/*.jsonl; do echo "== $f =="; while IFS= read -r line; do echo "$line" | python3 -c "import sys,json; json.loads(sys.stdin.read())" || echo "BAD LINE: $line"; done < "$f"; done`

Expected: no "BAD LINE" output.

- [ ] **Step 2.6: Commit fixtures**

```bash
cd /root/work/vault-rag-oss
git add agent-fleet/daemon/test/fixtures/jsonl/
git commit -m "test(chat-ui-1a): jsonl fixture corpus for parser + tailer

Four hand-crafted minimal jsonl files mirroring real Claude Code 2.1.143
event shapes:
  - simple-session.jsonl       — system / user / assistant / mode / user
  - with-tool-uses.jsonl        — assistant tool_use + user tool_result
  - compact-mid-session.jsonl   — system subtype:compact_boundary mid-file
  - permission-mode-spam.jsonl  — 5 mode lines, 2 actual changes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `parsers/jsonl-parser` — line → frame payload

**Files:**
- Create: `agent-fleet/daemon/src/parsers/jsonl-parser.js`
- Create: `agent-fleet/daemon/test/parsers/jsonl-parser.test.js`

Pure function. Input: one line of jsonl text + its byte offset. Output: `{type, payload}` or `null` (filtered). The parser is pass-through-by-default — `raw` always carries the full parsed line; `extracted` holds the normalised convenience view.

- [ ] **Step 3.1: Write failing tests for happy-path types**

Create `agent-fleet/daemon/test/parsers/jsonl-parser.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseJsonlLine, makeStatefulParser } =
  require('../../src/parsers/jsonl-parser');

const FIX = path.join(__dirname, '..', 'fixtures', 'jsonl');

function loadFixtureLines(name) {
  const text = fs.readFileSync(path.join(FIX, name), 'utf8');
  return text.split('\n').filter(l => l.length > 0);
}

test('parseJsonlLine: assistant text → claude_msg with extracted shape', () => {
  const [, , assistantLine] = loadFixtureLines('simple-session.jsonl');
  const out = parseJsonlLine(assistantLine, 100);
  assert.strictEqual(out.type, 'claude_msg');
  assert.strictEqual(out.payload.seq, 100);
  assert.strictEqual(out.payload.extracted.role, 'assistant');
  assert.strictEqual(out.payload.extracted.model, 'claude-opus-4-7');
  assert.strictEqual(out.payload.extracted.stop_reason, 'end_turn');
  assert.deepStrictEqual(out.payload.extracted.text_blocks,
    [{ type: 'text', text: 'hi' }]);
  assert.strictEqual(out.payload.extracted.is_sidechain, false);
  assert.strictEqual(out.payload.extracted.parent_uuid, 'u-2');
  assert.ok(out.payload.raw, 'raw passthrough present');
  assert.strictEqual(out.payload.raw.uuid, 'u-3');
});

test('parseJsonlLine: user text → claude_msg with text_in', () => {
  const [, userLine] = loadFixtureLines('simple-session.jsonl');
  const out = parseJsonlLine(userLine, 50);
  assert.strictEqual(out.type, 'claude_msg');
  assert.strictEqual(out.payload.extracted.role, 'user');
  assert.strictEqual(out.payload.extracted.text_in, 'hello');
  assert.deepStrictEqual(out.payload.extracted.tool_results, []);
});

test('parseJsonlLine: assistant tool_use → extracted.tool_uses', () => {
  const [, assistantLine] = loadFixtureLines('with-tool-uses.jsonl');
  const out = parseJsonlLine(assistantLine, 200);
  assert.strictEqual(out.payload.extracted.stop_reason, 'tool_use');
  assert.deepStrictEqual(out.payload.extracted.tool_uses, [
    { id: 'toolu-1', name: 'Bash', input: { command: 'ls /tmp' } }
  ]);
  assert.deepStrictEqual(out.payload.extracted.text_blocks, []);
});

test('parseJsonlLine: user tool_result → extracted.tool_results', () => {
  const [, , userLine] = loadFixtureLines('with-tool-uses.jsonl');
  const out = parseJsonlLine(userLine, 300);
  assert.strictEqual(out.payload.extracted.role, 'user');
  assert.deepStrictEqual(out.payload.extracted.tool_results, [
    { tool_use_id: 'toolu-1', content: 'foo\nbar\n', is_error: false }
  ]);
});

test('parseJsonlLine: compact_boundary subtype → compact_boundary frame', () => {
  const [, boundaryLine] = loadFixtureLines('compact-mid-session.jsonl');
  const out = parseJsonlLine(boundaryLine, 500);
  assert.strictEqual(out.type, 'compact_boundary');
  assert.deepStrictEqual(out.payload.metadata, {
    trigger: 'auto', preTokens: 195000, postTokens: 12000, durationMs: 850
  });
});

test('parseJsonlLine: returns null on unparseable line', () => {
  assert.strictEqual(parseJsonlLine('not-json', 0), null);
});

test('parseJsonlLine: returns null on unknown top-level type', () => {
  const line = JSON.stringify({type:'attachment', sessionId:'s', uuid:'u'});
  assert.strictEqual(parseJsonlLine(line, 0), null);
});

test('makeStatefulParser: dedupes permission-mode no-op repeats', () => {
  const lines = loadFixtureLines('permission-mode-spam.jsonl');
  const parser = makeStatefulParser();
  const outs = lines.map((l, i) => parser(l, i * 100));
  // 5 input → 2 emitted: first (default), then plan, then back-to-default.
  const nonNull = outs.filter(x => x !== null);
  assert.strictEqual(nonNull.length, 3);
  assert.strictEqual(nonNull[0].payload.extracted.subtype, 'permission-mode');
  assert.strictEqual(nonNull[0].payload.raw.permissionMode, 'default');
  assert.strictEqual(nonNull[1].payload.raw.permissionMode, 'plan');
  assert.strictEqual(nonNull[2].payload.raw.permissionMode, 'default');
});
```

- [ ] **Step 3.2: Run the tests and watch them fail**

Run: `cd agent-fleet/daemon && node --test test/parsers/jsonl-parser.test.js`

Expected: All fail with `Cannot find module '../../src/parsers/jsonl-parser'`.

- [ ] **Step 3.3: Implement the parser**

Create `agent-fleet/daemon/src/parsers/jsonl-parser.js`:

```javascript
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
    subtype: raw.subtype || raw.type === 'permission-mode'
      ? (raw.type === 'permission-mode' ? 'permission-mode' : raw.subtype || null)
      : null,
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
    for (const block of (msg.content || [])) {
      if (block.type === 'text') {
        extracted.text_in = (extracted.text_in || '') + block.text;
      } else if (block.type === 'tool_result') {
        extracted.tool_results.push({
          tool_use_id: block.tool_use_id,
          content: block.content,
          is_error: block.is_error === true,
        });
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
```

- [ ] **Step 3.4: Run the tests and watch them pass**

Run: `cd agent-fleet/daemon && node --test test/parsers/jsonl-parser.test.js`

Expected: `# pass 8`, `# fail 0`.

- [ ] **Step 3.5: Commit**

```bash
cd /root/work/vault-rag-oss
git add agent-fleet/daemon/src/parsers/ agent-fleet/daemon/test/parsers/
git commit -m "feat(chat-ui-1a): jsonl line parser with pass-through schema

parseJsonlLine(text, byteOffset) → { type, payload } | null. Per spec
v2: pass-through-by-default — raw carries the full jsonl line, extracted
holds normalized convenience view (role, model, text_blocks, tool_uses,
tool_results, stop_reason, is_sidechain, parent_uuid, usage).

compact_boundary lines emit a separate frame type so the SPA can render
a visual divider. Unknown top-level types (attachment, file-history-
snapshot, last-prompt, ai-title, hook events) return null and are
ignored at the daemon level.

makeStatefulParser() wraps parseJsonlLine with permission-mode dedupe:
only emits frames on actual mode transitions, suppressing default→default
no-op repeats (~1,368 spurious lines per session in real data).

8/8 unit tests pass against hand-crafted fixtures.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `session-store` — byte-offset cursor extension

**Files:**
- Modify: `agent-fleet/daemon/src/session-store.js`
- Modify: `agent-fleet/daemon/test/session-store.test.js`

Add `getOffset(id)` / `setOffset(id, offset)` to the existing `SessionStore`. Cursor persisted in the same `sessions.json` (separate key per entry: `{pid, last_seq, jsonl_offset}` shape).

- [ ] **Step 4.1: Inspect existing session-store test**

Run: `cat agent-fleet/daemon/test/session-store.test.js | head -40`

Skim what's already tested so the new tests follow the same style.

- [ ] **Step 4.2: Write failing tests for offset cursor**

Append to `agent-fleet/daemon/test/session-store.test.js`:

```javascript
test('SessionStore: getOffset returns 0 for unknown id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-'));
  const s = new SessionStore(dir);
  assert.strictEqual(s.getOffset('nope'), 0);
});

test('SessionStore: setOffset persists and getOffset returns it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-'));
  const s = new SessionStore(dir);
  s.put('s1', { pid: 1234, last_seq: 0 });
  s.setOffset('s1', 4096);
  assert.strictEqual(s.getOffset('s1'), 4096);
});

test('SessionStore: setOffset survives reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-'));
  const s1 = new SessionStore(dir);
  s1.put('s1', { pid: 1234, last_seq: 0 });
  s1.setOffset('s1', 8192);
  const s2 = new SessionStore(dir);
  assert.strictEqual(s2.getOffset('s1'), 8192);
});

test('SessionStore: setOffset on unknown id is a no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-'));
  const s = new SessionStore(dir);
  s.setOffset('nope', 999);
  assert.strictEqual(s.getOffset('nope'), 0);
});
```

- [ ] **Step 4.3: Run the new tests and watch them fail**

Run: `cd agent-fleet/daemon && node --test test/session-store.test.js`

Expected: 4 new tests fail with `TypeError: s.getOffset is not a function` (or `s.setOffset is not a function`).

- [ ] **Step 4.4: Implement `getOffset` / `setOffset`**

Edit `agent-fleet/daemon/src/session-store.js`. After the existing `list()` method and before `_flush()`, add:

```javascript
  // vt-chat-1a: byte-offset cursor for the per-session jsonl-tailer.
  // Stored inline on each session entry; survives daemon restart so
  // the tailer can resume without double-emitting or skipping lines.
  getOffset(id) {
    const e = this.map.get(id);
    return (e && typeof e.jsonl_offset === 'number') ? e.jsonl_offset : 0;
  }
  setOffset(id, offset) {
    const e = this.map.get(id);
    if (!e) return;
    e.jsonl_offset = offset;
    this._flush();
  }
```

- [ ] **Step 4.5: Run all session-store tests**

Run: `cd agent-fleet/daemon && node --test test/session-store.test.js`

Expected: `# pass <N>`, `# fail 0` (N = existing tests + 4 new).

- [ ] **Step 4.6: Commit**

```bash
cd /root/work/vault-rag-oss
git add agent-fleet/daemon/src/session-store.js agent-fleet/daemon/test/session-store.test.js
git commit -m "feat(chat-ui-1a): SessionStore.{getOffset,setOffset} for jsonl cursor

Per-session jsonl byte-offset cursor. Persisted inline on the existing
sessions.json entry (jsonl_offset field). The jsonl-tailer flushes the
offset on each line read so a daemon restart resumes at the exact byte
without double-emission or gaps.

getOffset returns 0 for unknown sessions (initial-state default).
setOffset on unknown id is a no-op (caller must put() the session first).

4/4 new tests pass; existing SessionStore tests unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `jsonl-tailer` — waiting-for-file state

**Files:**
- Create: `agent-fleet/daemon/src/jsonl-tailer.js`
- Create: `agent-fleet/daemon/test/jsonl-tailer.test.js`

`JsonlTailer` class. Constructor takes `{ sessionId, cwd, home, store, emit }`. Starts in `waiting_for_file` state, watches the project dir via `fs.watch`, transitions to `tailing` on file creation.

This task ships only the waiting-state behaviour. Tail logic comes in Task 6.

- [ ] **Step 5.1: Write failing test for waiting state**

Create `agent-fleet/daemon/test/jsonl-tailer.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonlTailer } = require('../src/jsonl-tailer');
const { SessionStore } = require('../src/session-store');

function newTmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  return home;
}

test('JsonlTailer: starts in waiting_for_file state', async () => {
  const home = newTmpHome();
  const cwd = '/root';
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-root'),
    { recursive: true });
  const store = new SessionStore(fs.mkdtempSync(
    path.join(os.tmpdir(), 'jt-store-')));
  store.put('sid-1', { pid: 1234, last_seq: 0 });
  const events = [];
  const t = new JsonlTailer({
    sessionId: 'sid-1', cwd, home, store, emit: (f) => events.push(f)
  });
  await t.start();
  assert.strictEqual(t.state, 'waiting_for_file');
  assert.deepStrictEqual(events, []);
  await t.stop();
});

test('JsonlTailer: transitions to tailing on file create', async () => {
  const home = newTmpHome();
  const projDir = path.join(home, '.claude', 'projects', '-root');
  fs.mkdirSync(projDir, { recursive: true });
  const store = new SessionStore(fs.mkdtempSync(
    path.join(os.tmpdir(), 'jt-store-')));
  store.put('sid-2', { pid: 1234, last_seq: 0 });
  const t = new JsonlTailer({
    sessionId: 'sid-2', cwd: '/root', home, store, emit: () => {}
  });
  await t.start();
  assert.strictEqual(t.state, 'waiting_for_file');

  // Create the jsonl file → fs.watch should fire.
  fs.writeFileSync(path.join(projDir, 'sid-2.jsonl'), '');
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(t.state, 'tailing');
  await t.stop();
});

test('JsonlTailer: stop() clears watchers', async () => {
  const home = newTmpHome();
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-root'),
    { recursive: true });
  const store = new SessionStore(fs.mkdtempSync(
    path.join(os.tmpdir(), 'jt-store-')));
  store.put('sid-3', { pid: 1234, last_seq: 0 });
  const t = new JsonlTailer({
    sessionId: 'sid-3', cwd: '/root', home, store, emit: () => {}
  });
  await t.start();
  await t.stop();
  assert.strictEqual(t.state, 'stopped');
});
```

- [ ] **Step 5.2: Run the tests and watch them fail**

Run: `cd agent-fleet/daemon && node --test test/jsonl-tailer.test.js`

Expected: All fail with `Cannot find module '../src/jsonl-tailer'`.

- [ ] **Step 5.3: Implement the waiting-state skeleton**

Create `agent-fleet/daemon/src/jsonl-tailer.js`:

```javascript
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { expectedJsonlPath, encodeProjectDir } = require('./jsonl-path');
const { makeStatefulParser } = require('./parsers/jsonl-parser');

// JsonlTailer — one per spawned session.
// States: waiting_for_file → tailing → stopped.
// The constructor records dependencies but does no I/O; .start() arms
// the dir watcher and (if the file already exists) opens it immediately.
class JsonlTailer {
  constructor({ sessionId, cwd, home, store, emit }) {
    if (!sessionId) throw new Error('sessionId required');
    if (!cwd) throw new Error('cwd required');
    if (!home) throw new Error('home required');
    if (!store) throw new Error('store required');
    if (typeof emit !== 'function') throw new Error('emit fn required');
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.home = home;
    this.store = store;
    this.emit = emit;
    this.state = 'idle';
    this._dirWatcher = null;
    this._fileWatcher = null;
    this._parser = makeStatefulParser();
    this._jsonlPath = expectedJsonlPath(cwd, sessionId, home);
    this._projectDir = path.dirname(this._jsonlPath);
  }

  async start() {
    if (this.state !== 'idle') return;
    if (fs.existsSync(this._jsonlPath)) {
      this.state = 'tailing';
      // Tail wiring lands in Task 6.
      return;
    }
    this.state = 'waiting_for_file';
    this._dirWatcher = fs.watch(this._projectDir, (eventType, filename) => {
      if (filename !== `${this.sessionId}.jsonl`) return;
      if (this.state !== 'waiting_for_file') return;
      if (fs.existsSync(this._jsonlPath)) {
        this.state = 'tailing';
        // Tail wiring lands in Task 6.
      }
    });
  }

  async stop() {
    this.state = 'stopped';
    if (this._dirWatcher) { this._dirWatcher.close(); this._dirWatcher = null; }
    if (this._fileWatcher) { this._fileWatcher.close(); this._fileWatcher = null; }
  }
}

module.exports = { JsonlTailer };
```

- [ ] **Step 5.4: Run the tests and watch them pass**

Run: `cd agent-fleet/daemon && node --test test/jsonl-tailer.test.js`

Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 5.5: Commit**

```bash
cd /root/work/vault-rag-oss
git add agent-fleet/daemon/src/jsonl-tailer.js agent-fleet/daemon/test/jsonl-tailer.test.js
git commit -m "feat(chat-ui-1a): JsonlTailer skeleton with waiting_for_file state

Per-session tailer class. States: idle → waiting_for_file → tailing →
stopped. start() arms fs.watch on the encoded project dir; transitions
to tailing on file-create. stop() closes watchers cleanly.

Tail-and-emit logic ships in the next task.

3/3 unit tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `jsonl-tailer` — tail with offset cursor

**Files:**
- Modify: `agent-fleet/daemon/src/jsonl-tailer.js`
- Modify: `agent-fleet/daemon/test/jsonl-tailer.test.js`

Wire up the actual read loop. On entry to `tailing`, open the file, seek to `store.getOffset(sessionId)`, read line-by-line (line buffer joined across read chunks), parse each line, emit, advance offset, persist via `store.setOffset` every line. Re-open / continue on `fs.watch` change events on the file itself.

- [ ] **Step 6.1: Write failing tests for tail + emit + cursor**

Append to `agent-fleet/daemon/test/jsonl-tailer.test.js`:

```javascript
function copyFixture(srcName, dstPath) {
  const src = path.join(__dirname, 'fixtures', 'jsonl', srcName);
  fs.copyFileSync(src, dstPath);
}

test('JsonlTailer: emits claude_msg frames per fixture line', async () => {
  const home = newTmpHome();
  const projDir = path.join(home, '.claude', 'projects', '-root');
  fs.mkdirSync(projDir, { recursive: true });
  const store = new SessionStore(fs.mkdtempSync(
    path.join(os.tmpdir(), 'jt-store-')));
  store.put('sess-1', { pid: 1234, last_seq: 0 });
  const events = [];
  const t = new JsonlTailer({
    sessionId: 'sess-1', cwd: '/root', home, store,
    emit: (f) => events.push(f)
  });
  await t.start();
  copyFixture('simple-session.jsonl', path.join(projDir, 'sess-1.jsonl'));
  // Wait for fs.watch + read loop.
  await new Promise(r => setTimeout(r, 500));
  // simple-session.jsonl has 5 lines; permission-mode is initial state so
  // it is the first to set lastMode and IS emitted. 5 total events.
  assert.strictEqual(events.length, 5);
  assert.strictEqual(events[0].type, 'claude_msg');
  assert.strictEqual(events[0].payload.extracted.role, 'system');
  assert.strictEqual(events[2].payload.extracted.role, 'assistant');
  await t.stop();
});

test('JsonlTailer: persists byte-offset, resumes without double-emit', async () => {
  const home = newTmpHome();
  const projDir = path.join(home, '.claude', 'projects', '-root');
  fs.mkdirSync(projDir, { recursive: true });
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-store-'));
  const store1 = new SessionStore(storeDir);
  store1.put('sess-2', { pid: 1234, last_seq: 0 });
  const events1 = [];
  const t1 = new JsonlTailer({
    sessionId: 'sess-2', cwd: '/root', home, store: store1,
    emit: (f) => events1.push(f)
  });
  await t1.start();
  copyFixture('simple-session.jsonl', path.join(projDir, 'sess-2.jsonl'));
  await new Promise(r => setTimeout(r, 500));
  assert.ok(events1.length >= 5);
  await t1.stop();

  // New tailer reading the same store dir — offset should pick up at EOF.
  const store2 = new SessionStore(storeDir);
  assert.ok(store2.getOffset('sess-2') > 0, 'offset persisted');
  const events2 = [];
  const t2 = new JsonlTailer({
    sessionId: 'sess-2', cwd: '/root', home, store: store2,
    emit: (f) => events2.push(f)
  });
  await t2.start();
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(events2.length, 0, 'no double-emit on resume');
  await t2.stop();
});

test('JsonlTailer: compact_boundary emitted as separate frame', async () => {
  const home = newTmpHome();
  const projDir = path.join(home, '.claude', 'projects', '-root');
  fs.mkdirSync(projDir, { recursive: true });
  const store = new SessionStore(fs.mkdtempSync(
    path.join(os.tmpdir(), 'jt-store-')));
  store.put('sess-3', { pid: 1234, last_seq: 0 });
  const events = [];
  const t = new JsonlTailer({
    sessionId: 'sess-3', cwd: '/root', home, store,
    emit: (f) => events.push(f)
  });
  await t.start();
  copyFixture('compact-mid-session.jsonl', path.join(projDir, 'sess-3.jsonl'));
  await new Promise(r => setTimeout(r, 500));
  const types = events.map(e => e.type);
  assert.deepStrictEqual(types, ['claude_msg', 'compact_boundary', 'claude_msg']);
  assert.strictEqual(events[1].payload.metadata.trigger, 'auto');
  await t.stop();
});
```

- [ ] **Step 6.2: Run the tests and watch them fail**

Run: `cd agent-fleet/daemon && node --test test/jsonl-tailer.test.js`

Expected: The new tests fail — initial-state tests still pass, new tests fail because the tail loop isn't implemented (no `claude_msg` events appear after fixture copy).

- [ ] **Step 6.3: Implement the tail loop**

Edit `agent-fleet/daemon/src/jsonl-tailer.js`. Replace the file with:

```javascript
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { expectedJsonlPath } = require('./jsonl-path');
const { makeStatefulParser } = require('./parsers/jsonl-parser');

class JsonlTailer {
  constructor({ sessionId, cwd, home, store, emit }) {
    if (!sessionId) throw new Error('sessionId required');
    if (!cwd) throw new Error('cwd required');
    if (!home) throw new Error('home required');
    if (!store) throw new Error('store required');
    if (typeof emit !== 'function') throw new Error('emit fn required');
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.home = home;
    this.store = store;
    this.emit = emit;
    this.state = 'idle';
    this._dirWatcher = null;
    this._fileWatcher = null;
    this._parser = makeStatefulParser();
    this._jsonlPath = expectedJsonlPath(cwd, sessionId, home);
    this._projectDir = path.dirname(this._jsonlPath);
    this._lineBuf = '';
    this._reading = false;
  }

  async start() {
    if (this.state !== 'idle') return;
    if (fs.existsSync(this._jsonlPath)) {
      await this._enterTailing();
      return;
    }
    this.state = 'waiting_for_file';
    this._dirWatcher = fs.watch(this._projectDir, (eventType, filename) => {
      if (filename !== `${this.sessionId}.jsonl`) return;
      if (this.state !== 'waiting_for_file') return;
      if (fs.existsSync(this._jsonlPath)) {
        this._enterTailing().catch(e =>
          console.error(`[jsonl-tailer] enterTailing failed: ${e.message}`));
      }
    });
  }

  async _enterTailing() {
    this.state = 'tailing';
    await this._readFromCursor();
    this._fileWatcher = fs.watch(this._jsonlPath, () => {
      if (this.state === 'tailing') {
        this._readFromCursor().catch(e =>
          console.error(`[jsonl-tailer] tail read failed: ${e.message}`));
      }
    });
  }

  async _readFromCursor() {
    if (this._reading) return;
    this._reading = true;
    try {
      const startOffset = this.store.getOffset(this.sessionId);
      let stat;
      try { stat = fs.statSync(this._jsonlPath); }
      catch { return; }
      if (stat.size <= startOffset) return;
      const fd = fs.openSync(this._jsonlPath, 'r');
      try {
        const chunkSize = 64 * 1024;
        const buf = Buffer.alloc(chunkSize);
        let pos = startOffset;
        while (pos < stat.size) {
          const remaining = stat.size - pos;
          const toRead = Math.min(chunkSize, remaining);
          const n = fs.readSync(fd, buf, 0, toRead, pos);
          if (n === 0) break;
          this._lineBuf += buf.slice(0, n).toString('utf8');
          pos += n;
          this._drainLines(pos - this._lineBuf.length);
        }
        // Final flush — if a complete line was at EOF without trailing \n,
        // it would have been drained on the next \n. Leave any partial
        // tail in _lineBuf for the next read.
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      this._reading = false;
    }
  }

  // Drains complete lines from _lineBuf. byteOffsetOfBufStart is the
  // file-byte offset corresponding to _lineBuf[0]. The persisted cursor
  // is advanced past each complete line (including its \n).
  _drainLines(byteOffsetOfBufStart) {
    let absOffset = byteOffsetOfBufStart;
    let nl;
    while ((nl = this._lineBuf.indexOf('\n')) !== -1) {
      const line = this._lineBuf.slice(0, nl);
      const lineByteOffset = absOffset;
      const consumed = Buffer.byteLength(line, 'utf8') + 1;
      this._lineBuf = this._lineBuf.slice(nl + 1);
      absOffset += consumed;
      if (line.length === 0) continue;
      const frame = this._parser(line, lineByteOffset);
      if (frame) this.emit(frame);
      this.store.setOffset(this.sessionId, absOffset);
    }
  }

  async stop() {
    this.state = 'stopped';
    if (this._dirWatcher) { this._dirWatcher.close(); this._dirWatcher = null; }
    if (this._fileWatcher) { this._fileWatcher.close(); this._fileWatcher = null; }
  }
}

module.exports = { JsonlTailer };
```

- [ ] **Step 6.4: Run the tailer tests**

Run: `cd agent-fleet/daemon && node --test test/jsonl-tailer.test.js`

Expected: `# pass 6`, `# fail 0`. (3 from Task 5 + 3 new.)

- [ ] **Step 6.5: Commit**

```bash
cd /root/work/vault-rag-oss
git add agent-fleet/daemon/src/jsonl-tailer.js agent-fleet/daemon/test/jsonl-tailer.test.js
git commit -m "feat(chat-ui-1a): JsonlTailer tail loop with durable byte-offset cursor

Reads in 64 KiB chunks from the persisted cursor (store.getOffset),
buffers across partial-line chunk boundaries, splits on \\n, feeds each
complete line to the stateful parser, emits resulting frames, advances
the cursor past each consumed line (Buffer.byteLength + 1).

fs.watch on the jsonl file re-triggers the read loop on every append.
Reentrancy guard (_reading) prevents stacked reads if the watcher fires
during an in-flight read.

Two-tailer restart test verifies: tailer1 reads all 5 fixture lines,
persists cursor; tailer2 (fresh SessionStore from same dir) reads zero
new lines — no double-emit, no skipped lines.

compact_boundary lines emit as a separate frame type (verified by
compact-mid-session.jsonl fixture).

6/6 unit tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `jsonl-tailer` — multi-line append + permission-mode dedupe

**Files:**
- Modify: `agent-fleet/daemon/test/jsonl-tailer.test.js`

Cover two real-world scenarios:
1. Lines arrive in multiple `fs.watch` events (simulates the real claude write cadence).
2. `permission-mode-spam.jsonl` fixture produces only 3 frames (the parser's dedupe is exercised end-to-end through the tailer).

- [ ] **Step 7.1: Add the two scenarios as failing tests**

Append to `agent-fleet/daemon/test/jsonl-tailer.test.js`:

```javascript
test('JsonlTailer: incremental appends produce one frame per line', async () => {
  const home = newTmpHome();
  const projDir = path.join(home, '.claude', 'projects', '-root');
  fs.mkdirSync(projDir, { recursive: true });
  const store = new SessionStore(fs.mkdtempSync(
    path.join(os.tmpdir(), 'jt-store-')));
  store.put('sess-i', { pid: 1234, last_seq: 0 });
  const events = [];
  const t = new JsonlTailer({
    sessionId: 'sess-i', cwd: '/root', home, store,
    emit: (f) => events.push(f)
  });
  await t.start();

  const file = path.join(projDir, 'sess-i.jsonl');
  const fixture = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'jsonl', 'simple-session.jsonl'),
    'utf8'
  );
  const lines = fixture.split('\n').filter(Boolean);
  // Write lines one at a time, give the watcher time per line.
  for (const line of lines) {
    fs.appendFileSync(file, line + '\n');
    await new Promise(r => setTimeout(r, 100));
  }
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(events.length, lines.length);
  await t.stop();
});

test('JsonlTailer: permission-mode dedupe end-to-end', async () => {
  const home = newTmpHome();
  const projDir = path.join(home, '.claude', 'projects', '-root');
  fs.mkdirSync(projDir, { recursive: true });
  const store = new SessionStore(fs.mkdtempSync(
    path.join(os.tmpdir(), 'jt-store-')));
  store.put('sess-pm', { pid: 1234, last_seq: 0 });
  const events = [];
  const t = new JsonlTailer({
    sessionId: 'sess-pm', cwd: '/root', home, store,
    emit: (f) => events.push(f)
  });
  await t.start();
  copyFixture('permission-mode-spam.jsonl',
    path.join(projDir, 'sess-pm.jsonl'));
  await new Promise(r => setTimeout(r, 500));
  // 5 input lines, 3 emitted (default, plan, default).
  assert.strictEqual(events.length, 3);
  assert.strictEqual(events[0].payload.raw.permissionMode, 'default');
  assert.strictEqual(events[1].payload.raw.permissionMode, 'plan');
  assert.strictEqual(events[2].payload.raw.permissionMode, 'default');
  await t.stop();
});
```

- [ ] **Step 7.2: Run all tailer tests**

Run: `cd agent-fleet/daemon && node --test test/jsonl-tailer.test.js`

Expected: `# pass 8`, `# fail 0`. The two new tests should pass on the existing implementation — Task 6's tail loop already handles incremental appends and the parser already dedupes.

- [ ] **Step 7.3: If a test fails, debug before continuing**

If either test fails, the most likely cause is fs.watch coalescing on Linux (multiple appends → one event). Increase the per-line sleep to 200ms. If that still fails, the tail loop has a real bug — fix it before committing.

- [ ] **Step 7.4: Commit**

```bash
cd /root/work/vault-rag-oss
git add agent-fleet/daemon/test/jsonl-tailer.test.js
git commit -m "test(chat-ui-1a): tailer scenarios for incremental writes + mode dedupe

Adds two tests that exercise the existing tail loop against more
realistic scenarios:
  - 5 separate appendFile calls (100 ms apart) → 5 frames; verifies
    that no events are coalesced or dropped by the watcher loop.
  - permission-mode-spam.jsonl fixture → 3 frames (default, plan,
    default) confirming the stateful parser's transition dedupe is
    correctly threaded through the tailer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `subagent-tailer` — sidecar discovery

**Files:**
- Create: `agent-fleet/daemon/src/subagent-tailer.js`
- Create: `agent-fleet/daemon/test/subagent-tailer.test.js`

Claude Code stores Task-tool subagent transcripts in `~/.claude/projects/<enc>/<sid>/subagents/<subid>.jsonl` sidecar files (one subdir per parent session). `SubagentTailer` watches that subdir, spawns a child `JsonlTailer` per sidecar file, tags emitted frames with `is_sidechain: true` so the SPA renders them in a nested block.

- [ ] **Step 8.1: Write failing tests**

Create `agent-fleet/daemon/test/subagent-tailer.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SubagentTailer } = require('../src/subagent-tailer');
const { SessionStore } = require('../src/session-store');

function newTmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  return home;
}

test('SubagentTailer: starts in waiting_for_dir state if subagents/ absent',
async () => {
  const home = newTmpHome();
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-root'),
    { recursive: true });
  const store = new SessionStore(fs.mkdtempSync(
    path.join(os.tmpdir(), 'sat-store-')));
  const t = new SubagentTailer({
    parentSessionId: 'sid-p', cwd: '/root', home, store,
    emit: () => {}
  });
  await t.start();
  assert.strictEqual(t.state, 'waiting_for_dir');
  await t.stop();
});

test('SubagentTailer: spawns sub-tailers on sidecar appearance', async () => {
  const home = newTmpHome();
  const projDir = path.join(home, '.claude', 'projects', '-root');
  const subDir = path.join(projDir, 'sid-p', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const store = new SessionStore(fs.mkdtempSync(
    path.join(os.tmpdir(), 'sat-store-')));
  const events = [];
  const t = new SubagentTailer({
    parentSessionId: 'sid-p', cwd: '/root', home, store,
    emit: (f) => events.push(f)
  });
  await t.start();
  assert.strictEqual(t.state, 'watching');
  // Drop a fixture sidecar in.
  const fixture = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'jsonl', 'simple-session.jsonl'),
    'utf8'
  );
  fs.writeFileSync(path.join(subDir, 'sub-1.jsonl'), fixture);
  await new Promise(r => setTimeout(r, 500));
  assert.ok(events.length >= 5, `got ${events.length} events`);
  // All emitted frames must be tagged is_sidechain.
  for (const e of events) {
    if (e.type === 'claude_msg') {
      assert.strictEqual(e.payload.extracted.is_sidechain, true,
        'subagent frames must be tagged');
    }
  }
  await t.stop();
});

test('SubagentTailer: stop closes all sub-tailers', async () => {
  const home = newTmpHome();
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-root', 'sid-p',
    'subagents'), { recursive: true });
  const store = new SessionStore(fs.mkdtempSync(
    path.join(os.tmpdir(), 'sat-store-')));
  const t = new SubagentTailer({
    parentSessionId: 'sid-p', cwd: '/root', home, store,
    emit: () => {}
  });
  await t.start();
  await t.stop();
  assert.strictEqual(t.state, 'stopped');
});
```

- [ ] **Step 8.2: Run the tests and watch them fail**

Run: `cd agent-fleet/daemon && node --test test/subagent-tailer.test.js`

Expected: All fail with `Cannot find module '../src/subagent-tailer'`.

- [ ] **Step 8.3: Implement the subagent tailer**

Create `agent-fleet/daemon/src/subagent-tailer.js`:

```javascript
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { encodeProjectDir } = require('./jsonl-path');
const { JsonlTailer } = require('./jsonl-tailer');

// SubagentTailer — one per parent session. Watches
// ~/.claude/projects/<enc>/<parentSid>/subagents/ for new sidecar
// jsonl files. Each file gets its own JsonlTailer (configured to
// point directly at the sidecar) whose emitted frames are wrapped
// to set extracted.is_sidechain = true.
class SubagentTailer {
  constructor({ parentSessionId, cwd, home, store, emit }) {
    if (!parentSessionId) throw new Error('parentSessionId required');
    if (!cwd) throw new Error('cwd required');
    if (!home) throw new Error('home required');
    if (!store) throw new Error('store required');
    if (typeof emit !== 'function') throw new Error('emit fn required');
    this.parentSessionId = parentSessionId;
    this.cwd = cwd;
    this.home = home;
    this.store = store;
    this.emit = emit;
    this.state = 'idle';
    this._dirWatcher = null;
    this._subTailers = new Map();
    this._subagentDir = path.join(
      home, '.claude', 'projects',
      encodeProjectDir(cwd), parentSessionId, 'subagents'
    );
  }

  async start() {
    if (this.state !== 'idle') return;
    if (!fs.existsSync(this._subagentDir)) {
      this.state = 'waiting_for_dir';
      const parent = path.dirname(this._subagentDir);
      if (fs.existsSync(parent)) {
        this._dirWatcher = fs.watch(parent, (eventType, filename) => {
          if (filename !== 'subagents') return;
          if (this.state !== 'waiting_for_dir') return;
          if (fs.existsSync(this._subagentDir)) {
            this._dirWatcher.close();
            this._dirWatcher = null;
            this._enterWatching().catch(e =>
              console.error(`[subagent-tailer] enter failed: ${e.message}`));
          }
        });
      }
      return;
    }
    await this._enterWatching();
  }

  async _enterWatching() {
    this.state = 'watching';
    // Sweep existing sidecars first.
    for (const f of fs.readdirSync(this._subagentDir)) {
      if (f.endsWith('.jsonl')) await this._addSidecar(f);
    }
    this._dirWatcher = fs.watch(this._subagentDir, (eventType, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return;
      if (this._subTailers.has(filename)) return;
      this._addSidecar(filename).catch(e =>
        console.error(`[subagent-tailer] addSidecar failed: ${e.message}`));
    });
  }

  async _addSidecar(filename) {
    // The child JsonlTailer expects to resolve its own path from cwd +
    // sessionId; we override by injecting a synthetic cwd/sessionId that
    // resolves to the sidecar file. Simpler: subclass JsonlTailer by
    // monkey-patching the resolved path. We instead construct a tailer
    // pointed at a parallel-shaped path: pretend the sidecar lives in
    // a project dir whose encoding maps to the subagents/ dir.
    //
    // To keep JsonlTailer pure, give it a sessionId that matches the
    // sidecar's base name and a cwd whose encodeProjectDir produces the
    // subagents dir path. We bypass that complexity by constructing the
    // tailer directly with the resolved path via a private field.
    const subSid = filename.replace(/\.jsonl$/, '');
    const wrapEmit = (frame) => {
      if (frame.type === 'claude_msg') {
        frame.payload.extracted.is_sidechain = true;
      }
      this.emit(frame);
    };
    // Reuse JsonlTailer by lying about cwd: we point its expected path
    // at the sidecar using a fake cwd that encodes to the parent-session
    // subagent dir. Easier: construct, then overwrite _jsonlPath +
    // _projectDir before start.
    const childCwd = '/' + path.relative('/', this._subagentDir);
    const t = new JsonlTailer({
      sessionId: subSid,
      cwd: childCwd,
      home: this.home,
      store: this.store,
      emit: wrapEmit,
    });
    // Force the tailer onto the real sidecar file regardless of
    // jsonl-path's encoding rules.
    t._jsonlPath = path.join(this._subagentDir, filename);
    t._projectDir = this._subagentDir;
    this._subTailers.set(filename, t);
    await t.start();
  }

  async stop() {
    this.state = 'stopped';
    if (this._dirWatcher) { this._dirWatcher.close(); this._dirWatcher = null; }
    for (const t of this._subTailers.values()) await t.stop();
    this._subTailers.clear();
  }
}

module.exports = { SubagentTailer };
```

- [ ] **Step 8.4: Run subagent-tailer tests**

Run: `cd agent-fleet/daemon && node --test test/subagent-tailer.test.js`

Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 8.5: Commit**

```bash
cd /root/work/vault-rag-oss
git add agent-fleet/daemon/src/subagent-tailer.js agent-fleet/daemon/test/subagent-tailer.test.js
git commit -m "feat(chat-ui-1a): SubagentTailer for sidecar Task-tool transcripts

Watches ~/.claude/projects/<enc>/<parent>/subagents/ for new
<subid>.jsonl files. Each sidecar gets a child JsonlTailer; emitted
frames are wrapped to set extracted.is_sidechain = true so the SPA
can render them in a nested SubagentBlock.

Handles the case where the subagents/ subdir does not yet exist by
arming a parent-dir watcher (waiting_for_dir state) and transitioning
to watching when the dir appears.

Existing sidecars are swept on enter; new ones discovered via fs.watch.
stop() closes the dir watcher and all child tailers cleanly.

3/3 unit tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Full daemon test suite + summary

- [ ] **Step 9.1: Run the complete daemon test suite**

Run: `cd agent-fleet/daemon && npm test 2>&1 | tail -10`

Expected: `# pass <N>`, `# fail 0` — N is the total across all tests (existing 32 + Phase 1A new tests, ~52).

- [ ] **Step 9.2: Verify no orphan imports / unused exports**

Run: `cd agent-fleet/daemon && grep -rE "require\\(.*jsonl|require\\(.*subagent" src/ test/ | head`

Expected: only the modules' own self-tests + the modules themselves; ws-client.js does NOT yet import these (wiring lands in Phase 1B).

- [ ] **Step 9.3: Smoke-test against a real session jsonl**

Run:

```bash
cd /root/work/vault-rag-oss/agent-fleet/daemon
node -e "
const { JsonlTailer } = require('./src/jsonl-tailer');
const { SessionStore } = require('./src/session-store');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Borrow a real session id from this machine.
const dir = '/root/.claude/projects/-root';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
if (!files.length) { console.log('no real session to smoke against'); process.exit(0); }
const sid = files[0].replace(/\.jsonl\$/, '');
console.log('smoking on session:', sid);
const store = new SessionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-')));
store.put(sid, { pid: 0, last_seq: 0 });
let count = 0;
let kinds = {};
const t = new JsonlTailer({
  sessionId: sid, cwd: '/root', home: '/root', store,
  emit: (f) => { count++; kinds[f.type] = (kinds[f.type]||0)+1; }
});
t.start().then(() => {
  setTimeout(() => {
    console.log('emitted', count, 'frames:', kinds);
    t.stop();
  }, 3000);
});
"
```

Expected: emits at least 50+ frames against a real session, with both `claude_msg` and possibly `compact_boundary` in the breakdown.

- [ ] **Step 9.4: Tag the Phase 1A milestone**

```bash
cd /root/work/vault-rag-oss
git tag chat-ui-phase-1a-complete
git push origin chat-ui-phase-1a-complete
```

- [ ] **Step 9.5: File follow-up vt tasks for Phase 1B**

Run:

```bash
export PATH=$PATH:/root/work/vault-rag-oss/scripts/bin
vt create -t task -p 2 --epic vt-0385 "Phase 1B: wire jsonl-tailer into ws-client + hub frame dispatch" \
  --body "Phase 1A landed daemon foundation (jsonl-path, parser, tailer, subagent-tailer, session-store offset cursor). Phase 1B wires them into the daemon's WS bridge (ws-client.js) so frames hit the hub, adds hub dispatch cases in scripts/lib/fleet-routes.js, and implements replay_request/replay_batch flow. SPA work is Phase 1C."

vt create -t task -p 2 --epic vt-0385 "Phase 1C: chat-view SPA renderer + tab-gated subscription" \
  --body "Render claude_msg + compact_boundary frames into MessageBubble / ToolCallCard / SubagentBlock / CompactBoundary. Add chat tab (default) + raw-terminal tab toggle in app.js. Subscribe to pty_data only while raw tab active."
```

Expected: two new vt ids printed.

---

## Self-review

**Spec coverage:**
- `encodeProjectDir` rule and `expectedJsonlPath` ✓ (Task 1)
- pass-through `raw` + normalized `extracted` schema ✓ (Task 3)
- compact_boundary as separate frame ✓ (Tasks 3, 6)
- byte-offset cursor durable across daemon restart ✓ (Tasks 4, 6)
- waiting_for_file state + open-on-create ✓ (Tasks 5, 6)
- permission-mode dedupe ✓ (Tasks 3, 7)
- subagent sidecar tailing + is_sidechain tag ✓ (Task 8)
- Real-session smoke test ✓ (Step 9.3)

**Spec items intentionally NOT in Phase 1A** (deferred to 1B/1C):
- WS frame emission to hub (Phase 1B)
- replay_request / replay_batch (Phase 1B)
- session_lifecycle frame (Phase 1B — emitted by ws-client on spawn/exit, not the tailer)
- ws-client integration (Phase 1B)
- SPA tab-gated subscription (Phase 1C)

**Placeholder scan:** None. Every step has concrete code, exact commands, expected output.

**Type consistency:**
- `encodeProjectDir(cwd) → string` consistent in Tasks 1, 5, 6, 8.
- `expectedJsonlPath(cwd, sessionId, home) → string` consistent.
- Parser return shape `{type, payload}|null` consistent across Tasks 3, 6, 7, 8.
- `JsonlTailer` constructor signature `{sessionId, cwd, home, store, emit}` consistent (used in Tasks 5, 6, 7).
- `SubagentTailer` constructor `{parentSessionId, cwd, home, store, emit}` consistent.
- `SessionStore.getOffset(id) / setOffset(id, offset)` consistent.

Plan complete and saved to `docs/superpowers/plans/2026-05-18-fleet-chat-ui-phase-1a-daemon-foundation.md`.
