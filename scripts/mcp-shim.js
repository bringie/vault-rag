#!/usr/bin/env node
// mcp-shim: stateless MCP HTTP server exposing vault-rag tools.
// Spec: JSON-RPC 2.0 over HTTP POST /mcp. Stateless (no session management).
// Auth: X-Vault-Token header == VAULT_RAG_MCP_TOKEN env (constant-time compare).
// Tools delegate to internal rag-api (Bearer VAULT_RAG_API_TOKEN).

const http = require('http');

const PORT          = parseInt(process.env.MCP_PORT || '5680', 10);
const MCP_TOKEN   = process.env.VAULT_RAG_MCP_TOKEN;
const RAG_URL       = process.env.RAG_API_URL    || 'http://vault-rag-api:5679';
const RAG_TOKEN     = process.env.VAULT_RAG_API_TOKEN;
const SERVER_NAME   = 'vault-rag';
const SERVER_VER    = '1.0.0';
const PROTOCOL_VER  = '2024-11-05';

if (!MCP_TOKEN || !RAG_TOKEN) {
  console.error('[mcp-shim] FATAL: VAULT_RAG_MCP_TOKEN and VAULT_RAG_API_TOKEN required');
  process.exit(1);
}

const TOOLS = [
  {
    name: 'search',
    description: 'Semantic vector search across the obsidian vault. Returns top-k chunks ordered by cosine similarity. Use for finding context, prior decisions, related notes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query' },
        k:     { type: 'integer', description: 'Number of results (1-50)', default: 8 },
        tags:  { type: 'array', items: { type: 'string' }, description: 'Optional tag filter (matches if any tag present)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get',
    description: 'Read a single vault note by relative path. Returns full text, frontmatter, mtime.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Vault-relative path, e.g. "00-inbox/idea.md"' } },
      required: ['path'],
    },
  },
  {
    name: 'put',
    description: 'Create or update a vault note. Auto-frontmatter (created/updated/source). Triggers reindex unless reindex=false. Writes under agents/<agent_id>/ unless path begins with 00-inbox/ or 05-sessions/.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id:    { type: 'string', description: 'Agent identifier (a-z 0-9 -, max 64 chars)' },
        path:        { type: 'string', description: 'Vault-relative path ending in .md' },
        content:     { type: 'string', description: 'Markdown body (frontmatter optional)' },
        frontmatter: { type: 'object', description: 'Frontmatter patch merged into final note' },
        mode:        { type: 'string', enum: ['upsert', 'create', 'append'], default: 'upsert' },
        reindex:     { type: 'boolean', default: true },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'backlinks',
    description: 'List vault notes that link to a target note (Obsidian [[wiki-style]] links).',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Target note name (without [[ ]])' } },
      required: ['target'],
    },
  },
];

async function ragCall(routePath, body) {
  const r = await fetch(`${RAG_URL}${routePath}`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${RAG_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`rag-api ${r.status}: non-json: ${text.slice(0, 200)}`); }
  if (!r.ok) throw new Error(`rag-api ${r.status}: ${json.error || text.slice(0, 200)}`);
  return json;
}

const TOOL_IMPL = {
  search:    (args) => ragCall('/search',    args),
  get:       (args) => ragCall('/get',       args),
  put:       (args) => ragCall('/put',       args),
  backlinks: (args) => ragCall('/backlinks', args),
};

function tokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

async function dispatch(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VER,
      capabilities:    { tools: {} },
      serverInfo:      { name: SERVER_NAME, version: SERVER_VER },
    });
  }

  if (method === 'notifications/initialized' || method === 'initialized') {
    return null;
  }

  if (method === 'ping') return rpcResult(id, {});

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    const fn   = TOOL_IMPL[name];
    if (!fn) return rpcError(id, -32602, `unknown tool: ${name}`);
    try {
      const out = await fn(args);
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      });
    } catch (e) {
      return rpcResult(id, {
        content: [{ type: 'text', text: `error: ${e.message}` }],
        isError: true,
      });
    }
  }

  return rpcError(id, -32601, `method not found: ${method}`);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error(`bad json: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

function send(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type':   'application/json; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });

  if (req.method !== 'POST' || req.url !== '/mcp') {
    return send(res, 404, { error: 'not found' });
  }

  const tok = req.headers['x-vault-token'];
  if (!tokenEqual(typeof tok === 'string' ? tok : '', MCP_TOKEN)) {
    return send(res, 401, { error: 'unauthorized' });
  }

  let msg;
  try { msg = await readBody(req); }
  catch (e) { return send(res, 400, rpcError(null, -32700, e.message)); }

  if (!msg) return send(res, 400, rpcError(null, -32600, 'empty body'));

  if (Array.isArray(msg)) {
    const out = await Promise.all(msg.map(dispatch));
    return send(res, 200, out.filter(Boolean));
  }

  const out = await dispatch(msg);
  if (out === null) {
    res.writeHead(202).end();
    return;
  }
  send(res, 200, out);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mcp-shim] listening on :${PORT} (rag=${RAG_URL}, auth=X-Vault-Token)`);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
