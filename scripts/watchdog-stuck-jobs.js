#!/usr/bin/env node
// watchdog-stuck-jobs: mark job_runs rows stuck in 'running' >30min as 'killed'.
// Idempotent. Returns rows-killed count for ofelia summary.

const { Client } = require('pg');

const PG = {
  host:     process.env.VAULT_RAG_PG_HOST || 'vault-rag-postgres',
  database: process.env.VAULT_RAG_PG_DB   || 'vault_rag',
  user:     process.env.VAULT_RAG_PG_USER || 'postgres',
  password: process.env.VAULT_RAG_PG_PASS,
  port:     5432,
};
const STUCK_MIN = parseInt(process.env.WATCHDOG_STUCK_MIN || '30', 10);

(async () => {
  const pg = new Client(PG);
  await pg.connect();
  try {
    const r = await pg.query(
      `UPDATE job_runs
         SET status='killed',
             error=COALESCE(error||' | ','')||'watchdog: stuck >' || $1 || 'min',
             finished_at=NOW(),
             duration_ms=(EXTRACT(EPOCH FROM (NOW()-started_at))*1000)::bigint
       WHERE status='running'
         AND started_at < NOW() - ($1::text || ' minutes')::interval
       RETURNING id, job_name, started_at`,
      [STUCK_MIN]
    );
    console.log(`[watchdog] killed=${r.rowCount} threshold=${STUCK_MIN}min`);
    if (r.rowCount) {
      for (const row of r.rows) {
        console.log(`[watchdog] kill id=${row.id} job=${row.job_name} started=${row.started_at.toISOString()}`);
      }
    }
  } finally {
    await pg.end();
  }
})().catch(e => { console.error('[watchdog] FATAL:', e.message); process.exit(1); });
