#!/usr/bin/env node
// cleanup-vault-audit: delete vault_audit rows older than retention window. Runs weekly.

const { Client } = require('pg');

const PG = {
  host:     process.env.VAULT_RAG_PG_HOST || 'vault-rag-postgres',
  database: process.env.VAULT_RAG_PG_DB   || 'vault_rag',
  user:     process.env.VAULT_RAG_PG_USER || 'postgres',
  password: process.env.VAULT_RAG_PG_PASS,
  port:     5432,
};
const RETAIN_DAYS = parseInt(process.env.AUDIT_RETAIN_DAYS || '90', 10);

(async () => {
  const pg = new Client(PG);
  await pg.connect();
  try {
    const r = await pg.query(
      `DELETE FROM vault_audit
        WHERE ts < NOW() - ($1::text || ' days')::interval
        RETURNING id`,
      [RETAIN_DAYS]
    );
    console.log(`[audit-cleanup] deleted=${r.rowCount} retain=${RETAIN_DAYS}d`);
  } finally {
    await pg.end();
  }
})().catch(e => { console.error('[audit-cleanup] FATAL:', e.message); process.exit(1); });
