'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const fleetCost = require('./fleet-cost');
const prices = require('./fleet-prices');

const PG_BASE = {
  host: '127.0.0.1', port: parseInt(process.env.VAULT_RAG_PG_PORT || '55433', 10),
  user: 'postgres', password: process.env.VAULT_RAG_PG_PASS,
};
async function withBoth(fn) {
  const tokmonPg = new Client({ ...PG_BASE, database: 'tokmon' });
  const vaultPg = new Client({ ...PG_BASE, database: 'vault_rag' });
  await tokmonPg.connect();
  await vaultPg.connect();
  try { return await fn(tokmonPg, vaultPg); }
  finally { await tokmonPg.end(); await vaultPg.end(); }
}
async function resetEvents(c) {
  await c.query('TRUNCATE events RESTART IDENTITY CASCADE');
}
async function seedPrices(c) {
  await c.query('TRUNCATE fleet_model_prices RESTART IDENTITY');
  await c.query(`
    INSERT INTO fleet_model_prices (match_pattern, priority, valid_from, input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok, flagged)
    VALUES
      ('claude-opus-%',   200, '1970-01-01', 15, 75, 18.75, 1.50, false),
      ('claude-sonnet-%', 200, '1970-01-01', 3, 15, 3.75, 0.30, false),
      ('claude-haiku-%',  200, '1970-01-01', 1, 5, 1.25, 0.10, false),
      ('%',                 0, '1970-01-01', 0, 0, 0, 0, true)`);
  prices.invalidate();
}
async function seed(c, host, ts, model, inT, outT, ccm = 0, cr = 0) {
  const offset = Math.floor(Math.random() * 1e12);
  await c.query(
    `INSERT INTO events (host_id, message_uuid, ts, session_id, project_path, model,
       input_tokens, output_tokens, cache_creation_5m, cache_creation_1h, cache_read,
       source_file, source_offset, raw_hash, raw)
     VALUES ($1, $2, $3, 'sess-t', '/x', $4, $5, $6, $7, 0, $8, '/x', $9, 'h', '{}'::jsonb)`,
    [host, `msg-${offset}`, ts, model, inT, outT, ccm, cr, offset]);
}

test('rowCost uses seeded prices', async () => {
  await withBoth(async (tok, vault) => {
    await seedPrices(vault);
    const c = await fleetCost.rowCost(
      { model: 'claude-opus-4-7', input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_5m: 0, cache_read: 0 },
      new Date(),
      vault,
    );
    assert.ok(Math.abs(c - 22.5) < 0.001, `got ${c}`);
  });
});

test('sessionCost sums rows within window for given host', async () => {
  await withBoth(async (tok, vault) => {
    await resetEvents(tok);
    await seedPrices(vault);
    const start = new Date('2026-05-15T10:00:00Z');
    const end   = new Date('2026-05-15T11:00:00Z');
    await seed(tok, 'mac1', new Date('2026-05-15T10:30:00Z'), 'claude-sonnet-4-6', 1_000_000, 500_000);
    await seed(tok, 'mac1', new Date('2026-05-15T10:45:00Z'), 'claude-opus-4-7',   1_000_000, 100_000);
    await seed(tok, 'other', new Date('2026-05-15T10:30:00Z'), 'claude-sonnet-4-6', 5_000_000, 5_000_000);
    await seed(tok, 'mac1', new Date('2026-05-15T09:30:00Z'), 'claude-sonnet-4-6', 5_000_000, 0);
    const r = await fleetCost.sessionCost(tok, vault, 'mac1', start, end);
    assert.ok(Math.abs(r.usd - 33) < 0.01, `expected ~33, got ${r.usd}`);
    assert.equal(r.msgs, 2);
  });
});

test('hostSummary aggregates per-host costs over N days', async () => {
  await withBoth(async (tok, vault) => {
    await resetEvents(tok);
    await seedPrices(vault);
    await seed(tok, 'mac1', new Date(),   'claude-sonnet-4-6', 2_000_000, 1_000_000);
    await seed(tok, 'mac2', new Date(),   'claude-haiku-4-5',  3_000_000, 500_000);
    const out = await fleetCost.hostSummary(tok, vault, ['mac1', 'mac2'], 7);
    assert.ok(Math.abs(out.mac1.usd - 21) < 0.01, `mac1 got ${out.mac1?.usd}`);
    assert.ok(Math.abs(out.mac2.usd - 5.5) < 0.01, `mac2 got ${out.mac2?.usd}`);
  });
});

// vt-0127: aggregateDayRollup used to resolve price at MAX(ts) → mid-day price
// change mispriced the entire day. Now hourly bucketing bounds error to one hour.
test('vt-0127: aggregateDayRollup prices each hour at its own rate', async () => {
  await withBoth(async (tok, vault) => {
    await resetEvents(tok);
    await vault.query('TRUNCATE fleet_model_prices RESTART IDENTITY');
    await vault.query(`
      TRUNCATE fleet_cost_daily_rollup`);
    // Price doubles at 12:00 UTC.
    await vault.query(`
      INSERT INTO fleet_model_prices (match_pattern, priority, valid_from, input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok, flagged)
      VALUES
        ('claude-sonnet-%', 200, '1970-01-01',          3, 15, 3.75, 0.30, false),
        ('claude-sonnet-%', 200, '2026-05-14T12:00:00Z', 6, 30, 7.50, 0.60, false),
        ('%',                 0, '1970-01-01',          0, 0,  0,    0,    true)`);
    prices.invalidate();

    const day = '2026-05-14';
    // 1M input tokens at 06:00 (old price: $3 = 3) and 1M at 18:00 (new: $6 = 6).
    // Expected: 3 + 6 = $9. Old code (MAX(ts) → 18:00 price): 6 + 6 = $12.
    await seed(tok, 'h1', new Date('2026-05-14T06:00:00Z'), 'claude-sonnet-4-6', 1_000_000, 0);
    await seed(tok, 'h1', new Date('2026-05-14T18:00:00Z'), 'claude-sonnet-4-6', 1_000_000, 0);

    const r = await fleetCost.aggregateDayRollup(tok, vault, day);
    assert.ok(r.rows > 0);
    const { rows } = await vault.query(
      `SELECT usd FROM fleet_cost_daily_rollup WHERE day = $1 AND dim = 'model' AND value = 'claude-sonnet-4-6'`,
      [day]);
    assert.equal(rows.length, 1);
    assert.ok(Math.abs(Number(rows[0].usd) - 9) < 0.01,
      `expected ~$9 with hourly pricing, got $${rows[0].usd} (MAX-ts bug would give ~$12)`);
  });
});

test('unknown model uses fallback (zero cost, flagged)', async () => {
  await withBoth(async (tok, vault) => {
    await resetEvents(tok);
    await seedPrices(vault);
    await seed(tok, 'h1', new Date(), 'gpt-4o', 1_000_000, 1_000_000);
    const out = await fleetCost.hostSummary(tok, vault, ['h1'], 7);
    assert.strictEqual(out.h1.usd, 0);
    assert.strictEqual(out.h1.msgs, 1);
  });
});

// vt-0130: rowCostSync requires prices.ensure() to be awaited first; after
// that, hot-loop callers price rows synchronously (no per-row await hop).
test('vt-0130: rowCostSync matches async rowCost after prices.ensure', async () => {
  await withBoth(async (tok, vault) => {
    await seedPrices(vault);
    await prices.load(vault);
    const r = { model: 'claude-sonnet-4-6', input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_5m: 0, cache_read: 0 };
    const ts = new Date();
    const asyncUsd = await fleetCost.rowCost(r, ts, vault);
    const syncUsd  = fleetCost.rowCostSync(r, ts);
    assert.equal(syncUsd, asyncUsd);
  });
});
