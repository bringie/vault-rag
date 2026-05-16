'use strict';
// vt-0141/0142: test harness for rag-api HTTP routes. Avoids spinning up
// a real container — uses a single-process http server with the same
// handler tree. Requires the pg test instance at 127.0.0.1:55433 (same
// as fleet-routes.test.js etc.).
//
// Usage:
//   const { startTestApi, reqJson, closeTestApi } = require('./lib/rag-api-test-helpers');
//   const { server } = await startTestApi({ token: 'T' });
//   const r = await reqJson(server, 'POST', '/api/put', { token: 'T', body: {...} });
//   await closeTestApi();
//
// Each call re-requires rag-api.js (delete require.cache) so env changes
// stick. Tests should run sequentially within a file (don't parallelise).

const http = require('node:http');
const path = require('node:path');

let _ragApiHandle = null;

async function startTestApi({
  token = 'T',
  adminToken = null,
  vaultPath = '/tmp/rag-api-test-vault',
  pgHost = '127.0.0.1',
  pgPort = '55433',
  pgUser = 'postgres',
  pgPass = process.env.VAULT_RAG_PG_PASS,
  pgDb = 'vault_rag',
} = {}) {
  if (_ragApiHandle) await closeTestApi();

  // Env BEFORE require — rag-api.js reads it at top-level.
  process.env.VAULT_RAG_API_TOKEN = token;
  if (adminToken) process.env.VAULT_RAG_FLEET_ADMIN_TOKEN = adminToken;
  else delete process.env.VAULT_RAG_FLEET_ADMIN_TOKEN;
  process.env.VAULT_PATH = vaultPath;
  process.env.RAG_PORT = '0';                   // random ephemeral port
  process.env.VAULT_RAG_PG_HOST = pgHost;
  process.env.VAULT_RAG_PG_PORT = pgPort;
  process.env.VAULT_RAG_PG_USER = pgUser;
  process.env.VAULT_RAG_PG_PASS = pgPass;
  process.env.VAULT_RAG_PG_DB = pgDb;
  process.env.VAULT_SECRETS_SKIP_PG = '1';      // bypass git + age boot

  // Re-require to pick up env changes.
  const ragApiPath = require.resolve('../rag-api.js');
  delete require.cache[ragApiPath];
  // Suppress 'fleet-routes' / 'fleet-cost' / etc. module caches too so they
  // see the new env on fresh require.
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/scripts/lib/fleet-') || k.includes('/scripts/lib/secrets-')
        || k.includes('/scripts/lib/tokmon-')) {
      delete require.cache[k];
    }
  }
  const mod = require(ragApiPath);

  // Wait for server.listen to bind. rag-api uses an IIFE that awaits pg
  // before calling listen; poll for .address() up to 5s.
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const addr = mod.server.address();
    if (addr && addr.port) break;
    await new Promise(r => setTimeout(r, 20));
  }
  if (!mod.server.address()) throw new Error('rag-api did not listen within 5s');
  _ragApiHandle = mod;
  return { server: mod.server, close: closeTestApi };
}

async function closeTestApi() {
  if (!_ragApiHandle) return;
  const { server, cleanup } = _ragApiHandle;
  if (cleanup) await cleanup();
  await new Promise(r => server.close(r));
  _ragApiHandle = null;
}

async function reqJson(server, method, urlPath, { body, token } = {}) {
  const port = server.address().port;
  return await new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath, headers,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        let parsed = null;
        if (buf) { try { parsed = JSON.parse(buf); } catch { parsed = buf; } }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

module.exports = { startTestApi, closeTestApi, reqJson };
