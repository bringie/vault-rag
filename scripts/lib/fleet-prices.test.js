'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const prices = require('./fleet-prices');

const PG = {
  host: '127.0.0.1', port: parseInt(process.env.VAULT_RAG_PG_PORT || '55433', 10),
  user: 'postgres', password: process.env.VAULT_RAG_PG_PASS, database: 'vault_rag',
};

async function withClient(fn) {
  const c = new Client(PG);
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function resetPrices(c) {
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

test('priceFor returns opus prices for claude-opus-4-7', async () => {
  await withClient(async (c) => {
    await resetPrices(c);
    const p = await prices.priceFor(c, 'claude-opus-4-7');
    assert.strictEqual(p.input, 15);
    assert.strictEqual(p.output, 75);
    assert.strictEqual(p.cache_create, 18.75);
    assert.strictEqual(p.cache_read, 1.5);
    assert.strictEqual(p.flagged, false);
  });
});

test('priceFor returns sonnet prices for claude-sonnet-4-6', async () => {
  await withClient(async (c) => {
    await resetPrices(c);
    const p = await prices.priceFor(c, 'claude-sonnet-4-6');
    assert.strictEqual(p.input, 3);
    assert.strictEqual(p.flagged, false);
  });
});

test('priceFor returns fallback flagged for unknown model', async () => {
  await withClient(async (c) => {
    await resetPrices(c);
    const p = await prices.priceFor(c, 'gpt-4o');
    assert.strictEqual(p.input, 0);
    assert.strictEqual(p.flagged, true);
  });
});

test('priceFor returns ZERO_PRICE if table empty', async () => {
  await withClient(async (c) => {
    await c.query('TRUNCATE fleet_model_prices');
    prices.invalidate();
    const p = await prices.priceFor(c, 'any-model');
    assert.strictEqual(p.input, 0);
    assert.strictEqual(p.flagged, true);
  });
});

test('priceFor uses temporal lookup: pre-snapshot uses old price', async () => {
  await withClient(async (c) => {
    await resetPrices(c);
    await c.query(`
      INSERT INTO fleet_model_prices (match_pattern, priority, valid_from, input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok)
      VALUES ('claude-opus-%', 300, '2026-01-01', 99, 99, 99, 99)`);
    prices.invalidate();
    const before = await prices.priceFor(c, 'claude-opus-4-7', new Date('2025-12-01'));
    assert.strictEqual(before.input, 15);
    const after = await prices.priceFor(c, 'claude-opus-4-7', new Date('2026-06-01'));
    assert.strictEqual(after.input, 99);
  });
});

test('priceFor higher priority wins among valid matches', async () => {
  await withClient(async (c) => {
    await resetPrices(c);
    await c.query(`
      INSERT INTO fleet_model_prices (match_pattern, priority, valid_from, input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok)
      VALUES ('claude-opus-4-7', 500, '1970-01-01', 999, 999, 999, 999)`);
    prices.invalidate();
    const p = await prices.priceFor(c, 'claude-opus-4-7');
    assert.strictEqual(p.input, 999);
    const fam = await prices.priceFor(c, 'claude-opus-5');
    assert.strictEqual(fam.input, 15);
  });
});

test('priceFor ignores soft-deleted rows', async () => {
  await withClient(async (c) => {
    await resetPrices(c);
    await c.query(`UPDATE fleet_model_prices SET deleted_at = now() WHERE match_pattern = 'claude-opus-%'`);
    prices.invalidate();
    const p = await prices.priceFor(c, 'claude-opus-4-7');
    assert.strictEqual(p.input, 0);
    assert.strictEqual(p.flagged, true);
  });
});

test('invalidate clears cache so next call re-reads DB', async () => {
  await withClient(async (c) => {
    await resetPrices(c);
    await prices.priceFor(c, 'claude-opus-4-7');
    await c.query(`UPDATE fleet_model_prices SET input_per_mtok = 100 WHERE match_pattern = 'claude-opus-%' AND priority = 200`);
    prices.invalidate();
    const p = await prices.priceFor(c, 'claude-opus-4-7');
    assert.strictEqual(p.input, 100);
  });
});
