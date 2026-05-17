#!/usr/bin/env node
// rag-api: internal HTTP shim for vault-rag-mcp.
// Exposes: POST /search, /get, /backlinks, /put. Bearer auth on POST.
// Listens on 0.0.0.0:5679 inside vault-rag-net only (no host port).

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const lib = require('./lib/vault-lib');
const vtRoutes = require('./lib/vt-routes');
const gitSync = require('./lib/git-sync');
const fleetRoutes = require('./lib/fleet-routes');
const fleetDb = require('./lib/fleet-db');
const { SecretsHandler, NotFound, ConflictRetriesExhausted } = require('./secrets-handler.js');
const { SecretsClient } = require('./lib/secrets-client.js');
const tokmonRoutes = require('./lib/tokmon-routes');
const { tokenEqual: sharedTokenEqual } = require('./lib/shared-auth');

const TOKMON_INGEST_TOKEN = process.env.VAULT_RAG_TOKMON_INGEST_TOKEN || null;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// vt-0137: $HOME is a tmpfs; SSH needs $HOME/.ssh to exist before it can
// write known_hosts. Create on startup so git operations don't warn.
try { fs.mkdirSync(path.join(process.env.HOME || '/root', '.ssh'), { recursive: true, mode: 0o700 }); } catch {}

const VAULT = process.env.VAULT_PATH || '/vault';
const TOKEN = process.env.VAULT_RAG_API_TOKEN;
// vt-0124: separate token for fleet's mutating/RCE-capable endpoints. If unset,
// the fleet API runs in legacy single-token mode (viewer bearer gates writes).
const FLEET_ADMIN_TOKEN = process.env.VAULT_RAG_FLEET_ADMIN_TOKEN || null;
const PORT  = parseInt(process.env.RAG_PORT || process.env.PORT || '5679', 10);
const SKIP_PG = process.env.VAULT_SECRETS_SKIP_PG === '1';

if (!TOKEN) {
  console.error('[rag-api] FATAL: VAULT_RAG_API_TOKEN not set');
  process.exit(1);
}
if (!FLEET_ADMIN_TOKEN) {
  console.warn('[rag-api] WARN: VAULT_RAG_FLEET_ADMIN_TOKEN not set — fleet writes/exec/workflow-CRUD share the viewer bearer (RCE-capable). Set this token to require separate admin credentials for mutating ops.');
} else if (FLEET_ADMIN_TOKEN === TOKEN) {
  console.warn('[rag-api] WARN: VAULT_RAG_FLEET_ADMIN_TOKEN equals VAULT_RAG_API_TOKEN — admin/viewer split is not meaningful. Rotate one of them.');
}

const PG = {
  host:     process.env.VAULT_RAG_PG_HOST || 'vault-rag-postgres',
  database: process.env.VAULT_RAG_PG_DB   || 'vault_rag',
  user:     process.env.VAULT_RAG_PG_USER || 'postgres',
  password: process.env.VAULT_RAG_PG_PASS,
  port:     parseInt(process.env.VAULT_RAG_PG_PORT || '5432', 10),
};

const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WRITABLE_PREFIXES = ['00-inbox/', '03-sessions/', '04-tasks/', '06-resources/notes/'];

// vt-0186: pg.Pool replaces shared pg.Client. Each withPg() call acquires
// a dedicated client from the pool for the duration of fn(), so BEGIN/
// COMMIT inside fn() is bound to one connection. fleet code that does
// single .query() calls reads ctx.db directly — Pool exposes .query()
// which itself acquires+releases per call, which is safe for non-tx use.
let pg;

async function pgConnect() {
  pg = new Pool({
    ...PG,
    max: parseInt(process.env.VAULT_RAG_PG_POOL_MAX || '10', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pg.on('error', (e) => {
    // Pool errors don't kill the pool — log and let in-flight handlers
    // see the error via their own catch. Idle clients are auto-recycled.
    console.error(`[rag-api] pg pool error: ${e.message}`);
  });
  // Smoke-test once at boot so we fail loudly instead of lazily on first
  // query. Caller (boot block) handles failure.
  await pg.query('SELECT 1');
}

async function withPg(fn) {
  if (!pg) await pgConnect();
  let client = await pg.connect();
  let retried = false;
  try {
    return await fn(client);
  } catch (e) {
    if (!retried && /connection|terminated/i.test(e.message)) {
      retried = true;
      try { client.release(true); } catch {}
      client = await pg.connect();
      return await fn(client);
    }
    throw e;
  } finally {
    try { client.release(); } catch {}
  }
}

// vt-0187: atomic transaction wrapper. Use for write-pairs that must
// land together (insertMetric + setLatestMetrics, upsertHost +
// setMetadata, batcher.flush + markSessionExited). Acquires a dedicated
// client, BEGIN, runs fn(client), COMMIT — or ROLLBACK on throw.
async function withTx(fn) {
  if (!pg) await pgConnect();
  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    try { client.release(); } catch {}
  }
}

// vt-0126 follow-up: same body-size cap pattern as fleet-routes readBody.
// Non-fleet endpoints (/api/put, /api/task/*, /api/secrets/*) used to accept
// unbounded bodies — a 1 GiB POST would OOM the container.
const MAX_RAG_BODY_BYTES = 4 * 1024 * 1024;  // 4 MiB: vault notes can be large
async function readBody(req, { maxBytes = MAX_RAG_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let aborted = false;
    req.on('data', c => {
      if (aborted) return;
      bytes += c.length;
      if (bytes > maxBytes) {
        aborted = true;
        const err = new Error(`body exceeds ${maxBytes} bytes`);
        err.statusCode = 413;
        return reject(err);
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error(`bad json: ${e.message}`)); }
    });
    req.on('error', (e) => { if (!aborted) reject(e); });
  });
}

function send(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

function checkAuth(req) {
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Bearer ')) return false;
  const tok = h.slice(7).trim();
  // vt-0183: use crypto.timingSafeEqual for consistency with shared-auth.js
  // and to handle multi-byte UTF-8 correctly (charCodeAt was fine for ASCII
  // tokens, but the buffer-based form is textbook + matches the rest of
  // the codebase).
  if (tok.length !== TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(tok, 'utf8'), Buffer.from(TOKEN, 'utf8'));
  } catch { return false; }
}

function safeRel(p) {
  if (!p) throw new Error('path required');
  if (p.includes('..') || p.startsWith('/') || p.includes('\\')) throw new Error('bad path');
  return p;
}

function resolveWritePath(agent_id, relPath) {
  const rel = safeRel(relPath);
  if (WRITABLE_PREFIXES.some(pre => rel.startsWith(pre))) return rel;
  if (!agent_id) throw new Error('agent_id required for non-prefix paths');
  if (!AGENT_RE.test(agent_id)) throw new Error('bad agent_id');
  return `agents/${agent_id}/${rel}`;
}

// vt-0134: prefer the standalone secrets-server when configured (production).
// Fall back to in-process SecretsHandler for dev/test/legacy deployments that
// haven't deployed the split yet.
let _secretsHandler = null;
let _secretsClient  = null;
function getSecretsClient() {
  if (_secretsClient !== null) return _secretsClient;
  const c = new SecretsClient();
  _secretsClient = c.enabled ? c : false;
  if (c.enabled) console.log(`[rag-api] secrets via standalone server: ${c.url}`);
  return _secretsClient;
}
function getSecretsHandler() {
  if (_secretsHandler) return _secretsHandler;
  _secretsHandler = new SecretsHandler({
    ageKeyPath:     process.env.VAULT_AGE_KEY_PATH,
    recipientsPath: process.env.VAULT_RECIPIENTS_PATH || '/vault/secrets/recipients',
    vaultAgePath:   process.env.VAULT_AGE_PATH || '/vault/secrets/vault.age',
    repoPath:       process.env.VAULT_REPO_PATH || '/vault',
  });
  return _secretsHandler;
}
// Returns the active secrets backend (client OR in-process handler).
function secretsBackend() {
  const client = getSecretsClient();
  return client || getSecretsHandler();
}

// vt-0142: audit every secret operation. Lives in rag-api (where the
// HTTP auth + bearer are visible) so the standalone vault-rag-secrets
// container per vt-0134 keeps its minimal capability set.
function callerFingerprint(req) {
  if (!req) return null;
  const auth = req.headers?.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}
async function auditSecret(req, op, name, outcome) {
  try {
    await withPg(c => c.query(
      `INSERT INTO secret_audit (op, name, caller_id, via, outcome) VALUES ($1,$2,$3,$4,$5)`,
      [op, name || null, callerFingerprint(req), 'http', outcome]));
  } catch (e) {
    console.error(`[secret-audit] ${op} ${name || ''}: ${e.message}`);
  }
}
function mapOutcome(e) {
  if (e instanceof NotFound || e.statusCode === 404 || e.code === 404) return 'denied';
  return 'error';
}

// vt-0146: directory listing for the Fleet UI vault tab. Filesystem walk
// (vault_files table never existed). Auth: viewer Bearer enough — readers
// only. Tag overlay from chunks table is best-effort.
async function handleNotesList(req, res) {
  if (!checkAuth(req)) return send(res, 401, { error: 'unauthorized' });
  const u = new URL(req.url, 'http://x');
  const prefix = (u.searchParams.get('prefix') || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const depth = Math.min(Math.max(parseInt(u.searchParams.get('depth') || '2', 10), 0), 5);
  if (prefix.includes('..')) return send(res, 422, { error: 'bad prefix' });
  const base = prefix ? path.join(VAULT, prefix) : VAULT;
  if (!base.startsWith(VAULT)) return send(res, 422, { error: 'bad prefix' });
  if (!fs.existsSync(base)) return send(res, 200, { entries: [] });

  const entries = [];
  function walk(dir, depthLeft, rel) {
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      if (d.name === 'node_modules') continue;
      const full = path.join(dir, d.name);
      const subRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        entries.push({ path: subRel + '/', kind: 'dir' });
        if (depthLeft > 0) walk(full, depthLeft - 1, subRel);
      } else if (d.name.endsWith('.md')) {
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        entries.push({ path: subRel, kind: 'file', size: stat.size, mtime: stat.mtimeMs });
      }
    }
  }
  walk(base, depth, prefix);

  if (entries.length && !SKIP_PG) {
    try {
      const paths = entries.filter(e => e.kind === 'file').map(e => e.path);
      if (paths.length) {
        const r = await withPg(c => c.query(
          `SELECT path, array_agg(DISTINCT t) AS tags
           FROM chunks, unnest(tags) AS t
           WHERE path = ANY($1)
           GROUP BY path`, [paths]));
        const tagsByPath = Object.fromEntries(r.rows.map(row => [row.path, row.tags]));
        for (const e of entries) if (e.kind === 'file' && tagsByPath[e.path]) e.tags = tagsByPath[e.path];
      }
    } catch (e) { console.error('[notes-list] tag overlay:', e.message); }
  }

  send(res, 200, { entries: entries.slice(0, 5000) });
}

// vt-0158: lightweight basename→path index for wiki-link resolution.
// Walks the whole vault (max 50k entries to bound cost), returns
// {byBase, byBasenameLower, all} where:
//   byBase[basename-without-ext] = rel-path-with-md
//   byBasenameLower is the same key-lowercased for case-insensitive matches
//   all is a sorted array of all .md paths
// Used by the Fleet UI vault tab to resolve [[name]] / [[folder/name]] /
// [[name|alias]] links on click without an extra round-trip per click.
async function handleNotesIndex(req, res) {
  if (!checkAuth(req)) return send(res, 401, { error: 'unauthorized' });
  const all = [];
  const byBase = {};
  const byBaseLower = {};
  // vt-0171: cap reduced to 20k. At ~200 B avg path × 3 structures + JSON
  // serialization overhead, 20k entries ≈ ~10 MiB response — already
  // generous for the UI's wiki-link resolver. Larger vaults get truncated;
  // the UI falls back to its prefix-match heuristic.
  const MAX = 20000;
  function walk(dir, rel) {
    if (all.length >= MAX) return;
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      if (all.length >= MAX) return;
      if (d.name.startsWith('.')) continue;
      if (d.name === 'node_modules') continue;
      const full = path.join(dir, d.name);
      const subRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        walk(full, subRel);
      } else if (d.name.endsWith('.md')) {
        all.push(subRel);
        const base = d.name.replace(/\.md$/, '');
        // First write wins (so a more "canonical" path higher in the tree
        // beats a duplicate buried in archive/_refactor/etc). The UI can
        // also send the full rel-path to disambiguate.
        if (!(base in byBase)) byBase[base] = subRel;
        const lc = base.toLowerCase();
        if (!(lc in byBaseLower)) byBaseLower[lc] = subRel;
      }
    }
  }
  walk(VAULT, '');
  all.sort();
  send(res, 200, { byBase, byBaseLower, all, truncated: all.length >= MAX });
}

// vt-0193: aggregated health snapshot for the Health dashboard.
// Returns per-subsystem traffic-light status without forcing the UI to
// query each endpoint separately. All checks are best-effort with short
// timeouts so a wedged subsystem doesn't hang the response.
async function handleHealthDetail(req, res) {
  const out = {
    ok: true,
    ts: new Date().toISOString(),
    subsystems: {},
  };
  // pg pool
  try {
    const r = await pg.query('SELECT 1 AS ok');
    out.subsystems.pg = { status: 'ok', detail: `pool max=${pg.options?.max ?? '?'}, total=${pg.totalCount}, idle=${pg.idleCount}` };
  } catch (e) {
    out.ok = false;
    out.subsystems.pg = { status: 'error', detail: scrubError(e.message) };
  }
  // secrets backend (lightweight probe)
  try {
    await secretsBackend().list();
    out.subsystems.secrets = { status: 'ok' };
  } catch (e) {
    out.ok = false;
    out.subsystems.secrets = { status: 'error', detail: scrubError(e.message) };
  }
  // git repo state + last commit
  try {
    const { execSync } = require('node:child_process');
    const lastCommitTs = execSync('git -C ' + VAULT + ' log -1 --format=%aI', { timeout: 2000 }).toString().trim();
    const ageMs = Date.now() - new Date(lastCommitTs).getTime();
    out.subsystems.git = {
      status: ageMs < 7 * 24 * 3600 * 1000 ? 'ok' : 'warn',
      detail: lastCommitTs,
      last_commit_age_seconds: Math.round(ageMs / 1000),
    };
  } catch (e) {
    out.subsystems.git = { status: 'error', detail: scrubError(e.message) };
  }
  // age.key backup recency (file mtime). Looks for .bak.* in same dir as
  // the active key.
  try {
    const ageKeyPath = process.env.VAULT_AGE_KEY || '/opt/vault-rag/.secrets/age.key';
    const dir = path.dirname(ageKeyPath);
    let mostRecent = null;
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('age.key.bak.')) {
          const st = fs.statSync(path.join(dir, f));
          if (!mostRecent || st.mtimeMs > mostRecent) mostRecent = st.mtimeMs;
        }
      }
    }
    if (mostRecent) {
      const ageMs = Date.now() - mostRecent;
      out.subsystems.age_key_backup = {
        status: ageMs < 30 * 24 * 3600 * 1000 ? 'ok' : 'warn',
        detail: new Date(mostRecent).toISOString(),
        age_seconds: Math.round(ageMs / 1000),
      };
    } else {
      out.subsystems.age_key_backup = { status: 'warn', detail: 'no .bak.* file found' };
    }
  } catch (e) {
    out.subsystems.age_key_backup = { status: 'error', detail: scrubError(e.message) };
  }
  // daemons online count + last_seen
  try {
    const r = await pg.query(`SELECT COUNT(*) FILTER (WHERE status='online') AS online, COUNT(*) AS total FROM fleet_hosts`);
    const { online, total } = r.rows[0];
    out.subsystems.daemons = {
      status: parseInt(online, 10) > 0 ? 'ok' : 'warn',
      detail: `${online}/${total} online`,
      online: parseInt(online, 10),
      total: parseInt(total, 10),
    };
  } catch (e) {
    out.subsystems.daemons = { status: 'error', detail: scrubError(e.message) };
  }
  send(res, 200, out);
}

// vt-0158: git log for a single vault file. Returns the last N commits
// touching that path with sha+ts+author+subject. Vault is a git repo
// (Obsidian-Git on every device + vault-sync.sh on the hub auto-commit),
// so history is meaningful — every Fleet UI save shows up too via the
// auto-commit hook.
// vt-0165: strict path validator for git-spawning endpoints. Reject
// anything outside /^[\w./-]+$/ to keep \0, leading dash, unicode, or
// shell-meta chars away from spawn argv. The existing `..` filter and
// VAULT-prefix check stay; this is an additional first-line filter.
function safeGitPath(rel) {
  if (!rel || rel.includes('..')) return null;
  if (rel.startsWith('-') || rel.startsWith('/')) return null;
  if (!/^[\w./-]+$/.test(rel)) return null;
  return rel;
}
async function handleNotesHistory(req, res) {
  if (!checkAuth(req)) return send(res, 401, { error: 'unauthorized' });
  const u = new URL(req.url, 'http://x');
  const rel = safeGitPath((u.searchParams.get('path') || '').replace(/^\/+/, ''));
  if (!rel) return send(res, 422, { error: 'bad path' });
  const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '50', 10), 1), 500);
  const full = path.join(VAULT, rel);
  if (!full.startsWith(VAULT + path.sep) && full !== VAULT) {
    return send(res, 422, { error: 'bad path' });
  }
  const { spawn } = require('node:child_process');
  // Format: sha<TAB>iso-ts<TAB>author<TAB>subject — unit-separator-free,
  // \x1f as record separator so subjects containing tabs/newlines don't
  // corrupt parsing.
  const args = [
    '-C', VAULT, 'log',
    `--max-count=${limit}`,
    `--pretty=format:%H%x09%aI%x09%an%x09%s%x1e`,
    '--', rel,
  ];
  const p = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (c) => { out += c.toString('utf8'); });
  p.stderr.on('data', (c) => { err += c.toString('utf8'); });
  p.on('close', (code) => {
    if (code !== 0) {
      return send(res, 500, { error: 'git log failed', detail: err.slice(0, 200) });
    }
    const commits = out.split('\x1e').map(s => s.trim()).filter(Boolean).map(line => {
      const [sha, ts, author, ...subjectParts] = line.split('\t');
      return { sha, ts, author, subject: subjectParts.join('\t') };
    });
    send(res, 200, { path: rel, commits });
  });
}

// vt-0158: blob at a specific commit. Lets the UI diff "what was the
// file at sha X" without checking out anything. Plain text only; binary
// blobs return 422.
async function handleNotesShow(req, res) {
  if (!checkAuth(req)) return send(res, 401, { error: 'unauthorized' });
  const u = new URL(req.url, 'http://x');
  const rel = safeGitPath((u.searchParams.get('path') || '').replace(/^\/+/, ''));
  const sha = u.searchParams.get('sha') || '';
  if (!rel) return send(res, 422, { error: 'bad path' });
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) return send(res, 422, { error: 'bad sha' });
  const { spawn } = require('node:child_process');
  // vt-0172: cap stdout at 16 MiB. A vault note larger than that won't
  // render meaningfully in the UI anyway, and unbounded growth here is
  // a memory-exhaustion vector for any viewer-authenticated caller.
  const MAX_BYTES = 16 * 1024 * 1024;
  const p = spawn('git', ['-C', VAULT, 'show', `${sha}:${rel}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; let err = ''; let total = 0; let killed = false;
  p.stdout.on('data', (c) => {
    total += c.length;
    if (total > MAX_BYTES) {
      killed = true;
      try { p.kill('SIGKILL'); } catch {}
      return;
    }
    chunks.push(c);
  });
  p.stderr.on('data', (c) => { err += c.toString('utf8'); });
  p.on('close', (code) => {
    if (killed) return send(res, 413, { error: 'blob too large (>16 MiB)' });
    if (code !== 0) {
      return send(res, 404, { error: 'not found at sha', detail: err.slice(0, 200) });
    }
    const buf = Buffer.concat(chunks);
    // Quick binary sniff: any null byte in first 1KB → reject.
    const head = buf.slice(0, 1024);
    if (head.includes(0)) return send(res, 422, { error: 'binary blob' });
    send(res, 200, { path: rel, sha, text: buf.toString('utf8') });
  });
}

// vt-0159: unified diff for a vault file. Two modes:
//   ?path=X&sha=Y           → `git show --no-color Y -- X` (this commit vs parent)
//   ?path=X&from=A&to=B     → `git diff --no-color A B -- X` (arbitrary range)
//                             B may be the literal "HEAD" or "WORK" (working tree)
// Auth: viewer Bearer. Read-only.
async function handleNotesDiff(req, res) {
  if (!checkAuth(req)) return send(res, 401, { error: 'unauthorized' });
  const u = new URL(req.url, 'http://x');
  const rel = safeGitPath((u.searchParams.get('path') || '').replace(/^\/+/, ''));
  if (!rel) return send(res, 422, { error: 'bad path' });
  const sha = u.searchParams.get('sha') || '';
  const from = u.searchParams.get('from') || '';
  const to = u.searchParams.get('to') || '';
  // sha-or-ref pattern: hex sha, or HEAD, or WORK (alias for working tree).
  const refRe = /^([0-9a-f]{4,64}|HEAD|WORK)$/i;
  let args;
  if (sha) {
    if (!refRe.test(sha)) return send(res, 422, { error: 'bad sha' });
    args = ['-C', VAULT, 'show', '--no-color', '--unified=3', sha, '--', rel];
  } else if (from && to) {
    if (!refRe.test(from) || !refRe.test(to)) return send(res, 422, { error: 'bad ref' });
    if (to.toUpperCase() === 'WORK') {
      // working tree side — `git diff <from> -- path` does this implicitly
      args = ['-C', VAULT, 'diff', '--no-color', '--unified=3', from, '--', rel];
    } else {
      args = ['-C', VAULT, 'diff', '--no-color', '--unified=3', from, to, '--', rel];
    }
  } else {
    return send(res, 422, { error: 'sha OR (from+to) required' });
  }
  const { spawn } = require('node:child_process');
  const p = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; let err = '';
  p.stdout.on('data', (c) => chunks.push(c));
  p.stderr.on('data', (c) => { err += c.toString('utf8'); });
  p.on('close', (code) => {
    if (code !== 0 && code !== 1) {
      // git diff exits 1 when there ARE differences — that's not an error.
      // Only treat other non-zero as failure.
      return send(res, 500, { error: 'git failed', detail: err.slice(0, 200) });
    }
    send(res, 200, { path: rel, diff: Buffer.concat(chunks).toString('utf8') });
  });
}

// vt-0140: ingest path moved from the standalone tokmon-ingest container.
// Auth is the separate VAULT_RAG_TOKMON_INGEST_TOKEN — shippers don't hold
// the viewer or admin bearer.
async function handleTokmonIngest(req, res) {
  const auth = req.headers['x-tokmon-token']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!TOKMON_INGEST_TOKEN || !sharedTokenEqual(auth, TOKMON_INGEST_TOKEN)) {
    return send(res, 401, { error: 'unauthorized' });
  }
  if (!fleetCtx.tokmonDb) {
    return send(res, 503, { error: 'tokmon db not configured' });
  }
  const body = await readBody(req);
  if (!body || !Array.isArray(body.events)) {
    return send(res, 422, { error: 'events[] required' });
  }
  if (body.events.length > 5000) {
    return send(res, 413, { error: 'batch too large (max 5000)' });
  }
  const filtered = body.events.filter(e => tokmonRoutes.isPlausibleTs(e.ts));
  const dropped = body.events.length - filtered.length;
  const result = await tokmonRoutes.ingestBulk(fleetCtx.tokmonDb, filtered);
  if (dropped) result.dropped_implausible_ts = dropped;
  send(res, 200, { ok: true, ...result });
}

async function handleSecretGet(body, req) {
  if (!body.name) throw new Error('name required');
  try {
    const value = await secretsBackend().get(body.name);
    await auditSecret(req, 'get', body.name, 'ok');
    return { value };
  } catch (e) {
    await auditSecret(req, 'get', body.name, mapOutcome(e));
    if (e instanceof NotFound || e.statusCode === 404) { const err = new Error(e.message); err.code = 404; throw err; }
    throw e;
  }
}

async function handleSecretList(_body, req) {
  try {
    const names = await secretsBackend().list();
    await auditSecret(req, 'list', null, 'ok');
    return { names };
  } catch (e) {
    await auditSecret(req, 'list', null, mapOutcome(e));
    throw e;
  }
}

async function handleSecretSet(body, req) {
  if (!body.name) throw new Error('name required');
  if (body.value === undefined || body.value === null) throw new Error('value required');
  try {
    const committed_sha = await secretsBackend().set(body.name, body.value);
    await auditSecret(req, 'set', body.name, 'ok');
    return { committed_sha };
  } catch (e) {
    await auditSecret(req, 'set', body.name, mapOutcome(e));
    throw e;
  }
}

async function handleSecretDelete(body, req) {
  if (!body.name) throw new Error('name required');
  try {
    const committed_sha = await secretsBackend().delete(body.name);
    await auditSecret(req, 'delete', body.name, 'ok');
    return { committed_sha };
  } catch (e) {
    await auditSecret(req, 'delete', body.name, mapOutcome(e));
    if (e instanceof NotFound || e.statusCode === 404) { const err = new Error(e.message); err.code = 404; throw err; }
    throw e;
  }
}

async function handleSecretRotate(body, req) {
  if (!body.name) throw new Error('name required');
  const newValue = body.value === undefined ? null : body.value;
  try {
    const committed_sha = await secretsBackend().rotate(body.name, newValue);
    await auditSecret(req, 'rotate', body.name, 'ok');
    return { committed_sha };
  } catch (e) {
    await auditSecret(req, 'rotate', body.name, mapOutcome(e));
    throw e;
  }
}

async function handleSecretVerify(_body, req) {
  try {
    const out = await secretsBackend().verify();
    await auditSecret(req, 'verify', null, 'ok');
    return out;
  } catch (e) {
    await auditSecret(req, 'verify', null, mapOutcome(e));
    throw e;
  }
}

async function handleSearch(body) {
  const query = String(body.query || '').trim();
  if (!query) throw new Error('query required');
  const k = Math.min(Math.max(parseInt(body.k, 10) || 8, 1), 50);
  const tags = Array.isArray(body.tags) ? body.tags : null;

  const [emb] = await lib.embed([query], 'query');
  const params = [lib.vec(emb)];
  let where = '';
  if (tags && tags.length) { where = 'WHERE tags && $2'; params.push(tags); }
  params.push(k);
  const sql = `
    SELECT path, idx, text, fm, tags, 1 - (emb <=> $1::vector) AS score
    FROM chunks
    ${where}
    ORDER BY emb <=> $1::vector
    LIMIT $${params.length}
  `;
  const r = await withPg(c => c.query(sql, params));
  return { results: r.rows };
}

async function handleGet(body) {
  const p = safeRel(String(body.path || '').trim());
  const full = path.join(VAULT, p);
  if (!full.startsWith(VAULT + path.sep) && full !== VAULT) throw new Error('bad path');
  if (!fs.existsSync(full)) throw new Error('not found');
  // vt-0183: realpath check — match handlePut. A pre-existing symlink
  // could otherwise let a GET leak content from outside the vault root.
  const realFull = fs.realpathSync(full);
  if (!realFull.startsWith(VAULT + path.sep) && realFull !== VAULT) {
    throw new Error('bad path (symlink escape)');
  }
  const text = fs.readFileSync(full, 'utf8');
  const stat = fs.statSync(full);
  // vt-0141: round-trip sha so callers (Fleet UI editor) can send it back
  // as expected_sha on PUT for optimistic concurrency.
  return { path: p, text, mtime: stat.mtime.toISOString(), size: stat.size, sha: sha256(text) };
}

async function handleBacklinks(body) {
  const target = String(body.target || '').trim();
  if (!target) throw new Error('target required');
  const r = await withPg(c => c.query(
    'SELECT source FROM backlinks WHERE target=$1 ORDER BY source',
    [target]
  ));
  return { target, sources: r.rows.map(x => x.source) };
}

// vt-0153: per-path in-process mutex serialises the expected_sha check +
// the writeFileSync that follows it. Without this, two PUTs targeting the
// same file can both pass the SHA gate before either writes, producing a
// last-writer-wins (the second writer is the "winner" but its merge was
// computed against stale shaBefore). The lock is in-memory only — it does
// NOT protect against external writers (Obsidian-Git auto-sync); that
// race is bounded by vault-sync.sh's debounce window and accepted.
const _pathLocks = new Map();
async function withPathLock(key, fn) {
  const prev = _pathLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  const chain = prev.then(() => next);
  _pathLocks.set(key, chain);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Only clear if no one else queued behind us (chain still on top).
    if (_pathLocks.get(key) === chain) _pathLocks.delete(key);
  }
}

async function handlePut(body, req) {
  // vt-0173: normalize lock key for case-insensitive filesystems (macOS
  // dev/CI). Without this, "Foo.md" and "foo.md" get separate locks but
  // hit the same file → race resurrected.
  const lockKey = String(body.path || '').toLowerCase();
  return await withPathLock(lockKey, () => handlePutLocked(body, req));
}
async function handlePutLocked(body, req) {
  const agent_id = body.agent_id ? String(body.agent_id).trim() : null;
  const relPath  = String(body.path || '').trim();
  const content  = String(body.content || '');
  const fmPatch  = body.frontmatter && typeof body.frontmatter === 'object' ? body.frontmatter : {};
  const mode     = body.mode || 'upsert';
  const reindex  = body.reindex !== false;

  if (!relPath.endsWith('.md')) throw new Error('path must end with .md');

  // vt-0161: admin bearer bypasses WRITABLE_PREFIXES — the prefix list was
  // a safety rail for unsupervised agents, but a human admin in the Fleet
  // UI should be able to edit any vault file.
  // vt-0162: CRITICAL fix — checkAdminAuth fallbacks to viewer when
  // FLEET_ADMIN_TOKEN is unset (see fleet-routes.js:77-78), which would
  // mean every viewer-authed PUT bypasses the prefix gate. Require admin
  // token to be EXPLICITLY configured before honoring isAdmin.
  const isAdmin = req && FLEET_ADMIN_TOKEN && fleetRoutes.checkAdminAuth(req, fleetCtx);
  // vt-0162: even admin must NOT write directly to secrets/ via /put — that
  // path is for encrypted blobs managed by the secrets handler (which writes
  // through a separate code path) or recipients (managed via secret_set).
  // A misclick that overwrites secrets/vault.age would destroy the entire
  // encrypted store.
  const isProtectedPath = relPath.startsWith('secrets/');
  if (isProtectedPath) {
    const err = new Error('secrets/ is managed via /api/secrets/* — direct /put refused');
    err.code = 403; throw err;
  }
  const finalRel = isAdmin ? safeRel(relPath) : resolveWritePath(agent_id, relPath);
  const full = path.join(VAULT, finalRel);
  if (!full.startsWith(VAULT + path.sep)) throw new Error('bad path');
  // I8 (audit pass 2): a pre-existing symlink anywhere in the chain (planted
  // by the indexer, a misbehaving agent, or a foreign process) would let a
  // PUT escape the vault root. Resolve the actual on-disk path of the parent
  // dir and verify it's still under VAULT before opening.
  if (fs.existsSync(full)) {
    const realFull = fs.realpathSync(full);
    if (!realFull.startsWith(VAULT + path.sep)) throw new Error('bad path (symlink escape)');
  } else {
    let parent = path.dirname(full);
    while (parent && parent.startsWith(VAULT)) {
      if (fs.existsSync(parent)) {
        const realParent = fs.realpathSync(parent);
        if (!realParent.startsWith(VAULT + path.sep) && realParent !== VAULT) {
          throw new Error('bad path (symlink escape)');
        }
        break;
      }
      parent = path.dirname(parent);
    }
  }

  const exists = fs.existsSync(full);
  if (mode === 'create' && exists) {
    const err = new Error('already exists');
    err.code = 409;
    throw err;
  }

  const now = new Date().toISOString();
  const existingRaw = exists ? fs.readFileSync(full, 'utf8') : '';
  const shaBefore = exists ? sha256(existingRaw) : null;
  // vt-0141: optimistic concurrency. If the caller passes expected_sha, the
  // current on-disk SHA must match — otherwise this is a mid-air collision
  // (Obsidian-Git push + Fleet UI editor both writing the same note). 412 lets
  // the UI show a "reload from server / force overwrite" conflict modal.
  // expected_sha is meaningless on the create path (mode === 'create' already
  // 409s on exists), and null/undefined means "no concurrency check" so old
  // callers keep working.
  // vt-0154: treat empty-string expected_sha as "no check" (same as undefined/
  // null). A client that wires up a form binding may send '' instead of
  // omitting the field; rejecting every PUT in that case was a footgun.
  if (body.expected_sha !== undefined && body.expected_sha !== null && body.expected_sha !== ''
      && exists && mode !== 'create' && body.expected_sha !== shaBefore) {
    const err = new Error(`stale write: expected_sha=${body.expected_sha} but current=${shaBefore}`);
    err.code = 412;
    throw err;
  }
  const { fm: existingFm, body: existingBody } = exists
    ? lib.parseFrontmatter(existingRaw)
    : { fm: {}, body: '' };

  const { fm: incomingFm, body: incomingBody } = lib.parseFrontmatter(content);

  const autoFm = {
    ...(exists ? {} : { created: now, source: 'rag-api', ...(agent_id ? { agent_id } : {}) }),
    updated: now,
  };

  const finalBody = mode === 'append' && exists
    ? (existingBody.trimEnd() + '\n\n' + incomingBody.trimStart())
    : incomingBody;

  const finalFm = lib.mergeFrontmatter(
    lib.mergeFrontmatter(existingFm, incomingFm),
    lib.mergeFrontmatter(fmPatch, autoFm)
  );

  fs.mkdirSync(path.dirname(full), { recursive: true });
  const out = lib.serializeFrontmatter(finalFm, finalBody);
  fs.writeFileSync(full, out, 'utf8');
  const bytes = Buffer.byteLength(out, 'utf8');
  const shaAfter = sha256(out);
  const op = exists ? mode : 'create';

  let chunks = 0, links = 0;
  if (reindex) {
    const r = await withPg(c => lib.upsertFile(c, finalRel, finalBody, finalFm));
    chunks = r.chunks; links = r.links;
  }

  try {
    await withPg(c => c.query(
      `INSERT INTO vault_audit (agent_id, path, op, sha_before, sha_after, bytes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [agent_id, finalRel, op, shaBefore, shaAfter, bytes]
    ));
  } catch (e) {
    console.error(`[rag-api] audit insert failed: ${e.message}`);
  }

  gitSync.trigger(VAULT);

  return {
    path: finalRel,
    bytes,
    status: exists ? 'updated' : 'created',
    chunks,
    links,
  };
}

const ROUTES = {
  '/search':          handleSearch,
  '/get':             handleGet,
  '/backlinks':       handleBacklinks,
  '/put':             handlePut,
  '/secrets/get':     handleSecretGet,
  '/secrets/list':    handleSecretList,
  '/secrets/set':     handleSecretSet,
  '/secrets/delete':  handleSecretDelete,
  '/secrets/rotate':  handleSecretRotate,
  '/secrets/verify':  handleSecretVerify,
};

const TASK_ROUTES = {
  '/task/create':  'create',
  '/task/list':    'list',
  '/task/ready':   'ready',
  '/task/show':    'show',
  '/task/claim':   'claim',
  '/task/close':   'close',
  '/task/update':  'update',
  '/task/dep_add': 'dep_add',
  '/task/dep_rm':  'dep_rm',
};

const fleetCtx = fleetRoutes.makeContext({ token: TOKEN, adminToken: FLEET_ADMIN_TOKEN, db: null, version: '0.1.0' });

const server = http.createServer(async (req, res) => {
  if (req.url && req.url.startsWith('/api/')) req.url = req.url.slice(4);
  if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });
  // vt-0193: detailed health endpoint for the Health dashboard UI.
  // Reports per-subsystem status without requiring secret-store reveals;
  // viewer bearer suffices.
  if (req.method === 'GET' && req.url.startsWith('/healthz/detail')) {
    if (!checkAuth(req) && !(FLEET_ADMIN_TOKEN && fleetRoutes.checkAdminAuth(req, fleetCtx))) {
      return send(res, 401, { error: 'unauthorized' });
    }
    return handleHealthDetail(req, res).catch(e => {
      console.error('[rag-api] /healthz/detail', e.stack || e.message);
      send(res, 500, { error: scrubError(e.message) });
    });
  }
  // fleet routes (HTTP) — own dispatch handles auth + methods
  if (fleetRoutes.tryDispatch(req, res, fleetCtx)) return;
  // vt-0140: tokmon shipper ingest — uses its OWN token (X-Tokmon-Token header
  // or Bearer fallback), separate from the API/admin bearer. Lives before the
  // generic POST-only filter so shippers can hit it without holding the
  // viewer/admin bearer.
  if (req.method === 'POST' && req.url === '/tokmon/ingest'
      && process.env.VAULT_RAG_TOKMON_INGEST_ENABLED !== '0') {
    return handleTokmonIngest(req, res).catch(e => {
      console.error('[rag-api] /tokmon/ingest', e.stack || e.message);
      send(res, e.statusCode || 500, { error: scrubError(e.message) });
    });
  }
  // vt-0146: GET /api/notes/list — directory listing for the Fleet UI vault
  // tab. Filesystem walk under VAULT (no DB dependency on vault_files which
  // doesn't exist). Optional tag overlay from chunks.
  if (req.method === 'GET' && req.url.startsWith('/notes/list')) {
    return handleNotesList(req, res).catch(e => {
      console.error('[rag-api] /notes/list', e.stack || e.message);
      send(res, e.statusCode || 500, { error: scrubError(e.message) });
    });
  }
  // vt-0158: basename→path index for wiki-link resolution.
  if (req.method === 'GET' && req.url.startsWith('/notes/index')) {
    return handleNotesIndex(req, res).catch(e => {
      console.error('[rag-api] /notes/index', e.stack || e.message);
      send(res, e.statusCode || 500, { error: scrubError(e.message) });
    });
  }
  // vt-0158: per-file git history.
  if (req.method === 'GET' && req.url.startsWith('/notes/history')) {
    return handleNotesHistory(req, res).catch(e => {
      console.error('[rag-api] /notes/history', e.stack || e.message);
      send(res, e.statusCode || 500, { error: scrubError(e.message) });
    });
  }
  // vt-0158: blob at sha for diffing previous revisions.
  if (req.method === 'GET' && req.url.startsWith('/notes/show')) {
    return handleNotesShow(req, res).catch(e => {
      console.error('[rag-api] /notes/show', e.stack || e.message);
      send(res, e.statusCode || 500, { error: scrubError(e.message) });
    });
  }
  // vt-0159: unified diff (patch for one commit, or arbitrary range).
  if (req.method === 'GET' && req.url.startsWith('/notes/diff')) {
    return handleNotesDiff(req, res).catch(e => {
      console.error('[rag-api] /notes/diff', e.stack || e.message);
      send(res, e.statusCode || 500, { error: scrubError(e.message) });
    });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  // vt-0163: accept EITHER viewer bearer OR admin bearer at the outer gate.
  // Pre-fix, when VAULT_RAG_FLEET_ADMIN_TOKEN was set, this check rejected
  // admin tokens outright — making the vt-0161 "admin can edit any vault
  // file" feature dead in the configuration it was designed for. Mirrors
  // fleet-routes.js:1361.
  if (!checkAuth(req) && !(FLEET_ADMIN_TOKEN && fleetRoutes.checkAdminAuth(req, fleetCtx))) {
    return send(res, 401, { error: 'unauthorized' });
  }
  // VT task routes (vt-rest-mcp) — dispatched separately.
  if (TASK_ROUTES[req.url]) {
    const name = TASK_ROUTES[req.url];
    const handler = vtRoutes.handlers[name];
    if (!handler) return send(res, 404, { error: `no handler: ${name}` });
    try {
      const body = await readBody(req);
      // vt-0166: serialize task mutations through withPathLock so a
      // concurrent /api/put on the same task file (vt-NNNN-slug.md) can't
      // race with task_create/update/close. Key by body.id when present
      // (specific task) else by route (covers list/ready scans).
      const lockKey = body && body.id
        ? `04-tasks/${String(body.id).toLowerCase()}`
        : `__task_route__:${name}`;
      const out = await withPathLock(lockKey, () => handler({ vault: VAULT, body }));
      send(res, out.status, out.body);
    } catch (e) {
      console.error(`[rag-api] ${req.url}: ${e.stack || e.message}`);
      send(res, e.statusCode || 500, { error: scrubError(e.message || String(e)) });
    }
    return;
  }

  const handler = ROUTES[req.url];
  if (!handler) return send(res, 404, { error: 'not found' });
  try {
    const body = await readBody(req);
    // vt-0142: handlers may opt into receiving the raw req (for caller-id
    // fingerprint + via attribution in the audit log). Signature is
    // (body, req) so legacy 1-arg handlers stay working.
    const out = await handler(body, req);
    send(res, 200, out);
  } catch (e) {
    console.error(`[rag-api] ${req.url}: ${e.message}`);
    const code = e.statusCode || (e.code && Number.isInteger(e.code) ? e.code : 400);
    send(res, code, { error: scrubError(e.message) });
  }
});

// I10 (audit pass 2): strip pg connection details ("host=...", "port=...",
// "user=...") and absolute file paths from error messages before they reach
// the wire. Server-side logs keep the full message via console.error.
function scrubError(msg) {
  if (!msg) return 'internal error';
  return String(msg)
    .replace(/\bhost\s*=\s*\S+/gi, 'host=<redacted>')
    .replace(/\bport\s*=\s*\d+/gi, 'port=<redacted>')
    .replace(/\buser\s*=\s*\S+/gi, 'user=<redacted>')
    .replace(/(connection terminated|ECONNREFUSED|ETIMEDOUT)[\s\S]{0,200}/gi, '$1')
    .slice(0, 500);
}

// WS upgrade for fleet
fleetRoutes.attachUpgrade(server, () => fleetCtx);

(async () => {
  if (!SKIP_PG) {
    try { await pgConnect(); }
    catch (e) { console.error(`[rag-api] pg connect deferred: ${e.message}`); pg = null; }
  }
  // Connect to tokmon DB for cost queries (best-effort; cost endpoints return 503 if missing)
  let tokmonPg = null;
  if (!SKIP_PG) {
    try {
      tokmonPg = new Pool({
        ...PG, database: process.env.VAULT_RAG_TOKMON_DB || 'tokmon',
        max: parseInt(process.env.VAULT_RAG_TOKMON_POOL_MAX || '4', 10),
        idleTimeoutMillis: 30_000,
      });
      await tokmonPg.query('SELECT 1');
      tokmonPg.on('error', (e) => { console.error(`[rag-api] tokmon pg pool error: ${e.message}`); });
      fleetCtx.tokmonDb = tokmonPg;
      console.log(`[rag-api] tokmon db connected for fleet cost ingest`);
    } catch (e) {
      console.error(`[rag-api] tokmon connect failed (cost endpoints will 503): ${e.message}`);
    }
  }
  // Hand pg client to fleet, run orphan flip + schedule retention.
  if (pg) {
    fleetCtx.db = pg;
    try {
      const n = await fleetDb.orphanRunningSessions(pg);
      if (n) console.log(`[rag-api] fleet: orphaned ${n} sessions on startup`);
    } catch (e) {
      console.error(`[rag-api] fleet orphan check failed: ${e.message}`);
    }
    // Retention runs only after pg is bound. If pg failed to connect at boot,
    // retention never starts — rag-api must restart once pg is reachable.
    try {
      const { startRetention } = require('./lib/fleet-retention');
      startRetention(pg);
      console.log('[rag-api] fleet metrics retention started');
    } catch (e) {
      console.error(`[rag-api] retention start failed: ${e.message}`);
    }
    const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const PURGE_AGE = process.env.VAULT_RAG_FLEET_RETENTION || '30 days';
    setInterval(async () => {
      try {
        // Drain in chunks of 10k to avoid one massive AccessExclusiveLock.
        let total = 0, limited = true, passes = 0;
        while (limited && passes < 100) {
          const r = await fleetDb.purgeOldEvents(pg, PURGE_AGE);
          total += r.deleted;
          limited = r.limited;
          passes += 1;
        }
        if (total) console.log(`[rag-api] fleet: purged ${total} events older than ${PURGE_AGE} (${passes} passes)`);
      } catch (e) {
        console.error(`[rag-api] fleet purge failed: ${e.message}`);
      }
    }, PURGE_INTERVAL_MS).unref?.();

    // vt-0110: workflow trigger scheduler. Scans fleet_workflows where
    // trigger is set; if `now - last_run_at >= every_ms`, kicks a new run.
    // Coarse 60s tick. every_ms minimum 60_000 (enforced at API layer).
    const wfDb = require('./lib/fleet-workflow-db');
    setInterval(async () => {
      try {
        const triggered = await wfDb.listTriggeredWorkflows(pg);
        if (!triggered.length) return;
        const now = Date.now();
        for (const w of triggered) {
          if (!w.trigger || typeof w.trigger.every_ms !== 'number') continue;
          const last = w.last_run_at ? new Date(w.last_run_at).getTime() : 0;
          if (now - last < w.trigger.every_ms) continue;
          // Fire: create run + start the runner (same path as POST /workflows/:id/run).
          try {
            const run = await wfDb.createRun(pg, { workflowId: w.id, snapshot: w.definition });
            const runner = await fleetRoutes.ensureWorkflowRunner(fleetCtx);
            if (runner) runner.start(run.id);
            console.log(`[rag-api] trigger fired: workflow=${w.name} run=${run.id}`);
          } catch (e) {
            console.error(`[rag-api] trigger fire failed for ${w.name}: ${e.message}`);
          }
        }
      } catch (e) {
        console.error(`[rag-api] workflow trigger scan failed: ${e.message}`);
      }
    }, 60 * 1000).unref?.();

    // vt-0114: daily cost rollup. Run BEFORE the tokmon retention purge
    // (so we don't lose rows we never aggregated). Tick every 6h —
    // covers UTC midnight in any operator timezone without leaning on
    // exact cron.
    const fleetCost = require('./lib/fleet-cost');
    setInterval(async () => {
      if (!fleetCtx.tokmonDb) return;
      try {
        // Aggregate yesterday + today — yesterday so it's complete, today
        // for partial-day visibility (rows get overwritten on next tick).
        for (const offset of [1, 0]) {
          const d = new Date(Date.now() - offset * 86400000);
          const dayStr = d.toISOString().slice(0, 10);
          const r = await fleetCost.aggregateDayRollup(fleetCtx.tokmonDb, pg, dayStr);
          if (r.rows) console.log(`[rag-api] cost rollup ${dayStr}: ${r.rows} rows`);
        }
      } catch (e) {
        console.error(`[rag-api] cost rollup failed: ${e.message}`);
      }
    }, 6 * 60 * 60 * 1000).unref?.();
    // Run once at startup so a fresh deploy seeds yesterday's data without
    // waiting 6h for the first tick.
    setTimeout(async () => {
      if (!fleetCtx.tokmonDb) return;
      try {
        const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const r = await fleetCost.aggregateDayRollup(fleetCtx.tokmonDb, pg, yest);
        if (r.rows) console.log(`[rag-api] cost rollup ${yest}: ${r.rows} rows (startup)`);
      } catch (e) {
        console.error(`[rag-api] cost rollup (startup) failed: ${e.message}`);
      }
    }, 15_000).unref?.();

    // vt-0120: tokmon.events retention. Cost-event rows otherwise grow
    // forever; we keep N days of fine-grained data + the daily cost view
    // (computed on read, not pre-aggregated for now — see vt-0114 for the
    // rollup follow-up). Default 90 days; override via env.
    const TOKMON_RETAIN_DAYS = parseInt(process.env.VAULT_RAG_TOKMON_RETAIN_DAYS || '90', 10);
    setInterval(async () => {
      if (!fleetCtx.tokmonDb) return;
      try {
        let total = 0, limited = true, passes = 0;
        while (limited && passes < 20) {
          const { rowCount } = await fleetCtx.tokmonDb.query(
            `DELETE FROM events WHERE id IN (
               SELECT id FROM events
               WHERE ts < now() - ($1 || ' days')::interval
               LIMIT 50000
             )`, [String(TOKMON_RETAIN_DAYS)]);
          total += rowCount;
          limited = rowCount >= 50000;
          passes += 1;
        }
        if (total) console.log(`[rag-api] tokmon: purged ${total} events older than ${TOKMON_RETAIN_DAYS} days (${passes} passes)`);
      } catch (e) {
        console.error(`[rag-api] tokmon purge failed: ${e.message}`);
      }
    }, 24 * 60 * 60 * 1000).unref?.();
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[rag-api] listening on :${PORT} (vault=${VAULT}, pg=${SKIP_PG ? 'skipped' : `${PG.host}/${PG.database}`}, auth=Bearer)`);
  });
})().catch(e => {
  console.error(`[rag-api] FATAL: ${e.stack || e.message}`);
  process.exit(1);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });

// vt-0141 prereq: export `server` so tests can read .address().port and call
// .close(). Requires PORT=0 + VAULT_SECRETS_SKIP_PG=1 + test-pg env to be
// set BEFORE require. cleanup() ends the lazy pg + tokmon clients so the
// node:test event loop can exit. See scripts/lib/rag-api-test-helpers.js.
async function cleanup() {
  // vt-0186: fleetCtx.db is the SAME Pool object as `pg`; end() it once.
  if (fleetCtx?.tokmonDb) { try { await fleetCtx.tokmonDb.end(); } catch {} fleetCtx.tokmonDb = null; }
  if (fleetCtx) fleetCtx.db = null;
  if (pg) { try { await pg.end(); } catch {} pg = null; }
}
module.exports = { server, cleanup };
