'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SessionStore } = require('../src/session-store');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sstore-')); }

test('persists and reloads sessions', () => {
  const dir = tmpDir();
  const a = new SessionStore(dir);
  a.put('s1', { pid: 100, last_seq: 5 });
  a.put('s2', { pid: 200, last_seq: 7 });
  const b = new SessionStore(dir);
  assert.deepEqual(b.get('s1'), { pid: 100, last_seq: 5 });
  assert.deepEqual(b.list().map(([id]) => id).sort(), ['s1','s2']);
});

test('delete removes', () => {
  const dir = tmpDir();
  const s = new SessionStore(dir);
  s.put('x', { pid: 1, last_seq: 0 });
  s.delete('x');
  assert.equal(s.get('x'), null);
});

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
