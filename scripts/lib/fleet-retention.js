'use strict';
// fleet-retention: 5-min rollup + 24h raw/7d rollup cleanup.

async function runRetention(pool) {
  // vt-0129: wrap rollup + delete in a single transaction so all statements
  // see the same `now()` snapshot. Without this, a metric write arriving
  // between rollup INSERT and DELETE could end up in a window that's neither
  // rolled up nor preserved. The race window is tiny in practice (rollup
  // covers t < date_bin('5min', now()), DELETE removes t > 24h, no overlap
  // under healthy NTP), but the transaction makes the contract explicit.
  //
  // Accept either pg.Pool or pg.Client. Pool exposes `.totalCount`; Client
  // doesn't. (Both have `.connect()`, so we can't use that as a discriminator.)
  const isPool = typeof pool.totalCount === 'number';
  const client = isPool ? await pool.connect() : pool;
  const useTx = isPool;
  try {
    if (useTx) await client.query('BEGIN');
    // 1. Upsert rollups — 30-min lookback covers late samples within window.
    await client.query(`
      INSERT INTO fleet_host_metrics_5m (host_id, bucket, cpu_pct_avg, cpu_pct_max, ram_used_bytes)
      SELECT host_id, date_bin('5 minutes', ts, '1970-01-01'::timestamptz) AS bucket,
             avg(cpu_pct)::real, max(cpu_pct)::real, avg(ram_used_bytes)::bigint
      FROM fleet_host_metrics
      WHERE ts > now() - interval '30 minutes' AND ts < date_bin('5 minutes', now(), '1970-01-01'::timestamptz)
      GROUP BY host_id, bucket
      ON CONFLICT (host_id, bucket) DO UPDATE SET
        cpu_pct_avg = EXCLUDED.cpu_pct_avg,
        cpu_pct_max = EXCLUDED.cpu_pct_max,
        ram_used_bytes = EXCLUDED.ram_used_bytes`);
    // 2. Cleanup (same transactional now())
    await client.query(`DELETE FROM fleet_host_metrics WHERE ts < now() - interval '24 hours'`);
    await client.query(`DELETE FROM fleet_host_metrics_5m WHERE bucket < now() - interval '7 days'`);
    if (useTx) await client.query('COMMIT');
  } catch (e) {
    if (useTx) { try { await client.query('ROLLBACK'); } catch {} }
    throw e;
  } finally {
    if (useTx && client.release) client.release();
  }
}

function startRetention(db, intervalMs = 5 * 60 * 1000) {
  // Run once at boot, then every 5 min.
  runRetention(db).catch(e => console.error('[retention] boot:', e.message));
  const t = setInterval(() => {
    runRetention(db).catch(e => console.error('[retention] tick:', e.message));
  }, intervalMs);
  t.unref?.();
  return t;
}

module.exports = { runRetention, startRetention };
