#!/usr/bin/env node
// rag-api: internal HTTP shim for vault-rag-mcp.
// Exposes: POST /search, /get, /backlinks, /put. Bearer auth on POST.
// Listens on 0.0.0.0:5679 inside vault-rag-net only (no host port).

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
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

let pg;

async function pgConnect() {
  pg = new Client(PG);
  pg.on('error', (e) => {
    console.error(`[rag-api] pg error: ${e.message}`);
    pg = null;
  });
  await pg.connect();
}

async function withPg(fn) {
  if (!pg) await pgConnect();
  try { return await fn(pg); }
  catch (e) {
    if (/connection|terminated/i.test(e.message)) {
      try { await pg.end(); } catch {}
      pg = null;
      await pgConnect();
      return await fn(pg);
    }
    throw e;
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
  if (tok.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < tok.length; i++) diff |= tok.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0;
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

async function handlePut(body) {
  const agent_id = body.agent_id ? String(body.agent_id).trim() : null;
  const relPath  = String(body.path || '').trim();
  const content  = String(body.content || '');
  const fmPatch  = body.frontmatter && typeof body.frontmatter === 'object' ? body.frontmatter : {};
  const mode     = body.mode || 'upsert';
  const reindex  = body.reindex !== false;

  if (!relPath.endsWith('.md')) throw new Error('path must end with .md');

  const finalRel = resolveWritePath(agent_id, relPath);
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
  if (body.expected_sha !== undefined && body.expected_sha !== null
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
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (!checkAuth(req)) return send(res, 401, { error: 'unauthorized' });
  // VT task routes (vt-rest-mcp) — dispatched separately.
  if (TASK_ROUTES[req.url]) {
    const name = TASK_ROUTES[req.url];
    const handler = vtRoutes.handlers[name];
    if (!handler) return send(res, 404, { error: `no handler: ${name}` });
    try {
      const body = await readBody(req);
      const out = await handler({ vault: VAULT, body });
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
      tokmonPg = new Client({ ...PG, database: process.env.VAULT_RAG_TOKMON_DB || 'tokmon' });
      await tokmonPg.connect();
      tokmonPg.on('error', (e) => { console.error(`[rag-api] tokmon pg error: ${e.message}`); tokmonPg = null; });
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
  if (pg) { try { await pg.end(); } catch {} pg = null; }
  if (fleetCtx?.tokmonDb) { try { await fleetCtx.tokmonDb.end(); } catch {} fleetCtx.tokmonDb = null; }
  if (fleetCtx?.db) { try { await fleetCtx.db.end(); } catch {} fleetCtx.db = null; }
}
module.exports = { server, cleanup };
