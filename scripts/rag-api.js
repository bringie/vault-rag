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
const { SecretsHandler, NotFound, ConflictRetriesExhausted } = require('./secrets-handler.js');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const VAULT = process.env.VAULT_PATH || '/vault';
const TOKEN = process.env.VAULT_RAG_API_TOKEN;
const PORT  = parseInt(process.env.RAG_PORT || process.env.PORT || '5679', 10);
const SKIP_PG = process.env.VAULT_SECRETS_SKIP_PG === '1';

if (!TOKEN) {
  console.error('[rag-api] FATAL: VAULT_RAG_API_TOKEN not set');
  process.exit(1);
}

const PG = {
  host:     process.env.VAULT_RAG_PG_HOST || 'vault-rag-postgres',
  database: process.env.VAULT_RAG_PG_DB   || 'vault_rag',
  user:     process.env.VAULT_RAG_PG_USER || 'postgres',
  password: process.env.VAULT_RAG_PG_PASS,
  port:     5432,
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

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error(`bad json: ${e.message}`)); }
    });
    req.on('error', reject);
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

let _secretsHandler = null;
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

async function handleSecretGet(body) {
  if (!body.name) throw new Error('name required');
  try {
    const value = await getSecretsHandler().get(body.name);
    return { value };
  } catch (e) {
    if (e instanceof NotFound) { const err = new Error(e.message); err.code = 404; throw err; }
    throw e;
  }
}

async function handleSecretList() {
  return { names: await getSecretsHandler().list() };
}

async function handleSecretSet(body) {
  if (!body.name) throw new Error('name required');
  if (body.value === undefined || body.value === null) throw new Error('value required');
  return { committed_sha: await getSecretsHandler().set(body.name, body.value) };
}

async function handleSecretDelete(body) {
  if (!body.name) throw new Error('name required');
  try {
    return { committed_sha: await getSecretsHandler().delete(body.name) };
  } catch (e) {
    if (e instanceof NotFound) { const err = new Error(e.message); err.code = 404; throw err; }
    throw e;
  }
}

async function handleSecretRotate(body) {
  if (!body.name) throw new Error('name required');
  const newValue = body.value === undefined ? null : body.value;
  return { committed_sha: await getSecretsHandler().rotate(body.name, newValue) };
}

async function handleSecretVerify() {
  return await getSecretsHandler().verify();
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
  return { path: p, text, mtime: stat.mtime.toISOString(), size: stat.size };
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

  const exists = fs.existsSync(full);
  if (mode === 'create' && exists) {
    const err = new Error('already exists');
    err.code = 409;
    throw err;
  }

  const now = new Date().toISOString();
  const existingRaw = exists ? fs.readFileSync(full, 'utf8') : '';
  const shaBefore = exists ? sha256(existingRaw) : null;
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

const server = http.createServer(async (req, res) => {
  if (req.url && req.url.startsWith('/api/')) req.url = req.url.slice(4);
  if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });
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
      send(res, 500, { error: String(e.message || e) });
    }
    return;
  }

  const handler = ROUTES[req.url];
  if (!handler) return send(res, 404, { error: 'not found' });
  try {
    const body = await readBody(req);
    const out = await handler(body);
    send(res, 200, out);
  } catch (e) {
    console.error(`[rag-api] ${req.url}: ${e.message}`);
    const code = e.code && Number.isInteger(e.code) ? e.code : 400;
    send(res, code, { error: e.message });
  }
});

(async () => {
  if (!SKIP_PG) {
    try { await pgConnect(); }
    catch (e) { console.error(`[rag-api] pg connect deferred: ${e.message}`); pg = null; }
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[rag-api] listening on :${PORT} (vault=${VAULT}, pg=${SKIP_PG ? 'skipped' : `${PG.host}/${PG.database}`}, auth=Bearer)`);
  });
})().catch(e => {
  console.error(`[rag-api] FATAL: ${e.stack || e.message}`);
  process.exit(1);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
