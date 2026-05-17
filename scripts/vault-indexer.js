#!/usr/bin/env node
'use strict';

// vault-indexer: pull vault git, embed changed .md, upsert pgvector,
// rebuild backlinks, bump meta.last_indexed_sha. Idempotent.

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');
const lib = require('./lib/vault-lib');

const VAULT = process.env.VAULT_PATH || '/vault';
const PG = {
  host:     process.env.VAULT_RAG_PG_HOST || 'vault-rag-postgres',
  database: process.env.VAULT_RAG_PG_DB   || 'vault_rag',
  user:     process.env.VAULT_RAG_PG_USER || 'postgres',
  password: process.env.VAULT_RAG_PG_PASS,
  port:     5432,
};

const git = (args) =>
  execSync(`git -C ${VAULT} ${args}`, { encoding: 'utf8' }).trim();

async function main() {
  try { git('pull --quiet --rebase --autostash'); }
  catch (e) { console.error(`[indexer] git pull warn: ${e.message}`); }

  const headSha = git('rev-parse HEAD');

  const pg = new Client(PG);
  await pg.connect();

  const { rows } = await pg.query(`SELECT v FROM meta WHERE k='last_indexed_sha'`);
  const lastSha = rows[0]?.v || '';

  let changed = [];
  if (!lastSha) {
    const all = git('ls-files -- "*.md"').split('\n').filter(Boolean);
    changed = all.map(p => ({ status: 'A', path: p }));
  } else if (lastSha === headSha) {
    console.log(`[indexer] no changes since ${lastSha.slice(0, 7)}`);
    await pg.end();
    return;
  } else {
    const diff = git(`diff --name-status ${lastSha} ${headSha} -- "*.md"`);
    changed = diff.split('\n').filter(Boolean).map(line => {
      const parts = line.split(/\t/);
      return { status: parts[0][0], path: parts[parts.length - 1], oldPath: parts[0].startsWith('R') ? parts[1] : null };
    });
  }

  console.log(`[indexer] HEAD=${headSha.slice(0,7)} last=${lastSha.slice(0,7) || 'INIT'} files=${changed.length}`);

  let upserted = 0, deleted = 0, errors = 0;

  for (const f of changed) {
    try {
      if (f.status === 'D') {
        await lib.deleteFile(pg, f.path);
        deleted++; continue;
      }
      if (f.oldPath) {
        await lib.deleteFile(pg, f.oldPath);
      }
      const full = path.join(VAULT, f.path);
      if (!fs.existsSync(full)) continue;
      const raw = fs.readFileSync(full, 'utf8');
      const { fm, body } = lib.parseFrontmatter(raw);
      await lib.upsertFile(pg, f.path, body, fm);
      upserted++;
    } catch (e) {
      try { await pg.query('ROLLBACK'); } catch {}
      console.error(`[indexer] ERR ${f.path}: ${e.message}`);
      try {
        await pg.query(
          `INSERT INTO ingest_log (source, ref, path, status, error) VALUES ('vault-indexer',$1,$2,'err',$3)`,
          [f.status, f.path, String(e.message).slice(0, 500)]
        );
      } catch {}
      errors++;
    }
  }

  if (errors === 0) {
    await pg.query(
      `INSERT INTO meta (k, v) VALUES ('last_indexed_sha', $1)
       ON CONFLICT (k) DO UPDATE SET v=$1, updated_at=now()`,
      [headSha]
    );
  } else {
    console.warn(`[indexer] errors=${errors}, sha NOT bumped (will retry next run)`);
  }
  await pg.query(
    `INSERT INTO ingest_log (source, ref, status) VALUES ('vault-indexer',$1,'ok')`,
    [`upserted=${upserted} deleted=${deleted} errors=${errors} sha=${headSha.slice(0,7)}`]
  );

  console.log(`[indexer] upserted=${upserted} deleted=${deleted} errors=${errors}`);
  await pg.end();
}

main().catch(e => {
  console.error(`[indexer] FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
