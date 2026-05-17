#!/usr/bin/env node
// cleanup-vault-audit: delete audit rows older than retention windows.
// vt-0204: extended to also prune secret_audit, ingest_log, workflow_audit
// so audit tables can't grow unbounded.

const { Client } = require('pg');

const PG = {
  host:     process.env.VAULT_RAG_PG_HOST || 'vault-rag-postgres',
  database: process.env.VAULT_RAG_PG_DB   || 'vault_rag',
  user:     process.env.VAULT_RAG_PG_USER || 'postgres',
  password: process.env.VAULT_RAG_PG_PASS,
  port:     5432,
};
const RETAIN_DAYS         = parseInt(process.env.AUDIT_RETAIN_DAYS         || '90', 10);
const SECRET_RETAIN_DAYS  = parseInt(process.env.SECRET_AUDIT_RETAIN_DAYS  || String(RETAIN_DAYS), 10);
const WORKFLOW_RETAIN_DAYS= parseInt(process.env.WORKFLOW_AUDIT_RETAIN_DAYS|| String(RETAIN_DAYS), 10);
const INGEST_RETAIN_DAYS  = parseInt(process.env.INGEST_LOG_RETAIN_DAYS    || '30', 10);

async function prune(pg, table, retainDays, where = 'true') {
  try {
    const r = await pg.query(
      `DELETE FROM ${table}
        WHERE ts < NOW() - ($1::text || ' days')::interval
          AND ${where}
        RETURNING id`,
      [retainDays]
    );
    console.log(`[audit-cleanup] table=${table} deleted=${r.rowCount} retain=${retainDays}d`);
  } catch (e) {
    // Table may not exist on older deployments — log + continue.
    console.warn(`[audit-cleanup] table=${table} skipped: ${e.message}`);
  }
}

(async () => {
  const pg = new Client(PG);
  await pg.connect();
  try {
    await prune(pg, 'vault_audit', RETAIN_DAYS);
    await prune(pg, 'secret_audit', SECRET_RETAIN_DAYS);
    await prune(pg, 'workflow_audit', WORKFLOW_RETAIN_DAYS);
    // ingest_log keeps errors longer (their retention window controls the
    // 'detail' jsonb column for non-error rows only).
    await prune(pg, 'ingest_log', INGEST_RETAIN_DAYS, "level <> 'error'");
  } finally {
    await pg.end();
  }
})().catch(e => { console.error('[audit-cleanup] FATAL:', e.message); process.exit(1); });
