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
