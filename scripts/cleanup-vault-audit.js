#!/usr/bin/env node
// cleanup-vault-audit: delete audit rows older than retention windows.
// vt-0204: extended to also prune secret_audit, ingest_log, workflow_audit
// so audit tables can't grow unbounded.

const { Client } = require('pg');
const log = require('./lib/log').for('audit-cleanup');

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
const WEBHOOK_RETAIN_DAYS = parseInt(process.env.WEBHOOK_DELIVERY_RETAIN_DAYS || '30', 10);
// vt-0302-followup: auth_audit retention. ws-ticket grants accumulate
// fast on a busy operator desktop (page refresh = new ticket). 60d is
// generous for incident review.
const AUTH_RETAIN_DAYS    = parseInt(process.env.AUTH_AUDIT_RETAIN_DAYS    || '60', 10);

// vt-0302-followup: CLI flags for manual operator use when the
// AuditTableTooLarge alert fires:
//   node cleanup-vault-audit.js --table=auth_audit --older-than=30
//   node cleanup-vault-audit.js --dry-run
const argv = process.argv.slice(2);
function flag(name) {
  for (const a of argv) {
    if (a === `--${name}`) return true;
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return null;
}
const ONLY_TABLE = flag('table');
const OVERRIDE_OLDER_THAN = flag('older-than') ? parseInt(flag('older-than'), 10) : null;
const DRY_RUN = flag('dry-run') === true;

async function prune(pg, table, retainDays, where = 'true') {
  if (ONLY_TABLE && ONLY_TABLE !== table) return;
  const days = OVERRIDE_OLDER_THAN != null ? OVERRIDE_OLDER_THAN : retainDays;
  try {
    if (DRY_RUN) {
      const r = await pg.query(
        `SELECT COUNT(*)::int AS n FROM ${table}
          WHERE ts < NOW() - ($1::text || ' days')::interval
            AND ${where}`,
        [days]);
      console.log(`[audit-cleanup] DRY-RUN table=${table} would-delete=${r.rows[0].n} retain=${days}d`);
      return;
    }
    const r = await pg.query(
      `DELETE FROM ${table}
        WHERE ts < NOW() - ($1::text || ' days')::interval
          AND ${where}
        RETURNING id`,
      [days]
    );
    console.log(`[audit-cleanup] table=${table} deleted=${r.rowCount} retain=${days}d`);
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
    // vt-0240: webhook_deliveries grows per attempt per subscription per
    // event — easy to amass millions of rows on a busy hub.
    await prune(pg, 'webhook_deliveries', WEBHOOK_RETAIN_DAYS);
    // vt-0302-followup: auth_audit retention.
    await prune(pg, 'auth_audit', AUTH_RETAIN_DAYS);
  } finally {
    await pg.end();
  }
})().catch(e => { log.error('fatal', { msg: e.message }); process.exit(1); });
