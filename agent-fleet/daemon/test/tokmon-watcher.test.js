'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseUsageEvent, TokmonWatcher } = require('../src/tokmon-watcher');

test('vt-0140: parseUsageEvent extracts usage from a typical jsonl line', () => {
  const line = JSON.stringify({
    type: 'assistant',
    uuid: 'u1',
    timestamp: '2026-05-16T12:00:00Z',
    sessionId: 's1',
    cwd: '/proj',
    message: {
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 25,
      },
    },
  });
  const ev = parseUsageEvent(line, '/tmp/foo.jsonl', 0);
  assert.equal(ev.input_tokens, 100);
  assert.equal(ev.output_tokens, 50);
  assert.equal(ev.cache_read, 200);
  assert.equal(ev.cache_creation_5m, 25);
  assert.equal(ev.model, 'claude-sonnet-4-5');
  assert.equal(ev.session_id, 's1');
  assert.equal(ev.message_uuid, 'u1');
  assert.equal(ev.source_offset, 0);
});

test('vt-0140: parseUsageEvent returns null for non-assistant events', () => {
  const line = JSON.stringify({ type: 'user', message: { content: 'hi' } });
  assert.strictEqual(parseUsageEvent(line, '/tmp/f', 0), null);
});

test('vt-0140: parseUsageEvent returns null for malformed JSON', () => {
  assert.strictEqual(parseUsageEvent('not json', '/tmp/f', 0), null);
});

test('vt-0140: parseUsageEvent returns null when message.usage is missing', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: 'no usage' } });
  assert.strictEqual(parseUsageEvent(line, '/tmp/f', 0), null);
});

test('vt-0140: parseUsageEvent infers project_path from sourceFile', () => {
  const line = JSON.stringify({
    type: 'assistant',
    uuid: 'u2',
    sessionId: 's2',
    message: { model: 'claude-opus', usage: { input_tokens: 1 } },
    // NB: no `cwd` field → fallback to sourceFile parse
  });
  const ev = parseUsageEvent(line, '/u/.claude/projects/-Users-x-myproj/session.jsonl', 0);
  assert.equal(ev.project_path, '-Users-x-myproj');
});

test('vt-0140: TokmonWatcher detects file rotation (size shrinks → offset reset)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokmon-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'projA'));
    const file = path.join(dir, 'projA', 'session.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'assistant', uuid: 'u1',
      message: { model: 'm', usage: { input_tokens: 1 } },
    }) + '\n');
    const w = new TokmonWatcher({ hubUrl: 'http://127.0.0.1:1', token: 't', projectsDir: dir });
    w._flush = async () => {};  // disable network for the test
    await w._scan();
    const offAfterFirst = w.offsets.get(file);
    assert.ok(offAfterFirst > 0, 'offset should advance');

    // Rotation: truncate and rewrite from zero.
    fs.writeFileSync(file, '');
    await w._scan();
    assert.equal(w.offsets.get(file), 0, 'offset reset on shrink');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vt-0140: TokmonWatcher batches new events across scans', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokmon-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'projB'));
    const file = path.join(dir, 'projB', 'session.jsonl');
    const w = new TokmonWatcher({ hubUrl: 'http://127.0.0.1:1', token: 't', projectsDir: dir });
    w._flush = async () => {};

    fs.writeFileSync(file, JSON.stringify({
      type: 'assistant', uuid: 'a',
      message: { model: 'm', usage: { input_tokens: 1 } },
    }) + '\n');
    await w._scan();
    assert.equal(w.batch.length, 1);

    // Append second event — only it should be parsed.
    fs.appendFileSync(file, JSON.stringify({
      type: 'assistant', uuid: 'b',
      message: { model: 'm', usage: { input_tokens: 2 } },
    }) + '\n');
    await w._scan();
    assert.equal(w.batch.length, 2);
    assert.equal(w.batch[1].message_uuid, 'b');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
