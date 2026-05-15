'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventBatcher } = require('./fleet-event-batcher');

test('flushes when batch hits size threshold', async () => {
  const captured = [];
  const b = new EventBatcher({
    flushSize: 3, flushIntervalMs: 1000,
    write: async (batch) => { captured.push(batch.length); },
  });
  b.push({ sessionId: 's', kind: 'pty_out', seq: 0, payload: Buffer.from('a') });
  b.push({ sessionId: 's', kind: 'pty_out', seq: 1, payload: Buffer.from('b') });
  b.push({ sessionId: 's', kind: 'pty_out', seq: 2, payload: Buffer.from('c') });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(captured, [3]);
  await b.shutdown();
});

test('flushes after interval even if below size', async () => {
  const captured = [];
  const b = new EventBatcher({
    flushSize: 100, flushIntervalMs: 30,
    write: async (batch) => { captured.push(batch.length); },
  });
  b.push({ sessionId: 's', kind: 'pty_out', seq: 0, payload: Buffer.from('x') });
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(captured, [1]);
  await b.shutdown();
});

test('shutdown flushes pending items', async () => {
  const captured = [];
  const b = new EventBatcher({
    flushSize: 100, flushIntervalMs: 1000,
    write: async (batch) => { captured.push(batch.length); },
  });
  b.push({ sessionId: 's', kind: 'pty_out', seq: 0, payload: Buffer.from('z') });
  await b.shutdown();
  assert.deepEqual(captured, [1]);
});

test('drops pty_out frames when lagBudgetMs exceeded; lifecycle still flushed', async () => {
  const captured = [];
  let slow = true;
  const b = new EventBatcher({
    flushSize: 1, flushIntervalMs: 1000, lagBudgetMs: 50,
    write: async (batch) => {
      if (slow) await new Promise(r => setTimeout(r, 150));
      captured.push(batch.map(e => e.kind));
    },
  });
  b.push({ sessionId: 's', kind: 'pty_out', seq: 0, payload: Buffer.from('a') });
  await new Promise(r => setTimeout(r, 10));
  for (let i = 1; i < 20; i++) b.push({ sessionId: 's', kind: 'pty_out', seq: i, payload: Buffer.from('x') });
  b.push({ sessionId: 's', kind: 'lifecycle', seq: 99, payload: Buffer.from('exit') });
  slow = false;
  await new Promise(r => setTimeout(r, 300));
  await b.shutdown();
  const flat = captured.flat();
  assert.ok(flat.includes('lifecycle'), 'lifecycle should survive lag-drop');
  assert.ok(flat.filter(k => k === 'pty_out').length < 21, 'most pty_out should be dropped');
});
