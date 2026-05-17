#!/usr/bin/env node
'use strict';

// run-job.js: wrap a command, log row in job_runs (running -> ok/err with duration+summary).
// Usage: run-job.js <job_name> <cmd> [args...]
// Env: VAULT_RAG_PG_HOST, VAULT_RAG_PG_DB, VAULT_RAG_PG_USER, VAULT_RAG_PG_PASS, RUN_JOB_TAIL_BYTES (default 4096).

const { spawn } = require('child_process');
const fs   = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

// vt-0137: $HOME is a tmpfs (vault-rag-tools runs as non-root). Pre-create
// $HOME/.ssh so child git operations can write known_hosts without warnings.
try { fs.mkdirSync(path.join(process.env.HOME || '/root', '.ssh'), { recursive: true, mode: 0o700 }); } catch {}

const [, , jobName, ...cmdArgs] = process.argv;
if (!jobName || cmdArgs.length === 0) {
  console.error('usage: run-job.js <job_name> <cmd> [args...]');
  process.exit(2);
}

const PG = {
  host:     process.env.VAULT_RAG_PG_HOST || 'vault-rag-postgres',
  database: process.env.VAULT_RAG_PG_DB   || 'vault_rag',
  user:     process.env.VAULT_RAG_PG_USER || 'postgres',
  password: process.env.VAULT_RAG_PG_PASS,
  port:     5432,
};
const TAIL = parseInt(process.env.RUN_JOB_TAIL_BYTES || '4096', 10);

function tailRing(buf, chunk, max) {
  buf.push(chunk);
  let total = buf.reduce((n, b) => n + b.length, 0);
  while (total > max && buf.length > 1) {
    total -= buf[0].length;
    buf.shift();
  }
  return buf;
}

// vault-indexer-style: extract "upserted=X deleted=Y errors=Z sha=abc1234" if present.
function extractSummary(text) {
  const m = text.match(/upserted=\d+\s+deleted=\d+\s+errors=\d+(?:\s+sha=\S+)?/);
  if (m) return m[0];
  const lines = text.trim().split('\n').filter(Boolean);
  return lines.slice(-3).join(' | ').slice(-500);
}

(async () => {
  const pg = new Client(PG);
  await pg.connect();

  const { rows } = await pg.query(
    `INSERT INTO job_runs (job_name, status) VALUES ($1, 'running') RETURNING id`,
    [jobName]
  );
  const runId = rows[0].id;
  const startMs = Date.now();

  const child = spawn(cmdArgs[0], cmdArgs.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  const outBuf = [], errBuf = [];

  child.stdout.on('data', (d) => { process.stdout.write(d); tailRing(outBuf, d, TAIL); });
  child.stderr.on('data', (d) => { process.stderr.write(d); tailRing(errBuf, d, TAIL); });

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code, sig) => resolve(code != null ? code : (sig ? 128 : 1)));
    child.on('error', (e) => { console.error(`[run-job] spawn error: ${e.message}`); resolve(127); });
  });

  const durationMs = Date.now() - startMs;
  const stdoutTxt = Buffer.concat(outBuf).toString('utf8');
  const stderrTxt = Buffer.concat(errBuf).toString('utf8');
  const status = exitCode === 0 ? 'ok' : 'err';
  const summary = extractSummary(stdoutTxt) || null;
  const error = exitCode === 0 ? null : (stderrTxt.trim().slice(-1000) || `exit=${exitCode}`);

  await pg.query(
    `UPDATE job_runs
        SET finished_at=now(), duration_ms=$2, status=$3, exit_code=$4, summary=$5, error=$6
      WHERE id=$1`,
    [runId, durationMs, status, exitCode, summary, error]
  );
  await pg.end();
  process.exit(exitCode);
})().catch((e) => {
  console.error(`[run-job] FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
