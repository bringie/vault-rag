'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const fleetCost = require('./fleet-cost');

const PG_BASE = {
  host: '127.0.0.1', port: parseInt(process.env.VAULT_RAG_PG_PORT || '55433', 10),
  user: 'postgres', password: process.env.VAULT_RAG_PG_PASS,
};
async function withTokmon(fn) {
  const c = new Client({ ...PG_BASE, database: 'tokmon' });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
async function resetEvents(c) {
  await c.query('TRUNCATE events RESTART IDENTITY CASCADE');
}
async function seed(c, host, ts, model, inT, outT, ccm = 0, cr = 0) {
  const offset = Math.floor(Math.random() * 1e12);
  const msgUuid = `msg-${offset}`;
  await c.query(
    `INSERT INTO events (host_id, message_uuid, ts, session_id, project_path, model,
       input_tokens, output_tokens, cache_creation_5m, cache_creation_1h, cache_read,
       source_file, source_offset, raw_hash, raw)
     VALUES ($1, $2, $3, 'sess-t', '/x', $4, $5, $6, $7, 0, $8, '/x', $9, 'h', '{}'::jsonb)`,
    [host, msgUuid, ts, model, inT, outT, ccm, cr, offset]);
}

test('priceFor returns reasonable rates by family', () => {
  assert.deepEqual(fleetCost.priceFor('claude-opus-4-7'), [15, 75, 18.75, 1.50]);
  assert.deepEqual(fleetCost.priceFor('claude-sonnet-4-6'), [3, 15, 3.75, 0.30]);
  assert.deepEqual(fleetCost.priceFor('claude-haiku-4-5'), [1, 5, 1.25, 0.10]);
  assert.deepEqual(fleetCost.priceFor('unknown'), [3, 15, 3.75, 0.30]);
});

test('sessionCost sums rows within window for given host', async () => {
  await withTokmon(async (c) => {
    await resetEvents(c);
    const start = new Date('2026-05-15T10:00:00Z');
    const end   = new Date('2026-05-15T11:00:00Z');
    // Inside: matches
    await seed(c, 'mac1', new Date('2026-05-15T10:30:00Z'), 'claude-sonnet-4-6', 1_000_000, 500_000);
    await seed(c, 'mac1', new Date('2026-05-15T10:45:00Z'), 'claude-opus-4-7', 1_000_000, 100_000);
    // Outside (different host): excluded
    await seed(c, 'other', new Date('2026-05-15T10:30:00Z'), 'claude-sonnet-4-6', 5_000_000, 5_000_000);
    // Outside (ts before): excluded
    await seed(c, 'mac1', new Date('2026-05-15T09:30:00Z'), 'claude-sonnet-4-6', 5_000_000, 0);
    const r = await fleetCost.sessionCost(c, 'mac1', start, end);
    // sonnet: 1M*$3 + 0.5M*$15 = $3 + $7.5 = $10.5
    // opus:   1M*$15 + 0.1M*$75 = $15 + $7.5 = $22.5
    // total: $33
    assert.ok(Math.abs(r.usd - 33) < 0.01, `expected ~$33, got ${r.usd}`);
    assert.equal(r.msgs, 2);
    assert.equal(Object.keys(r.by_model).length, 2);
  });
});

test('hostSummary aggregates per-host costs over N days', async () => {
  await withTokmon(async (c) => {
    await resetEvents(c);
    await seed(c, 'mac1', new Date(Date.now() - 3600_000),  'claude-sonnet-4-6', 1_000_000, 500_000);
    await seed(c, 'mac1', new Date(Date.now() - 86400_000), 'claude-haiku-4-5',  2_000_000, 1_000_000);
    await seed(c, 'vmd',  new Date(Date.now() - 3600_000),  'claude-opus-4-7',   1_000_000, 100_000);
    const r = await fleetCost.hostSummary(c, ['mac1', 'vmd', 'missing'], 7);
    assert.ok(r.mac1.usd > 0);
    assert.ok(r.vmd.usd > 0);
    assert.ok(!r.missing, 'missing host should have no row');
  });
});

test('empty host list returns empty object', async () => {
  await withTokmon(async (c) => {
    const r = await fleetCost.hostSummary(c, [], 7);
    assert.deepEqual(r, {});
  });
});
