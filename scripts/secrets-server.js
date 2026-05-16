#!/usr/bin/env node
'use strict';
// vt-0134: minimal HTTP wrapper around SecretsHandler. Runs in its own
// container with NOTHING but age.key + /root/.ssh + /vault mounted — no
// workflow vm, no fleet routes, no RCE-capable surface. rag-api proxies
// /api/secrets/* here over the internal docker network.
//
// Auth: shared bearer token (VAULT_RAG_SECRETS_TOKEN) known only to rag-api
// (compose env injection). The endpoint is bound to the internal network;
// not exposed to host or via Caddy.

const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');
const { SecretsHandler, NotFound, ConflictRetriesExhausted } = require('./secrets-handler.js');

// vt-0137: $HOME is a tmpfs; pre-create $HOME/.ssh so ssh can write known_hosts.
try { fs.mkdirSync(path.join(process.env.HOME || '/root', '.ssh'), { recursive: true, mode: 0o700 }); } catch {}

const TOKEN = process.env.VAULT_RAG_SECRETS_TOKEN;
const PORT  = parseInt(process.env.PORT || '5682', 10);

if (!TOKEN) {
  console.error('[secrets-server] FATAL: VAULT_RAG_SECRETS_TOKEN not set');
  process.exit(1);
}

const handler = new SecretsHandler({
  ageKeyPath:     process.env.VAULT_AGE_KEY_PATH || '/run/secrets/age.key',
  recipientsPath: process.env.VAULT_RECIPIENTS_PATH || '/vault/secrets/recipients',
  vaultAgePath:   process.env.VAULT_AGE_PATH || '/vault/secrets/vault.age',
  repoPath:       process.env.VAULT_REPO_PATH || '/vault',
});

function tokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const MAX_BODY = 256 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let bytes = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      bytes += c.length;
      if (bytes > MAX_BODY) {
        aborted = true;
        const err = new Error('body too large');
        err.statusCode = 413;
        return reject(err);
      }
      buf += c;
    });
    req.on('end', () => {
      if (aborted) return;
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); }
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

const ROUTES = {
  '/secrets/get': async (b) => {
    if (!b.name) { const e = new Error('name required'); e.statusCode = 422; throw e; }
    const value = await handler.get(b.name);
    return { value };
  },
  '/secrets/list': async () => ({ names: await handler.list() }),
  '/secrets/set': async (b) => {
    if (!b.name) { const e = new Error('name required'); e.statusCode = 422; throw e; }
    if (b.value === undefined || b.value === null) { const e = new Error('value required'); e.statusCode = 422; throw e; }
    return { committed_sha: await handler.set(b.name, b.value) };
  },
  '/secrets/delete': async (b) => {
    if (!b.name) { const e = new Error('name required'); e.statusCode = 422; throw e; }
    return { committed_sha: await handler.delete(b.name) };
  },
  '/secrets/rotate': async (b) => {
    if (!b.name) { const e = new Error('name required'); e.statusCode = 422; throw e; }
    return { committed_sha: await handler.rotate(b.name, b.value === undefined ? null : b.value) };
  },
  '/secrets/verify': async () => await handler.verify(),
};

const server = http.createServer(async (req, res) => {
  try {
    // Health pre-auth so docker healthcheck doesn't need to know the token.
    if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });
    if (!tokenEqual(req.headers.authorization || '', `Bearer ${TOKEN}`)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const handlerFn = ROUTES[req.url];
    if (!handlerFn) return send(res, 404, { error: 'not found' });
    const body = await readBody(req);
    const out = await handlerFn(body);
    send(res, 200, out);
  } catch (e) {
    console.error(`[secrets-server] ${req.method} ${req.url}: ${e.stack || e.message}`);
    if (e instanceof NotFound) return send(res, 404, { error: e.message });
    if (e instanceof ConflictRetriesExhausted) return send(res, 409, { error: e.message });
    return send(res, e.statusCode || 500, { error: String(e.message || 'internal') });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[secrets-server] listening on :${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
