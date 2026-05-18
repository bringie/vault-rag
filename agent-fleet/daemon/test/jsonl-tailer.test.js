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
    await new Promise(r => setTimeout(r, 150));
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
