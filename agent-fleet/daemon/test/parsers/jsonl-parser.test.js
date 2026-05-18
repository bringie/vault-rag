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
  // 5 input → 3 emitted: first (default), then plan, then back-to-default.
  const nonNull = outs.filter(x => x !== null);
  assert.strictEqual(nonNull.length, 3);
  assert.strictEqual(nonNull[0].payload.extracted.subtype, 'permission-mode');
  assert.strictEqual(nonNull[0].payload.raw.permissionMode, 'default');
  assert.strictEqual(nonNull[1].payload.raw.permissionMode, 'plan');
  assert.strictEqual(nonNull[2].payload.raw.permissionMode, 'default');
});
