'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Pool, Client } = require('pg');
const { runRetention } = require('./fleet-retention');

const PG = {
  host:     process.env.VAULT_RAG_PG_HOST || '127.0.0.1',
  database: process.env.VAULT_RAG_PG_DB   || 'vault_rag',
  user:     process.env.VAULT_RAG_PG_USER || 'postgres',
  password: process.env.VAULT_RAG_PG_PASS,
  port:     parseInt(process.env.VAULT_RAG_PG_PORT || '55433', 10),
};

// vt-0129: runRetention now wraps rollup + delete in a single tx so all
// statements share now(). Test: rollup runs against a Pool (new path) AND
// against a single Client (legacy path) — both must complete without error.
test('vt-0129: runRetention completes against a Pool (transactional path)', async () => {
  const pool = new Pool(PG);
  try {
    await pool.query("DELETE FROM fleet_hosts WHERE name LIKE 'rt-%'");
    const h = (await pool.query("INSERT INTO fleet_hosts (name) VALUES ('rt-pool') RETURNING id")).rows[0].id;
    await pool.query(`INSERT INTO fleet_host_metrics (host_id, ts, cpu_pct, ram_used_bytes)
                      VALUES ($1, now() - interval '10 minutes', 12.5, 1024)`, [h]);
    await pool.query(`INSERT INTO fleet_host_metrics (host_id, ts, cpu_pct, ram_used_bytes)
                      VALUES ($1, now() - interval '25 hours', 50.0, 2048)`, [h]); // will be deleted
    await runRetention(pool);
    const after = await pool.query(`SELECT count(*)::int FROM fleet_host_metrics WHERE host_id = $1 AND ts < now() - interval '24 hours'`, [h]);
    assert.equal(after.rows[0].count, 0, 'rows older than 24h should be deleted');
    const rolled = await pool.query(`SELECT count(*)::int FROM fleet_host_metrics_5m WHERE host_id = $1`, [h]);
    assert.ok(rolled.rows[0].count >= 1, 'rollup row should exist for the 10-min-ago sample');
    await pool.query('DELETE FROM fleet_hosts WHERE id = $1', [h]);
  } finally {
    await pool.end();
  }
});

test('vt-0129: runRetention completes against a Client (legacy path)', async () => {
  const c = new Client(PG);
  await c.connect();
  try {
    await c.query("DELETE FROM fleet_hosts WHERE name LIKE 'rt-%'");
    const h = (await c.query("INSERT INTO fleet_hosts (name) VALUES ('rt-client') RETURNING id")).rows[0].id;
    await c.query(`INSERT INTO fleet_host_metrics (host_id, ts, cpu_pct, ram_used_bytes)
                   VALUES ($1, now() - interval '12 minutes', 22.0, 4096)`, [h]);
    await runRetention(c);
    const rolled = await c.query(`SELECT count(*)::int FROM fleet_host_metrics_5m WHERE host_id = $1`, [h]);
    assert.ok(rolled.rows[0].count >= 1);
    await c.query('DELETE FROM fleet_hosts WHERE id = $1', [h]);
  } finally {
    await c.end();
  }
});
