'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { collectMetrics, _internals } = require('../src/metrics-collector');

test('collectMetrics returns ts + numeric ram_total_bytes', async () => {
  const m = await collectMetrics();
  assert.ok(m.ts);
  assert.ok(typeof m.ram_total_bytes === 'number');
  assert.ok(m.ram_total_bytes > 0);
});

test('collectMetrics returns cpu_pct in [0,100] or null on error', async () => {
  const m = await collectMetrics();
  if (m.cpu_pct !== null) {
    assert.ok(m.cpu_pct >= 0 && m.cpu_pct <= 100, `cpu_pct=${m.cpu_pct} out of range`);
  }
});

test('collectMetrics returns disk array (may be empty)', async () => {
  const m = await collectMetrics();
  assert.ok(Array.isArray(m.disk));
  if (m.disk.length) {
    const d = m.disk[0];
    assert.ok(d.mount);
    assert.ok(typeof d.size_bytes === 'number');
    assert.ok(typeof d.used_bytes === 'number');
  }
});

test('cpu calculation clamps to [0,100]', () => {
  const { clampCpu } = _internals;
  assert.strictEqual(clampCpu(-5), 0);
  assert.strictEqual(clampCpu(150), 100);
  assert.strictEqual(clampCpu(42.7), 42.7);
});
