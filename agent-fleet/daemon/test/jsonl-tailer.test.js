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
