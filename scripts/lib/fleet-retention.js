'use strict';
// fleet-retention: 5-min rollup + 24h raw/7d rollup cleanup.

async function runRetention(db) {
  // 1. Upsert rollups — 30-min lookback covers late samples within window.
  await db.query(`
    INSERT INTO fleet_host_metrics_5m (host_id, bucket, cpu_pct_avg, cpu_pct_max, ram_used_bytes)
    SELECT host_id, date_trunc('5 minutes', ts) AS bucket,
           avg(cpu_pct)::real, max(cpu_pct)::real, avg(ram_used_bytes)::bigint
    FROM fleet_host_metrics
    WHERE ts > now() - interval '30 minutes' AND ts < date_trunc('5 minutes', now())
    GROUP BY host_id, bucket
    ON CONFLICT (host_id, bucket) DO UPDATE SET
      cpu_pct_avg = EXCLUDED.cpu_pct_avg,
      cpu_pct_max = EXCLUDED.cpu_pct_max,
      ram_used_bytes = EXCLUDED.ram_used_bytes`);
  // 2. Cleanup
  await db.query(`DELETE FROM fleet_host_metrics WHERE ts < now() - interval '24 hours'`);
  await db.query(`DELETE FROM fleet_host_metrics_5m WHERE bucket < now() - interval '7 days'`);
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
