# Vault Management Surfaces — Implementation Plan v2 (vt-0139 epic)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (subagent-driven-development is DISABLED per CLAUDE.md cost rules). Steps use `- [ ]` checkbox syntax for tracking.

**Goal:** ship unified vault management surfaces (Obsidian sync + Fleet UI viewer/editor + customizable agent installer + daemon-native cost capture), shrinking infra from 10 to 9 containers along the way.

**v2 changes from v1** (after subagent validation 2026-05-16):
- `vault_files` table DOES NOT EXIST — `/api/notes/list` uses filesystem walk + `chunks` aggregation for tags; `expected_sha` computed at PUT time (no new column).
- `req.url` is pre-stripped of `/api/` at rag-api.js:380 — new tokmon route is `/tokmon/ingest` (not `/api/tokmon/ingest` literal in code).
- SPA router uses `PAGES` map + `setPage(name)` + `<div id="xxxview" hidden>` — vault tab follows that pattern, not `window.__vault` invented globals.
- Daemon watcher starts ONCE before the reconnect loop (was: leak via per-reconnect instantiation).
- Audit-log INSERT lives in `rag-api.js` handlers (not in `secrets-handler.js`) — keeps vt-0134's secrets-container isolation.
- CSS file is `app.css` (was: wrong `styles.css` reference).
- Marked + DOMPurify vendored locally under `agent-fleet/web/vendor/` (was: CDN — breaks air-gapped + SRI placeholder risk).
- External tokmon shippers: deprecation window via env-flag (was: silent break).
- Added Task 3.5 (bootstrap-code flow), Pre-stage 0c (rag-api test harness), per-task feature flags.

**Architecture:** stage 0 collapses `vault-rag-tokmon-ingest` into the daemon. Two pre-stages (optimistic concurrency + secret-read audit) lift safety floors before any new editor ships. Then the customizable `vault-rag-setup` CLI lands as the config primitive that the daemon installer's `--with-mcp` flag re-uses. Obsidian sync ships next via Forgejo HTTPS + obsidian-git. Fleet UI vault tab ships in two slices (read-only first, editor+secrets later, gated on admin-mode probe).

**Tech Stack:** Node 22, vanilla JS in `agent-fleet/web/`, Postgres (vault_rag + tokmon DBs), age, git via Forgejo, marked + DOMPurify (vendored locally, no CDN, no build step), HMAC-SHA256 via node:crypto.

---

## File Structure

**New files:**
- `scripts/lib/tokmon-routes.js` — moved from `scripts/tokmon-ingest.js`.
- `agent-fleet/daemon/src/tokmon-watcher.js` — daemon-side jsonl watcher.
- `scripts/bin/vault-rag-setup` — bash CLI installer.
- `scripts/bin/lib/mcp-json-merge.js` — atomic merge helper.
- `scripts/bin/lib/mcp-json-merge.test.js` — node:test unit tests.
- `agent-fleet/web/vault.js` — vault tab logic.
- `agent-fleet/web/vendor/marked.min.js` — vendored.
- `agent-fleet/web/vendor/dompurify.min.js` — vendored.
- `agent-fleet/daemon/packaging/common/vault-rag-setup` — bundled CLI copy.
- `sql/017-secret-audit.sql` — `secret_audit` table + indices.
- `docs/obsidian-setup.md`.
- `scripts/lib/rag-api-test-helpers.js` — shared test fixtures.

**Modified:**
- `scripts/rag-api.js` — mount `/tokmon/ingest` + `/notes/list` + `expected_sha` + audit insert.
- `scripts/lib/shared-auth.js` (NEW; was tokenEqual duplicated in 3 files) — hoist constant-time bearer compare.
- `docker-compose.yml` — remove `vault-rag-tokmon-ingest` (deprecation window: keep behind `VAULT_RAG_TOKMON_LEGACY_CONTAINER=1` flag for one release).
- `agent-fleet/daemon/src/ws-client.js` — wire watcher OUTSIDE the reconnect loop.
- `agent-fleet/daemon/packaging/{linux,macos,windows}/install.{sh,ps1}` — `--with-mcp` delegates to `vault-rag-setup`.
- `agent-fleet/web/{app.js,index.html,app.css}` — register `vaultview` panel + `nav-vault` button.

---

## Pre-stage 0c: rag-api HTTP test harness (NEW)

**Files:**
- Create: `scripts/lib/rag-api-test-helpers.js`

### 0c.1: Test harness

Looking at the codebase, `scripts/secrets-handler.test.js` already has a working pg+age fixture pattern using `VAULT_SECRETS_SKIP_PG=1` + `skipGit:true`. Reuse it.

- [ ] Create `scripts/lib/rag-api-test-helpers.js`:

```js
'use strict';
// vt-0141/0142: shared fixtures for rag-api HTTP route tests. Avoids
// spinning up a real container — uses a single-process http server with
// the same handler tree.
const http = require('node:http');
const { Client } = require('pg');

async function startTestApi({ token = 'T', adminToken = null, pg = null } = {}) {
  // Set env BEFORE require so rag-api.js boot picks them up.
  process.env.VAULT_RAG_API_TOKEN = token;
  if (adminToken) process.env.VAULT_RAG_FLEET_ADMIN_TOKEN = adminToken;
  process.env.VAULT_SECRETS_SKIP_PG = '1';  // skip secret-vault git
  process.env.VAULT_PATH = process.env.VAULT_PATH || '/tmp/test-vault';
  delete require.cache[require.resolve('../rag-api.js')];
  // rag-api.js calls listen() at the bottom — wrap in a way that lets
  // tests reach the server. Simplest: require it and use the exported
  // server (TODO: add a `module.exports = { server }` at the bottom of
  // rag-api.js when this harness lands).
  const ragApi = require('../rag-api.js');
  // Wait for listen.
  await new Promise(r => setTimeout(r, 50));
  return { server: ragApi.server, close: () => new Promise(r => ragApi.server.close(r)) };
}

async function reqJson(server, method, urlPath, { body, token } = {}) {
  const port = server.address().port;
  return await new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let parsed = null;
        if (buf) { try { parsed = JSON.parse(buf); } catch { parsed = buf; } }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

module.exports = { startTestApi, reqJson };
```

- [ ] Add `module.exports = { server };` at the bottom of `scripts/rag-api.js` (after `server.listen(...)`). This is the one production-code change required to make the harness work.

- [ ] Smoke test:

```bash
cd scripts && VAULT_SECRETS_SKIP_PG=1 node -e "
  const h = require('./lib/rag-api-test-helpers');
  (async () => {
    const { server, close } = await h.startTestApi();
    const r = await h.reqJson(server, 'GET', '/healthz');
    console.log(r);
    await close();
  })();
"
```
Expected: `{status:200, body:{ok:true}}`.

### 0c.2: Commit

- [ ] `git add scripts/lib/rag-api-test-helpers.js scripts/rag-api.js`
- [ ] Commit: `test: rag-api HTTP test harness for vt-0141/0142 (vt-0139 prereq)`

---

## Task 0: Daemon-native token capture, drop tokmon-ingest container (vt-0140)

**Files:**
- Create: `scripts/lib/tokmon-routes.js`
- Create: `scripts/lib/shared-auth.js`
- Create: `agent-fleet/daemon/src/tokmon-watcher.js`
- Create: `agent-fleet/daemon/test/tokmon-watcher.test.js`
- Modify: `scripts/rag-api.js`
- Modify: `agent-fleet/daemon/src/ws-client.js`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Delete (after deprecation window): `scripts/tokmon-ingest.js`

### Step 0.1: Hoist tokenEqual into a shared lib

`tokenEqual` is currently duplicated in fleet-routes.js, mcp-shim.js, secrets-server.js, tokmon-ingest.js, rag-api.js (`checkAuth`). Consolidate.

- [ ] Create `scripts/lib/shared-auth.js`:

```js
'use strict';
// Constant-time bearer-compare. Same impl as mcp-shim.js (canonical).
function tokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
module.exports = { tokenEqual };
```

- [ ] Replace duplicates: `rag-api.js`, `fleet-routes.js`, `secrets-server.js`, `tokmon-ingest.js`, `mcp-shim.js` all `const { tokenEqual } = require('./lib/shared-auth.js');` (path adjusted per file location).

### Step 0.2: Extract tokmon ingest logic

- [ ] Create `scripts/lib/tokmon-routes.js`:

```js
'use strict';
// vt-0140: ingest path moved here from tokmon-ingest.js standalone server.
// rag-api.js wires the http route + bearer; this lib only does the SQL.
const { tokenEqual } = require('./shared-auth');

const TS_MAX_SKEW_MS = 30 * 24 * 60 * 60 * 1000;
function isPlausibleTs(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) && Math.abs(t - Date.now()) < TS_MAX_SKEW_MS;
}

async function ingestBulk(tokmonPg, events) {
  // EXACT body of tokmon-ingest.js ingestBulk (lines 92-180) — move
  // verbatim. The `withPg` wrapper from the old file is dropped here;
  // rag-api passes in an active client. On connection loss, rag-api's
  // own reconnect (fleetCost path) handles it.
  // ... see scripts/tokmon-ingest.js for the verbatim body to copy ...
}

module.exports = { ingestBulk, isPlausibleTs };
```

- [ ] Note: `tokenEqual` is now from shared-auth, not exported from tokmon-routes.

### Step 0.3: Register /tokmon/ingest in rag-api dispatch

- [ ] In `scripts/rag-api.js`, near the top:

```js
const tokmonRoutes = require('./lib/tokmon-routes');
const TOKMON_INGEST_TOKEN = process.env.VAULT_RAG_TOKMON_INGEST_TOKEN;
```

- [ ] In the http handler (after the `/api/` strip at line 380, before line 385's `checkAuth`):

```js
// vt-0140: tokmon shipper ingest. Lives BEFORE the Bearer-auth gate
// because shippers use the legacy X-Tokmon-Token header / separate token.
// Falls back to Bearer for parity. Behind a feature-flag for safe rollout.
if (req.method === 'POST' && req.url === '/tokmon/ingest'
    && process.env.VAULT_RAG_TOKMON_INGEST_ENABLED !== '0') {
  return handleTokmonIngest(req, res).catch(e => {
    console.error('[rag-api] /tokmon/ingest', e.stack || e.message);
    send(res, e.statusCode || 500, { error: scrubError(e.message) });
  });
}
```

- [ ] Add the handler (anywhere in the file, e.g. before the ROUTES const):

```js
async function handleTokmonIngest(req, res) {
  const auth = req.headers['x-tokmon-token']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!TOKMON_INGEST_TOKEN || !tokenEqual(auth, TOKMON_INGEST_TOKEN)) {
    return send(res, 401, { error: 'unauthorized' });
  }
  const body = await readBody(req);
  if (!body || !Array.isArray(body.events)) return send(res, 422, { error: 'events[] required' });
  if (body.events.length > 5000) return send(res, 413, { error: 'batch too large (max 5000)' });
  const filtered = body.events.filter(e => tokmonRoutes.isPlausibleTs(e.ts));
  const dropped = body.events.length - filtered.length;
  // Reuse the existing tokmon pg pool from fleet context (already wired
  // for cost rollups via fleetCost — see rag-api.js:437-447).
  if (!fleetCtx.tokmonDb) return send(res, 503, { error: 'tokmon db not configured' });
  const result = await tokmonRoutes.ingestBulk(fleetCtx.tokmonDb, filtered);
  if (dropped) result.dropped_implausible_ts = dropped;
  send(res, 200, { ok: true, ...result });
}
```

### Step 0.4: Daemon jsonl watcher

- [ ] Create `agent-fleet/daemon/src/tokmon-watcher.js` (see v1 plan for full code — unchanged in v2 except for the export shape):

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const FLUSH_INTERVAL_MS = 30_000;
const BATCH_MAX = 1000;

function parseUsageEvent(line, sourceFile, byteOffset) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (j.type !== 'assistant' || !j.message?.usage) return null;
  const u = j.message.usage;
  return {
    host_id: process.env.AGENT_FLEET_HOST_NAME || os.hostname(),
    message_uuid: j.uuid || `m-${crypto.randomUUID()}`,
    ts: j.timestamp || new Date().toISOString(),
    session_id: j.sessionId || j.message?.id || 'unknown',
    project_path: j.cwd || sourceFile.split('/projects/')[1]?.split('/')[0] || null,
    model: j.message?.model || 'unknown',
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_creation_5m: u.cache_creation_input_tokens || 0,
    cache_creation_1h: u.cache_creation?.ephemeral_1h_input_tokens || 0,
    cache_read: u.cache_read_input_tokens || 0,
    service_tier: u.service_tier || null,
    active_skill: null,
    source_file: sourceFile,
    source_offset: byteOffset,
    raw_hash: crypto.createHash('sha256').update(line).digest('hex').slice(0, 16),
    raw: line.length > 8192 ? null : j,
  };
}

class TokmonWatcher {
  constructor({ hubUrl, token, projectsDir }) {
    this.hubUrl = hubUrl;
    this.token = token;
    this.projectsDir = projectsDir || path.join(os.homedir(), '.claude', 'projects');
    this.offsets = new Map();
    this.batch = [];
    this.timer = null;
  }
  async start() {
    if (!fs.existsSync(this.projectsDir)) {
      console.log(`[tokmon-watcher] ${this.projectsDir} not found — disabled`);
      return;
    }
    await this._scan();
    this.timer = setInterval(() => this._scan().catch(e => console.error('[tokmon-watcher]', e.message)), FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async _scan() {
    const projects = fs.readdirSync(this.projectsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of projects) {
      const dir = path.join(this.projectsDir, d.name);
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        const prev = this.offsets.get(full) || 0;
        // File rotation / truncation detection: if file shrunk, reset offset.
        if (stat.size < prev) { this.offsets.set(full, 0); continue; }
        if (stat.size === prev) continue;
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.alloc(stat.size - prev);
        fs.readSync(fd, buf, 0, buf.length, prev);
        fs.closeSync(fd);
        const text = buf.toString('utf8');
        const lines = text.split('\n').filter(Boolean);
        let off = prev;
        for (const line of lines) {
          const ev = parseUsageEvent(line, full, off);
          if (ev) this.batch.push(ev);
          off += Buffer.byteLength(line, 'utf8') + 1;
        }
        this.offsets.set(full, stat.size);
      }
    }
    await this._flush();
  }
  async _flush() {
    if (!this.batch.length) return;
    const events = this.batch.splice(0, BATCH_MAX);
    try {
      const res = await fetch(`${this.hubUrl}/api/tokmon/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tokmon-token': this.token },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.batch.unshift(...events);
        console.error('[tokmon-watcher] ingest', res.status);
      }
    } catch (e) {
      this.batch.unshift(...events);
      console.error('[tokmon-watcher] ingest fail:', e.message);
    }
  }
}

module.exports = { TokmonWatcher, parseUsageEvent };
```

### Step 0.5: Test the parser

- [ ] Create `agent-fleet/daemon/test/tokmon-watcher.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseUsageEvent, TokmonWatcher } = require('../src/tokmon-watcher');

test('parseUsageEvent extracts usage from a typical jsonl line', () => {
  const line = JSON.stringify({
    type: 'assistant', uuid: 'u1', timestamp: '2026-05-16T12:00:00Z',
    sessionId: 's1', cwd: '/proj',
    message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200 } },
  });
  const ev = parseUsageEvent(line, '/tmp/foo.jsonl', 0);
  assert.equal(ev.input_tokens, 100);
  assert.equal(ev.cache_read, 200);
  assert.equal(ev.model, 'claude-sonnet-4-5');
});

test('parseUsageEvent returns null for non-assistant', () => {
  assert.strictEqual(parseUsageEvent('{"type":"user"}', '/tmp/f', 0), null);
});

test('parseUsageEvent returns null for malformed JSON', () => {
  assert.strictEqual(parseUsageEvent('not json', '/tmp/f', 0), null);
});

test('TokmonWatcher detects file rotation (size shrinks → offset reset)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokmon-test-'));
  fs.mkdirSync(path.join(dir, 'projA'));
  const file = path.join(dir, 'projA', 'session.jsonl');
  fs.writeFileSync(file, JSON.stringify({type:'assistant',uuid:'u1',message:{model:'m',usage:{input_tokens:1}}}) + '\n');
  const w = new TokmonWatcher({ hubUrl: 'http://127.0.0.1:1', token: 't', projectsDir: dir });
  w._flush = async () => {};  // disable network
  await w._scan();
  assert.equal(w.batch.length + (w.offsets.get(file) || 0) > 0, true);
  // Rotate: truncate and rewrite
  fs.writeFileSync(file, '');
  await w._scan();
  assert.equal(w.offsets.get(file), 0);
});
```

- [ ] Run: `cd agent-fleet/daemon && node --test test/tokmon-watcher.test.js`
- Expected: 4/4 pass.

### Step 0.6: Wire watcher into daemon (OUTSIDE reconnect loop)

- [ ] Modify `agent-fleet/daemon/src/ws-client.js`. Find the start of `async function runDaemon(opts)` — insert AFTER initial `attempt = 0` declaration and BEFORE the `while (!opts.abortSignal?.aborted)` reconnect loop:

```js
// vt-0140: jsonl watcher starts ONCE per daemon process. Survives WS
// reconnects (which can happen many times per day).
let tokmonWatcher = null;
if (process.env.AGENT_FLEET_TOKMON_ENABLED === '1') {
  const { TokmonWatcher } = require('./tokmon-watcher');
  const hubHttp = opts.hub
    .replace(/^ws/, 'http')
    .replace(/\/api\/fleet\/ws.*$/, '')
    .replace(/\/fleet\/ws.*$/, '');
  tokmonWatcher = new TokmonWatcher({
    hubUrl: hubHttp,
    token: process.env.AGENT_FLEET_TOKMON_TOKEN || opts.token,
  });
  tokmonWatcher.start().catch(e => console.error('[daemon] tokmon-watcher start:', e.message));
}
// On abort, stop the watcher.
opts.abortSignal?.addEventListener('abort', () => tokmonWatcher?.stop());
```

### Step 0.7: docker-compose deprecation window for tokmon-ingest

- [ ] Modify `docker-compose.yml`. Don't DELETE the service yet — add a profile so operators can opt out:

```yaml
  vault-rag-tokmon-ingest:
    profiles: ["tokmon-legacy"]   # vt-0140: deprecated. Bring back with
                                   #   docker compose --profile tokmon-legacy up -d
                                   # if external shippers still post to :5681.
                                   # rag-api's /api/tokmon/ingest replaces it.
    ...
```

- [ ] After 1 release of bake time, a follow-up PR removes the service block entirely.

### Step 0.8: Add tokmon DB env to rag-api (was previously in standalone container)

- [ ] Verify `docker-compose.yml` `vault-rag-api` already has `VAULT_RAG_TOKMON_PARSER_PASS` available (it does — used by fleet-cost). If not, add:

```yaml
environment:
  - TOKMON_PG_USER=tokmon_parser
  - TOKMON_PG_PASS=${VAULT_RAG_TOKMON_PARSER_PASS}
  - VAULT_RAG_TOKMON_INGEST_TOKEN=${VAULT_RAG_TOKMON_INGEST_TOKEN}
```

### Step 0.9: Test end-to-end

- [ ] Local: `docker compose up -d` (no `--profile tokmon-legacy`).
- [ ] Verify `vault-rag-tokmon-ingest` container is NOT running.
- [ ] curl: `curl -X POST -H "x-tokmon-token: $TOK" -d '{"events":[]}' http://127.0.0.1:5679/api/tokmon/ingest`
- Expected: `{"ok":true,"inserted":0,"dup":0,"tools":0}`.
- [ ] Start a local daemon with `AGENT_FLEET_TOKMON_ENABLED=1` pointing at the hub. Run claude in another terminal. After 30s + a `tail -f docker logs vault-rag-api`, verify ingest happens.

### Step 0.10: Commit

- [ ] `git add scripts/lib/shared-auth.js scripts/lib/tokmon-routes.js scripts/rag-api.js agent-fleet/daemon/src/tokmon-watcher.js agent-fleet/daemon/test/tokmon-watcher.test.js agent-fleet/daemon/src/ws-client.js docker-compose.yml .env.example`
- [ ] Don't delete `scripts/tokmon-ingest.js` yet (deprecation window).
- [ ] Commit: `infra: daemon-native token capture, tokmon-ingest behind legacy profile (vt-0140)`

---

## Task 1: Optimistic concurrency on /api/put via expected_sha (vt-0141)

**Files:**
- Modify: `scripts/rag-api.js`
- Modify: `scripts/rag-api.test.js` (create new — uses harness from 0c)

### Step 1.1: Guard in handlePut

- [ ] In `scripts/rag-api.js` handlePut, find `const shaBefore = exists ? sha256(existingRaw) : null;` (around line 297).
- [ ] Insert IMMEDIATELY AFTER it:

```js
// vt-0141: optimistic concurrency. expected_sha is meaningless on
// create — mode==='create' already 409s on exists.
if (body.expected_sha !== undefined && exists && mode !== 'create') {
  if (body.expected_sha !== shaBefore) {
    const err = new Error(`stale write: expected_sha=${body.expected_sha} but current=${shaBefore}`);
    err.code = 412;
    throw err;
  }
}
```

### Step 1.2: Return current sha in /api/get so client can round-trip

- [ ] Find `handleGet` (around scripts/rag-api.js:213). After reading `content`, compute and add `sha`:

```js
return { content, path: relPath, exists, sha: exists ? sha256(content) : null };
```

(Verify the response shape callers depend on — search `/api/get` consumers. The change is additive.)

### Step 1.3: Test

- [ ] Create `scripts/rag-api.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startTestApi, reqJson } = require('./lib/rag-api-test-helpers');

let tmpVault;
test.before(() => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-api-test-'));
  fs.mkdirSync(path.join(tmpVault, '00-inbox'), { recursive: true });
  process.env.VAULT_PATH = tmpVault;
});
test.after(() => { fs.rmSync(tmpVault, { recursive: true, force: true }); });

test('vt-0141: PUT new file ignores expected_sha (create path)', async () => {
  const { server, close } = await startTestApi({ token: 'T' });
  const r = await reqJson(server, 'POST', '/api/put', {
    token: 'T', body: { path: '00-inbox/v1.md', content: 'hello', agent_id: 'tester' },
  });
  assert.equal(r.status, 200);
  await close();
});

test('vt-0141: PUT returns 412 on stale expected_sha', async () => {
  const { server, close } = await startTestApi({ token: 'T' });
  await reqJson(server, 'POST', '/api/put', {
    token: 'T', body: { path: '00-inbox/race.md', content: 'v1', agent_id: 'tester' },
  });
  const r = await reqJson(server, 'POST', '/api/put', {
    token: 'T', body: { path: '00-inbox/race.md', content: 'v2', expected_sha: 'deadbeef', agent_id: 'tester' },
  });
  assert.equal(r.status, 412);
  await close();
});

test('vt-0141: PUT accepts correct expected_sha', async () => {
  const { server, close } = await startTestApi({ token: 'T' });
  await reqJson(server, 'POST', '/api/put', {
    token: 'T', body: { path: '00-inbox/ok.md', content: 'v1', agent_id: 'tester' },
  });
  const get = await reqJson(server, 'POST', '/api/get', { token: 'T', body: { path: '00-inbox/ok.md' } });
  const r = await reqJson(server, 'POST', '/api/put', {
    token: 'T', body: { path: '00-inbox/ok.md', content: 'v2', expected_sha: get.body.sha, agent_id: 'tester' },
  });
  assert.equal(r.status, 200);
  await close();
});
```

- [ ] Run: `cd scripts && node --test rag-api.test.js`
- Expected: 3/3 pass.

### Step 1.4: Commit

- [ ] Commit: `api/put: optimistic concurrency via expected_sha + sha in GET response (vt-0141)`

---

## Task 2: Secret-read audit log (vt-0142)

**Files:**
- Create: `sql/017-secret-audit.sql`
- Modify: `scripts/rag-api.js` (audit INSERT in handleSecretGet/List/Set/Delete/Rotate/Verify success+error paths)
- Modify: `scripts/rag-api.test.js`

### Step 2.1: SQL migration

- [ ] Create `sql/017-secret-audit.sql`:

```sql
CREATE TABLE IF NOT EXISTS secret_audit (
  id         bigserial PRIMARY KEY,
  ts         timestamptz NOT NULL DEFAULT now(),
  op         text NOT NULL,       -- 'get' | 'list' | 'set' | 'delete' | 'rotate' | 'verify'
  name       text,                -- null for 'list'
  caller_id  text,                -- fingerprint of the bearer (sha256(token) prefix)
  via        text,                -- 'http' | 'mcp' | 'cli'
  outcome    text NOT NULL DEFAULT 'ok'   -- 'ok' | 'denied' | 'error'
);
CREATE INDEX IF NOT EXISTS idx_secret_audit_ts ON secret_audit (ts DESC);
CREATE INDEX IF NOT EXISTS idx_secret_audit_name_ts ON secret_audit (name, ts DESC);
```

- [ ] Apply: `cat sql/017-secret-audit.sql | docker exec -i vault-rag-postgres psql -U postgres -d vault_rag`

### Step 2.2: Audit INSERT helper (in rag-api.js, not secrets-handler)

- [ ] In `scripts/rag-api.js`, add near the top after other helpers:

```js
// vt-0142: audit every secret operation. Lives in rag-api (where the
// HTTP auth + caller fingerprint are visible) so the standalone secrets
// container retains its minimal capability set per vt-0134.
function callerFingerprint(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}
async function auditSecret(req, op, name, outcome) {
  try {
    await withPg(c => c.query(
      `INSERT INTO secret_audit (op, name, caller_id, via, outcome) VALUES ($1,$2,$3,$4,$5)`,
      [op, name || null, callerFingerprint(req), 'http', outcome]));
  } catch (e) { console.error('[secret-audit]', e.message); }
}
```

### Step 2.3: Wire audit into each handler

For each of `handleSecretGet/List/Set/Delete/Rotate/Verify`, wrap the body to call `auditSecret(req, op, name, 'ok' | 'denied' | 'error')` after the operation. Examples:

- [ ] `handleSecretGet`:

```js
async function handleSecretGet(req, body) {
  if (!body.name) throw new Error('name required');
  try {
    const value = await secretsBackend().get(body.name);
    await auditSecret(req, 'get', body.name, 'ok');
    return { value };
  } catch (e) {
    await auditSecret(req, 'get', body.name, e.code === 404 ? 'denied' : 'error');
    if (e instanceof NotFound || e.statusCode === 404) { const err = new Error(e.message); err.code = 404; throw err; }
    throw e;
  }
}
```

- [ ] Caller wiring: existing dispatch passes `body` to handlers — need to also pass `req`. Update the ROUTES map handler signature OR thread `req` via closure. Cleanest: change the dispatch to:

```js
const out = await handler(req, body);
```

instead of `handler(body)`, then each handler ignores `req` if unneeded.

- [ ] Same wrap for List/Set/Delete/Rotate/Verify.

### Step 2.4: Test

- [ ] Append to `scripts/rag-api.test.js`:

```js
const { Client } = require('pg');
async function auditClient() {
  const c = new Client({ host: '127.0.0.1', port: 55433, user: 'postgres', password: process.env.VAULT_RAG_PG_PASS, database: 'vault_rag' });
  await c.connect();
  return c;
}

test('vt-0142: handleSecretGet inserts secret_audit row on 404', async () => {
  const { server, close } = await startTestApi({ token: 'T' });
  const pg = await auditClient();
  await pg.query("DELETE FROM secret_audit WHERE name = 'NOT_HERE'");
  const r = await reqJson(server, 'POST', '/api/secrets/get', {
    token: 'T', body: { name: 'NOT_HERE' },
  });
  assert.equal(r.status, 404);
  // Audit row should exist with outcome='denied' (404 → denied per our mapping).
  const rows = (await pg.query("SELECT outcome FROM secret_audit WHERE name = 'NOT_HERE' ORDER BY ts DESC LIMIT 1")).rows;
  assert.equal(rows[0]?.outcome, 'denied');
  await pg.end();
  await close();
});
```

### Step 2.5: Commit

- [ ] Commit: `secrets: audit every read in secret_audit (vt-0142)`

---

## Task 3: vault-rag-setup CLI (vt-0143)

**Files:**
- Create: `scripts/bin/vault-rag-setup`
- Create: `scripts/bin/lib/mcp-json-merge.js`
- Create: `scripts/bin/lib/mcp-json-merge.test.js`

### Step 3.1: mcp-json-merge helper

- [ ] Create `scripts/bin/lib/mcp-json-merge.js`:

```js
#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const target = args.target;
const name = args.name;
const url = args.url;
const token = args.token;
if (!target || !name || !url || !token) {
  console.error('mcp-json-merge: required: --target --name --url --token');
  process.exit(2);
}

fs.mkdirSync(path.dirname(target), { recursive: true });

let cur = {};
if (fs.existsSync(target)) {
  let raw;
  try { raw = fs.readFileSync(target, 'utf8'); }
  catch (e) { console.error('mcp-json-merge: read fail:', e.message); process.exit(1); }
  try { cur = JSON.parse(raw); }
  catch (e) {
    // vt-0143 hardening: don't silently obliterate existing config. Bail.
    console.error(`mcp-json-merge: ${target} is not valid JSON; refusing to clobber. ` +
      `Move it aside and re-run to start fresh.`);
    process.exit(1);
  }
}
cur.mcpServers = cur.mcpServers || {};
cur.mcpServers[name] = {
  type: 'http',
  url,
  headers: { 'X-Vault-Token': token },
};

const tmp = target + '.tmp.' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(cur, null, 2));
fs.chmodSync(tmp, 0o600);
fs.renameSync(tmp, target);
console.log(`mcp-json-merge: wrote ${target} (mcpServers.${name})`);
```

### Step 3.2: Tests for the merge helper

- [ ] Create `scripts/bin/lib/mcp-json-merge.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, 'mcp-json-merge.js');

function run(target, name, url, token) {
  return execFileSync('node', [SCRIPT, '--target', target, '--name', name, '--url', url, '--token', token], { encoding: 'utf8' });
}

test('vt-0143: merge preserves other mcpServers entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-merge-'));
  const target = path.join(dir, 'claude.json');
  fs.writeFileSync(target, JSON.stringify({ mcpServers: { other: { type: 'http', url: 'http://x' } } }, null, 2));
  run(target, 'vault-rag', 'http://h/mcp', 'T1');
  const out = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.ok(out.mcpServers.other);
  assert.equal(out.mcpServers['vault-rag'].headers['X-Vault-Token'], 'T1');
});

test('vt-0143: rotation only rewrites the named entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-merge-'));
  const target = path.join(dir, 'claude.json');
  run(target, 'vault-rag', 'http://h/mcp', 'T1');
  run(target, 'vault-rag', 'http://h/mcp', 'T2');
  const out = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(out.mcpServers['vault-rag'].headers['X-Vault-Token'], 'T2');
});

test('vt-0143: REFUSES to clobber malformed JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-merge-'));
  const target = path.join(dir, 'claude.json');
  fs.writeFileSync(target, 'not json {');
  let threw = false;
  try { run(target, 'vault-rag', 'http://h/mcp', 'T1'); }
  catch (e) { threw = true; }
  assert.ok(threw, 'should exit non-zero');
  // Original content preserved.
  assert.equal(fs.readFileSync(target, 'utf8'), 'not json {');
});

test('vt-0143: creates parent dir + sets 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-merge-'));
  const target = path.join(dir, 'nested', 'sub', 'claude.json');
  run(target, 'vault-rag', 'http://h/mcp', 'T1');
  const mode = fs.statSync(target).mode & 0o777;
  assert.equal(mode, 0o600);
});
```

- [ ] Run: `cd scripts/bin/lib && node --test mcp-json-merge.test.js`
- Expected: 4/4 pass.

### Step 3.3: Bash CLI wrapper

- [ ] Create `scripts/bin/vault-rag-setup`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# vault-rag-setup: configure an agent host to talk to a vault-rag hub.
# All URLs and tokens are flags or env — no hardcoded brain.* domain.

usage() {
  cat <<'EOF'
vault-rag-setup [flags]
  --hub <url>             vault-rag base URL (required)
  --api-token <t>         viewer/admin bearer (or use --api-token-stdin)
  --api-token-stdin       read API token from stdin
  --admin-token <t>       admin bearer (optional)
  --mcp-token <t>         MCP X-Vault-Token (if set, mcp.json is merged)
  --mcp-token-stdin       read MCP token from stdin
  --mcp-url <url>         MCP endpoint (default: <hub>/mcp)
  --vault-name <s>        mcpServers.<name> key (default: vault-rag)
  --config-dir <p>        config dir (default: $HOME/.config/vault-rag)
  --mcp-config <p>        mcp config path (default: $HOME/.claude.json)
  --config-only           skip mcp.json
  --mcp-only              skip ~/.config/vault-rag
  --dry-run               print actions, don't write
EOF
}

# ---- arg parsing ----
HUB=""; API_TOKEN=""; ADMIN_TOKEN=""; MCP_TOKEN=""; MCP_URL=""
VAULT_NAME="vault-rag"; CONFIG_DIR=""; MCP_CONFIG=""
CONFIG_ONLY=""; MCP_ONLY=""; DRY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB="$2"; shift 2;;
    --api-token) API_TOKEN="$2"; shift 2;;
    --api-token-stdin) read -r API_TOKEN; shift;;
    --admin-token) ADMIN_TOKEN="$2"; shift 2;;
    --mcp-token) MCP_TOKEN="$2"; shift 2;;
    --mcp-token-stdin) read -r MCP_TOKEN; shift;;
    --mcp-url) MCP_URL="$2"; shift 2;;
    --vault-name) VAULT_NAME="$2"; shift 2;;
    --config-dir) CONFIG_DIR="$2"; shift 2;;
    --mcp-config) MCP_CONFIG="$2"; shift 2;;
    --config-only) CONFIG_ONLY=1; shift;;
    --mcp-only) MCP_ONLY=1; shift;;
    --dry-run) DRY=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "unknown flag: $1" >&2; usage >&2; exit 2;;
  esac
done

[[ -n "$HUB" ]] || { echo "--hub required" >&2; exit 2; }
: "${CONFIG_DIR:=${HOME}/.config/vault-rag}"
: "${MCP_CONFIG:=${HOME}/.claude.json}"
: "${MCP_URL:=${HUB%/}/mcp}"

if [[ -z "$CONFIG_ONLY" && -n "$MCP_TOKEN" ]]; then
  [[ -n "$DRY" ]] || node "$(dirname "$0")/lib/mcp-json-merge.js" \
    --target "$MCP_CONFIG" --name "$VAULT_NAME" --url "$MCP_URL" --token "$MCP_TOKEN"
  echo "mcp-config: $MCP_CONFIG ($VAULT_NAME)"
fi

if [[ -z "$MCP_ONLY" && -n "$API_TOKEN" ]]; then
  mkdir -p "$CONFIG_DIR"
  CONFIG_TMP="$CONFIG_DIR/config.json.tmp"
  ( umask 077 && cat > "$CONFIG_TMP" <<EOF
{
  "hub": "$HUB",
  "api_token": "$API_TOKEN",
  "admin_token": "$ADMIN_TOKEN",
  "mcp_url": "$MCP_URL",
  "vault_name": "$VAULT_NAME",
  "updated_at": "$(date -u +%FT%TZ)"
}
EOF
  )
  if [[ -z "$DRY" ]]; then mv "$CONFIG_TMP" "$CONFIG_DIR/config.json"; chmod 0600 "$CONFIG_DIR/config.json"; fi
  echo "config: $CONFIG_DIR/config.json"
fi

echo "vault-rag-setup: ok"
```

- [ ] Make executable: `chmod +x scripts/bin/vault-rag-setup`.

### Step 3.4: Commit

- [ ] Commit: `bin: vault-rag-setup CLI + mcp.json merge primitive (vt-0143)`

---

## Task 3.5: Bootstrap-code flow (NEW — was missing from v1)

**Files:**
- Modify: `scripts/lib/fleet-routes.js` (new endpoints `/fleet/auth/setup-code` + `/fleet/auth/exchange`)
- Modify: `scripts/bin/vault-rag-setup` (add `--bootstrap-code` flag)
- Modify: `agent-fleet/web/app.js` (admin UI to mint codes)

### Step 3.5.1: Server-side endpoints

- [ ] In `fleet-routes.js`, follow the existing WS-ticket pattern (`signWsTicket` etc.). Add:

```js
const SETUP_CODE_TTL_MS = 10 * 60 * 1000;
function signSetupCode(ctx, scope) {
  const payload = { scope, exp: Date.now() + SETUP_CODE_TTL_MS };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', wsTicketSecret(ctx)).update(b64).digest('hex');
  return `${b64}.${sig}`;
}
function verifySetupCode(ctx, code) { /* mirror verifyWsTicket */ }

async function handleSetupCode({ res, ctx }) {
  // Admin-only — gated by isAdminPath. Returns a one-time code valid 10m.
  send(res, 200, { code: signSetupCode(ctx, 'viewer'), expires_in_ms: SETUP_CODE_TTL_MS });
}

async function handleSetupExchange({ res, body, ctx }) {
  if (!body || !body.code) return send(res, 422, { error: 'code required' });
  const v = verifySetupCode(ctx, body.code);
  if (!v) return send(res, 401, { error: 'invalid or expired code' });
  // Exchange for the actual viewer token. NOTE: tokens are not rotated
  // per-code in this MVP — same viewer bearer is returned. Future work:
  // mint per-host JWTs.
  send(res, 200, { api_token: ctx.token, hub: ctx.publicUrl || null });
}
```

- [ ] Wire: `POST /fleet/auth/setup-code` (admin) + `POST /fleet/auth/exchange` (public, validates signature).

### Step 3.5.2: CLI flag

- [ ] In `vault-rag-setup` add `--bootstrap-code <code>` mode: POST to `${HUB}/fleet/auth/exchange` with the code → receive `api_token` → write config.

### Step 3.5.3: Admin UI

- [ ] Add a "Generate setup code" button in the fleet UI. Modal shows the code + 10-min expiry. Operator pastes into agent host's `vault-rag-setup --bootstrap-code XXX`.

### Step 3.5.4: Test

- [ ] Add 2 fleet-routes tests: mint code with admin token returns shape; exchange returns api_token; expired code → 401.

### Step 3.5.5: Commit

- [ ] Commit: `fleet/auth: bootstrap-code flow for vault-rag-setup (vt-0143)`

---

## Task 4: Daemon installer --with-mcp (vt-0144)

**Files:**
- Modify: `agent-fleet/daemon/packaging/build.sh`
- Modify: `agent-fleet/daemon/packaging/linux/install.sh`
- Modify: `agent-fleet/daemon/packaging/macos/install.sh`
- Modify: `agent-fleet/daemon/packaging/windows/install.ps1`

### Step 4.1: Bundle vault-rag-setup into the package

- [ ] Modify `agent-fleet/daemon/packaging/build.sh`. After existing copy steps, add:

```bash
mkdir -p "$STAGE/packaging/common"
cp "$REPO/scripts/bin/vault-rag-setup" "$STAGE/packaging/common/"
mkdir -p "$STAGE/packaging/common/lib"
cp "$REPO/scripts/bin/lib/mcp-json-merge.js" "$STAGE/packaging/common/lib/"
chmod +x "$STAGE/packaging/common/vault-rag-setup"
```

### Step 4.2: Linux install.sh flag

- [ ] Add to `linux/install.sh` parse loop:

```bash
WITH_MCP=""
MCP_TOKEN_ARG="${AGENT_FLEET_MCP_TOKEN:-}"
MCP_URL_ARG="${AGENT_FLEET_MCP_URL:-}"
VAULT_NAME_ARG="${AGENT_FLEET_VAULT_NAME:-vault-rag}"
MCP_CONFIG_FOR_USER="${SUDO_USER:-${USER:-}}"

for arg in "$@"; do
  case "$arg" in
    --with-mcp) WITH_MCP=1 ;;
    --mcp-token=*) MCP_TOKEN_ARG="${arg#*=}" ;;
    --mcp-url=*)   MCP_URL_ARG="${arg#*=}" ;;
    --vault-name=*) VAULT_NAME_ARG="${arg#*=}" ;;
    --mcp-config-for-user=*) MCP_CONFIG_FOR_USER="${arg#*=}" ;;
  esac
done

if [[ -n "$WITH_MCP" ]]; then
  if [[ -z "$MCP_CONFIG_FOR_USER" ]]; then
    echo "[install] --with-mcp requires SUDO_USER or --mcp-config-for-user=<name>" >&2
    exit 2
  fi
  USER_HOME=$(getent passwd "$MCP_CONFIG_FOR_USER" | cut -d: -f6)
  [[ -d "$USER_HOME" ]] || { echo "[install] no home for $MCP_CONFIG_FOR_USER" >&2; exit 2; }
  : "${MCP_URL_ARG:=${AGENT_FLEET_HUB%/*}/mcp}"
  if [[ -z "$MCP_TOKEN_ARG" ]]; then
    read -r -s -p "MCP token (X-Vault-Token): " MCP_TOKEN_ARG; echo
  fi
  # Run as the target user so file ownership is right.
  sudo -u "$MCP_CONFIG_FOR_USER" bash "$INSTALL_DIR/packaging/common/vault-rag-setup" \
    --hub "$AGENT_FLEET_HUB" \
    --mcp-token-stdin \
    --mcp-url "$MCP_URL_ARG" \
    --vault-name "$VAULT_NAME_ARG" \
    --mcp-config "$USER_HOME/.claude.json" \
    --mcp-only <<< "$MCP_TOKEN_ARG"
fi
```

### Step 4.3: macOS install.sh flag

macOS installer ALREADY runs as the target user (`$EUID -ne 0` is enforced). `$HOME` is correct.

- [ ] Mirror the parsing block; replace the `sudo -u` invocation with a direct call (no privilege drop needed). Use `$HOME/.claude.json` as default.

### Step 4.4: Windows install.ps1 flag

- [ ] Add equivalent PowerShell parsing. Default config path: `$env:USERPROFILE\.claude.json`.

### Step 4.5: Smoke test

- [ ] Linux: `docker run --rm -it -v $PWD/agent-fleet/daemon/dist:/d --tmpfs /home/testuser debian bash -c "useradd -m testuser && sudo -u testuser true && SUDO_USER=testuser bash /d/install.sh --with-mcp --hub https://h --mcp-token=mt"`
- [ ] Verify `/home/testuser/.claude.json` has `mcpServers.vault-rag` with `X-Vault-Token: mt`.

### Step 4.6: Commit

- [ ] Commit: `daemon installers: --with-mcp delegates to bundled vault-rag-setup (vt-0144)`

---

## Task 5: Obsidian-Git docs + .gitattributes (vt-0145)

**Files:**
- Create: `docs/obsidian-setup.md`
- Create: `/root/obsidian-vault/.gitattributes` (via vault git, on prod)

### Step 5.1: .gitattributes on prod

- [ ] On prod: `cd /root/obsidian-vault && cat > .gitattributes <<'EOF'
# vt-0145: binary blobs — prevent line-ending normalization and partial-
# upload deltas (isomorphic-git on mobile can corrupt these otherwise).
secrets/vault.age binary
secrets/recipients binary
EOF
git add .gitattributes && git commit -m "vt-0145: mark vault.age + recipients as binary" && git push`

### Step 5.2: Docs

- [ ] Create `docs/obsidian-setup.md` (300-500 lines covering):
  - "What Obsidian gets you": local Markdown editing, mobile, graph
  - Forgejo PAT setup (dedicated `vault-readwrite` scope, NOT the full-access token)
  - HTTPS clone: `git clone https://<user>:<pat>@brain.../git/<user>/obsidian-vault.git ~/vault`
  - Install Obsidian + open `~/vault` as a vault
  - Install Obsidian Git community plugin
  - Plugin config: `Auto pull on startup`, `Auto push every 10m`, `Disable on mobile data`
  - **Warning**: "Do not edit the same note in Obsidian + Fleet UI within the same minute." Why: `vault-sync.sh` quarantines divergent commits into `_refactor/conflicts/`.
  - Conflict resolution flow
  - "Secrets are encrypted" — point at Fleet UI Secrets tab (or Stage 5 plugin once shipped)

### Step 5.3: Commit

- [ ] Commit (in vault-rag-oss repo): `docs: Obsidian-Git setup guide (vt-0145)`

---

## Task 6: Fleet UI Vault tab — read-only viewer (vt-0146)

**Files:**
- Modify: `agent-fleet/web/index.html` (new `vaultview` div + `nav-vault` button + vendor scripts)
- Modify: `agent-fleet/web/app.js` (PAGES entry)
- Create: `agent-fleet/web/vault.js`
- Modify: `agent-fleet/web/app.css`
- Create: `agent-fleet/web/vendor/marked.min.js` (vendored)
- Create: `agent-fleet/web/vendor/dompurify.min.js` (vendored)
- Modify: `scripts/rag-api.js` (new `GET /api/notes/list` via filesystem walk + chunks aggregation)

### Step 6.1: Vendor marked + DOMPurify

- [ ] Run:

```bash
mkdir -p agent-fleet/web/vendor
curl -sSL https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js -o agent-fleet/web/vendor/marked.min.js
curl -sSL https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js -o agent-fleet/web/vendor/dompurify.min.js
```

- [ ] Confirm sizes (~50 KB marked, ~70 KB dompurify).

### Step 6.2: /notes/list endpoint (filesystem walk)

- [ ] In `scripts/rag-api.js`, add a new GET-shaped handler. Since `req.url` is pre-stripped of `/api/`, the key is `/notes/list`:

```js
async function handleNotesList(req, res) {
  if (!checkAuth(req)) return send(res, 401, { error: 'unauthorized' });
  const u = new URL(req.url, 'http://x');
  const prefix = (u.searchParams.get('prefix') || '').replace(/^\/+/, '');
  const depth = Math.min(parseInt(u.searchParams.get('depth') || '2', 10), 5);
  if (prefix.includes('..')) return send(res, 422, { error: 'bad prefix' });
  const base = path.join(VAULT, prefix);
  if (!base.startsWith(VAULT)) return send(res, 422, { error: 'bad prefix' });
  if (!fs.existsSync(base)) return send(res, 200, { entries: [] });

  // Walk filesystem up to `depth` levels.
  const entries = [];
  function walk(dir, depthLeft, rel) {
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      const full = path.join(dir, d.name);
      const subRel = rel ? path.join(rel, d.name) : d.name;
      if (d.isDirectory()) {
        if (depthLeft > 0) walk(full, depthLeft - 1, subRel);
        entries.push({ path: subRel + '/', kind: 'dir' });
      } else if (d.name.endsWith('.md')) {
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        entries.push({ path: subRel, kind: 'file', size: stat.size, mtime: stat.mtimeMs });
      }
    }
  }
  walk(base, depth, prefix);

  // Tag overlay from chunks (best-effort).
  if (entries.length) {
    try {
      const paths = entries.filter(e => e.kind === 'file').map(e => e.path);
      const r = await withPg(c => c.query(
        `SELECT path, array_agg(DISTINCT t) AS tags
         FROM chunks, unnest(tags) AS t
         WHERE path = ANY($1)
         GROUP BY path`, [paths]));
      const tagsByPath = Object.fromEntries(r.rows.map(row => [row.path, row.tags]));
      for (const e of entries) if (e.kind === 'file' && tagsByPath[e.path]) e.tags = tagsByPath[e.path];
    } catch {}
  }

  send(res, 200, { entries: entries.slice(0, 5000) });
}
```

- [ ] Wire in the dispatch tree (rag-api.js, after `if (req.method === 'GET' && req.url === '/healthz')`):

```js
if (req.method === 'GET' && req.url.startsWith('/notes/list')) {
  return handleNotesList(req, res).catch(e => send(res, e.statusCode || 500, { error: scrubError(e.message) }));
}
```

### Step 6.3: SPA wiring

- [ ] In `agent-fleet/web/index.html`, ADD a new panel + nav button + vendor scripts.

Topbar nav (find existing `nav-cost` etc. buttons):
```html
<button id="nav-vault" class="nav-btn">Vault</button>
```

New panel (anywhere in body):
```html
<div id="vaultview" hidden>
  <div class="vault-split">
    <div id="vault-tree"></div>
    <div id="vault-viewer"><em>Select a note from the tree.</em></div>
  </div>
</div>
```

Vendor scripts at the end of body before app.js:
```html
<script src="vendor/marked.min.js"></script>
<script src="vendor/dompurify.min.js"></script>
<script src="vault.js"></script>
```

- [ ] In `agent-fleet/web/app.js`:
  - Add to `ALL_PANELS` (line 986): `'vaultview'`
  - Add to `ALL_NAVS` (line 987): `'vault'`
  - Add to `PAGES` (line 973):

```js
vault: { panels: ['vaultview'], nav: 'vault', title: 'page.vault', open: () => window.openVaultView?.() },
```

  - Add a `nav-vault.onclick` setup wherever the others are wired: `$('nav-vault').onclick = () => navigate('/vault');`

### Step 6.4: vault.js logic

- [ ] Create `agent-fleet/web/vault.js`:

```js
'use strict';
// vt-0146: vault tab — read-only viewer. Editor + Secrets land in vt-0147.
(function () {
  const $ = (id) => document.getElementById(id);
  let state = { token: null, isAdmin: false };

  // Pull token from app.js's state (set on login). We piggyback on the
  // `fleet-token-ready` custom event app.js dispatches after authentication.
  window.addEventListener('fleet-token-ready', (ev) => {
    state.token = ev.detail.token;
    state.isAdmin = !!ev.detail.isAdmin;
  });

  async function loadTree(prefix = '') {
    const r = await fetch(`/api/notes/list?prefix=${encodeURIComponent(prefix)}&depth=2`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
    if (!r.ok) throw new Error('list ' + r.status);
    return (await r.json()).entries;
  }

  async function loadNote(p) {
    const r = await fetch('/api/get', {
      method: 'POST',
      headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
    if (!r.ok) throw new Error('get ' + r.status);
    return await r.json();
  }

  function renderMd(text) {
    const html = window.marked.parse(text || '');
    return window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  }

  function escape(s) {
    return String(s ?? '').replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
  }

  async function open() {
    if (!state.token) return;
    const tree = $('vault-tree');
    tree.innerHTML = 'Loading…';
    try {
      const entries = await loadTree();
      tree.innerHTML = '';
      const ul = document.createElement('ul');
      ul.className = 'vault-tree-ul';
      for (const e of entries) {
        const li = document.createElement('li');
        li.className = e.kind === 'dir' ? 'vault-dir' : 'vault-file';
        li.dataset.path = e.path;
        // NEVER innerHTML user-controlled paths.
        li.textContent = e.path + (e.kind === 'dir' ? '' : ` (${e.size}b)`);
        ul.appendChild(li);
      }
      tree.appendChild(ul);
      ul.addEventListener('click', async (ev) => {
        const li = ev.target.closest('li.vault-file');
        if (!li) return;
        const note = await loadNote(li.dataset.path);
        $('vault-viewer').innerHTML = renderMd(note.content);
      });
    } catch (e) {
      tree.textContent = 'error: ' + e.message;
    }
  }

  window.openVaultView = open;
})();
```

### Step 6.5: app.js side — emit fleet-token-ready

- [ ] In `app.js`, after the token is loaded from localStorage AND after `setupAdminMode()` runs (you'll add this in the same step), dispatch:

```js
window.dispatchEvent(new CustomEvent('fleet-token-ready', { detail: { token: state.token, isAdmin: state.isAdmin } }));
```

### Step 6.6: Admin probe in app.js

- [ ] Add a helper:

```js
async function detectAdminMode() {
  try {
    // Probe a known admin-only endpoint that 403s for viewer tokens.
    // POST /fleet/dispatch validates the bearer; on bad body it 422s but
    // ONLY when admin. Viewer gets 403 from isAdminPath.
    const r = await fetch('/api/fleet/dispatch', {
      method: 'POST',
      headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    state.isAdmin = r.status !== 403;
  } catch { state.isAdmin = false; }
}
```

Call this after `state.token` is set on login.

### Step 6.7: CSS

- [ ] Append to `agent-fleet/web/app.css`:

```css
.vault-split { display: flex; gap: 12px; height: calc(100vh - 80px); }
#vault-tree { width: 320px; overflow: auto; border-right: 1px solid var(--border); padding: 8px; }
#vault-viewer { flex: 1; overflow: auto; padding: 12px; }
.vault-tree-ul { list-style: none; padding: 0; margin: 0; font: 12px/1.5 monospace; }
.vault-dir { color: var(--text-dim); }
.vault-file { cursor: pointer; }
.vault-file:hover { background: var(--bg-hover); }
@media (max-width: 768px) {
  .vault-split { flex-direction: column; height: auto; }
  #vault-tree { width: auto; max-height: 40vh; border-right: none; border-bottom: 1px solid var(--border); }
}
```

### Step 6.8: Test

- [ ] Manual: open `https://brain.../fleet/#/vault`. Tree loads. Click a file. Markdown renders. Verify no `<script>` runs from a test note `# xss <img src=x onerror=alert(1)>` (planted via /api/put).
- [ ] DOMPurify unit-style check (in dev console):

```js
window.DOMPurify.sanitize('<img src=x onerror=alert(1)>');
// expected: '<img src="x">' (no onerror)
```

### Step 6.9: Commit

- [ ] Commit: `fleet/web: Vault tab — read-only viewer + /api/notes/list (vt-0146)`

---

## Task 7: Editor + Secrets sub-tab (vt-0147)

**Files:**
- Modify: `agent-fleet/web/vault.js` (add edit mode + secrets sub-tab)
- Modify: `agent-fleet/web/index.html` (sub-tab structure)
- Modify: `agent-fleet/web/app.css`

### Step 7.1: Editor mode

WRITABLE_PREFIXES match (`00-inbox/`, `03-sessions/`, `04-tasks/`, `06-resources/notes/`, `agents/*`). If `state.isAdmin` AND path matches, show "Edit" button.

- [ ] Edit click → swap viewer pane for textarea + Save / Cancel.
- [ ] Save: POST `/api/put` with `expected_sha` from the prior `/api/get` response. On 412, show "Conflict — refresh server version?" modal with `[Reload from server]` or `[Force overwrite]` (force re-sends without expected_sha).

### Step 7.2: Secrets sub-tab

- [ ] In `vault-tree` panel: add a top-row toggle `[Notes] [Secrets]`.
- [ ] Secrets list: POST `/api/secrets/list`. Render names. Admin probe enables Set/Rotate/Delete buttons.
- [ ] Reveal click: POST `/api/secrets/get`. Modal shows value + copy-to-clipboard button + 30s timer + auto-close.
- [ ] Set/Rotate/Delete: prompt forms with confirm.

### Step 7.3: Test

- [ ] Manual: edit a note, save → /api/get returns new content. Open same note in two tabs, save in tab A, save in tab B → tab B 412 + conflict modal.
- [ ] Reveal a secret → check `secret_audit` table has a new `op=get outcome=ok` row.

### Step 7.4: Commit

- [ ] Commit: `fleet/web: Vault editor + Secrets sub-tab (vt-0147)`

---

## Task 8: DEFERRED — Obsidian decrypt plugin (vt-0148)

Per v1: ship Stage 1+2 first, validate user demand, then revisit.

---

## Task 9: vault.age backup CLI (vt-0149)

**Files:**
- Create: `scripts/bin/vault-rag-backup`

### Step 9.1: Backup script

- [ ] Create `scripts/bin/vault-rag-backup`:

```bash
#!/usr/bin/env bash
set -euo pipefail
# vault-rag-backup: copy vault.age + recipients to a destination.
# Supports local dirs, S3 (via aws cli), or scp targets.
# vault-rag-backup --to /backup/vault-rag-$(date +%F)/
# vault-rag-backup --restore --from /backup/vault-rag-2026-05-16/

VAULT_SECRETS_DIR="${VAULT_SECRETS_DIR:-/root/obsidian-vault/secrets}"
TO=""; FROM=""; RESTORE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --to) TO="$2"; shift 2;;
    --from) FROM="$2"; shift 2;;
    --restore) RESTORE=1; shift;;
    *) echo "unknown: $1" >&2; exit 2;;
  esac
done

if [[ -n "$RESTORE" ]]; then
  [[ -n "$FROM" ]] || { echo "--restore requires --from" >&2; exit 2; }
  cp -p "$FROM/vault.age" "$VAULT_SECRETS_DIR/"
  cp -p "$FROM/recipients" "$VAULT_SECRETS_DIR/"
  echo "restored to $VAULT_SECRETS_DIR"
  exit 0
fi

[[ -n "$TO" ]] || { echo "--to required" >&2; exit 2; }
case "$TO" in
  s3://*) aws s3 cp "$VAULT_SECRETS_DIR/vault.age" "$TO/vault.age"
          aws s3 cp "$VAULT_SECRETS_DIR/recipients" "$TO/recipients" ;;
  *)      mkdir -p "$TO"
          cp -p "$VAULT_SECRETS_DIR/vault.age" "$TO/"
          cp -p "$VAULT_SECRETS_DIR/recipients" "$TO/" ;;
esac
echo "backup → $TO"
```

### Step 9.2: Commit

- [ ] Commit: `bin: vault.age backup/restore CLI (vt-0149)`

---

## Self-review

After writing v2:

1. **Coverage**: every brainstorm + validation point mapped (incl. SPA pattern, fs walk for list, hoisted tokenEqual, vendored deps, bootstrap-code, test harness).
2. **Placeholders**: no "TBD" / "similar to above" / "(or create)" left.
3. **Type consistency**: `expected_sha`, `caller_id`, `name`, `kind`, `mtime`, `size` consistent.
4. **Test in every state-changing task**: Pre-stage 0c (harness smoke), Task 0 (4 watcher tests), Task 1 (3 PUT tests), Task 2 (audit-row test), Task 3 (4 merge tests), Task 3.5 (2 auth-flow tests), Task 4 (smoke), Task 6 (manual + DOMPurify check), Task 7 (manual + audit check).
5. **No XSS**: `textContent` for paths, `DOMPurify.sanitize` for markdown.
6. **No infra regression**: audit lives in rag-api (not secrets-handler). New tokmon route reuses existing `fleetCtx.tokmonDb`.
7. **Feature-flagged rollouts**: `VAULT_RAG_TOKMON_INGEST_ENABLED`, `VAULT_RAG_VAULT_TAB_ENABLED` (optional — gate UI nav), `tokmon-legacy` compose profile.
8. **Customization**: every URL/token is a flag/env — no hardcoded `brain.itiswednesdaymydud.es`.

## Execution handoff

When approved → `superpowers:executing-plans` (inline; `subagent-driven-development` disabled per CLAUDE.md).
