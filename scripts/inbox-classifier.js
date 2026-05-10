#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

const lib = require('./lib/vault-lib');
const cls = require('./lib/classifier-lib');
const state = require('./lib/classifier-state');
const { callClaude } = require('./lib/claude-cli');
const metrics = require('./lib/classifier-metrics');

const VAULT = process.env.VAULT_PATH || '/vault';
const INBOX = path.join(VAULT, '00-inbox');
const DEADLETTER = path.join(INBOX, '_deadletter');

const PG = {
  host:     process.env.VAULT_RAG_PG_HOST || 'vault-rag-postgres',
  database: process.env.VAULT_RAG_PG_DB   || 'vault_rag',
  user:     process.env.VAULT_RAG_PG_USER || 'postgres',
  password: process.env.VAULT_RAG_PG_PASS,
  port:     5432,
};

const MAX_ATTEMPTS = parseInt(process.env.INBOX_CLASSIFIER_MAX_ATTEMPTS || '3', 10);
const CONF_THRESHOLD = parseFloat(process.env.INBOX_CLASSIFIER_CONF || '0.7');
const TIMEOUT_MS = parseInt(process.env.INBOX_CLASSIFIER_TIMEOUT_MS || '60000', 10);

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

async function ensureDeadletter() {
  await fs.mkdir(DEADLETTER, { recursive: true });
}

async function moveTo(srcAbs, destAbs) {
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  try {
    await fs.rename(srcAbs, destAbs);
    return destAbs;
  } catch (e) {
    if (e.code === 'EEXIST') {
      const ts = Date.now();
      const ext = path.extname(destAbs);
      const stem = destAbs.slice(0, destAbs.length - ext.length);
      const alt = `${stem}-${ts}${ext}`;
      await fs.rename(srcAbs, alt);
      return alt;
    }
    throw e;
  }
}

async function auditClassify(pg, finalRel, shaAfter, bytes) {
  try {
    await pg.query(
      `INSERT INTO vault_audit (agent_id, path, op, sha_before, sha_after, bytes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      ['inbox-classifier', finalRel, 'classify', null, shaAfter, bytes]
    );
  } catch (e) {
    console.error(`[classifier] audit insert failed: ${e.message}`);
  }
}

async function processOne(pg, file) {
  const abs = path.join(INBOX, file);
  const text = await fs.readFile(abs, 'utf8');
  const { fm, body } = lib.parseFrontmatter(text);

  if (cls.shouldSkip(file, fm)) {
    metrics.skipped.inc();
    return 'skipped';
  }

  const sha = sha1(text);
  const existing = await state.lookup(pg, `00-inbox/${file}`);

  if (existing) {
    if ((existing.status === 'done' || existing.status === 'deadletter') && existing.sha === sha) {
      return 'skipped:already';
    }
    if (existing.status === 'processing' &&
        existing.started_at && (Date.now() - new Date(existing.started_at).getTime()) < 5 * 60 * 1000) {
      return 'skipped:processing';
    }
  }

  await state.claim(pg, `00-inbox/${file}`, sha);
  const t0 = Date.now();

  try {
    const prompt = cls.buildPrompt({ basename: file, frontmatter: fm, body });
    const stdout = await callClaude({ prompt, timeoutMs: TIMEOUT_MS });
    const result = cls.parseClaudeResponse(stdout);

    if (result.confidence < CONF_THRESHOLD) {
      const dest = path.join(DEADLETTER, file);
      await moveTo(abs, dest);
      await state.markDeadletter(pg, `00-inbox/${file}`, {
        last_error: `low_conf:${result.confidence}`,
        attempts: (existing?.attempts || 0) + 1,
      });
      metrics.processed.inc({ status: 'deadletter' });
      metrics.confidence.observe(result.confidence);
      return 'deadletter:low_conf';
    }

    cls.validateTargetFolder(result.target_folder);
    const fmNew = cls.enrichFrontmatter(fm, result, new Date().toISOString());
    const newText = lib.serializeFrontmatter(fmNew, body);
    await fs.writeFile(abs, newText, 'utf8');

    const destRel = `${result.target_folder}/${file}`;
    const destAbs = path.join(VAULT, destRel);
    const finalAbs = await moveTo(abs, destAbs);
    const finalRel = path.relative(VAULT, finalAbs);
    const finalText = await fs.readFile(finalAbs, 'utf8');

    await state.markDone(pg, `00-inbox/${file}`, {
      target_folder: result.target_folder,
      confidence: result.confidence,
    });
    await auditClassify(pg, finalRel, sha1(finalText), Buffer.byteLength(finalText, 'utf8'));
    metrics.processed.inc({ status: 'done' });
    metrics.confidence.observe(result.confidence);
    metrics.duration.observe((Date.now() - t0) / 1000);
    return `done:${result.target_folder}`;
  } catch (e) {
    const attempts = (existing?.attempts || 0) + 1;
    const last_error = `${e.code || 'error'}:${(e.message || '').slice(0, 200)}`;
    if (attempts >= MAX_ATTEMPTS) {
      try {
        const dest = path.join(DEADLETTER, file);
        await moveTo(abs, dest);
      } catch (_) {}
      await state.markDeadletter(pg, `00-inbox/${file}`, { last_error, attempts });
      metrics.processed.inc({ status: 'deadletter' });
      return `deadletter:${e.code || 'error'}`;
    }
    await state.release(pg, `00-inbox/${file}`, { last_error, attempts });
    metrics.processed.inc({ status: 'error' });
    return `retry:${e.code || 'error'}`;
  }
}

async function main() {
  await ensureDeadletter();
  const pg = new Client(PG);
  await pg.connect();

  const recovered = await state.recoverStaleProcessing(pg);
  if (recovered.length) console.log(`[classifier] recovered stale: ${recovered.length}`);

  let entries;
  try {
    entries = await fs.readdir(INBOX);
  } catch (e) {
    if (e.code === 'ENOENT') entries = [];
    else throw e;
  }

  const files = entries.filter(f => f.endsWith('.md'));
  let done = 0, deadletter = 0, skipped = 0, errors = 0;

  for (const f of files) {
    try {
      const r = await processOne(pg, f);
      if (r.startsWith('done')) done++;
      else if (r.startsWith('deadletter')) deadletter++;
      else if (r.startsWith('skipped')) skipped++;
      else errors++;
    } catch (e) {
      console.error(`[classifier] uncaught for ${f}: ${e.stack || e.message}`);
      errors++;
    }
  }

  await metrics.flush();
  await pg.end();
  console.log(`done=${done} deadletter=${deadletter} skipped=${skipped} errors=${errors}`);
}

main().catch((e) => {
  console.error(`[classifier] FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
