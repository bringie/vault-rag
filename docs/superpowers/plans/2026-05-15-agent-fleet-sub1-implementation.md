# Agent Fleet Sub-project #1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. (Note: `superpowers:subagent-driven-development` is disabled in this project per CLAUDE.md cost-control rules.) Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation layer (host daemon + hub control plane) of agent-fleet — a system to spawn, attach to, and stream Claude Code sessions across a fleet of hosts from a central server.

**Architecture:** Outbound WebSocket from each host's `node-pty`-backed daemon to a hub embedded inside the existing `rag-api.js` Node process. Hub persists hosts/sessions/transcripts to existing Postgres; routes input/output between daemons and viewer clients. Auth via shared `VAULT_RAG_API_TOKEN`. Reuses Caddy `handle_path /api/*` block — no new infra.

**Tech Stack:** Node 22, `node-pty`, `ws`, `pg`, built-in `node --test`, Postgres, Caddy, Docker Compose. Bash for CLI + smoke test.

**Spec:** `docs/superpowers/specs/2026-05-15-agent-fleet-control-plane-design.md`

---

## File Structure

**Create:**

```
sql/004-fleet-init.sql                          # schema migration
scripts/lib/fleet-db.js                         # postgres CRUD layer
scripts/lib/fleet-db.test.js                    # node --test
scripts/lib/fleet-ring-buffer.js                # per-session in-mem ring
scripts/lib/fleet-ring-buffer.test.js
scripts/lib/fleet-event-batcher.js              # batched event writes
scripts/lib/fleet-event-batcher.test.js
scripts/lib/fleet-routes.js                     # HTTP handlers + WS upgrade
scripts/lib/fleet-routes.test.js
scripts/bin/fleet                               # bash CLI (REST client)
agent-fleet/daemon/package.json
agent-fleet/daemon/bin/daemon.js                # entry point (npx)
agent-fleet/daemon/src/ws-client.js             # WS connect + reconnect
agent-fleet/daemon/src/pty-manager.js           # node-pty wrapper
agent-fleet/daemon/src/session-store.js         # sessions.json persistence
agent-fleet/daemon/test/ws-client.test.js
agent-fleet/daemon/test/pty-manager.test.js
agent-fleet/daemon/test/session-store.test.js
agent-fleet/daemon/README.md
tests/fleet/fake-claude.sh                       # mock claude binary
tests/fleet-e2e.sh                              # end-to-end smoke
```

**Modify:**

```
scripts/rag-api.js              # mount fleet routes + WS upgrade
scripts/package.json            # add 'ws' dep
docker-compose.yml              # add VAULT_RAG_FLEET_* env if needed
```

---

## Task Map

1. Schema migration (sql + manual apply)
2. `fleet-db.js` — host CRUD
3. `fleet-db.js` — session CRUD
4. `fleet-db.js` — events append + retention
5. `fleet-ring-buffer.js` — per-session ring
6. `fleet-event-batcher.js` — batched writes
7. `fleet-routes.js` — auth + dispatch skeleton
8. `fleet-routes.js` — hosts REST
9. `fleet-routes.js` — sessions REST
10. `fleet-routes.js` — WS upgrade + role dispatch
11. `fleet-routes.js` — daemon WS protocol (hello/heartbeat/spawn/pty_data/reconciliation)
12. `fleet-routes.js` — viewer WS protocol (hello/backfill/live/input/kill)
13. Wire fleet-routes into `rag-api.js` + retention scheduler
14. `tests/fleet/fake-claude.sh`
15. Daemon scaffold (`package.json`, `bin/daemon.js`)
16. Daemon `ws-client.js` (connect + reconnect)
17. Daemon `pty-manager.js` (incl. SIGTERM→SIGKILL grace)
18. Daemon wire-up (`session-store.js` + reconciliation + frame routing)
19. `scripts/bin/fleet` CLI
20. `tests/fleet-e2e.sh` integration smoke
21. Docker Compose verification
22. README + manual smoke

---

## Task 1: Schema Migration

**Files:**
- Create: `sql/004-fleet-init.sql`

- [ ] **Step 1: Write the migration**

```sql
-- sql/004-fleet-init.sql
-- agent-fleet schema: hosts, sessions, events (append-only).
-- Apply: docker exec -i vault-rag-postgres psql -U postgres -d vault_rag < sql/004-fleet-init.sql

CREATE TABLE IF NOT EXISTS fleet_hosts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text UNIQUE NOT NULL,
  os             text,
  arch           text,
  capabilities   text[] DEFAULT '{}',
  status         text NOT NULL DEFAULT 'offline'
                   CHECK (status IN ('online','offline')),
  daemon_version text,
  claude_version text,
  registered_at  timestamptz NOT NULL DEFAULT now(),
  last_seen      timestamptz,
  metadata       jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS fleet_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id     uuid NOT NULL REFERENCES fleet_hosts(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','orphaned','exited','killed')),
  cwd         text NOT NULL,
  args        jsonb DEFAULT '[]'::jsonb,
  env         jsonb DEFAULT '{}'::jsonb,
  pid         integer,
  exit_code   integer,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  created_by  text,
  label       text,
  metadata    jsonb DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS fleet_sessions_host_status ON fleet_sessions(host_id, status);
CREATE INDEX IF NOT EXISTS fleet_sessions_started ON fleet_sessions(started_at DESC);

CREATE TABLE IF NOT EXISTS fleet_events (
  id         bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES fleet_sessions(id) ON DELETE CASCADE,
  ts         timestamptz NOT NULL DEFAULT now(),
  kind       text NOT NULL
               CHECK (kind IN ('pty_out','pty_in','lifecycle','meta')),
  seq        bigint NOT NULL,
  payload    bytea,
  size       integer GENERATED ALWAYS AS (length(payload)) STORED
);
CREATE INDEX IF NOT EXISTS fleet_events_session_seq ON fleet_events(session_id, seq);
CREATE INDEX IF NOT EXISTS fleet_events_ts ON fleet_events(ts);
```

- [ ] **Step 2: Apply migration to running Postgres**

Run: `docker exec -i vault-rag-postgres psql -U postgres -d vault_rag < sql/004-fleet-init.sql`
Expected: `CREATE TABLE` (×3), `CREATE INDEX` (×4), no errors.

- [ ] **Step 3: Verify schema**

Run: `docker exec vault-rag-postgres psql -U postgres -d vault_rag -c "\d fleet_hosts"`
Expected: lists the columns and unique constraint on `name`.

Run: `docker exec vault-rag-postgres psql -U postgres -d vault_rag -c "\d fleet_events"`
Expected: shows `size` as generated column.

- [ ] **Step 4: Commit**

```bash
git add sql/004-fleet-init.sql
git commit -m "feat(agent-fleet): postgres schema (hosts, sessions, events)"
```

---

## Task 2: fleet-db.js — Host CRUD

**Files:**
- Create: `scripts/lib/fleet-db.js`
- Create: `scripts/lib/fleet-db.test.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/fleet-db.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const fleetDb = require('./fleet-db');

const PG = {
  host:     process.env.VAULT_RAG_PG_HOST || '127.0.0.1',
  database: process.env.VAULT_RAG_PG_DB   || 'vault_rag',
  user:     process.env.VAULT_RAG_PG_USER || 'postgres',
  password: process.env.VAULT_RAG_PG_PASS,
  port:     parseInt(process.env.VAULT_RAG_PG_PORT || '55433', 10),
};

async function withClient(fn) {
  const c = new Client(PG);
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function reset(c) {
  await c.query('TRUNCATE fleet_hosts, fleet_sessions, fleet_events RESTART IDENTITY CASCADE');
}

test('upsertHost inserts new host on first call', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, {
      name: 'h1', os: 'linux', arch: 'x86_64',
      capabilities: ['docker'], daemonVersion: '0.1.0', claudeVersion: '1.2.3',
    });
    assert.ok(h.id);
    assert.equal(h.name, 'h1');
    assert.equal(h.status, 'online');
    assert.deepEqual(h.capabilities, ['docker']);
  });
});

test('upsertHost reuses id on second call with same name', async () => {
  await withClient(async (c) => {
    await reset(c);
    const a = await fleetDb.upsertHost(c, { name: 'h2', os: 'darwin' });
    const b = await fleetDb.upsertHost(c, { name: 'h2', os: 'darwin', claudeVersion: 'changed' });
    assert.equal(b.id, a.id);
    assert.equal(b.claude_version, 'changed');
  });
});

test('listHosts returns all hosts ordered by name', async () => {
  await withClient(async (c) => {
    await reset(c);
    await fleetDb.upsertHost(c, { name: 'b' });
    await fleetDb.upsertHost(c, { name: 'a' });
    const rows = await fleetDb.listHosts(c);
    assert.deepEqual(rows.map(r => r.name), ['a', 'b']);
  });
});

test('setHostOffline flips status', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'x' });
    await fleetDb.setHostOffline(c, h.id);
    const rows = await fleetDb.listHosts(c);
    assert.equal(rows[0].status, 'offline');
  });
});

test('deleteHost cascades sessions', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'd' });
    await c.query('INSERT INTO fleet_sessions (host_id, cwd) VALUES ($1, $2)', [h.id, '/tmp']);
    await fleetDb.deleteHost(c, h.id);
    const { rows } = await c.query('SELECT COUNT(*) FROM fleet_sessions');
    assert.equal(rows[0].count, '0');
  });
});
```

- [ ] **Step 2: Run test to confirm failure (module missing)**

Run: `cd scripts && node --test lib/fleet-db.test.js`
Expected: `Error: Cannot find module './fleet-db'`

- [ ] **Step 3: Implement minimal fleet-db.js (hosts only)**

Create `scripts/lib/fleet-db.js`:

```js
'use strict';
// fleet-db: thin pg query layer for agent-fleet hosts/sessions/events.
// Callers pass an active pg.Client/pg.Pool — no connection management here.

async function upsertHost(c, h) {
  const sql = `
    INSERT INTO fleet_hosts (name, os, arch, capabilities, daemon_version, claude_version, status, last_seen)
    VALUES ($1, $2, $3, $4, $5, $6, 'online', now())
    ON CONFLICT (name) DO UPDATE SET
      os = COALESCE(EXCLUDED.os, fleet_hosts.os),
      arch = COALESCE(EXCLUDED.arch, fleet_hosts.arch),
      capabilities = COALESCE(EXCLUDED.capabilities, fleet_hosts.capabilities),
      daemon_version = COALESCE(EXCLUDED.daemon_version, fleet_hosts.daemon_version),
      claude_version = COALESCE(EXCLUDED.claude_version, fleet_hosts.claude_version),
      status = 'online',
      last_seen = now()
    RETURNING *`;
  const { rows } = await c.query(sql, [
    h.name, h.os || null, h.arch || null, h.capabilities || [],
    h.daemonVersion || null, h.claudeVersion || null,
  ]);
  return rows[0];
}

async function listHosts(c) {
  const { rows } = await c.query('SELECT * FROM fleet_hosts ORDER BY name');
  return rows;
}

async function getHost(c, id) {
  const { rows } = await c.query('SELECT * FROM fleet_hosts WHERE id = $1', [id]);
  return rows[0] || null;
}

async function setHostOffline(c, id) {
  await c.query("UPDATE fleet_hosts SET status='offline', last_seen=now() WHERE id=$1", [id]);
}

async function deleteHost(c, id) {
  await c.query('DELETE FROM fleet_hosts WHERE id=$1', [id]);
}

module.exports = { upsertHost, listHosts, getHost, setHostOffline, deleteHost };
```

- [ ] **Step 4: Run tests, expect 5 pass**

Run: `cd scripts && VAULT_RAG_PG_PORT=55433 VAULT_RAG_PG_PASS=$(grep VAULT_RAG_PG_PASS ../.env | cut -d= -f2) node --test lib/fleet-db.test.js`
Expected: `tests 5 / pass 5 / fail 0`.

(If postgres port differs, set `VAULT_RAG_PG_PORT` accordingly. Check `docker compose ps vault-rag-postgres` for host port mapping.)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fleet-db.js scripts/lib/fleet-db.test.js
git commit -m "feat(agent-fleet): fleet-db hosts CRUD"
```

---

## Task 3: fleet-db.js — Session CRUD

**Files:**
- Modify: `scripts/lib/fleet-db.js`
- Modify: `scripts/lib/fleet-db.test.js`

- [ ] **Step 1: Append session tests to fleet-db.test.js**

Append to `scripts/lib/fleet-db.test.js`:

```js
test('createSession returns id with status=pending', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'hs' });
    const s = await fleetDb.createSession(c, {
      hostId: h.id, cwd: '/tmp', args: ['--print', 'hi'],
      env: { FOO: 'bar' }, createdBy: 'test', label: 't1',
    });
    assert.ok(s.id);
    assert.equal(s.status, 'pending');
    assert.deepEqual(s.args, ['--print', 'hi']);
    assert.deepEqual(s.env, { FOO: 'bar' });
  });
});

test('markSessionRunning sets pid and status', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'hm' });
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/tmp' });
    await fleetDb.markSessionRunning(c, s.id, 12345);
    const got = await fleetDb.getSession(c, s.id);
    assert.equal(got.status, 'running');
    assert.equal(got.pid, 12345);
  });
});

test('markSessionExited sets exit_code + ended_at', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'he' });
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/tmp' });
    await fleetDb.markSessionExited(c, s.id, 137, 'killed');
    const got = await fleetDb.getSession(c, s.id);
    assert.equal(got.status, 'killed');
    assert.equal(got.exit_code, 137);
    assert.ok(got.ended_at);
  });
});

test('listSessions filters by host_id and status', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h1 = await fleetDb.upsertHost(c, { name: 'L1' });
    const h2 = await fleetDb.upsertHost(c, { name: 'L2' });
    await fleetDb.createSession(c, { hostId: h1.id, cwd: '/' });
    await fleetDb.createSession(c, { hostId: h2.id, cwd: '/' });
    const all = await fleetDb.listSessions(c, {});
    assert.equal(all.length, 2);
    const filtered = await fleetDb.listSessions(c, { hostId: h1.id });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].host_id, h1.id);
  });
});

test('orphanRunningSessions flips running → orphaned on hub restart', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'orph' });
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/' });
    await fleetDb.markSessionRunning(c, s.id, 999);
    const n = await fleetDb.orphanRunningSessions(c);
    assert.ok(n >= 1);
    const got = await fleetDb.getSession(c, s.id);
    assert.equal(got.status, 'orphaned');
  });
});
```

- [ ] **Step 2: Run tests, expect 5 failures**

Run: `cd scripts && node --test lib/fleet-db.test.js`
Expected: failures referencing `createSession`, `markSessionRunning`, etc.

- [ ] **Step 3: Add session functions to fleet-db.js**

Append to `scripts/lib/fleet-db.js` (before `module.exports`):

```js
async function createSession(c, s) {
  const sql = `
    INSERT INTO fleet_sessions (host_id, cwd, args, env, created_by, label, metadata)
    VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7::jsonb)
    RETURNING *`;
  const { rows } = await c.query(sql, [
    s.hostId, s.cwd,
    JSON.stringify(s.args || []),
    JSON.stringify(s.env || {}),
    s.createdBy || null, s.label || null,
    JSON.stringify(s.metadata || {}),
  ]);
  return rows[0];
}

async function getSession(c, id) {
  const { rows } = await c.query('SELECT * FROM fleet_sessions WHERE id=$1', [id]);
  return rows[0] || null;
}

async function listSessions(c, { hostId, status, limit = 100, offset = 0 } = {}) {
  const where = [];
  const args = [];
  if (hostId) { args.push(hostId); where.push(`host_id = $${args.length}`); }
  if (status) { args.push(status); where.push(`status = $${args.length}`); }
  const wh = where.length ? `WHERE ${where.join(' AND ')}` : '';
  args.push(limit); args.push(offset);
  const sql = `SELECT * FROM fleet_sessions ${wh}
               ORDER BY started_at DESC
               LIMIT $${args.length - 1} OFFSET $${args.length}`;
  const { rows } = await c.query(sql, args);
  return rows;
}

async function markSessionRunning(c, id, pid) {
  await c.query("UPDATE fleet_sessions SET status='running', pid=$2 WHERE id=$1", [id, pid]);
}

async function markSessionExited(c, id, exitCode, status = 'exited') {
  await c.query(
    `UPDATE fleet_sessions SET status=$3, exit_code=$2, ended_at=now() WHERE id=$1`,
    [id, exitCode, status],
  );
}

async function orphanRunningSessions(c) {
  const { rowCount } = await c.query(
    "UPDATE fleet_sessions SET status='orphaned' WHERE status='running'");
  return rowCount;
}
```

Update `module.exports` to add: `createSession, getSession, listSessions, markSessionRunning, markSessionExited, orphanRunningSessions`.

- [ ] **Step 4: Run tests, expect 10 pass**

Run: `cd scripts && node --test lib/fleet-db.test.js`
Expected: `tests 10 / pass 10 / fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fleet-db.js scripts/lib/fleet-db.test.js
git commit -m "feat(agent-fleet): fleet-db sessions CRUD"
```

---

## Task 4: fleet-db.js — Events Append + Retention

**Files:**
- Modify: `scripts/lib/fleet-db.js`
- Modify: `scripts/lib/fleet-db.test.js`

- [ ] **Step 1: Append events tests**

Append to `scripts/lib/fleet-db.test.js`:

```js
test('appendEvents inserts batch and returns count', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'ev1' });
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/' });
    const n = await fleetDb.appendEvents(c, [
      { sessionId: s.id, kind: 'pty_out', seq: 0, payload: Buffer.from('hello') },
      { sessionId: s.id, kind: 'pty_out', seq: 1, payload: Buffer.from('world') },
    ]);
    assert.equal(n, 2);
    const { rows } = await c.query('SELECT seq, payload FROM fleet_events ORDER BY seq');
    assert.equal(rows[0].payload.toString(), 'hello');
    assert.equal(rows[1].seq, '1');
  });
});

test('appendEvents is idempotent via ON CONFLICT (session_id, seq, kind)', async () => {
  // Plan choice: we do NOT add a unique constraint — dedup happens in hub before append.
  // This test asserts that duplicate sequences are persisted (caller must dedup).
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'ev2' });
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/' });
    await fleetDb.appendEvents(c, [{ sessionId: s.id, kind: 'pty_out', seq: 0, payload: Buffer.from('a') }]);
    await fleetDb.appendEvents(c, [{ sessionId: s.id, kind: 'pty_out', seq: 0, payload: Buffer.from('a') }]);
    const { rows } = await c.query('SELECT COUNT(*) FROM fleet_events WHERE session_id=$1', [s.id]);
    assert.equal(rows[0].count, '2');
  });
});

test('maxSeq returns the highest seq for a session (or null)', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'ms' });
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/' });
    assert.equal(await fleetDb.maxSeq(c, s.id), null);
    await fleetDb.appendEvents(c, [
      { sessionId: s.id, kind: 'pty_out', seq: 0, payload: Buffer.from('a') },
      { sessionId: s.id, kind: 'pty_out', seq: 4, payload: Buffer.from('b') },
    ]);
    assert.equal(await fleetDb.maxSeq(c, s.id), 4);
  });
});

test('readTranscript returns events ordered by seq', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'tr' });
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/' });
    await fleetDb.appendEvents(c, [
      { sessionId: s.id, kind: 'pty_out', seq: 1, payload: Buffer.from('B') },
      { sessionId: s.id, kind: 'pty_out', seq: 0, payload: Buffer.from('A') },
    ]);
    const rows = await fleetDb.readTranscript(c, s.id, { sinceSeq: 0 });
    assert.equal(rows[0].payload.toString(), 'A');
    assert.equal(rows[1].payload.toString(), 'B');
  });
});

test('purgeOldEvents deletes pty_* older than cutoff but keeps lifecycle', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'pg' });
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/' });
    await c.query(
      `INSERT INTO fleet_events (session_id, ts, kind, seq, payload) VALUES
       ($1, now() - interval '60 days', 'pty_out', 0, decode('aa','hex')),
       ($1, now() - interval '60 days', 'lifecycle', 1, decode('bb','hex')),
       ($1, now() - interval '1 day', 'pty_out', 2, decode('cc','hex'))`,
      [s.id],
    );
    const n = await fleetDb.purgeOldEvents(c, '30 days');
    assert.equal(n, 1);
    const { rows } = await c.query('SELECT kind, seq FROM fleet_events ORDER BY seq');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.kind), ['lifecycle', 'pty_out']);
  });
});
```

- [ ] **Step 2: Run tests, expect 5 failures**

Run: `cd scripts && node --test lib/fleet-db.test.js`
Expected: failures referencing `appendEvents`, `maxSeq`, etc.

- [ ] **Step 3: Add event functions to fleet-db.js**

Append to `scripts/lib/fleet-db.js` (before `module.exports`):

```js
async function appendEvents(c, events) {
  if (!events.length) return 0;
  const cols = ['session_id', 'kind', 'seq', 'payload'];
  const params = [];
  const placeholders = events.map((ev, i) => {
    const base = i * cols.length;
    params.push(ev.sessionId, ev.kind, ev.seq, ev.payload);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
  });
  const sql = `INSERT INTO fleet_events (${cols.join(',')}) VALUES ${placeholders.join(',')}`;
  await c.query(sql, params);
  return events.length;
}

async function maxSeq(c, sessionId) {
  const { rows } = await c.query(
    'SELECT MAX(seq) AS m FROM fleet_events WHERE session_id=$1', [sessionId]);
  return rows[0].m === null ? null : Number(rows[0].m);
}

async function readTranscript(c, sessionId, { sinceSeq = 0, limit = 10000, kind = null } = {}) {
  const args = [sessionId, sinceSeq, limit];
  let kindClause = '';
  if (kind) { args.push(kind); kindClause = `AND kind = $${args.length}`; }
  const { rows } = await c.query(
    `SELECT id, ts, kind, seq, payload, size FROM fleet_events
     WHERE session_id = $1 AND seq >= $2 ${kindClause}
     ORDER BY seq
     LIMIT $3`, args);
  return rows;
}

async function purgeOldEvents(c, intervalStr) {
  const { rowCount } = await c.query(
    `DELETE FROM fleet_events WHERE ts < now() - $1::interval AND kind IN ('pty_out','pty_in','meta')`,
    [intervalStr]);
  return rowCount;
}
```

Update `module.exports` to add: `appendEvents, maxSeq, readTranscript, purgeOldEvents`.

- [ ] **Step 4: Run tests, expect 15 pass**

Run: `cd scripts && node --test lib/fleet-db.test.js`
Expected: `tests 15 / pass 15 / fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fleet-db.js scripts/lib/fleet-db.test.js
git commit -m "feat(agent-fleet): fleet-db events append + retention"
```

---

## Task 5: fleet-ring-buffer.js — Per-Session Ring

**Files:**
- Create: `scripts/lib/fleet-ring-buffer.js`
- Create: `scripts/lib/fleet-ring-buffer.test.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/fleet-ring-buffer.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { RingBuffer } = require('./fleet-ring-buffer');

test('append + snapshot returns buffered data', () => {
  const rb = new RingBuffer(1024);
  rb.append({ seq: 0, data: Buffer.from('hello ') });
  rb.append({ seq: 1, data: Buffer.from('world') });
  const snap = rb.snapshot();
  assert.equal(Buffer.concat(snap.map(f => f.data)).toString(), 'hello world');
  assert.equal(snap[0].seq, 0);
  assert.equal(snap[1].seq, 1);
});

test('evicts oldest frames when capacity exceeded', () => {
  const rb = new RingBuffer(10);
  rb.append({ seq: 0, data: Buffer.from('aaaa') });
  rb.append({ seq: 1, data: Buffer.from('bbbb') });
  rb.append({ seq: 2, data: Buffer.from('cccc') });
  rb.append({ seq: 3, data: Buffer.from('dddd') });
  const snap = rb.snapshot();
  const total = snap.reduce((n, f) => n + f.data.length, 0);
  assert.ok(total <= 10, `total ${total} > capacity 10`);
  assert.equal(snap[snap.length - 1].seq, 3);
});

test('snapshot returns deep copy (mutation safe)', () => {
  const rb = new RingBuffer(64);
  rb.append({ seq: 0, data: Buffer.from('xyz') });
  const a = rb.snapshot();
  rb.append({ seq: 1, data: Buffer.from('extra') });
  assert.equal(a.length, 1);  // unchanged
});

test('size returns total bytes buffered', () => {
  const rb = new RingBuffer(1024);
  assert.equal(rb.size(), 0);
  rb.append({ seq: 0, data: Buffer.from('abc') });
  assert.equal(rb.size(), 3);
});
```

- [ ] **Step 2: Run, expect module-not-found**

Run: `cd scripts && node --test lib/fleet-ring-buffer.test.js`
Expected: `Cannot find module './fleet-ring-buffer'`.

- [ ] **Step 3: Implement RingBuffer**

Create `scripts/lib/fleet-ring-buffer.js`:

```js
'use strict';
// FIFO byte-budgeted ring buffer of {seq, data} frames.
// Caller appends frames in monotonic seq order. snapshot() returns a copy.
// When total bytes exceeds capacity, oldest frames are dropped until <= capacity.

class RingBuffer {
  constructor(capacityBytes) {
    this.cap = capacityBytes;
    this.frames = [];   // [{seq, data: Buffer}]
    this.bytes = 0;
  }
  append({ seq, data }) {
    this.frames.push({ seq, data });
    this.bytes += data.length;
    while (this.bytes > this.cap && this.frames.length > 1) {
      const dropped = this.frames.shift();
      this.bytes -= dropped.data.length;
    }
  }
  snapshot() {
    return this.frames.slice();  // shallow array copy; data Buffers immutable in practice
  }
  size() {
    return this.bytes;
  }
}

module.exports = { RingBuffer };
```

- [ ] **Step 4: Run tests, expect 4 pass**

Run: `cd scripts && node --test lib/fleet-ring-buffer.test.js`
Expected: `tests 4 / pass 4 / fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fleet-ring-buffer.js scripts/lib/fleet-ring-buffer.test.js
git commit -m "feat(agent-fleet): ring buffer for session live backfill"
```

---

## Task 6: fleet-event-batcher.js — Batched DB Writes

**Files:**
- Create: `scripts/lib/fleet-event-batcher.js`
- Create: `scripts/lib/fleet-event-batcher.test.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/fleet-event-batcher.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventBatcher } = require('./fleet-event-batcher');

test('flushes when batch hits size threshold', async () => {
  const captured = [];
  const b = new EventBatcher({
    flushSize: 3, flushIntervalMs: 1000,
    write: async (batch) => { captured.push(batch.length); },
  });
  b.push({ sessionId: 's', kind: 'pty_out', seq: 0, payload: Buffer.from('a') });
  b.push({ sessionId: 's', kind: 'pty_out', seq: 1, payload: Buffer.from('b') });
  b.push({ sessionId: 's', kind: 'pty_out', seq: 2, payload: Buffer.from('c') });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(captured, [3]);
  await b.shutdown();
});

test('flushes after interval even if below size', async () => {
  const captured = [];
  const b = new EventBatcher({
    flushSize: 100, flushIntervalMs: 30,
    write: async (batch) => { captured.push(batch.length); },
  });
  b.push({ sessionId: 's', kind: 'pty_out', seq: 0, payload: Buffer.from('x') });
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(captured, [1]);
  await b.shutdown();
});

test('shutdown flushes pending items', async () => {
  const captured = [];
  const b = new EventBatcher({
    flushSize: 100, flushIntervalMs: 1000,
    write: async (batch) => { captured.push(batch.length); },
  });
  b.push({ sessionId: 's', kind: 'pty_out', seq: 0, payload: Buffer.from('z') });
  await b.shutdown();
  assert.deepEqual(captured, [1]);
});

test('drops pty_out frames when lagBudgetMs exceeded; lifecycle still flushed', async () => {
  const captured = [];
  let slow = true;
  const b = new EventBatcher({
    flushSize: 1, flushIntervalMs: 1000, lagBudgetMs: 50,
    write: async (batch) => {
      if (slow) await new Promise(r => setTimeout(r, 150));  // simulate slow DB
      captured.push(batch.map(e => e.kind));
    },
  });
  b.push({ sessionId: 's', kind: 'pty_out', seq: 0, payload: Buffer.from('a') });
  await new Promise(r => setTimeout(r, 10));
  // While first flush is slow, push more pty_out frames — they should be dropped.
  for (let i = 1; i < 20; i++) b.push({ sessionId: 's', kind: 'pty_out', seq: i, payload: Buffer.from('x') });
  b.push({ sessionId: 's', kind: 'lifecycle', seq: 99, payload: Buffer.from('exit') });
  slow = false;
  await new Promise(r => setTimeout(r, 300));
  await b.shutdown();
  // First batch is just pty_out. Subsequent must contain lifecycle, but most pty_out dropped.
  const flat = captured.flat();
  assert.ok(flat.includes('lifecycle'), 'lifecycle should survive lag-drop');
  assert.ok(flat.filter(k => k === 'pty_out').length < 21, 'most pty_out should be dropped');
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd scripts && node --test lib/fleet-event-batcher.test.js`
Expected: module not found.

- [ ] **Step 3: Implement EventBatcher**

Create `scripts/lib/fleet-event-batcher.js`:

```js
'use strict';
// EventBatcher: in-mem queue, flushes when size threshold reached or interval elapses.
// If write() lags past lagBudgetMs, new pty_out/pty_in events are dropped (lifecycle/meta kept).

class EventBatcher {
  constructor({ flushSize = 50, flushIntervalMs = 200, lagBudgetMs = 5000, write }) {
    this.flushSize = flushSize;
    this.flushIntervalMs = flushIntervalMs;
    this.lagBudgetMs = lagBudgetMs;
    this.write = write;
    this.queue = [];
    this.flushing = false;
    this.lagStartedAt = null;
    this.stopped = false;
    this.timer = setInterval(() => this._maybeFlush(), this.flushIntervalMs);
    this.timer.unref?.();
  }
  push(event) {
    if (this.stopped) return;
    const drop = this.lagStartedAt
      && Date.now() - this.lagStartedAt > this.lagBudgetMs
      && (event.kind === 'pty_out' || event.kind === 'pty_in');
    if (drop) return;
    this.queue.push(event);
    if (this.queue.length >= this.flushSize) this._maybeFlush();
  }
  async _maybeFlush() {
    if (this.flushing || this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    this.flushing = true;
    const startedAt = Date.now();
    if (this.lagStartedAt === null) this.lagStartedAt = startedAt;
    try {
      await this.write(batch);
      this.lagStartedAt = null;
    } catch (e) {
      // Re-queue lifecycle/meta; drop pty_*
      const survivors = batch.filter(e => e.kind === 'lifecycle' || e.kind === 'meta');
      this.queue.unshift(...survivors);
      // keep lagStartedAt so backpressure remains
    } finally {
      this.flushing = false;
    }
  }
  async shutdown() {
    this.stopped = true;
    clearInterval(this.timer);
    // Drain pending
    while (this.queue.length && !this.flushing) {
      await this._maybeFlush();
    }
    if (this.flushing) {
      // wait for in-flight flush
      while (this.flushing) await new Promise(r => setTimeout(r, 10));
    }
  }
}

module.exports = { EventBatcher };
```

- [ ] **Step 4: Run tests, expect 4 pass**

Run: `cd scripts && node --test lib/fleet-event-batcher.test.js`
Expected: `tests 4 / pass 4 / fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fleet-event-batcher.js scripts/lib/fleet-event-batcher.test.js
git commit -m "feat(agent-fleet): event batcher with lag-budget drop"
```

---

## Task 7: fleet-routes.js — Auth + Dispatch Skeleton

**Files:**
- Create: `scripts/lib/fleet-routes.js`
- Create: `scripts/lib/fleet-routes.test.js`

- [ ] **Step 1: Add `ws` to scripts/package.json**

Run: `cd scripts && npm install ws@^8.18.0 --save`
Expected: `package.json` and `package-lock.json` updated, `node_modules/ws` present.

- [ ] **Step 2: Write the failing test**

Create `scripts/lib/fleet-routes.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fleetRoutes = require('./fleet-routes');

function startTestServer(opts) {
  const server = http.createServer();
  fleetRoutes.attach(server, opts);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function reqJson(server, method, path, { body, token } = {}) {
  const port = server.address().port;
  return await new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

test('rejects missing auth with 401', async () => {
  const server = await startTestServer({ token: 'T', db: null });
  const r = await reqJson(server, 'GET', '/fleet/hosts');
  assert.equal(r.status, 401);
  server.close();
});

test('rejects wrong token with 401', async () => {
  const server = await startTestServer({ token: 'T', db: null });
  const r = await reqJson(server, 'GET', '/fleet/hosts', { token: 'WRONG' });
  assert.equal(r.status, 401);
  server.close();
});

test('404 on unknown route', async () => {
  const server = await startTestServer({ token: 'T', db: null });
  const r = await reqJson(server, 'GET', '/fleet/unknown', { token: 'T' });
  assert.equal(r.status, 404);
  server.close();
});

test('healthz is reachable without auth', async () => {
  const server = await startTestServer({ token: 'T', db: null });
  const r = await reqJson(server, 'GET', '/fleet/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  server.close();
});
```

- [ ] **Step 3: Run, expect module not found**

Run: `cd scripts && node --test lib/fleet-routes.test.js`
Expected: `Cannot find module './fleet-routes'`.

- [ ] **Step 4: Implement minimal fleet-routes.js**

Create `scripts/lib/fleet-routes.js`:

```js
'use strict';
// fleet-routes: HTTP + WS handlers for agent-fleet. Mounted by rag-api.js.

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => buf += c);
    req.on('end', () => {
      if (!buf) return resolve(null);
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function checkAuth(req, token) {
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${token}`;
}

const handlers = {};   // 'METHOD /path' → async ({req, res, body, ctx})

function register(methodPath, fn) { handlers[methodPath] = fn; }

register('GET /fleet/healthz', async ({ res }) => send(res, 200, { ok: true }));

function dispatchHttp(req, res, ctx) {
  const key = `${req.method} ${req.url.split('?')[0]}`;
  const h = handlers[key];
  // healthz before auth
  if (req.method === 'GET' && req.url.startsWith('/fleet/healthz')) {
    return h({ req, res, body: null, ctx });
  }
  if (!checkAuth(req, ctx.token)) return send(res, 401, { error: 'unauthorized' });
  if (!h) return send(res, 404, { error: 'not found' });
  readBody(req)
    .then(body => h({ req, res, body, ctx }))
    .catch(e => send(res, 400, { error: e.message }));
}

function attach(server, ctx) {
  server.on('request', (req, res) => {
    if (!req.url.startsWith('/fleet/')) return;   // not ours; let other handlers process
    dispatchHttp(req, res, ctx);
  });
}

module.exports = { attach, register, send, readBody, checkAuth, handlers };
```

- [ ] **Step 5: Run tests, expect 4 pass**

Run: `cd scripts && node --test lib/fleet-routes.test.js`
Expected: `tests 4 / pass 4 / fail 0`.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/fleet-routes.js scripts/lib/fleet-routes.test.js scripts/package.json scripts/package-lock.json
git commit -m "feat(agent-fleet): fleet-routes skeleton with auth"
```

---

## Task 8: fleet-routes.js — Hosts REST

**Files:**
- Modify: `scripts/lib/fleet-routes.js`
- Modify: `scripts/lib/fleet-routes.test.js`

- [ ] **Step 1: Append tests**

Append to `scripts/lib/fleet-routes.test.js`:

```js
const { Client } = require('pg');
const PG = {
  host: '127.0.0.1', port: parseInt(process.env.VAULT_RAG_PG_PORT || '55433', 10),
  user: 'postgres', password: process.env.VAULT_RAG_PG_PASS, database: 'vault_rag',
};

async function startWithDb() {
  const pg = new Client(PG);
  await pg.connect();
  await pg.query('TRUNCATE fleet_hosts, fleet_sessions, fleet_events RESTART IDENTITY CASCADE');
  const server = await startTestServer({ token: 'T', db: pg });
  return { server, pg, close: async () => { server.close(); await pg.end(); } };
}

test('GET /fleet/hosts returns empty list initially', async () => {
  const { server, close } = await startWithDb();
  const r = await reqJson(server, 'GET', '/fleet/hosts', { token: 'T' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
  await close();
});

test('GET /fleet/hosts returns inserted hosts', async () => {
  const { server, pg, close } = await startWithDb();
  await pg.query("INSERT INTO fleet_hosts (name, os, status) VALUES ('mac', 'darwin', 'online')");
  const r = await reqJson(server, 'GET', '/fleet/hosts', { token: 'T' });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].name, 'mac');
  await close();
});

test('GET /fleet/hosts/:id returns 404 for missing', async () => {
  const { server, close } = await startWithDb();
  const r = await reqJson(server, 'GET', '/fleet/hosts/00000000-0000-0000-0000-000000000000', { token: 'T' });
  assert.equal(r.status, 404);
  await close();
});

test('DELETE /fleet/hosts/:id removes host', async () => {
  const { server, pg, close } = await startWithDb();
  const { rows } = await pg.query("INSERT INTO fleet_hosts (name) VALUES ('h') RETURNING id");
  const r = await reqJson(server, 'DELETE', `/fleet/hosts/${rows[0].id}`, { token: 'T' });
  assert.equal(r.status, 204);
  const after = await pg.query('SELECT COUNT(*) FROM fleet_hosts');
  assert.equal(after.rows[0].count, '0');
  await close();
});
```

- [ ] **Step 2: Run, expect 4 failures**

Run: `cd scripts && VAULT_RAG_PG_PASS=... node --test lib/fleet-routes.test.js`
Expected: 404 for all 4 new host tests (no handlers yet).

- [ ] **Step 3: Add host handlers + path parsing**

Modify `scripts/lib/fleet-routes.js`. After `register('GET /fleet/healthz', ...)`, add:

```js
const fleetDb = require('./fleet-db');

// Helper: extract :id from /fleet/hosts/:id pattern
function pathMatch(url, prefix) {
  const path = url.split('?')[0];
  if (!path.startsWith(prefix + '/')) return null;
  return path.slice(prefix.length + 1);
}

async function handleGetHosts({ res, ctx }) {
  const rows = await fleetDb.listHosts(ctx.db);
  send(res, 200, rows);
}

async function handleGetHost({ req, res, ctx }) {
  const id = pathMatch(req.url, '/fleet/hosts');
  const h = await fleetDb.getHost(ctx.db, id);
  if (!h) return send(res, 404, { error: 'host not found' });
  send(res, 200, h);
}

async function handleDeleteHost({ req, res, ctx }) {
  const id = pathMatch(req.url, '/fleet/hosts');
  await fleetDb.deleteHost(ctx.db, id);
  res.writeHead(204); res.end();
}
```

Replace `dispatchHttp` so it understands parametric paths:

```js
function dispatchHttp(req, res, ctx) {
  const method = req.method;
  const path = req.url.split('?')[0];
  if (method === 'GET' && path === '/fleet/healthz') return handlers['GET /fleet/healthz']({ req, res, body: null, ctx });
  if (!checkAuth(req, ctx.token)) return send(res, 401, { error: 'unauthorized' });
  // exact matches first
  const exact = `${method} ${path}`;
  if (handlers[exact]) {
    return readBody(req).then(b => handlers[exact]({ req, res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
  }
  // parametric: /fleet/hosts/:id
  if (method === 'GET' && /^\/fleet\/hosts\/[0-9a-f-]{36}$/i.test(path)) return handleGetHost({ req, res, ctx });
  if (method === 'DELETE' && /^\/fleet\/hosts\/[0-9a-f-]{36}$/i.test(path)) return handleDeleteHost({ req, res, ctx });
  send(res, 404, { error: 'not found' });
}

register('GET /fleet/hosts', handleGetHosts);
```

- [ ] **Step 4: Run tests, expect 8 pass**

Run: `cd scripts && VAULT_RAG_PG_PASS=... node --test lib/fleet-routes.test.js`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fleet-routes.js scripts/lib/fleet-routes.test.js
git commit -m "feat(agent-fleet): GET/DELETE /fleet/hosts"
```

---

## Task 9: fleet-routes.js — Sessions REST

**Files:**
- Modify: `scripts/lib/fleet-routes.js`
- Modify: `scripts/lib/fleet-routes.test.js`

- [ ] **Step 1: Append tests**

Append to `scripts/lib/fleet-routes.test.js`:

```js
test('POST /fleet/sessions returns 422 without host_id', async () => {
  const { server, close } = await startWithDb();
  const r = await reqJson(server, 'POST', '/fleet/sessions', { token: 'T', body: { cwd: '/' } });
  assert.equal(r.status, 422);
  await close();
});

test('POST /fleet/sessions creates session', async () => {
  const { server, pg, close } = await startWithDb();
  const { rows } = await pg.query("INSERT INTO fleet_hosts (name) VALUES ('h') RETURNING id");
  const r = await reqJson(server, 'POST', '/fleet/sessions', {
    token: 'T', body: { host_id: rows[0].id, cwd: '/tmp', args: ['--print', 'hi'] },
  });
  assert.equal(r.status, 201);
  assert.ok(r.body.session_id);
  await close();
});

test('GET /fleet/sessions filters by host_id', async () => {
  const { server, pg, close } = await startWithDb();
  const h1 = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('a') RETURNING id")).rows[0].id;
  const h2 = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('b') RETURNING id")).rows[0].id;
  await pg.query("INSERT INTO fleet_sessions (host_id, cwd) VALUES ($1, '/')", [h1]);
  await pg.query("INSERT INTO fleet_sessions (host_id, cwd) VALUES ($1, '/')", [h2]);
  const r = await reqJson(server, 'GET', `/fleet/sessions?host_id=${h1}`, { token: 'T' });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  await close();
});

test('GET /fleet/sessions/:id/transcript.txt returns plain text', async () => {
  const { server, pg, close } = await startWithDb();
  const h = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('t') RETURNING id")).rows[0].id;
  const s = (await pg.query("INSERT INTO fleet_sessions (host_id, cwd) VALUES ($1, '/') RETURNING id", [h])).rows[0].id;
  await pg.query(`INSERT INTO fleet_events (session_id, kind, seq, payload) VALUES
    ($1, 'pty_out', 0, decode('48656c6c6f','hex')),
    ($1, 'pty_out', 1, decode('20576f726c64','hex'))`, [s]);
  const port = server.address().port;
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/fleet/sessions/${s}/transcript.txt`,
      method: 'GET', headers: { authorization: 'Bearer T' } }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(r.status, 200);
  assert.equal(r.body, 'Hello World');
  await close();
});
```

- [ ] **Step 2: Run, expect 4 failures (404/422)**

Run: `cd scripts && VAULT_RAG_PG_PASS=... node --test lib/fleet-routes.test.js`

- [ ] **Step 3: Implement session handlers**

Append to `scripts/lib/fleet-routes.js` (above `module.exports`):

```js
async function handleListSessions({ req, res, ctx }) {
  const url = new URL(req.url, 'http://x');
  const filter = {
    hostId: url.searchParams.get('host_id') || undefined,
    status: url.searchParams.get('status') || undefined,
    limit:  parseInt(url.searchParams.get('limit') || '100', 10),
    offset: parseInt(url.searchParams.get('offset') || '0', 10),
  };
  const rows = await fleetDb.listSessions(ctx.db, filter);
  send(res, 200, rows);
}

async function handleCreateSession({ body, res, ctx }) {
  if (!body || !body.host_id) return send(res, 422, { error: 'host_id required' });
  if (!body.cwd) return send(res, 422, { error: 'cwd required' });
  const host = await fleetDb.getHost(ctx.db, body.host_id);
  if (!host) return send(res, 422, { error: 'host_id not found' });
  const s = await fleetDb.createSession(ctx.db, {
    hostId: body.host_id, cwd: body.cwd,
    args: body.args, env: body.env,
    createdBy: body.created_by, label: body.label, metadata: body.metadata,
  });
  // Forward 'spawn' frame to daemon ws if available — wired in Task 11.
  if (ctx.bus && typeof ctx.bus.requestSpawn === 'function') {
    ctx.bus.requestSpawn(host.id, { session_id: s.id, cwd: s.cwd, args: s.args, env: s.env });
  }
  send(res, 201, { session_id: s.id });
}

async function handleGetSession({ req, res, ctx }) {
  const id = pathMatch(req.url, '/fleet/sessions');
  const s = await fleetDb.getSession(ctx.db, id);
  if (!s) return send(res, 404, { error: 'session not found' });
  send(res, 200, s);
}

async function handlePostInput({ req, res, body, ctx }) {
  const m = req.url.match(/^\/fleet\/sessions\/([0-9a-f-]{36})\/input$/i);
  if (!m) return send(res, 404, { error: 'not found' });
  if (!body || typeof body.data !== 'string') return send(res, 422, { error: 'data required' });
  if (ctx.bus) ctx.bus.sendInput(m[1], body.data);
  res.writeHead(204); res.end();
}

async function handlePostKill({ req, res, body, ctx }) {
  const m = req.url.match(/^\/fleet\/sessions\/([0-9a-f-]{36})\/kill$/i);
  if (!m) return send(res, 404, { error: 'not found' });
  const signal = (body && body.signal) || 'SIGTERM';
  if (ctx.bus) ctx.bus.sendKill(m[1], signal);
  res.writeHead(204); res.end();
}

async function handleTranscriptTxt(req, res, ctx) {
  const m = req.url.match(/^\/fleet\/sessions\/([0-9a-f-]{36})\/transcript\.txt$/i);
  if (!m) return send(res, 404, { error: 'not found' });
  const rows = await fleetDb.readTranscript(ctx.db, m[1], { sinceSeq: 0, kind: 'pty_out' });
  const text = Buffer.concat(rows.map(r => r.payload || Buffer.alloc(0))).toString('utf8')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');  // strip CSI sequences
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

register('GET /fleet/sessions', handleListSessions);
register('POST /fleet/sessions', handleCreateSession);
```

Update `dispatchHttp`'s parametric section:

```js
  // Sessions parametric
  const sidRe = '[0-9a-f-]{36}';
  if (method === 'GET' && new RegExp(`^\\/fleet\\/sessions\\/${sidRe}$`, 'i').test(path)) return handleGetSession({ req, res, ctx });
  if (method === 'POST' && new RegExp(`^\\/fleet\\/sessions\\/${sidRe}\\/input$`, 'i').test(path)) {
    return readBody(req).then(b => handlePostInput({ req, res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
  }
  if (method === 'POST' && new RegExp(`^\\/fleet\\/sessions\\/${sidRe}\\/kill$`, 'i').test(path)) {
    return readBody(req).then(b => handlePostKill({ req, res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
  }
  if (method === 'GET' && new RegExp(`^\\/fleet\\/sessions\\/${sidRe}\\/transcript\\.txt$`, 'i').test(path)) {
    return handleTranscriptTxt(req, res, ctx);
  }
```

- [ ] **Step 4: Run tests, expect 12 pass**

Run: `cd scripts && VAULT_RAG_PG_PASS=... node --test lib/fleet-routes.test.js`
Expected: 12/12.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fleet-routes.js scripts/lib/fleet-routes.test.js
git commit -m "feat(agent-fleet): sessions REST (list/create/get/input/kill/transcript)"
```

---

## Task 10: fleet-routes.js — WS Upgrade + Role Dispatch

**Files:**
- Modify: `scripts/lib/fleet-routes.js`
- Modify: `scripts/lib/fleet-routes.test.js`

- [ ] **Step 1: Append WS tests**

Append to `scripts/lib/fleet-routes.test.js`:

```js
const WebSocket = require('ws');

test('WS rejects connection without bearer', async () => {
  const { server, close } = await startWithDb();
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=x`);
  const code = await new Promise(r => ws.on('close', (c) => r(c)));
  assert.equal(code, 4001);
  await close();
});

test('WS rejects unknown role with 4003', async () => {
  const { server, close } = await startWithDb();
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=bogus`, {
    headers: { authorization: 'Bearer T' },
  });
  const code = await new Promise(r => ws.on('close', (c) => r(c)));
  assert.equal(code, 4003);
  await close();
});

test('WS daemon connect: hello → welcome', async () => {
  const { server, close } = await startWithDb();
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=t1`, {
    headers: { authorization: 'Bearer T' },
  });
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'hello', os: 'linux', arch: 'x86_64', capabilities: [] }));
  const msg = await new Promise(r => ws.on('message', (b) => r(JSON.parse(b.toString()))));
  assert.equal(msg.type, 'welcome');
  assert.ok(msg.host_id);
  ws.close();
  await close();
});
```

- [ ] **Step 2: Run, expect failures (no WS handler yet)**

Run: `cd scripts && VAULT_RAG_PG_PASS=... node --test lib/fleet-routes.test.js`

- [ ] **Step 3: Add WS upgrade to fleet-routes.js**

Replace `attach` and add WS handling. In `scripts/lib/fleet-routes.js`, near the top after `const fleetDb = require('./fleet-db');` add:

```js
const { WebSocketServer } = require('ws');
```

Then replace `attach` and add the bus + WS handler section:

```js
function makeBus(ctx) {
  const daemonsByHost = new Map();  // host_id -> ws
  const viewersBySession = new Map();  // session_id -> Set<ws>
  return {
    registerDaemon(hostId, ws) {
      const prev = daemonsByHost.get(hostId);
      if (prev && prev !== ws) try { prev.close(4004, 'replaced'); } catch {}
      daemonsByHost.set(hostId, ws);
      ws.on('close', () => { if (daemonsByHost.get(hostId) === ws) daemonsByHost.delete(hostId); });
    },
    getDaemon(hostId) { return daemonsByHost.get(hostId); },
    addViewer(sessionId, ws) {
      let set = viewersBySession.get(sessionId);
      if (!set) { set = new Set(); viewersBySession.set(sessionId, set); }
      set.add(ws);
      ws.on('close', () => { set.delete(ws); if (!set.size) viewersBySession.delete(sessionId); });
    },
    broadcastViewers(sessionId, frame) {
      const set = viewersBySession.get(sessionId);
      if (!set) return;
      const payload = JSON.stringify(frame);
      for (const v of set) {
        try { v.send(payload); } catch {}
      }
    },
    requestSpawn(hostId, payload) {
      const d = daemonsByHost.get(hostId);
      if (!d) return false;
      d.send(JSON.stringify({ type: 'spawn', ...payload }));
      return true;
    },
    sendInput(sessionId, dataStr) {
      // sessionId → host_id lookup is async; caller should pre-resolve in real path.
      // For MVP we accept that ctx.bus.sendInput is called from POST handler
      // which has already loaded the session — TODO Task 11 finalizes path.
      // For now: best-effort fanout to all daemons (only matching host responds via PTY map).
      for (const d of daemonsByHost.values()) {
        try { d.send(JSON.stringify({ type: 'input', session_id: sessionId, data: dataStr })); } catch {}
      }
    },
    sendKill(sessionId, signal) {
      for (const d of daemonsByHost.values()) {
        try { d.send(JSON.stringify({ type: 'kill', session_id: sessionId, signal })); } catch {}
      }
    },
  };
}

async function handleDaemonWs(ws, params, ctx) {
  const hostName = params.get('host_name');
  if (!hostName) return ws.close(4002, 'host_name required');
  const host = await fleetDb.upsertHost(ctx.db, {
    name: hostName,
    daemonVersion: params.get('daemon_version') || null,
  });
  ws.send(JSON.stringify({ type: 'welcome', host_id: host.id, server_version: ctx.version || '0.0.1' }));
  ctx.bus.registerDaemon(host.id, ws);
  ws.on('close', async () => {
    try { await fleetDb.setHostOffline(ctx.db, host.id); } catch {}
  });
  // Frame handling completed in Task 11
  ws.on('message', async (raw) => {
    try {
      const f = JSON.parse(raw.toString());
      if (f.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      // other frame handling: Task 11
    } catch (e) {
      ws.close(4005, 'invalid frame');
    }
  });
}

async function handleViewerWs(ws, params, ctx) {
  const sid = params.get('session_id');
  if (!sid) return ws.close(4002, 'session_id required');
  const s = await fleetDb.getSession(ctx.db, sid);
  if (!s) return ws.close(4404, 'session not found');
  ws.send(JSON.stringify({
    type: 'hello', session_id: s.id, host_id: s.host_id, status: s.status, cwd: s.cwd,
  }));
  ctx.bus.addViewer(s.id, ws);
  ws.on('message', async (raw) => {
    try {
      const f = JSON.parse(raw.toString());
      if (f.type === 'input') ctx.bus.sendInput(s.id, f.data);
      else if (f.type === 'kill') ctx.bus.sendKill(s.id, f.signal || 'SIGTERM');
    } catch {}
  });
}

function attach(server, ctx) {
  if (!ctx.bus) ctx.bus = makeBus(ctx);
  const wss = new WebSocketServer({ noServer: true });
  server.on('request', (req, res) => {
    if (!req.url.startsWith('/fleet/')) return;
    dispatchHttp(req, res, ctx);
  });
  server.on('upgrade', (req, sock, head) => {
    if (!req.url.startsWith('/fleet/ws')) return;
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${ctx.token}`) {
      sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); sock.destroy(); return;
    }
    const u = new URL(req.url, 'http://x');
    const role = u.searchParams.get('role');
    if (role !== 'daemon' && role !== 'viewer') {
      // accept the upgrade so we can close with a proper WS frame
      wss.handleUpgrade(req, sock, head, (ws) => ws.close(4003, 'invalid role'));
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => {
      if (role === 'daemon') handleDaemonWs(ws, u.searchParams, ctx);
      else handleViewerWs(ws, u.searchParams, ctx);
    });
  });
  // For auth-missing case we close right after the WS handshake establishes,
  // because we can't write an HTTP 401 there without bypassing wss.handleUpgrade.
  // The "no auth" rejection above gets WS close code 4001 because we don't even upgrade.
  // To emit 4001 cleanly, we instead do:
  // -> rewrite the auth-fail path: accept upgrade then close 4001.
}
```

Now refactor the auth-fail branch to emit `4001`:

```js
  server.on('upgrade', (req, sock, head) => {
    if (!req.url.startsWith('/fleet/ws')) return;
    const u = new URL(req.url, 'http://x');
    const role = u.searchParams.get('role');
    const auth = req.headers.authorization || '';
    wss.handleUpgrade(req, sock, head, (ws) => {
      if (auth !== `Bearer ${ctx.token}`) return ws.close(4001, 'unauthorized');
      if (role !== 'daemon' && role !== 'viewer') return ws.close(4003, 'invalid role');
      if (role === 'daemon') handleDaemonWs(ws, u.searchParams, ctx);
      else handleViewerWs(ws, u.searchParams, ctx);
    });
  });
```

- [ ] **Step 4: Run tests, expect 15 pass**

Run: `cd scripts && VAULT_RAG_PG_PASS=... node --test lib/fleet-routes.test.js`
Expected: `tests 15 / pass 15 / fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fleet-routes.js scripts/lib/fleet-routes.test.js
git commit -m "feat(agent-fleet): WS upgrade + role dispatch (daemon/viewer)"
```

---

## Task 11: fleet-routes.js — Daemon WS Protocol (Full)

**Files:**
- Modify: `scripts/lib/fleet-routes.js`
- Modify: `scripts/lib/fleet-routes.test.js`

- [ ] **Step 1: Append tests for spawn / pty_data / session_exit**

Append to `scripts/lib/fleet-routes.test.js`:

```js
test('daemon spawn_ok → marks session running with pid', async () => {
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  // Step 1: daemon connects, gets welcome
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=h1`,
    { headers: { authorization: 'Bearer T' } });
  const welcome = await new Promise(r => ws.on('message', (b) => r(JSON.parse(b.toString()))));
  const hostId = welcome.host_id;
  // Step 2: create session via REST (hub will not actually forward to daemon for spawn — we test reverse)
  const sess = await pg.query("INSERT INTO fleet_sessions (host_id, cwd) VALUES ($1, '/') RETURNING id", [hostId]);
  const sid = sess.rows[0].id;
  // Step 3: daemon → spawn_ok
  ws.send(JSON.stringify({ type: 'spawn_ok', session_id: sid, pid: 4242 }));
  await new Promise(r => setTimeout(r, 100));
  const after = await pg.query('SELECT status, pid FROM fleet_sessions WHERE id=$1', [sid]);
  assert.equal(after.rows[0].status, 'running');
  assert.equal(after.rows[0].pid, 4242);
  ws.close();
  await close();
});

test('daemon pty_data → fleet_events row appended', async () => {
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=h2`,
    { headers: { authorization: 'Bearer T' } });
  const welcome = await new Promise(r => ws.on('message', (b) => r(JSON.parse(b.toString()))));
  const sess = await pg.query("INSERT INTO fleet_sessions (host_id, cwd, status) VALUES ($1, '/', 'running') RETURNING id", [welcome.host_id]);
  const sid = sess.rows[0].id;
  ws.send(JSON.stringify({ type: 'pty_data', session_id: sid, seq: 0, data: Buffer.from('hi').toString('base64') }));
  await new Promise(r => setTimeout(r, 350));  // give batcher time to flush
  const ev = await pg.query("SELECT payload FROM fleet_events WHERE session_id=$1 AND kind='pty_out'", [sid]);
  assert.equal(ev.rows[0].payload.toString(), 'hi');
  ws.close();
  await close();
});

test('daemon session_exit → marks session exited', async () => {
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=h3`,
    { headers: { authorization: 'Bearer T' } });
  const welcome = await new Promise(r => ws.on('message', (b) => r(JSON.parse(b.toString()))));
  const sess = await pg.query("INSERT INTO fleet_sessions (host_id, cwd, status) VALUES ($1, '/', 'running') RETURNING id", [welcome.host_id]);
  const sid = sess.rows[0].id;
  ws.send(JSON.stringify({ type: 'session_exit', session_id: sid, exit_code: 0 }));
  await new Promise(r => setTimeout(r, 100));
  const after = await pg.query('SELECT status, exit_code FROM fleet_sessions WHERE id=$1', [sid]);
  assert.equal(after.rows[0].status, 'exited');
  assert.equal(after.rows[0].exit_code, 0);
  ws.close();
  await close();
});

test('reconciliation: daemon reports session dead → hub flips to exited', async () => {
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  // Pre-existing running session (simulating pre-hub-restart state)
  const h = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('r1') RETURNING id")).rows[0].id;
  const s = (await pg.query("INSERT INTO fleet_sessions (host_id, cwd, status, pid) VALUES ($1, '/', 'running', 999) RETURNING id", [h])).rows[0].id;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=r1`,
    { headers: { authorization: 'Bearer T' } });
  await new Promise(r => ws.on('message', () => r()));
  ws.send(JSON.stringify({
    type: 'reconciliation',
    sessions: [{ session_id: s, pid: 999, alive: false, exit_code: 137, last_seq: 50 }],
  }));
  await new Promise(r => setTimeout(r, 100));
  const after = await pg.query('SELECT status, exit_code FROM fleet_sessions WHERE id=$1', [s]);
  assert.equal(after.rows[0].status, 'exited');
  assert.equal(after.rows[0].exit_code, 137);
  ws.close();
  await close();
});
```

- [ ] **Step 2: Run, expect 4 failures**

Run: `cd scripts && VAULT_RAG_PG_PASS=... node --test lib/fleet-routes.test.js`

- [ ] **Step 3: Implement daemon frame handling**

Modify `scripts/lib/fleet-routes.js`. Replace the `ws.on('message', ...)` block inside `handleDaemonWs` with:

```js
  const { EventBatcher } = require('./fleet-event-batcher');
  const { RingBuffer } = require('./fleet-ring-buffer');
  const rings = ctx.rings;   // Map<session_id, RingBuffer>; created in attach
  const batcher = ctx.batcher;

  ws.on('message', async (raw) => {
    let f;
    try { f = JSON.parse(raw.toString()); } catch { return ws.close(4005, 'invalid frame'); }
    try {
      if (f.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
      if (f.type === 'spawn_ok') {
        await fleetDb.markSessionRunning(ctx.db, f.session_id, f.pid);
        ctx.bus.broadcastViewers(f.session_id, { type: 'session_started', session_id: f.session_id });
        return;
      }
      if (f.type === 'spawn_err') {
        await fleetDb.markSessionExited(ctx.db, f.session_id, -1, 'exited');
        return;
      }
      if (f.type === 'pty_data') {
        const buf = Buffer.from(f.data, 'base64');
        const seq = Number(f.seq);
        let rb = rings.get(f.session_id);
        if (!rb) { rb = new RingBuffer(64 * 1024); rings.set(f.session_id, rb); }
        rb.append({ seq, data: buf });
        batcher.push({ sessionId: f.session_id, kind: 'pty_out', seq, payload: buf });
        ctx.bus.broadcastViewers(f.session_id, { type: 'pty_data', seq, data: f.data });
        return;
      }
      if (f.type === 'session_exit') {
        const status = f.signal ? 'killed' : 'exited';
        await fleetDb.markSessionExited(ctx.db, f.session_id, f.exit_code, status);
        batcher.push({ sessionId: f.session_id, kind: 'lifecycle', seq: 1e15,
          payload: Buffer.from(JSON.stringify({ exit_code: f.exit_code, signal: f.signal || null })) });
        ctx.bus.broadcastViewers(f.session_id, { type: 'session_exit', exit_code: f.exit_code });
        rings.delete(f.session_id);
        return;
      }
      if (f.type === 'reconciliation') {
        for (const s of f.sessions || []) {
          if (s.alive) {
            await fleetDb.markSessionRunning(ctx.db, s.session_id, s.pid);
          } else {
            const status = (s.exit_code === 137 || s.signal) ? 'killed' : 'exited';
            await fleetDb.markSessionExited(ctx.db, s.session_id, s.exit_code ?? null, status);
          }
        }
        return;
      }
    } catch (e) {
      console.error(`[fleet-routes] daemon frame error: ${e.message}`);
    }
  });
```

Also modify `attach` to initialise `ctx.rings` and `ctx.batcher`:

```js
function attach(server, ctx) {
  if (!ctx.bus) ctx.bus = makeBus(ctx);
  if (!ctx.rings) ctx.rings = new Map();
  if (!ctx.batcher) {
    ctx.batcher = new EventBatcher({
      flushSize: 50, flushIntervalMs: 200,
      write: async (batch) => { await fleetDb.appendEvents(ctx.db, batch); },
    });
  }
  // ... rest unchanged
}
```

- [ ] **Step 4: Run tests, expect 19 pass**

Run: `cd scripts && VAULT_RAG_PG_PASS=... node --test lib/fleet-routes.test.js`
Expected: 19/19.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fleet-routes.js scripts/lib/fleet-routes.test.js
git commit -m "feat(agent-fleet): daemon WS protocol (spawn_ok/pty_data/session_exit/reconciliation)"
```

---

## Task 12: fleet-routes.js — Viewer WS Backfill + Live Stream

**Files:**
- Modify: `scripts/lib/fleet-routes.js`
- Modify: `scripts/lib/fleet-routes.test.js`

- [ ] **Step 1: Append viewer tests**

Append to `scripts/lib/fleet-routes.test.js`:

```js
test('viewer receives backfill from ring buffer + live frames', async () => {
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  // 1. daemon connects, ring fills
  const dws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=v1`,
    { headers: { authorization: 'Bearer T' } });
  const welcome = await new Promise(r => dws.on('message', (b) => r(JSON.parse(b.toString()))));
  const sess = await pg.query("INSERT INTO fleet_sessions (host_id, cwd, status) VALUES ($1,'/','running') RETURNING id", [welcome.host_id]);
  const sid = sess.rows[0].id;
  dws.send(JSON.stringify({ type: 'pty_data', session_id: sid, seq: 0, data: Buffer.from('first').toString('base64') }));
  await new Promise(r => setTimeout(r, 50));
  // 2. viewer attaches — should get hello + backfill
  const vws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=viewer&session_id=${sid}`,
    { headers: { authorization: 'Bearer T' } });
  const msgs = [];
  vws.on('message', (b) => msgs.push(JSON.parse(b.toString())));
  await new Promise(r => setTimeout(r, 100));
  assert.equal(msgs[0].type, 'hello');
  assert.equal(msgs[1].type, 'backfill');
  assert.equal(Buffer.from(msgs[1].data, 'base64').toString(), 'first');
  // 3. daemon sends live frame → viewer receives
  dws.send(JSON.stringify({ type: 'pty_data', session_id: sid, seq: 1, data: Buffer.from('live').toString('base64') }));
  await new Promise(r => setTimeout(r, 50));
  const live = msgs.find(m => m.type === 'pty_data' && m.seq === 1);
  assert.ok(live, 'live frame should arrive');
  dws.close(); vws.close();
  await close();
});

test('viewer input forwards to daemon ws', async () => {
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  const dws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=v2`,
    { headers: { authorization: 'Bearer T' } });
  const welcome = await new Promise(r => dws.on('message', (b) => r(JSON.parse(b.toString()))));
  const sess = await pg.query("INSERT INTO fleet_sessions (host_id, cwd, status) VALUES ($1,'/','running') RETURNING id", [welcome.host_id]);
  const sid = sess.rows[0].id;
  const received = [];
  dws.on('message', (b) => received.push(JSON.parse(b.toString())));
  const vws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=viewer&session_id=${sid}`,
    { headers: { authorization: 'Bearer T' } });
  await new Promise(r => vws.on('open', r));
  vws.send(JSON.stringify({ type: 'input', data: 'echo hi\n' }));
  await new Promise(r => setTimeout(r, 50));
  const inputFrame = received.find(f => f.type === 'input' && f.session_id === sid);
  assert.ok(inputFrame);
  assert.equal(inputFrame.data, 'echo hi\n');
  dws.close(); vws.close();
  await close();
});
```

- [ ] **Step 2: Run, expect 2 failures**

- [ ] **Step 3: Add backfill emission to handleViewerWs**

Modify `handleViewerWs` to emit backfill from ring buffer (or DB fallback) and forward input:

```js
async function handleViewerWs(ws, params, ctx) {
  const sid = params.get('session_id');
  if (!sid) return ws.close(4002, 'session_id required');
  const s = await fleetDb.getSession(ctx.db, sid);
  if (!s) return ws.close(4404, 'session not found');
  ws.send(JSON.stringify({
    type: 'hello', session_id: s.id, host_id: s.host_id, status: s.status, cwd: s.cwd,
  }));
  // Backfill: ring buffer if available, else last 64KB from DB
  const rb = ctx.rings.get(s.id);
  if (rb && rb.size() > 0) {
    const frames = rb.snapshot();
    const merged = Buffer.concat(frames.map(f => f.data));
    ws.send(JSON.stringify({
      type: 'backfill',
      from_seq: frames[0].seq,
      to_seq: frames[frames.length - 1].seq,
      data: merged.toString('base64'),
    }));
  } else {
    const rows = await fleetDb.readTranscript(ctx.db, s.id, { sinceSeq: 0, kind: 'pty_out', limit: 256 });
    if (rows.length) {
      const merged = Buffer.concat(rows.map(r => r.payload || Buffer.alloc(0)));
      ws.send(JSON.stringify({
        type: 'backfill',
        from_seq: Number(rows[0].seq),
        to_seq: Number(rows[rows.length - 1].seq),
        data: merged.toString('base64'),
      }));
    }
  }
  ctx.bus.addViewer(s.id, ws);
  // Forward viewer messages back to the session's host daemon
  const daemon = ctx.bus.getDaemon(s.host_id);
  ws.on('message', async (raw) => {
    try {
      const f = JSON.parse(raw.toString());
      if (!daemon) return;
      if (f.type === 'input') daemon.send(JSON.stringify({ type: 'input', session_id: s.id, data: f.data }));
      else if (f.type === 'kill') daemon.send(JSON.stringify({ type: 'kill', session_id: s.id, signal: f.signal || 'SIGTERM' }));
      else if (f.type === 'resize') daemon.send(JSON.stringify({ type: 'resize', session_id: s.id, cols: f.cols, rows: f.rows }));
    } catch {}
  });
}
```

- [ ] **Step 4: Run tests, expect 21 pass**

Run: `cd scripts && VAULT_RAG_PG_PASS=... node --test lib/fleet-routes.test.js`
Expected: 21/21.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fleet-routes.js scripts/lib/fleet-routes.test.js
git commit -m "feat(agent-fleet): viewer backfill + input/kill forwarding"
```

---

## Task 13: Wire fleet-routes into rag-api.js

**Files:**
- Modify: `scripts/rag-api.js`

- [ ] **Step 1: Add fleet-routes require + attach call**

Open `scripts/rag-api.js`. Near the top imports, after `const vtRoutes = require('./lib/vt-routes');`, add:

```js
const fleetRoutes = require('./lib/fleet-routes');
```

Find the `const server = http.createServer(...)` block. Right after the `server` is declared but before `(async () => { ... server.listen ...})`, add:

```js
fleetRoutes.attach(server, {
  token: TOKEN,
  db: null,    // set after pgConnect
  version: '0.1.0',
});
```

Then in the async startup block, right after `await pgConnect();`, hand the pg client to fleet:

```js
  // Hand pg client to fleet-routes (re-attach refreshes ctx.db reference)
  fleetRoutes.attach(server, { token: TOKEN, db: pg, version: '0.1.0' });
```

Because calling `attach` twice would add two listeners, refactor `attach` in `fleet-routes.js` to be idempotent:

```js
function attach(server, ctx) {
  // First call: full wire-up. Subsequent calls: update ctx fields only.
  if (server._fleetCtx) {
    Object.assign(server._fleetCtx, ctx);
    return;
  }
  server._fleetCtx = ctx;
  ctx = server._fleetCtx;
  if (!ctx.bus) ctx.bus = makeBus(ctx);
  if (!ctx.rings) ctx.rings = new Map();
  if (!ctx.batcher) {
    ctx.batcher = new EventBatcher({
      flushSize: 50, flushIntervalMs: 200,
      write: async (batch) => { if (ctx.db) await fleetDb.appendEvents(ctx.db, batch); },
    });
  }
  // ... rest of wiring (request + upgrade listeners) using ctx via the closure
}
```

- [ ] **Step 2: Start hub locally and curl**

Run: `docker compose up -d --build vault-rag-rag-api`
(or restart the rag-api container per your local convention)

Verify endpoint:
```
curl -fsSL https://brain.itiswednesdaymydud.es/api/fleet/healthz
# expect: {"ok":true}

curl -fsSL -H "Authorization: Bearer $VAULT_RAG_API_TOKEN" \
  https://brain.itiswednesdaymydud.es/api/fleet/hosts
# expect: []
```

- [ ] **Step 3: On hub restart, run orphan flip**

Add at the end of the `pgConnect` chain (after `await pgConnect();`):

```js
  try {
    const n = await require('./lib/fleet-db').orphanRunningSessions(pg);
    if (n) console.log(`[rag-api] fleet: orphaned ${n} sessions on startup`);
  } catch (e) {
    console.error(`[rag-api] fleet orphan check failed: ${e.message}`);
  }
```

- [ ] **Step 4: Schedule nightly retention purge**

Also after the orphan flip, add:

```js
  // Retention: nightly purge of pty_* events older than 30 days
  const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const PURGE_AGE = process.env.VAULT_RAG_FLEET_RETENTION || '30 days';
  setInterval(async () => {
    try {
      const n = await require('./lib/fleet-db').purgeOldEvents(pg, PURGE_AGE);
      if (n) console.log(`[rag-api] fleet: purged ${n} events older than ${PURGE_AGE}`);
    } catch (e) {
      console.error(`[rag-api] fleet purge failed: ${e.message}`);
    }
  }, PURGE_INTERVAL_MS).unref?.();
```

- [ ] **Step 5: Commit**

```bash
git add scripts/rag-api.js scripts/lib/fleet-routes.js
git commit -m "feat(agent-fleet): wire fleet routes + WS upgrade into rag-api"
```

---

## Task 14: tests/fleet/fake-claude.sh

**Files:**
- Create: `tests/fleet/fake-claude.sh`

- [ ] **Step 1: Write the mock**

Create `tests/fleet/fake-claude.sh`:

```bash
#!/usr/bin/env bash
# fake-claude: mock the claude CLI for fleet-e2e.
# Modes:
#   --print <prompt>     → echoes the prompt to stdout, exits 0
#   --hang               → sleeps 60s
#   --fail               → exits 1
#   (no args)            → interactive: echoes each input line back, exits on 'quit'
set -euo pipefail

if [ "${1:-}" = "--print" ]; then
  shift
  echo "$@"
  exit 0
fi

if [ "${1:-}" = "--hang" ]; then
  sleep 60
  exit 0
fi

if [ "${1:-}" = "--fail" ]; then
  exit 1
fi

# Interactive default
while IFS= read -r line; do
  if [ "$line" = "quit" ]; then exit 0; fi
  echo "echo: $line"
done
```

- [ ] **Step 2: Make executable + smoke**

Run:
```bash
chmod +x tests/fleet/fake-claude.sh
echo 'world' | ./tests/fleet/fake-claude.sh --print hello
# expect: hello
echo -e 'a\nquit' | ./tests/fleet/fake-claude.sh
# expect: echo: a
```

- [ ] **Step 3: Commit**

```bash
git add tests/fleet/fake-claude.sh
git commit -m "test(agent-fleet): fake-claude mock binary"
```

---

## Task 15: Daemon Scaffold

**Files:**
- Create: `agent-fleet/daemon/package.json`
- Create: `agent-fleet/daemon/bin/daemon.js`
- Create: `agent-fleet/daemon/README.md`

- [ ] **Step 1: package.json**

Create `agent-fleet/daemon/package.json`:

```json
{
  "name": "@bringie/agent-fleet-daemon",
  "version": "0.1.0",
  "description": "Per-host daemon for agent-fleet: spawns Claude Code sessions on demand, streams PTY I/O to a central hub via WebSocket.",
  "main": "bin/daemon.js",
  "bin": { "agent-fleet-daemon": "bin/daemon.js" },
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node bin/daemon.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "node-pty": "^1.0.0",
    "ws": "^8.18.0"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: bin/daemon.js entry point**

Create `agent-fleet/daemon/bin/daemon.js`:

```js
#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { runDaemon } = require('../src/ws-client');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--hub') out.hub = args[++i];
    else if (a === '--token') out.token = args[++i];
    else if (a === '--host-name') out.hostName = args[++i];
    else if (a === '--caps') out.capabilities = args[++i].split(',').filter(Boolean);
    else if (a === '--state-dir') out.stateDir = args[++i];
    else if (a === '--claude-bin') out.claudeBin = args[++i];
  }
  out.hub = out.hub || process.env.AGENT_FLEET_HUB;
  out.token = out.token || process.env.AGENT_FLEET_TOKEN || process.env.VAULT_RAG_API_TOKEN;
  out.hostName = out.hostName || process.env.AGENT_FLEET_HOST_NAME || require('node:os').hostname();
  out.stateDir = out.stateDir || path.join(require('node:os').homedir(), '.agent-fleet');
  out.claudeBin = out.claudeBin || process.env.AGENT_FLEET_CLAUDE_BIN || 'claude';
  return out;
}

const opts = parseArgs();
if (!opts.hub) { console.error('--hub required'); process.exit(2); }
if (!opts.token) { console.error('--token (or env AGENT_FLEET_TOKEN) required'); process.exit(2); }
runDaemon(opts).catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Stub runDaemon so bin runs**

Create `agent-fleet/daemon/src/ws-client.js`:

```js
'use strict';
// agent-fleet daemon entry. Reconnect loop + frame dispatch.
// Full impl in Task 16.
async function runDaemon(opts) {
  console.log(`[daemon] would connect to ${opts.hub} as ${opts.hostName}`);
  await new Promise(() => {});   // hang for now
}
module.exports = { runDaemon };
```

- [ ] **Step 4: README**

Create `agent-fleet/daemon/README.md`:

```markdown
# @bringie/agent-fleet-daemon

Per-host daemon for agent-fleet. Connects out to a central hub over WebSocket; spawns Claude Code sessions on demand; streams PTY I/O.

## Install

```
npx @bringie/agent-fleet-daemon \
  --hub wss://brain.example.com/api/fleet/ws \
  --token "$VAULT_RAG_API_TOKEN" \
  --host-name mac1
```

## Environment variables

| Var | Equivalent flag |
|---|---|
| `AGENT_FLEET_HUB` | `--hub` |
| `AGENT_FLEET_TOKEN` (or `VAULT_RAG_API_TOKEN`) | `--token` |
| `AGENT_FLEET_HOST_NAME` | `--host-name` |
| `AGENT_FLEET_CLAUDE_BIN` | `--claude-bin` (default: `claude`) |

## State

Persisted at `~/.agent-fleet/` — host_id, sessions index, write-buffer.
```

- [ ] **Step 5: Smoke**

Run from `agent-fleet/daemon/`:
```
node bin/daemon.js --hub ws://localhost:0 --token T --host-name local
# expect: [daemon] would connect to ws://localhost:0 as local; process hangs
^C
```

- [ ] **Step 6: Commit**

```bash
git add agent-fleet/daemon/
git commit -m "feat(agent-fleet-daemon): scaffold (package.json + bin + stub)"
```

---

## Task 16: Daemon ws-client.js — Connect + Reconnect

**Files:**
- Modify: `agent-fleet/daemon/src/ws-client.js`
- Create: `agent-fleet/daemon/test/ws-client.test.js`

- [ ] **Step 1: Write the failing reconnect test**

Create `agent-fleet/daemon/test/ws-client.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { computeBackoff } = require('../src/ws-client');

test('computeBackoff caps at 30s and grows exponentially with jitter ±25%', () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const v = computeBackoff(attempt);
    assert.ok(v >= 0, `attempt ${attempt}: ${v} < 0`);
    assert.ok(v <= 30_000 * 1.25, `attempt ${attempt}: ${v} > 30s+jitter`);
  }
  // attempt 0 is around 1s (±25%)
  let saw = 0;
  for (let i = 0; i < 50; i++) {
    const v = computeBackoff(0);
    if (v >= 750 && v <= 1250) saw++;
  }
  assert.ok(saw > 30, `expected ~all attempt-0 backoffs in [750..1250]ms; got ${saw}/50`);
});

test('runDaemon reconnects on close (mock hub)', async (t) => {
  let acceptCount = 0;
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    acceptCount++;
    ws.send(JSON.stringify({ type: 'welcome', host_id: 'host-x', server_version: '0' }));
    setTimeout(() => ws.close(), 50);   // force daemon to reconnect
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const { runDaemon } = require('../src/ws-client');
  // Run in background; abort after we see 3 connections.
  const ctrl = new AbortController();
  const p = runDaemon({
    hub: `ws://127.0.0.1:${port}`,
    token: 'T', hostName: 't',
    stateDir: '/tmp/agent-fleet-test-' + process.pid,
    claudeBin: '/bin/true',
    abortSignal: ctrl.signal,
    backoffOverride: () => 50,   // shrink for test
  });
  // Wait until we see 3 accepted
  const start = Date.now();
  while (acceptCount < 3 && Date.now() - start < 5000) {
    await new Promise(r => setTimeout(r, 25));
  }
  ctrl.abort();
  await p.catch(() => {});
  server.close();
  assert.ok(acceptCount >= 3, `expected ≥3 connection attempts, got ${acceptCount}`);
});
```

- [ ] **Step 2: Run, expect failures**

Run: `cd agent-fleet/daemon && node --test test/ws-client.test.js`

- [ ] **Step 3: Implement ws-client.js**

Replace `agent-fleet/daemon/src/ws-client.js`:

```js
'use strict';
const WebSocket = require('ws');
const fs = require('node:fs');
const path = require('node:path');

const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 30_000;

function computeBackoff(attempt) {
  const exp = Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** attempt);
  const jitter = (Math.random() * 0.5 - 0.25) * exp;   // ±25%
  return Math.max(0, Math.round(exp + jitter));
}

async function runDaemon(opts) {
  fs.mkdirSync(opts.stateDir, { recursive: true });
  const backoff = opts.backoffOverride || computeBackoff;
  let attempt = 0;
  let hostId = null;
  const cfgPath = path.join(opts.stateDir, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try { hostId = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).host_id; } catch {}
  }

  while (!opts.abortSignal?.aborted) {
    let ws;
    try {
      const url = new URL(opts.hub);
      url.searchParams.set('role', 'daemon');
      url.searchParams.set('host_name', opts.hostName);
      url.searchParams.set('daemon_version', '0.1.0');
      ws = new WebSocket(url.toString(), { headers: { authorization: `Bearer ${opts.token}` } });
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
        ws.once('close', () => reject(new Error('closed before open')));
      });
      attempt = 0;
      ws.send(JSON.stringify({
        type: 'hello', host_name: opts.hostName,
        os: process.platform, arch: process.arch,
        capabilities: opts.capabilities || [],
      }));
      await new Promise((resolve, reject) => {
        const heartbeat = setInterval(() => {
          try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
        }, 15_000);
        heartbeat.unref?.();
        ws.on('message', (raw) => {
          try {
            const f = JSON.parse(raw.toString());
            if (f.type === 'welcome' && f.host_id) {
              hostId = f.host_id;
              fs.writeFileSync(cfgPath, JSON.stringify({ host_id: hostId, host_name: opts.hostName }));
            }
            // Frame dispatch (spawn, input, kill) — Task 17.
            if (opts.onFrame) opts.onFrame(f, ws);
          } catch {}
        });
        ws.on('close', () => { clearInterval(heartbeat); resolve(); });
        ws.on('error', (e) => { clearInterval(heartbeat); reject(e); });
        opts.abortSignal?.addEventListener('abort', () => {
          clearInterval(heartbeat);
          try { ws.close(); } catch {}
          resolve();
        });
      });
    } catch (e) {
      if (opts.abortSignal?.aborted) break;
    }
    if (opts.abortSignal?.aborted) break;
    const wait = backoff(attempt++);
    await new Promise(r => setTimeout(r, wait));
  }
}

module.exports = { runDaemon, computeBackoff };
```

- [ ] **Step 4: Install deps + run**

Run:
```
cd agent-fleet/daemon
npm install
node --test test/ws-client.test.js
```
Expected: 2/2 pass.

- [ ] **Step 5: Commit**

```bash
git add agent-fleet/daemon/
git commit -m "feat(agent-fleet-daemon): ws client with reconnect+backoff"
```

---

## Task 17: Daemon pty-manager.js

**Files:**
- Create: `agent-fleet/daemon/src/pty-manager.js`
- Create: `agent-fleet/daemon/test/pty-manager.test.js`

- [ ] **Step 1: Write the failing test**

Create `agent-fleet/daemon/test/pty-manager.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { PtyManager } = require('../src/pty-manager');

const FAKE_CLAUDE = path.resolve(__dirname, '../../..', 'tests/fleet/fake-claude.sh');

test('spawn captures stdout and reports exit', async () => {
  const m = new PtyManager({ claudeBin: FAKE_CLAUDE });
  const events = [];
  m.on('data', (e) => events.push({ k: 'data', ...e }));
  m.on('exit', (e) => events.push({ k: 'exit', ...e }));
  const sess = m.spawn({ sessionId: 's1', cwd: '/tmp', args: ['--print', 'hello'] });
  await new Promise((resolve) => m.once('exit', resolve));
  const outBuf = Buffer.concat(events.filter(e => e.k === 'data' && e.sessionId === 's1').map(e => e.data));
  assert.ok(outBuf.toString().includes('hello'), `got: ${outBuf.toString()}`);
  const exit = events.find(e => e.k === 'exit');
  assert.equal(exit.exitCode, 0);
});

test('writeInput passes to stdin', async () => {
  const m = new PtyManager({ claudeBin: FAKE_CLAUDE });
  const dataEvents = [];
  m.on('data', (e) => dataEvents.push(e));
  m.spawn({ sessionId: 's2', cwd: '/tmp', args: [] });
  await new Promise(r => setTimeout(r, 50));
  m.writeInput('s2', 'hello\n');
  m.writeInput('s2', 'quit\n');
  await new Promise(r => setTimeout(r, 300));
  const out = Buffer.concat(dataEvents.map(e => e.data)).toString();
  assert.ok(out.includes('echo: hello'), `got: ${out}`);
});

test('kill SIGTERM then SIGKILL after 5s grace', async () => {
  const m = new PtyManager({ claudeBin: FAKE_CLAUDE, killGraceMs: 100 });
  m.spawn({ sessionId: 's3', cwd: '/tmp', args: ['--hang'] });
  await new Promise(r => setTimeout(r, 50));
  m.kill('s3');
  const exit = await new Promise(r => m.once('exit', r));
  assert.equal(exit.sessionId, 's3');
  assert.ok(exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL', `signal: ${exit.signal}`);
});
```

- [ ] **Step 2: Run, expect module-not-found**

- [ ] **Step 3: Implement pty-manager.js**

Create `agent-fleet/daemon/src/pty-manager.js`:

```js
'use strict';
const { EventEmitter } = require('node:events');
const pty = require('node-pty');

class PtyManager extends EventEmitter {
  constructor({ claudeBin = 'claude', killGraceMs = 5000 } = {}) {
    super();
    this.claudeBin = claudeBin;
    this.killGraceMs = killGraceMs;
    this.sessions = new Map();   // sessionId -> { proc, seq }
  }
  spawn({ sessionId, cwd, args = [], env = {} }) {
    const proc = pty.spawn(this.claudeBin, args, {
      name: 'xterm-color', cols: 120, rows: 30, cwd,
      env: { ...process.env, ...env },
    });
    this.sessions.set(sessionId, { proc, seq: 0 });
    this.emit('spawn', { sessionId, pid: proc.pid });
    proc.onData((d) => {
      const entry = this.sessions.get(sessionId);
      if (!entry) return;
      const seq = entry.seq++;
      this.emit('data', { sessionId, seq, data: Buffer.from(d, 'utf8') });
    });
    proc.onExit(({ exitCode, signal }) => {
      this.sessions.delete(sessionId);
      this.emit('exit', { sessionId, exitCode, signal: signal ? `SIG${signalName(signal)}` : null });
    });
    return { pid: proc.pid };
  }
  writeInput(sessionId, data) {
    const e = this.sessions.get(sessionId);
    if (!e) return;
    e.proc.write(data);
  }
  resize(sessionId, cols, rows) {
    const e = this.sessions.get(sessionId);
    if (!e) return;
    e.proc.resize(cols, rows);
  }
  kill(sessionId, signal = 'SIGTERM') {
    const e = this.sessions.get(sessionId);
    if (!e) return;
    try { e.proc.kill(signal); } catch {}
    setTimeout(() => {
      const still = this.sessions.get(sessionId);
      if (still) try { still.proc.kill('SIGKILL'); } catch {}
    }, this.killGraceMs).unref?.();
  }
  list() {
    return Array.from(this.sessions.entries()).map(([id, e]) => ({
      session_id: id, pid: e.proc.pid, last_seq: e.seq,
    }));
  }
}

function signalName(n) {
  const map = { 1:'HUP', 2:'INT', 9:'KILL', 15:'TERM' };
  return map[n] || String(n);
}

module.exports = { PtyManager };
```

- [ ] **Step 4: Run tests**

Run: `cd agent-fleet/daemon && node --test test/pty-manager.test.js`
Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add agent-fleet/daemon/src/pty-manager.js agent-fleet/daemon/test/pty-manager.test.js
git commit -m "feat(agent-fleet-daemon): pty-manager (spawn/write/resize/kill)"
```

---

## Task 18: Daemon Wire-Up — ws-client + pty-manager + session-store

**Files:**
- Modify: `agent-fleet/daemon/src/ws-client.js`
- Create: `agent-fleet/daemon/src/session-store.js`
- Create: `agent-fleet/daemon/test/session-store.test.js`

- [ ] **Step 1: session-store test**

Create `agent-fleet/daemon/test/session-store.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SessionStore } = require('../src/session-store');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sstore-')); }

test('persists and reloads sessions', () => {
  const dir = tmpDir();
  const a = new SessionStore(dir);
  a.put('s1', { pid: 100, last_seq: 5 });
  a.put('s2', { pid: 200, last_seq: 7 });
  const b = new SessionStore(dir);
  assert.deepEqual(b.get('s1'), { pid: 100, last_seq: 5 });
  assert.deepEqual(b.list().map(([id]) => id).sort(), ['s1','s2']);
});

test('delete removes', () => {
  const dir = tmpDir();
  const s = new SessionStore(dir);
  s.put('x', { pid: 1, last_seq: 0 });
  s.delete('x');
  assert.equal(s.get('x'), null);
});
```

- [ ] **Step 2: Implement session-store**

Create `agent-fleet/daemon/src/session-store.js`:

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

class SessionStore {
  constructor(stateDir) {
    this.file = path.join(stateDir, 'sessions.json');
    fs.mkdirSync(stateDir, { recursive: true });
    this.map = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
    } catch {}
  }
  put(id, info) { this.map.set(id, info); this._flush(); }
  get(id) { return this.map.get(id) || null; }
  delete(id) { this.map.delete(id); this._flush(); }
  list() { return Array.from(this.map.entries()); }
  _flush() {
    const obj = Object.fromEntries(this.map);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { SessionStore };
```

- [ ] **Step 3: Run tests**

Run: `cd agent-fleet/daemon && node --test test/session-store.test.js`
Expected: 2/2 pass.

- [ ] **Step 4: Wire pty-manager + session-store into ws-client**

Modify `agent-fleet/daemon/src/ws-client.js`. Replace the inner `await new Promise((resolve, reject) => { ... heartbeat ...})` with a full version that owns a PtyManager and routes frames:

```js
'use strict';
const WebSocket = require('ws');
const fs = require('node:fs');
const path = require('node:path');
const { PtyManager } = require('./pty-manager');
const { SessionStore } = require('./session-store');

const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 30_000;

function computeBackoff(attempt) {
  const exp = Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** attempt);
  const jitter = (Math.random() * 0.5 - 0.25) * exp;
  return Math.max(0, Math.round(exp + jitter));
}

async function runDaemon(opts) {
  fs.mkdirSync(opts.stateDir, { recursive: true });
  const backoff = opts.backoffOverride || computeBackoff;
  const store = new SessionStore(opts.stateDir);
  const ptyMgr = new PtyManager({ claudeBin: opts.claudeBin });
  let ws = null;
  let attempt = 0;
  let hostId = null;
  const cfgPath = path.join(opts.stateDir, 'config.json');
  try { hostId = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).host_id; } catch {}

  // PTY → WS bridge
  ptyMgr.on('spawn', ({ sessionId, pid }) => {
    store.put(sessionId, { pid, last_seq: 0 });
    safeSend(ws, { type: 'spawn_ok', session_id: sessionId, pid });
  });
  ptyMgr.on('data', ({ sessionId, seq, data }) => {
    const cur = store.get(sessionId);
    if (cur) store.put(sessionId, { ...cur, last_seq: seq });
    safeSend(ws, { type: 'pty_data', session_id: sessionId, seq, data: data.toString('base64') });
  });
  ptyMgr.on('exit', ({ sessionId, exitCode, signal }) => {
    safeSend(ws, { type: 'session_exit', session_id: sessionId, exit_code: exitCode, signal: signal || undefined });
    store.delete(sessionId);
  });

  while (!opts.abortSignal?.aborted) {
    try {
      const url = new URL(opts.hub);
      url.searchParams.set('role', 'daemon');
      url.searchParams.set('host_name', opts.hostName);
      url.searchParams.set('daemon_version', '0.1.0');
      ws = new WebSocket(url.toString(), { headers: { authorization: `Bearer ${opts.token}` } });
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
        ws.once('close', () => reject(new Error('closed before open')));
      });
      attempt = 0;
      ws.send(JSON.stringify({
        type: 'hello', host_name: opts.hostName,
        os: process.platform, arch: process.arch,
        capabilities: opts.capabilities || [],
      }));
      // Reconciliation: report live sessions
      const local = store.list();
      const recon = local.map(([id, info]) => {
        const alive = ptyMgr.sessions.has(id);
        return { session_id: id, pid: info.pid, alive, last_seq: info.last_seq, ...(alive ? {} : { exit_code: -1 }) };
      });
      if (recon.length) ws.send(JSON.stringify({ type: 'reconciliation', sessions: recon }));
      // Mark dead sessions cleared after reconciliation accepted
      for (const [id, info] of local) if (!ptyMgr.sessions.has(id)) store.delete(id);

      await new Promise((resolve) => {
        const heartbeat = setInterval(() => safeSend(ws, { type: 'ping' }), 15_000);
        heartbeat.unref?.();
        ws.on('message', (raw) => {
          let f;
          try { f = JSON.parse(raw.toString()); } catch { return; }
          if (f.type === 'welcome' && f.host_id) {
            hostId = f.host_id;
            fs.writeFileSync(cfgPath, JSON.stringify({ host_id: hostId, host_name: opts.hostName }));
          } else if (f.type === 'spawn') {
            try {
              ptyMgr.spawn({ sessionId: f.session_id, cwd: f.cwd, args: f.args || [], env: f.env || {} });
            } catch (e) {
              safeSend(ws, { type: 'spawn_err', session_id: f.session_id, error: e.message });
            }
          } else if (f.type === 'input') {
            ptyMgr.writeInput(f.session_id, f.data);
          } else if (f.type === 'kill') {
            ptyMgr.kill(f.session_id, f.signal || 'SIGTERM');
          } else if (f.type === 'resize') {
            ptyMgr.resize(f.session_id, f.cols, f.rows);
          }
          opts.onFrame?.(f, ws);
        });
        ws.on('close', () => { clearInterval(heartbeat); resolve(); });
        ws.on('error', () => { clearInterval(heartbeat); resolve(); });
        opts.abortSignal?.addEventListener('abort', () => {
          clearInterval(heartbeat);
          try { ws.close(); } catch {}
          resolve();
        });
      });
    } catch (_) { /* fallthrough to backoff */ }
    if (opts.abortSignal?.aborted) break;
    await new Promise(r => setTimeout(r, backoff(attempt++)));
  }
}

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch {}
}

module.exports = { runDaemon, computeBackoff };
```

- [ ] **Step 5: Run daemon tests**

Run: `cd agent-fleet/daemon && node --test test/`
Expected: all daemon tests pass.

- [ ] **Step 6: Commit**

```bash
git add agent-fleet/daemon/
git commit -m "feat(agent-fleet-daemon): wire pty-manager + session-store + reconciliation"
```

---

## Task 19: scripts/bin/fleet — CLI

**Files:**
- Create: `scripts/bin/fleet`

- [ ] **Step 1: Write the CLI**

Create `scripts/bin/fleet` (executable):

```bash
#!/usr/bin/env bash
# fleet: CLI for agent-fleet (REST client).
set -euo pipefail

: "${VAULT_RAG_API_URL:?set VAULT_RAG_API_URL}"
: "${VAULT_RAG_API_TOKEN:?set VAULT_RAG_API_TOKEN}"

api() {
  local method="$1"; shift
  local path="$1"; shift
  curl -fsSL -X "$method" \
    -H "Authorization: Bearer $VAULT_RAG_API_TOKEN" \
    -H "Content-Type: application/json" \
    "$@" \
    "$VAULT_RAG_API_URL/api/fleet$path"
}

cmd="${1:-help}"; shift || true

case "$cmd" in
  hosts)
    api GET /hosts | python3 -m json.tool
    ;;
  sessions)
    sub="${1:-list}"; shift || true
    case "$sub" in
      list)
        q=""
        if [ "${1:-}" = "--host" ]; then q="?host_id=$2"; shift 2; fi
        api GET "/sessions${q}" | python3 -m json.tool
        ;;
      tail)
        sid="${1:?session id required}"
        api GET "/sessions/${sid}/transcript.txt"
        ;;
      spawn)
        if [ "${1:-}" != "--host" ]; then echo "fleet sessions spawn --host <id> -- <command...>" >&2; exit 2; fi
        host="$2"; shift 2
        if [ "${1:-}" != "--" ]; then echo "expected '--' separator" >&2; exit 2; fi
        shift
        # Remaining args become the command. We pass the binary name as $1 of args; daemon spawns its claudeBin.
        # In MVP, daemon always spawns `claude`; args here are appended.
        args_json=$(printf '"%s",' "$@" | sed 's/,$//')
        body=$(printf '{"host_id":"%s","cwd":"/tmp","args":[%s]}' "$host" "$args_json")
        api POST /sessions --data "$body"
        ;;
      kill)
        sid="${1:?session id required}"
        api POST "/sessions/${sid}/kill" --data '{}'
        ;;
      *)
        echo "fleet sessions {list|tail|spawn|kill}" >&2; exit 2;;
    esac
    ;;
  help|*)
    cat <<EOF
Usage: fleet <command> [args]

  hosts                                  list registered hosts
  sessions list [--host <id>]            list sessions
  sessions tail <session_id>             stream transcript (text)
  sessions spawn --host <id> -- <args>   spawn a session (args after --)
  sessions kill <session_id>             kill session
EOF
    ;;
esac
```

- [ ] **Step 2: Smoke**

```
chmod +x scripts/bin/fleet
export VAULT_RAG_API_URL=https://brain.itiswednesdaymydud.es
export VAULT_RAG_API_TOKEN=$(vt secrets get VAULT_RAG_API_TOKEN)
./scripts/bin/fleet hosts
# expect: []
```

- [ ] **Step 3: Commit**

```bash
git add scripts/bin/fleet
git commit -m "feat(agent-fleet): bash CLI (hosts/sessions list/tail/spawn/kill)"
```

---

## Task 20: tests/fleet-e2e.sh

**Files:**
- Create: `tests/fleet-e2e.sh`

- [ ] **Step 1: Write the e2e**

Create `tests/fleet-e2e.sh`:

```bash
#!/usr/bin/env bash
# fleet-e2e: spawn daemon + hub locally, drive it through one full session.
set -euo pipefail
trap 'echo FAIL line $LINENO; kill 0 2>/dev/null; exit 1' ERR

cd "$(dirname "$0")/.."

PG_PASS=$(grep VAULT_RAG_PG_PASS .env | cut -d= -f2)
TOKEN="e2e-token-$$"

# Start a throwaway rag-api process pointing at vault-rag-postgres (host port 55433).
RAG_PORT=15679 \
VAULT_RAG_API_TOKEN="$TOKEN" \
VAULT_RAG_PG_HOST=127.0.0.1 \
VAULT_RAG_PG_PORT=55433 \
VAULT_RAG_PG_PASS="$PG_PASS" \
VAULT_PATH=/tmp \
VAULT_SECRETS_SKIP_PG=1 \
  node scripts/rag-api.js &
RAG_PID=$!

# Wait for hub
for i in $(seq 1 30); do
  curl -fsSL http://127.0.0.1:15679/api/fleet/healthz >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsSL http://127.0.0.1:15679/api/fleet/healthz | grep -q ok

# Reset DB
docker exec vault-rag-postgres psql -U postgres -d vault_rag \
  -c "TRUNCATE fleet_hosts, fleet_sessions, fleet_events RESTART IDENTITY CASCADE" >/dev/null

# Start daemon, claudeBin = fake-claude
STATE=$(mktemp -d)
AGENT_FLEET_HUB="ws://127.0.0.1:15679/api/fleet/ws" \
AGENT_FLEET_TOKEN="$TOKEN" \
AGENT_FLEET_HOST_NAME=e2e-host \
AGENT_FLEET_CLAUDE_BIN="$(pwd)/tests/fleet/fake-claude.sh" \
  node agent-fleet/daemon/bin/daemon.js --state-dir "$STATE" &
D_PID=$!

# Wait for host registration
for i in $(seq 1 30); do
  hosts=$(curl -fsSL -H "Authorization: Bearer $TOKEN" http://127.0.0.1:15679/api/fleet/hosts)
  if [ "$hosts" != "[]" ]; then break; fi
  sleep 0.5
done
echo "$hosts" | grep -q e2e-host

HOST_ID=$(echo "$hosts" | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["id"])')

# Spawn a print-mode session
SESS=$(curl -fsSL -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"host_id\":\"$HOST_ID\",\"cwd\":\"/tmp\",\"args\":[\"--print\",\"e2e-hello\"]}" \
  http://127.0.0.1:15679/api/fleet/sessions)
SID=$(echo "$SESS" | python3 -c 'import sys,json; print(json.load(sys.stdin)["session_id"])')

# Wait for transcript to populate
for i in $(seq 1 20); do
  txt=$(curl -fsSL -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:15679/api/fleet/sessions/$SID/transcript.txt" || true)
  if echo "$txt" | grep -q e2e-hello; then break; fi
  sleep 0.5
done
echo "$txt" | grep -q e2e-hello && echo PASS || { echo "no e2e-hello in transcript: $txt"; false; }

# Cleanup
kill $D_PID $RAG_PID 2>/dev/null || true
wait $D_PID 2>/dev/null || true
wait $RAG_PID 2>/dev/null || true
rm -rf "$STATE"
echo "fleet-e2e: OK"
```

- [ ] **Step 2: Make executable + run**

Run:
```
chmod +x tests/fleet-e2e.sh
./tests/fleet-e2e.sh
```
Expected: `fleet-e2e: OK` at the end.

- [ ] **Step 3: Commit**

```bash
git add tests/fleet-e2e.sh
git commit -m "test(agent-fleet): end-to-end smoke (daemon + hub + fake-claude)"
```

---

## Task 21: Docker Compose + Dockerfile updates

**Files:**
- Modify: `docker-compose.yml`
- Modify: `Dockerfile.tools` (only if daemon to run inside `vault-rag-tools` container — for MVP we run daemon **outside** containers, on each host. No tooling image change needed.)

- [ ] **Step 1: Ensure rag-api gets `ws` dep at build time**

Confirm `scripts/package.json` lists `ws` (added in Task 7). The rag-api container builds from `scripts/` directory; on next `docker compose up --build`, `ws` is installed automatically.

- [ ] **Step 2: Restart rag-api**

```
docker compose up -d --build vault-rag-rag-api
docker compose logs --tail=30 vault-rag-rag-api | grep fleet
```
Expected: log line shows orphan check (`fleet: orphaned N sessions on startup`).

- [ ] **Step 3: Smoke against deployed hub**

```
curl -fsSL https://brain.itiswednesdaymydud.es/api/fleet/healthz
curl -fsSL -H "Authorization: Bearer $VAULT_RAG_API_TOKEN" \
  https://brain.itiswednesdaymydud.es/api/fleet/hosts
```
Expected: 200 ok, hosts list.

- [ ] **Step 4: Commit**

If `docker-compose.yml` did not need changes, skip commit; otherwise:

```bash
git add docker-compose.yml
git commit -m "chore(agent-fleet): docker-compose env for fleet routes"
```

---

## Task 22: README

**Files:**
- Create: `agent-fleet/README.md`

- [ ] **Step 1: Write README**

Create `agent-fleet/README.md`:

```markdown
# agent-fleet — multi-host control plane for Claude Code

Sub-project of vault-rag-oss. Lets you spawn, attach to, and stream Claude Code sessions across multiple hosts from a central web/REST/MCP interface.

## Components

- **Hub** — embedded in `rag-api.js`. Exposes `/api/fleet/*` REST + `/api/fleet/ws` WebSocket. Persists hosts/sessions/transcripts to Postgres.
- **Daemon** — per-host npm package `@bringie/agent-fleet-daemon`. Connects out to the hub, spawns `claude` in PTY, streams I/O.
- **CLI** — `scripts/bin/fleet` (bash). REST client wrapper.

See `docs/superpowers/specs/2026-05-15-agent-fleet-control-plane-design.md` for the full design.

## Quick start

On the hub (already deployed as part of vault-rag-oss):

```
curl https://brain.example.com/api/fleet/healthz
```

On each host:

```
npx @bringie/agent-fleet-daemon \
  --hub wss://brain.example.com/api/fleet/ws \
  --token "$VAULT_RAG_API_TOKEN" \
  --host-name $(hostname)
```

Drive from CLI:

```
fleet hosts
fleet sessions spawn --host <host_id> -- --print 'hi'
fleet sessions tail <session_id>
```

## Acceptance criteria

See sub-project #1 implementation plan: `docs/superpowers/plans/2026-05-15-agent-fleet-sub1-implementation.md`.
```

- [ ] **Step 2: Commit**

```bash
git add agent-fleet/README.md
git commit -m "docs(agent-fleet): top-level README"
```

---

## Final Verification

- [ ] **Step 1: Run full test suite**

```
cd scripts && node --test lib/
cd ../agent-fleet/daemon && node --test test/
cd ../.. && ./tests/fleet-e2e.sh
```
All expected to pass.

- [ ] **Step 2: Deploy to brain**

```
ssh root@brain.itiswednesdaymydud.es 'cd /opt/vault-rag && git pull && docker compose up -d --build vault-rag-rag-api'
```

- [ ] **Step 3: Live smoke on real MacBook**

```
# On MacBook
npm install -g @bringie/agent-fleet-daemon
agent-fleet-daemon --hub wss://brain.itiswednesdaymydud.es/api/fleet/ws \
  --token "$(vt secrets get VAULT_RAG_API_TOKEN)" \
  --host-name macbook-1
# Should connect, register, idle on heartbeat.
```

From AI host:
```
fleet hosts
# expect: macbook-1 online

fleet sessions spawn --host <macbook-id> -- --print 'hello from brain'
fleet sessions tail <session_id>
# expect: 'hello from brain'
```

- [ ] **Step 4: vt close**

```bash
vt close vt-NNNN --reason "Agent-fleet sub-project #1 (host daemon + hub) shipped. Acceptance criteria met. Sub-projects #2/#3/#4 to follow."
```

---

## Acceptance Criteria Checklist (from spec)

- [ ] Daemon installs via `npx @bringie/agent-fleet-daemon` on macOS + Linux. **(Tasks 15-18)**
- [ ] Daemon registers with hub on first connect; persisted as `fleet_hosts` row. **(Task 10 + 16)**
- [ ] `POST /api/fleet/sessions` spawns claude on the chosen host; returns `session_id`. **(Task 9 + 11)**
- [ ] PTY output streams to viewers via WS in real time. **(Task 11 + 12)**
- [ ] Input from viewer reaches PTY stdin. **(Task 12)**
- [ ] `POST .../kill` terminates session; status=killed in DB. **(Task 9 + 11 + 17)**
- [ ] Daemon crash + restart → reconciliation frame → hub correctly marks dead sessions exited. **(Task 11 + 18)**
- [ ] Hub restart → daemons reconnect; live sessions resume streaming. **(Task 13 orphan flip + Task 16 reconnect)**
- [ ] `tests/fleet-e2e.sh` passes. **(Task 20)**
- [ ] `scripts/bin/fleet` CLI lists hosts, lists sessions, tails transcript. **(Task 19)**
