'use strict';
// fleet-retention: 5-min rollup + 24h raw/7d rollup cleanup.

const log = require('./log').for('fleet-retention');

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

// vt-0340: per-host session event retention. Keep PTY content
// (fleet_events transcript + ring) for the top-N most-recently
// completed sessions per host; drop older. fleet_sessions rows
// are preserved (duration / cost / exit_code stay for analytics).
const SESSION_KEEP_PER_HOST = parseInt(
  process.env.VAULT_RAG_SESSION_KEEP_PER_HOST || '10', 10);
const SESSION_PURGE_BATCH = parseInt(
  process.env.VAULT_RAG_SESSION_PURGE_BATCH || '5000', 10);

async function purgeOldSessionEvents(pg) {
  // Identify hosts with > N closed sessions.
  const { rows: hosts } = await pg.query(
    `SELECT host_id, COUNT(*)::int AS n
     FROM fleet_sessions
     WHERE status IN ('done','failed','cancelled','exited','killed','orphaned')
     GROUP BY host_id
     HAVING COUNT(*) > $1`,
    [SESSION_KEEP_PER_HOST]);

  let totalPurged = 0;
  for (const h of hosts) {
    // Per-host: collect ids beyond the top-N keep window, then
    // batch-delete their fleet_events. Two queries (planner picks the
    // partial index from migration 029).
    const { rows: toDelete } = await pg.query(`
      WITH ranked AS (
        SELECT id, row_number() OVER (
          PARTITION BY host_id
          ORDER BY COALESCE(ended_at, started_at) DESC
        ) AS rn
        FROM fleet_sessions
        WHERE host_id = $1
          AND status IN ('done','failed','cancelled','exited','killed','orphaned')
      )
      SELECT id FROM ranked WHERE rn > $2 LIMIT $3`,
      [h.host_id, SESSION_KEEP_PER_HOST, SESSION_PURGE_BATCH]);
    if (!toDelete.length) continue;
    const ids = toDelete.map(r => r.id);
    const { rowCount } = await pg.query(
      `DELETE FROM fleet_events WHERE session_id = ANY($1::uuid[])`,
      [ids]);
    totalPurged += rowCount || 0;
  }
  return totalPurged;
}

function startRetention(db, intervalMs = 5 * 60 * 1000) {
  // Run once at boot, then every 5 min.
  runRetention(db).catch(e => log.error('boot_failed', { msg: e.message }));
  const t = setInterval(() => {
    runRetention(db).catch(e => log.error('tick_failed', { msg: e.message }));
  }, intervalMs);
  t.unref?.();
  return t;
}

// vt-0340: session-event purge runs hourly (independent of metrics
// rollup which is 5-min cadence). Two timers keep them decoupled.
function startSessionEventPurge(pg, intervalMs = 60 * 60 * 1000) {
  // Run once at boot (~ 30s after) so a hot deploy doesn't stampede.
  setTimeout(() => {
    purgeOldSessionEvents(pg)
      .then(n => { if (n > 0) log.info('session_events_purged', { rows: n, keep: SESSION_KEEP_PER_HOST }); })
      .catch(e => log.error('session_event_purge_boot_failed', { msg: e.message }));
  }, 30_000);
  const t = setInterval(() => {
    purgeOldSessionEvents(pg)
      .then(n => { if (n > 0) log.info('session_events_purged', { rows: n, keep: SESSION_KEEP_PER_HOST }); })
      .catch(e => log.error('session_event_purge_tick_failed', { msg: e.message }));
  }, intervalMs);
  t.unref?.();
  return t;
}

module.exports = { runRetention, startRetention, purgeOldSessionEvents, startSessionEventPurge };
