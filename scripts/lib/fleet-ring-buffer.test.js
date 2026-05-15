'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { RingBuffer } = require('./fleet-ring-buffer');

test('append + snapshot returns buffered data', () => {
  const rb = new RingBuffer(1024);
  rb.append({ seq: 0, data: Buffer.from('hello ') });
  rb.append({ seq: 1, data: Buffer.from('world') });
  const snap = rb.snapshot();
  assert.equal(Buffer.concat(snap.map(f => f.data)).toString(), 'hello world');
  assert.equal(snap[0].seq, 0);
  assert.equal(snap[1].seq, 1);
});

test('evicts oldest frames when capacity exceeded', () => {
  const rb = new RingBuffer(10);
  rb.append({ seq: 0, data: Buffer.from('aaaa') });
  rb.append({ seq: 1, data: Buffer.from('bbbb') });
  rb.append({ seq: 2, data: Buffer.from('cccc') });
  rb.append({ seq: 3, data: Buffer.from('dddd') });
  const snap = rb.snapshot();
  const total = snap.reduce((n, f) => n + f.data.length, 0);
  assert.ok(total <= 10, `total ${total} > capacity 10`);
  assert.equal(snap[snap.length - 1].seq, 3);
});

test('snapshot returns shallow copy (length stable after future append)', () => {
  const rb = new RingBuffer(64);
  rb.append({ seq: 0, data: Buffer.from('xyz') });
  const a = rb.snapshot();
  rb.append({ seq: 1, data: Buffer.from('extra') });
  assert.equal(a.length, 1);
});

test('size returns total bytes buffered', () => {
  const rb = new RingBuffer(1024);
  assert.equal(rb.size(), 0);
  rb.append({ seq: 0, data: Buffer.from('abc') });
  assert.equal(rb.size(), 3);
});
