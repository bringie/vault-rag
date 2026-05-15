---
type: plan
status: draft
epic: agent-fleet
spec: docs/superpowers/specs/2026-05-15-agent-fleet-configurable-pricing-design.md
date: 2026-05-15
---

# Agent-Fleet Configurable LLM Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement task-by-task. Steps use checkbox (`- [ ]`) syntax. `subagent-driven-development` is disabled per project CLAUDE.md.

**Goal:** Заменить hardcoded `PRICES` в fleet-cost.js на конфигурируемую таблицу `fleet_model_prices` с временными снапшотами + REST CRUD + UI page.

**Architecture:** Postgres-backed pricing с LIKE pattern matching + priority. Immutable history (INSERT-only, soft-delete). In-memory cache 60s + invalidate-on-write. rowCost становится async и принимает ts для temporal lookup.

**Tech Stack:** Node.js (CommonJS), `pg`, `node:test`, vanilla JS+CSS frontend.

---

## File Layout

| File | Purpose | Status |
|------|---------|--------|
| `sql/010-fleet-model-prices.sql` | Schema + seed (3 Claude families + default) | new |
| `scripts/lib/fleet-prices.js` | Cache-backed resolver | new |
| `scripts/lib/fleet-prices.test.js` | Resolver tests | new |
| `scripts/lib/fleet-cost.js` | rowCost async, uses fleet-prices | modify |
| `scripts/lib/fleet-cost.test.js` | Update for async rowCost / new priceFor sig | modify |
| `scripts/lib/fleet-routes.js` | /fleet/prices CRUD + resolve endpoint | modify (+~80 LOC) |
| `scripts/lib/fleet-routes.test.js` | 4-5 new tests | modify |
| `agent-fleet/web/prices.js` | Page logic | new (~200 LOC) |
| `agent-fleet/web/index.html` | nav button + page container | modify |
| `agent-fleet/web/app.js` | route + nav wiring | modify (~15 LOC) |
| `agent-fleet/web/app.css` | small additions | modify |

---

## Conventions Engineer Must Know

- Tests use `node:test` + `node:assert`. Run: `VAULT_RAG_PG_PASS=testpass node --test scripts/lib/<file>.test.js`.
- Two Postgres pools: `vault_rag` (fleet_*) at 55433, and `tokmon` events at 55433 (same fleet-test-pg container, different db).
- Fleet-routes handlers take `{req, res, body, ctx}`, use `send(res, status, body)`. ctx.db = vault_rag pool, ctx.tokmonDb = tokmon pool.
- HTTP test pattern: `startTestServer({token: 'T', db: pg})` then `reqJson(server, 'GET', '/fleet/...', {token: 'T'})`.
- `node --check <file>.js` for syntax-only validation.
- After every backend change: re-run that file's `.test.js` suite alone.
- Frontend testing: deploy + manual hard-refresh in browser (no test framework set up).
- Migration apply on prod: SSH brain :977, `docker exec -i vault-rag-postgres psql -U postgres -d vault_rag < /opt/vault-rag/sql/010-*.sql`.

---

## Task 1: SQL migration with seed

**Files:**
- Create: `sql/010-fleet-model-prices.sql`

- [ ] **Step 1: Write the migration**

Create `sql/010-fleet-model-prices.sql`:

```sql
CREATE TABLE IF NOT EXISTS fleet_model_prices (
  id                    bigserial PRIMARY KEY,
  match_pattern         text NOT NULL,
  priority              int NOT NULL DEFAULT 100,
  valid_from            timestamptz NOT NULL DEFAULT now(),
  input_per_mtok        numeric(10,4) NOT NULL,
  output_per_mtok       numeric(10,4) NOT NULL,
  cache_create_per_mtok numeric(10,4) NOT NULL DEFAULT 0,
  cache_read_per_mtok   numeric(10,4) NOT NULL DEFAULT 0,
  flagged               boolean NOT NULL DEFAULT false,
  note                  text,
  deleted_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fleet_model_prices_priority
  ON fleet_model_prices (priority DESC, valid_from DESC)
  WHERE deleted_at IS NULL;

-- Idempotent seed: skip if any seed row already exists (re-runs are safe).
INSERT INTO fleet_model_prices
  (match_pattern, priority, valid_from, input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok, note)
SELECT * FROM (VALUES
  ('claude-opus-%',   200, '1970-01-01'::timestamptz, 15.0000, 75.0000, 18.7500, 1.5000, 'seed: opus family'),
  ('claude-sonnet-%', 200, '1970-01-01'::timestamptz,  3.0000, 15.0000,  3.7500, 0.3000, 'seed: sonnet family'),
  ('claude-haiku-%',  200, '1970-01-01'::timestamptz,  1.0000,  5.0000,  1.2500, 0.1000, 'seed: haiku family'),
  ('%',                 0, '1970-01-01'::timestamptz,  0.0000,  0.0000,  0.0000, 0.0000, 'fallback (unpriced)')
) AS v(match_pattern, priority, valid_from, input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok, note)
WHERE NOT EXISTS (
  SELECT 1 FROM fleet_model_prices
  WHERE match_pattern = v.match_pattern
    AND priority = v.priority
    AND valid_from = v.valid_from
    AND deleted_at IS NULL
);

-- Mark the fallback row as flagged so UI can highlight unpriced events.
UPDATE fleet_model_prices SET flagged = true WHERE match_pattern = '%' AND priority = 0 AND flagged = false;
```

- [ ] **Step 2: Apply to dev postgres**

Run: `docker exec -i fleet-test-pg psql -U postgres -d vault_rag < sql/010-fleet-model-prices.sql`

Expected output: `CREATE TABLE`, `CREATE INDEX`, `INSERT 0 4`, `UPDATE 1`.

- [ ] **Step 3: Verify schema + seed**

Run: `docker exec fleet-test-pg psql -U postgres -d vault_rag -c "SELECT match_pattern, priority, input_per_mtok, flagged FROM fleet_model_prices ORDER BY priority DESC, match_pattern"`

Expected: 4 rows. opus/sonnet/haiku at priority 200 with non-zero input prices, % at priority 0 with flagged=true.

- [ ] **Step 4: Commit**

```bash
git add sql/010-fleet-model-prices.sql
git commit -m "feat: schema + seed for fleet_model_prices

Configurable LLM pricing table. LIKE match_pattern + priority +
valid_from. Seeded with current hardcoded 3 Claude families at
valid_from=epoch + default '%' row flagged for unpriced fallback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: fleet-prices.js resolver module

**Files:**
- Create: `scripts/lib/fleet-prices.js`
- Create: `scripts/lib/fleet-prices.test.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/fleet-prices.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const prices = require('./fleet-prices');

const PG = {
  host: '127.0.0.1', port: parseInt(process.env.VAULT_RAG_PG_PORT || '55433', 10),
  user: 'postgres', password: process.env.VAULT_RAG_PG_PASS, database: 'vault_rag',
};

async function withClient(fn) {
  const c = new Client(PG);
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function resetPrices(c) {
  await c.query('TRUNCATE fleet_model_prices RESTART IDENTITY');
  await c.query(`
    INSERT INTO fleet_model_prices (match_pattern, priority, valid_from, input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok, flagged)
    VALUES
      ('claude-opus-%',   200, '1970-01-01', 15, 75, 18.75, 1.50, false),
      ('claude-sonnet-%', 200, '1970-01-01', 3, 15, 3.75, 0.30, false),
      ('claude-haiku-%',  200, '1970-01-01', 1, 5, 1.25, 0.10, false),
      ('%',                 0, '1970-01-01', 0, 0, 0, 0, true)`);
  prices.invalidate();
}

test('priceFor returns opus prices for claude-opus-4-7', async () => {
  await withClient(async (c) => {
    await resetPrices(c);
    const p = await prices.priceFor(c, 'claude-opus-4-7');
    assert.strictEqual(p.input, 15);
    assert.strictEqual(p.output, 75);
    assert.strictEqual(p.cache_create, 18.75);
    assert.strictEqual(p.cache_read, 1.5);
    assert.strictEqual(p.flagged, false);
  });
});

test('priceFor returns sonnet prices for claude-sonnet-4-6', async () => {
  await withClient(async (c) => {
    await resetPrices(c);
    const p = await prices.priceFor(c, 'claude-sonnet-4-6');
    assert.strictEqual(p.input, 3);
    assert.strictEqual(p.flagged, false);
  });
});

test('priceFor returns fallback flagged for unknown model', async () => {
  await withClient(async (c) => {
    await resetPrices(c);
    const p = await prices.priceFor(c, 'gpt-4o');
    assert.strictEqual(p.input, 0);
    assert.strictEqual(p.flagged, true);
  });
});

test('priceFor returns ZERO_PRICE if table empty', async () => {
  await withClient(async (c) => {
    await c.query('TRUNCATE fleet_model_prices');
    prices.invalidate();
    const p = await prices.priceFor(c, 'any-model');
    assert.strictEqual(p.input, 0);
    assert.strictEqual(p.flagged, true);
  });
});

test('priceFor uses temporal lookup: pre-snapshot uses old price', async () => {
  await withClient(async (c) => {
    await resetPrices(c);
    // Insert higher-priority opus row valid only after 2026-01-01
    await c.query(`
      INSERT INTO fleet_model_prices (match_pattern, priority, valid_from, input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok)
      VALUES ('claude-opus-%', 300, '2026-01-01', 99, 99, 99, 99)`);
    prices.invalidate();
    // Before 2026-01-01 → old price (15)
    const before = await prices.priceFor(c, 'claude-opus-4-7', new Date('2025-12-01'));
    assert.strictEqual(before.input, 15);
    // After 2026-01-01 → new price (99)
    const after = await prices.priceFor(c, 'claude-opus-4-7', new Date('2026-06-01'));
    assert.strictEqual(after.input, 99);
  });
});

test('priceFor higher priority wins among valid matches', async () => {
  await withClient(async (c) => {
    await resetPrices(c);
    // Override specific version at higher priority
    await c.query(`
      INSERT INTO fleet_model_prices (match_pattern, priority, valid_from, input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok)
      VALUES ('claude-opus-4-7', 500, '1970-01-01', 999, 999, 999, 999)`);
    prices.invalidate();
    const p = await prices.priceFor(c, 'claude-opus-4-7');
    assert.strictEqual(p.input, 999);
    // Other opus version still uses family row
    const fam = await prices.priceFor(c, 'claude-opus-5');
    assert.strictEqual(fam.input, 15);
  });
});

test('priceFor ignores soft-deleted rows', async () => {
  await withClient(async (c) => {
    await resetPrices(c);
    await c.query(`UPDATE fleet_model_prices SET deleted_at = now() WHERE match_pattern = 'claude-opus-%'`);
    prices.invalidate();
    const p = await prices.priceFor(c, 'claude-opus-4-7');
    // Falls through to '%' default
    assert.strictEqual(p.input, 0);
    assert.strictEqual(p.flagged, true);
  });
});

test('invalidate clears cache so next call re-reads DB', async () => {
  await withClient(async (c) => {
    await resetPrices(c);
    await prices.priceFor(c, 'claude-opus-4-7'); // warms cache
    await c.query(`UPDATE fleet_model_prices SET input_per_mtok = 100 WHERE match_pattern = 'claude-opus-%' AND priority = 200`);
    prices.invalidate();
    const p = await prices.priceFor(c, 'claude-opus-4-7');
    assert.strictEqual(p.input, 100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `VAULT_RAG_PG_PASS=testpass node --test scripts/lib/fleet-prices.test.js`

Expected: `Cannot find module './fleet-prices'`.

- [ ] **Step 3: Implement fleet-prices.js**

Create `scripts/lib/fleet-prices.js`:

```js
'use strict';
// fleet-prices: cache-backed price resolver. Single source of truth: fleet_model_prices.

const TTL_MS = 60_000;
const ZERO_PRICE = Object.freeze({
  input: 0, output: 0, cache_create: 0, cache_read: 0, flagged: true, id: null,
});

let cache = { rows: [], loadedAt: 0 };
let inFlightLoad = null;  // concurrency guard: dedupe parallel cold-cache loads

function likeMatch(pattern, s) {
  // Postgres LIKE: % = any chars, _ = single char. Case-insensitive here.
  const re = new RegExp(
    '^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex specials
      .replace(/%/g, '.*')
      .replace(/_/g, '.')
    + '$',
    'i',
  );
  return re.test(s);
}

async function load(db) {
  // Dedupe concurrent cold-cache loads — first call queries, others await same promise.
  if (inFlightLoad) return inFlightLoad;
  inFlightLoad = (async () => {
    try {
      const { rows } = await db.query(`
        SELECT id, match_pattern, priority, valid_from,
               input_per_mtok, output_per_mtok,
               cache_create_per_mtok, cache_read_per_mtok, flagged
        FROM fleet_model_prices
        WHERE deleted_at IS NULL
        ORDER BY priority DESC, valid_from DESC`);
      cache = { rows, loadedAt: Date.now() };
    } finally {
      inFlightLoad = null;
    }
  })();
  return inFlightLoad;
}

async function ensure(db) {
  if (Date.now() - cache.loadedAt >= TTL_MS) {
    await load(db);
  }
}

function invalidate() { cache = { rows: [], loadedAt: 0 }; inFlightLoad = null; }

async function priceFor(db, model, ts) {
  await ensure(db);
  if (!cache.rows.length) return ZERO_PRICE;
  const m = (model || '').toLowerCase();
  const at = ts instanceof Date ? ts : new Date(ts || Date.now());
  for (const r of cache.rows) {
    if (new Date(r.valid_from) > at) continue;
    if (!likeMatch(r.match_pattern.toLowerCase(), m)) continue;
    return {
      input: Number(r.input_per_mtok),
      output: Number(r.output_per_mtok),
      cache_create: Number(r.cache_create_per_mtok),
      cache_read: Number(r.cache_read_per_mtok),
      flagged: Boolean(r.flagged),
      id: r.id,
    };
  }
  return ZERO_PRICE;
}

module.exports = { priceFor, invalidate, load, likeMatch, ZERO_PRICE };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `VAULT_RAG_PG_PASS=testpass node --test scripts/lib/fleet-prices.test.js`

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fleet-prices.js scripts/lib/fleet-prices.test.js
git commit -m "feat: fleet-prices resolver with LIKE pattern + temporal lookup

In-memory cache 60s TTL + invalidate(). Resolution: sort by
(priority DESC, valid_from DESC), pick first row where
valid_from <= ts AND pattern LIKE model. Falls back to ZERO_PRICE
(input=0, flagged=true) if no match.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: fleet-cost.js refactor — rowCost async

**Files:**
- Modify: `scripts/lib/fleet-cost.js`
- Modify: `scripts/lib/fleet-cost.test.js`

- [ ] **Step 1: Refactor fleet-cost.js**

Replace the contents of `scripts/lib/fleet-cost.js`:

```js
'use strict';
// fleet-cost: attribute token-monitor events to fleet sessions/hosts.
// Prices come from fleet_model_prices (via fleet-prices.js). vaultPg = vault_rag pool.

const prices = require('./fleet-prices');

async function rowCost(r, ts, vaultPg) {
  const p = await prices.priceFor(vaultPg, r.model, ts);
  return (
    Number(r.input_tokens)      / 1e6 * p.input +
    Number(r.output_tokens)     / 1e6 * p.output +
    Number(r.cache_creation_5m) / 1e6 * p.cache_create +
    Number(r.cache_read)        / 1e6 * p.cache_read
  );
}

// Aggregate events matching WHERE clause. vaultPg used to resolve prices.
async function aggregateRows(tokmonPg, vaultPg, where, args) {
  const { rows } = await tokmonPg.query(
    `SELECT model, MAX(ts) AS last_ts,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_5m) AS cache_creation_5m, SUM(cache_read) AS cache_read,
            COUNT(*) AS msgs
     FROM events
     WHERE ${where}
     GROUP BY model`, args);
  let usd = 0, msgs = 0;
  const byModel = {};
  for (const r of rows) {
    const c = await rowCost(r, r.last_ts, vaultPg);
    usd += c; msgs += Number(r.msgs);
    byModel[r.model] = {
      usd: c, msgs: Number(r.msgs),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cache_creation_5m: Number(r.cache_creation_5m),
      cache_read: Number(r.cache_read),
    };
  }
  return { usd, msgs, by_model: byModel };
}

async function sessionCost(tokmonPg, vaultPg, hostName, startedAt, endedAt, fleetSessionId) {
  if (fleetSessionId) {
    const exact = await aggregateRows(tokmonPg, vaultPg, 'session_id = $1', [fleetSessionId]);
    if (exact.msgs > 0) return { ...exact, attribution: 'exact' };
  }
  const end = endedAt || new Date();
  const heur = await aggregateRows(tokmonPg, vaultPg, 'host_id = $1 AND ts >= $2 AND ts < $3',
    [hostName, startedAt, end]);
  return { ...heur, attribution: 'approximate' };
}

async function hostSummary(tokmonPg, vaultPg, hostNames, days = 7) {
  if (!hostNames.length) return {};
  const { rows } = await tokmonPg.query(
    `SELECT host_id, model, MAX(ts) AS last_ts,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_5m) AS cache_creation_5m, SUM(cache_read) AS cache_read,
            COUNT(*) AS msgs
     FROM events
     WHERE host_id = ANY($1) AND ts > now() - ($2 || ' days')::interval
     GROUP BY host_id, model`,
    [hostNames, String(days)]);
  const out = {};
  for (const r of rows) {
    if (!out[r.host_id]) out[r.host_id] = { usd: 0, msgs: 0, by_model: {} };
    const c = await rowCost(r, r.last_ts, vaultPg);
    out[r.host_id].usd += c;
    out[r.host_id].msgs += Number(r.msgs);
    out[r.host_id].by_model[r.model] = { usd: c, msgs: Number(r.msgs) };
  }
  return out;
}

async function timeline(tokmonPg, vaultPg, hostNames, days = 7, groupBy = 'model') {
  if (groupBy === 'label' && vaultPg) return timelineByLabel(tokmonPg, vaultPg, days);
  const dim = groupBy === 'host' ? 'host_id' : 'model';
  const where = ['ts > now() - ($1 || \' days\')::interval'];
  const args = [String(days)];
  if (hostNames && hostNames.length) {
    args.push(hostNames);
    where.push(`host_id = ANY($${args.length})`);
  }
  const { rows } = await tokmonPg.query(
    `SELECT date_trunc('day', ts) AS day, ${dim} AS dim, model,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_5m) AS cache_creation_5m, SUM(cache_read) AS cache_read,
            COUNT(*) AS msgs
     FROM events
     WHERE ${where.join(' AND ')}
     GROUP BY day, ${dim}, model
     ORDER BY day`, args);
  const out = [];
  for (const r of rows) {
    out.push({
      day: r.day, dim: r.dim, model: r.model, msgs: Number(r.msgs),
      usd: await rowCost(r, r.day, vaultPg),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cache_creation_5m: Number(r.cache_creation_5m),
      cache_read: Number(r.cache_read),
    });
  }
  return out;
}

async function timelineByLabel(tokmonPg, vaultPg, days = 7) {
  const { rows: ev } = await tokmonPg.query(
    `SELECT date_trunc('day', ts) AS day, session_id, model,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_5m) AS cache_creation_5m, SUM(cache_read) AS cache_read,
            COUNT(*) AS msgs
     FROM events
     WHERE ts > now() - ($1 || ' days')::interval
     GROUP BY day, session_id, model`, [String(days)]);
  if (!ev.length) return [];
  const sessionIds = Array.from(new Set(ev.map(r => r.session_id).filter(x => /^[0-9a-f-]{36}$/i.test(x))));
  const labelById = new Map();
  if (sessionIds.length) {
    const { rows: ss } = await vaultPg.query(
      `SELECT id::text AS id, COALESCE(label, '(unlabeled)') AS label FROM fleet_sessions WHERE id::text = ANY($1)`,
      [sessionIds]);
    for (const s of ss) labelById.set(s.id, s.label);
  }
  const grouped = new Map();
  for (const r of ev) {
    const label = labelById.get(r.session_id) || '(external/unlabeled)';
    const key = `${r.day.toISOString()}|${label}|${r.model}`;
    let g = grouped.get(key);
    if (!g) {
      g = { day: r.day, dim: label, model: r.model, msgs: 0, input_tokens: 0, output_tokens: 0, cache_creation_5m: 0, cache_read: 0 };
      grouped.set(key, g);
    }
    g.msgs += Number(r.msgs);
    g.input_tokens += Number(r.input_tokens);
    g.output_tokens += Number(r.output_tokens);
    g.cache_creation_5m += Number(r.cache_creation_5m);
    g.cache_read += Number(r.cache_read);
  }
  const out = [];
  for (const g of grouped.values()) {
    out.push({ ...g, usd: await rowCost(g, g.day, vaultPg) });
  }
  return out.sort((a, b) => a.day - b.day);
}

module.exports = { sessionCost, hostSummary, timeline, rowCost };
```

Notes:
- `priceFor` no longer exported from fleet-cost.js (was hardcoded helper; use fleet-prices.priceFor directly).
- All cost-summing functions now take `vaultPg` as second arg.
- `aggregateRows` selects `MAX(ts) AS last_ts` and passes it to rowCost for temporal pricing.
- `timeline` uses the bucketed `day` as the ts for pricing — daily granularity is fine for retroactive snapshots.

**Temporal accuracy caveat (MVP limitation):** Because cost aggregation groups by (model[, host, day]) BEFORE pricing, the price applied per group is the price at `MAX(ts)` (or `day` for timeline). A session straddling a price-change boundary gets the post-change price for ALL its events of that model. v2 fix would be GROUP BY (model, resolved_price_id) via per-event price resolution. Affects only the day of a price change — acceptable for MVP. Spec §13.6 should read "approximate at bucket-MAX-ts granularity".

- [ ] **Step 2: Update fleet-cost.test.js**

Replace `scripts/lib/fleet-cost.test.js` entirely (test setup needs vaultPg fixture):

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const fleetCost = require('./fleet-cost');
const prices = require('./fleet-prices');

const PG_BASE = {
  host: '127.0.0.1', port: parseInt(process.env.VAULT_RAG_PG_PORT || '55433', 10),
  user: 'postgres', password: process.env.VAULT_RAG_PG_PASS,
};
async function withBoth(fn) {
  const tokmonPg = new Client({ ...PG_BASE, database: 'tokmon' });
  const vaultPg = new Client({ ...PG_BASE, database: 'vault_rag' });
  await tokmonPg.connect();
  await vaultPg.connect();
  try { return await fn(tokmonPg, vaultPg); }
  finally { await tokmonPg.end(); await vaultPg.end(); }
}
async function resetEvents(c) {
  await c.query('TRUNCATE events RESTART IDENTITY CASCADE');
}
async function seedPrices(c) {
  await c.query('TRUNCATE fleet_model_prices RESTART IDENTITY');
  await c.query(`
    INSERT INTO fleet_model_prices (match_pattern, priority, valid_from, input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok, flagged)
    VALUES
      ('claude-opus-%',   200, '1970-01-01', 15, 75, 18.75, 1.50, false),
      ('claude-sonnet-%', 200, '1970-01-01', 3, 15, 3.75, 0.30, false),
      ('claude-haiku-%',  200, '1970-01-01', 1, 5, 1.25, 0.10, false),
      ('%',                 0, '1970-01-01', 0, 0, 0, 0, true)`);
  prices.invalidate();
}
async function seed(c, host, ts, model, inT, outT, ccm = 0, cr = 0) {
  const offset = Math.floor(Math.random() * 1e12);
  await c.query(
    `INSERT INTO events (host_id, message_uuid, ts, session_id, project_path, model,
       input_tokens, output_tokens, cache_creation_5m, cache_creation_1h, cache_read,
       source_file, source_offset, raw_hash, raw)
     VALUES ($1, $2, $3, 'sess-t', '/x', $4, $5, $6, $7, 0, $8, '/x', $9, 'h', '{}'::jsonb)`,
    [host, `msg-${offset}`, ts, model, inT, outT, ccm, cr, offset]);
}

test('rowCost uses seeded prices', async () => {
  await withBoth(async (tok, vault) => {
    await seedPrices(vault);
    const c = await fleetCost.rowCost(
      { model: 'claude-opus-4-7', input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_5m: 0, cache_read: 0 },
      new Date(),
      vault,
    );
    // 1M*15 + 0.1M*75 = 15 + 7.5 = 22.5
    assert.ok(Math.abs(c - 22.5) < 0.001, `got ${c}`);
  });
});

test('sessionCost sums rows within window for given host', async () => {
  await withBoth(async (tok, vault) => {
    await resetEvents(tok);
    await seedPrices(vault);
    const start = new Date('2026-05-15T10:00:00Z');
    const end   = new Date('2026-05-15T11:00:00Z');
    await seed(tok, 'mac1', new Date('2026-05-15T10:30:00Z'), 'claude-sonnet-4-6', 1_000_000, 500_000);
    await seed(tok, 'mac1', new Date('2026-05-15T10:45:00Z'), 'claude-opus-4-7',   1_000_000, 100_000);
    await seed(tok, 'other', new Date('2026-05-15T10:30:00Z'), 'claude-sonnet-4-6', 5_000_000, 5_000_000);
    await seed(tok, 'mac1', new Date('2026-05-15T09:30:00Z'), 'claude-sonnet-4-6', 5_000_000, 0);
    const r = await fleetCost.sessionCost(tok, vault, 'mac1', start, end);
    // sonnet: 1M*3 + 0.5M*15 = 10.5  ; opus: 1M*15 + 0.1M*75 = 22.5  ; total 33
    assert.ok(Math.abs(r.usd - 33) < 0.01, `expected ~33, got ${r.usd}`);
    assert.equal(r.msgs, 2);
  });
});

test('hostSummary aggregates per-host costs over N days', async () => {
  await withBoth(async (tok, vault) => {
    await resetEvents(tok);
    await seedPrices(vault);
    await seed(tok, 'mac1', new Date(),   'claude-sonnet-4-6', 2_000_000, 1_000_000);
    await seed(tok, 'mac2', new Date(),   'claude-haiku-4-5',  3_000_000, 500_000);
    const out = await fleetCost.hostSummary(tok, vault, ['mac1', 'mac2'], 7);
    // mac1 sonnet: 2*3 + 1*15 = 21
    // mac2 haiku:  3*1 + 0.5*5 = 5.5
    assert.ok(Math.abs(out.mac1.usd - 21) < 0.01, `mac1 got ${out.mac1?.usd}`);
    assert.ok(Math.abs(out.mac2.usd - 5.5) < 0.01, `mac2 got ${out.mac2?.usd}`);
  });
});

test('unknown model uses fallback (zero cost, flagged)', async () => {
  await withBoth(async (tok, vault) => {
    await resetEvents(tok);
    await seedPrices(vault);
    await seed(tok, 'h1', new Date(), 'gpt-4o', 1_000_000, 1_000_000);
    const out = await fleetCost.hostSummary(tok, vault, ['h1'], 7);
    assert.strictEqual(out.h1.usd, 0);
    assert.strictEqual(out.h1.msgs, 1);
  });
});
```

- [ ] **Step 3: Run cost tests**

Run: `VAULT_RAG_PG_PASS=testpass node --test scripts/lib/fleet-cost.test.js`

Expected: 4 tests pass.

- [ ] **Step 4: Update fleet-routes.js callers**

Cost-related handlers in `scripts/lib/fleet-routes.js` call `fleetCost.sessionCost`, `hostSummary`, `timeline`. They must pass `ctx.db` (vault_rag pool) as the new vaultPg argument.

Find every call and prepend `ctx.db`:

```bash
grep -n "fleetCost\." scripts/lib/fleet-routes.js
```

Expected matches (line numbers approximate, current vs after refactor):

In each of these locations, add `ctx.db` as the second argument to the call.

Examples of changes (apply to each match):

```js
// before:
const cost = await fleetCost.sessionCost(ctx.tokmonDb, host.name, s.started_at, new Date(), s.id);
// after:
const cost = await fleetCost.sessionCost(ctx.tokmonDb, ctx.db, host.name, s.started_at, new Date(), s.id);

// before:
const summary = await fleetCost.hostSummary(ctx.tokmonDb, hostNames, days);
// after:
const summary = await fleetCost.hostSummary(ctx.tokmonDb, ctx.db, hostNames, days);

// before (timeline with vaultPg already at end):
const rows = await fleetCost.timeline(ctx.tokmonDb, hostNames, days, groupBy, ctx.db);
// after (vaultPg now second arg, no trailing arg):
const rows = await fleetCost.timeline(ctx.tokmonDb, ctx.db, hostNames, days, groupBy);
```

- [ ] **Step 5: Run routes tests**

Run: `VAULT_RAG_PG_PASS=testpass node --test scripts/lib/fleet-routes.test.js`

Expected: all tests pass (28).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/fleet-cost.js scripts/lib/fleet-cost.test.js scripts/lib/fleet-routes.js
git commit -m "refactor(fleet-cost): rowCost async, prices from fleet_model_prices

rowCost(r, ts, vaultPg) async — resolves price via fleet-prices.priceFor
using event timestamp for temporal accuracy. All cost-summing functions
take vaultPg as their second arg.

fleet-routes handlers updated to pass ctx.db.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: REST /fleet/prices endpoints

**Files:**
- Modify: `scripts/lib/fleet-routes.js` (+~80 LOC)
- Modify: `scripts/lib/fleet-routes.test.js` (+5 tests)

- [ ] **Step 1: Add handlers**

In `scripts/lib/fleet-routes.js`, near other handler functions (above `dispatchHttp`), insert:

```js
// --- Pricing handlers ---

const fleetPrices = require('./fleet-prices');

async function handleListPrices({ req, res, ctx }) {
  const u = new URL(req.url, 'http://x');
  const withHistory = u.searchParams.get('history') === '1';
  const where = withHistory ? '' : 'WHERE deleted_at IS NULL';
  const { rows } = await ctx.db.query(`
    SELECT id, match_pattern, priority, valid_from,
           input_per_mtok, output_per_mtok,
           cache_create_per_mtok, cache_read_per_mtok,
           flagged, note, deleted_at, created_at
    FROM fleet_model_prices ${where}
    ORDER BY priority DESC, valid_from DESC`);
  send(res, 200, rows);
}

async function handleCreatePrice({ res, body, ctx }) {
  if (!body || !body.match_pattern || typeof body.input_per_mtok !== 'number' || typeof body.output_per_mtok !== 'number') {
    return send(res, 422, { error: 'match_pattern + numeric input_per_mtok + output_per_mtok required' });
  }
  const { rows } = await ctx.db.query(
    `INSERT INTO fleet_model_prices
       (match_pattern, priority, valid_from,
        input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok,
        flagged, note)
     VALUES ($1, $2, COALESCE($3, now()), $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      body.match_pattern,
      Number.isFinite(body.priority) ? body.priority : 100,
      body.valid_from || null,
      body.input_per_mtok,
      body.output_per_mtok,
      Number.isFinite(body.cache_create_per_mtok) ? body.cache_create_per_mtok : 0,
      Number.isFinite(body.cache_read_per_mtok) ? body.cache_read_per_mtok : 0,
      Boolean(body.flagged),
      body.note || null,
    ]);
  fleetPrices.invalidate();
  send(res, 201, rows[0]);
}

async function handleDeletePrice({ req, res, ctx }) {
  const id = req.url.split('?')[0].split('/')[3];
  await ctx.db.query(`UPDATE fleet_model_prices SET deleted_at = now() WHERE id = $1`, [id]);
  fleetPrices.invalidate();
  res.writeHead(204); res.end();
}

async function handleResolvePrice({ res, body, ctx }) {
  if (!body || !body.model) return send(res, 422, { error: 'model required' });
  const ts = body.at ? new Date(body.at) : new Date();
  const matched = await fleetPrices.priceFor(ctx.db, body.model, ts);
  send(res, 200, { matched, at: ts.toISOString() });
}
```

- [ ] **Step 2: Register routes**

In `dispatchHttp` near the other route registrations (e.g. after groups routes, before workflows), add:

```js
// Pricing
if (method === 'GET'    && path === '/fleet/prices')               return handleListPrices({ req, res, ctx });
if (method === 'POST'   && path === '/fleet/prices') {
  return readBody(req).then(b => handleCreatePrice({ res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
}
if (method === 'POST'   && path === '/fleet/prices/resolve') {
  return readBody(req).then(b => handleResolvePrice({ res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
}
if (method === 'DELETE' && /^\/fleet\/prices\/\d+$/.test(path))    return handleDeletePrice({ req, res, ctx });
```

- [ ] **Step 3: Write tests**

Append to `scripts/lib/fleet-routes.test.js`:

```js
// --- Pricing ---

async function startWithPrices() {
  const pg = new Client(PG);
  await pg.connect();
  await pg.query('TRUNCATE fleet_model_prices RESTART IDENTITY');
  await pg.query(`
    INSERT INTO fleet_model_prices (match_pattern, priority, valid_from, input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok, flagged)
    VALUES
      ('claude-opus-%',   200, '1970-01-01', 15, 75, 18.75, 1.50, false),
      ('%',                 0, '1970-01-01',  0,  0,     0,    0, true)`);
  const server = await startTestServer({ token: 'T', db: pg });
  return { server, pg, close: async () => { server.close(); await pg.end(); } };
}

test('GET /fleet/prices lists active rows', async () => {
  const { server, close } = await startWithPrices();
  const r = await reqJson(server, 'GET', '/fleet/prices', { token: 'T' });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.ok(r.body.find(p => p.match_pattern === 'claude-opus-%'));
  await close();
});

test('POST /fleet/prices inserts new snapshot row', async () => {
  const { server, close } = await startWithPrices();
  const r = await reqJson(server, 'POST', '/fleet/prices', {
    token: 'T', body: { match_pattern: 'gpt-4o%', input_per_mtok: 2.5, output_per_mtok: 10 },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.match_pattern, 'gpt-4o%');
  await close();
});

test('POST /fleet/prices rejects missing fields', async () => {
  const { server, close } = await startWithPrices();
  const r = await reqJson(server, 'POST', '/fleet/prices', {
    token: 'T', body: { match_pattern: 'x' },
  });
  assert.equal(r.status, 422);
  await close();
});

test('DELETE /fleet/prices/:id soft-deletes', async () => {
  const { server, pg, close } = await startWithPrices();
  const created = await reqJson(server, 'POST', '/fleet/prices', {
    token: 'T', body: { match_pattern: 'temp%', input_per_mtok: 1, output_per_mtok: 1 },
  });
  const id = created.body.id;
  const del = await reqJson(server, 'DELETE', `/fleet/prices/${id}`, { token: 'T' });
  assert.equal(del.status, 204);
  const { rows } = await pg.query('SELECT deleted_at FROM fleet_model_prices WHERE id = $1', [id]);
  assert.ok(rows[0].deleted_at);
  await close();
});

test('POST /fleet/prices/resolve returns matched row + ZERO_PRICE for unknown', async () => {
  const { server, close } = await startWithPrices();
  const known = await reqJson(server, 'POST', '/fleet/prices/resolve', {
    token: 'T', body: { model: 'claude-opus-4-7' },
  });
  assert.equal(known.status, 200);
  assert.equal(known.body.matched.input, 15);
  assert.equal(known.body.matched.flagged, false);

  const unknown = await reqJson(server, 'POST', '/fleet/prices/resolve', {
    token: 'T', body: { model: 'totally-new-llm' },
  });
  assert.equal(unknown.body.matched.flagged, true);
  await close();
});

test('POST /fleet/prices invalidates cache: subsequent resolve sees new price', async () => {
  const { server, close } = await startWithPrices();
  // Warm cache via resolve
  const r1 = await reqJson(server, 'POST', '/fleet/prices/resolve', {
    token: 'T', body: { model: 'claude-opus-4-7' },
  });
  assert.equal(r1.body.matched.input, 15);
  // POST a higher-priority override
  await reqJson(server, 'POST', '/fleet/prices', {
    token: 'T', body: { match_pattern: 'claude-opus-4-7', priority: 500, input_per_mtok: 99, output_per_mtok: 99 },
  });
  // Resolve should see new price (cache invalidated by POST handler)
  const r2 = await reqJson(server, 'POST', '/fleet/prices/resolve', {
    token: 'T', body: { model: 'claude-opus-4-7' },
  });
  assert.equal(r2.body.matched.input, 99);
  await close();
});

test('GET /fleet/prices?history=1 includes soft-deleted rows', async () => {
  const { server, close } = await startWithPrices();
  const created = await reqJson(server, 'POST', '/fleet/prices', {
    token: 'T', body: { match_pattern: 'tmp-%', input_per_mtok: 5, output_per_mtok: 5 },
  });
  await reqJson(server, 'DELETE', `/fleet/prices/${created.body.id}`, { token: 'T' });

  const active = await reqJson(server, 'GET', '/fleet/prices', { token: 'T' });
  assert.ok(!active.body.find(p => p.id === created.body.id), 'soft-deleted hidden by default');

  const all = await reqJson(server, 'GET', '/fleet/prices?history=1', { token: 'T' });
  assert.ok(all.body.find(p => p.id === created.body.id), 'soft-deleted visible with history=1');
  await close();
});

test('GET /fleet/prices rejects missing auth', async () => {
  const { server, close } = await startWithPrices();
  const r = await reqJson(server, 'GET', '/fleet/prices');  // no token
  assert.equal(r.status, 401);
  await close();
});
```

- [ ] **Step 4: Run routes tests**

Run: `VAULT_RAG_PG_PASS=testpass node --test --test-name-pattern='prices|/fleet/prices' scripts/lib/fleet-routes.test.js`

Expected: 8 new tests pass.

- [ ] **Step 5: Full regression**

Run: `VAULT_RAG_PG_PASS=testpass node --test scripts/lib/fleet-routes.test.js`

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/fleet-routes.js scripts/lib/fleet-routes.test.js
git commit -m "feat: REST endpoints for /fleet/prices

GET /fleet/prices?history=1
POST /fleet/prices (new snapshot)
DELETE /fleet/prices/:id (soft)
POST /fleet/prices/resolve {model, at?} (debug)
Cache invalidated on each write.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: UI — #/prices page

**Files:**
- Create: `agent-fleet/web/prices.js`
- Modify: `agent-fleet/web/index.html`
- Modify: `agent-fleet/web/app.js`
- Modify: `agent-fleet/web/app.css`

- [ ] **Step 1: HTML container + nav button**

Edit `agent-fleet/web/index.html`. Find the nav buttons and add:

```html
<button id="nav-prices"    class="btn-ghost">$ prices</button>
```

Right after `nav-workflows`.

Add page container (sibling to `workflowsview`):

```html
<!-- PRICES PAGE -->
<div id="pricesview" hidden>
  <header class="archive-head">
    <div>
      <span class="display" style="font-size:1.1em">MODEL PRICES</span>
      <span id="prices-count" class="lbl" style="margin-left:1em">— rules</span>
    </div>
    <div>
      <label class="lbl" style="margin-right:.6em">
        <input id="px-history" type="checkbox"> show history
      </label>
      <button id="px-new" class="btn-ghost">+ new pattern</button>
      <button id="pricesview-close" class="btn-ghost">× back</button>
    </div>
  </header>
  <div class="archive-table-wrap">
    <table class="archive-table">
      <thead><tr>
        <th>pattern</th><th>priority</th><th>valid from</th>
        <th>input $/Mtok</th><th>output $/Mtok</th>
        <th>cache create</th><th>cache read</th><th>flag</th><th></th>
      </tr></thead>
      <tbody id="px-rows"></tbody>
    </table>
  </div>
</div>
```

Add script tag before app.js:

```html
<script src="/fleet/static/prices.js"></script>
```

- [ ] **Step 2: Create prices.js module**

Create `agent-fleet/web/prices.js`:

```js
'use strict';
// prices: #/prices page logic. Global: window.openPricesView.
(function () {
  function token() { return localStorage.fleetToken || ''; }
  async function api(path, opts = {}) {
    const headers = { 'authorization': `Bearer ${token()}` };
    if (opts.body) headers['content-type'] = 'application/json';
    const res = await fetch('/fleet' + path, { ...opts, headers });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { const j = await res.json(); msg += ' ' + (j.error || ''); } catch {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }
  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  async function openPricesView() {
    const showHistory = document.getElementById('px-history').checked;
    document.getElementById('pricesview-close').onclick = () => location.hash = '#/dashboard';
    document.getElementById('px-history').onchange = openPricesView;
    document.getElementById('px-new').onclick = () => openEditModal(null);
    await loadPrices(showHistory);
  }

  async function loadPrices(showHistory) {
    const rows = await api('/prices' + (showHistory ? '?history=1' : ''));
    document.getElementById('prices-count').textContent = `${rows.length} rules`;
    const body = document.getElementById('px-rows');
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:2em;color:var(--text-faint)">no pricing rules</td></tr>';
      return;
    }
    body.innerHTML = rows.map(r => {
      const dimmed = r.deleted_at ? 'opacity:0.4' : '';
      return `<tr style="${dimmed}">
        <td><strong>${esc(r.match_pattern)}</strong></td>
        <td>${r.priority}</td>
        <td>${new Date(r.valid_from).toISOString().slice(0,10)}</td>
        <td>${Number(r.input_per_mtok).toFixed(2)}</td>
        <td>${Number(r.output_per_mtok).toFixed(2)}</td>
        <td>${Number(r.cache_create_per_mtok).toFixed(2)}</td>
        <td>${Number(r.cache_read_per_mtok).toFixed(2)}</td>
        <td>${r.flagged ? '<span style="color:var(--warn)">⚠ fallback</span>' : ''}</td>
        <td>
          <button class="btn-ghost" data-edit="${r.id}" style="font-size:.75em">edit</button>
          ${r.deleted_at ? '' : `<button class="btn-ghost" data-del="${r.id}" style="font-size:.75em">×</button>`}
        </td>
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
      const row = rows.find(x => String(x.id) === b.dataset.edit);
      openEditModal(row);
    });
    body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('soft-delete this price row?')) return;
      try { await api(`/prices/${b.dataset.del}`, { method: 'DELETE' }); }
      catch (e) { alert(e.message); }
      await loadPrices(document.getElementById('px-history').checked);
    });
  }

  function openEditModal(existing) {
    const modal = document.getElementById('group-detail-modal');
    if (!modal) return alert('modal element missing');
    modal.hidden = false;
    const r = existing || { match_pattern: '', priority: 100, input_per_mtok: 0, output_per_mtok: 0, cache_create_per_mtok: 0, cache_read_per_mtok: 0, note: '' };
    modal.innerHTML = `
      <div class="gd-frame" style="width:520px">
        <div class="gd-head">
          <span class="display" style="font-size:1.1em">${existing ? 'NEW SNAPSHOT // ' + esc(r.match_pattern) : 'NEW PRICING RULE'}</span>
          <span style="flex:1"></span>
          <button class="btn-ghost" data-pm-close>× close</button>
        </div>
        <div class="gd-body">
          <p style="color:var(--text-dim); font-size:11px; margin-top:0">
            ${existing
              ? 'Saving creates a NEW row with valid_from=now. Old row stays for history.'
              : 'Pattern uses Postgres LIKE: % = any chars, _ = single. Examples: claude-opus-%, gpt-4o%, %'}
          </p>
          <label class="lbl">pattern</label><input id="pm-pattern" value="${esc(r.match_pattern)}"/>
          <label class="lbl">priority (higher wins)</label><input id="pm-priority" type="number" value="${r.priority}"/>
          <label class="lbl">input $/Mtok</label><input id="pm-input" type="number" step="0.0001" value="${Number(r.input_per_mtok)}"/>
          <label class="lbl">output $/Mtok</label><input id="pm-output" type="number" step="0.0001" value="${Number(r.output_per_mtok)}"/>
          <label class="lbl">cache_create $/Mtok</label><input id="pm-cc" type="number" step="0.0001" value="${Number(r.cache_create_per_mtok || 0)}"/>
          <label class="lbl">cache_read $/Mtok</label><input id="pm-cr" type="number" step="0.0001" value="${Number(r.cache_read_per_mtok || 0)}"/>
          <label class="lbl">note (optional)</label><input id="pm-note" value="${esc(r.note || '')}"/>
          <div style="margin-top:1em; display:flex; gap:.5em">
            <button class="btn-ghost" data-pm-save>save (new snapshot)</button>
            <button class="btn-ghost" data-pm-close>cancel</button>
          </div>
          <div id="pm-error" style="color:var(--danger); margin-top:.5em; min-height:1em"></div>
        </div>
      </div>
    `;
    modal.querySelectorAll('[data-pm-close]').forEach(b => b.onclick = () => { modal.hidden = true; });
    modal.querySelector('[data-pm-save]').onclick = async () => {
      const body = {
        match_pattern: document.getElementById('pm-pattern').value.trim(),
        priority: parseInt(document.getElementById('pm-priority').value, 10),
        input_per_mtok: parseFloat(document.getElementById('pm-input').value),
        output_per_mtok: parseFloat(document.getElementById('pm-output').value),
        cache_create_per_mtok: parseFloat(document.getElementById('pm-cc').value),
        cache_read_per_mtok: parseFloat(document.getElementById('pm-cr').value),
        note: document.getElementById('pm-note').value.trim(),
      };
      try {
        await api('/prices', { method: 'POST', body: JSON.stringify(body) });
        modal.hidden = true;
        await loadPrices(document.getElementById('px-history').checked);
      } catch (e) {
        document.getElementById('pm-error').textContent = e.message;
      }
    };
  }

  window.openPricesView = openPricesView;
})();
```

- [ ] **Step 3: Wire route + nav in app.js**

Edit `agent-fleet/web/app.js`. In `applyRoute()`, add hide-show for pricesview and a route handler:

In the section that hides all overlays at the top of applyRoute:

```js
const pxv = $('pricesview'); if (pxv) pxv.hidden = true;
```

Then add the route handler (near the workflows handlers):

```js
if (r.name === 'prices') {
  setNav('prices'); pxv.hidden = false;
  if (window.openPricesView) window.openPricesView();
  return;
}
```

In `setNav`:

```js
const pn = $('nav-prices'); if (pn) pn.classList.toggle('active-nav', active === 'prices');
```

In `boot()`:

```js
const pNav = $('nav-prices'); if (pNav) pNav.onclick = () => navigate('/prices');
```

- [ ] **Step 4: CSS for prices page**

Append to `agent-fleet/web/app.css` inside the existing overlay rule (search for `#groupsview, #workflowsview`):

```css
#groupsview, #workflowsview, #workfloweditor, #workflowrunviewer, #pricesview {
  position: fixed; inset: 0; z-index: 80; background: var(--bg);
  display: flex; flex-direction: column; overflow: auto;
}
```

(I.e. add `#pricesview` to the existing selector list.)

Also style the pricing inputs in the modal:

```css
.gd-body input[type="number"], .gd-body input[type="text"] {
  width: 100%; padding: .4em .55em; background: var(--bg); color: var(--text);
  border: 1px solid var(--line); font-family: var(--font-mono); font-size: .9em;
  margin-bottom: .3em;
}
```

- [ ] **Step 5: Syntax check + manual smoke**

Run: `node --check agent-fleet/web/prices.js && node --check agent-fleet/web/app.js`

Expected: silent OK.

Boot hub locally:

```bash
docker exec -i fleet-test-pg psql -U postgres -d vault_rag < sql/010-fleet-model-prices.sql || true
VAULT_RAG_PG_HOST=127.0.0.1 VAULT_RAG_PG_PORT=55433 VAULT_RAG_PG_PASS=testpass VAULT_RAG_PG_DB=vault_rag VAULT_RAG_API_TOKEN=Tsmoke RAG_PORT=18099 node scripts/rag-api.js >/tmp/rag-smoke.log 2>&1 &
sleep 2
# verify endpoints
TOKEN=Tsmoke
curl -s http://127.0.0.1:18099/fleet/prices -H "Authorization: Bearer $TOKEN"
curl -s -X POST http://127.0.0.1:18099/fleet/prices/resolve -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"model":"claude-opus-4-7"}'
# verify cost endpoint still works
curl -s "http://127.0.0.1:18099/fleet/cost/summary?days=7" -H "Authorization: Bearer $TOKEN"
```

Expected:
- `GET /fleet/prices` returns array with at least 4 rows
- `POST /fleet/prices/resolve` returns `{matched:{input:15,...}}` for opus
- `GET /fleet/cost/summary` returns the same shape as before refactor (numbers unchanged)

Stop hub: `pkill -f scripts/rag-api.js`

- [ ] **Step 6: Commit**

```bash
git add agent-fleet/web/prices.js agent-fleet/web/index.html agent-fleet/web/app.js agent-fleet/web/app.css
git commit -m "feat: pricing UI page

#/prices: table + 'show history' toggle + 'edit' (new snapshot)
+ 'delete' (soft). Modal form for create/snapshot. Yellow flag for
fallback rows.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Deploy to prod + verify

**Files:** none new; this is a deploy task.

- [ ] **Step 1: Push commits**

```bash
git push
```

- [ ] **Step 2: Pull on prod + apply migration**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es 'cd /opt/vault-rag && git pull --ff-only origin main && docker exec -i vault-rag-postgres psql -U postgres -d vault_rag < /opt/vault-rag/sql/010-fleet-model-prices.sql && docker restart vault-rag-api'
```

Expected output: `CREATE TABLE`, `CREATE INDEX`, `INSERT 0 4`, `UPDATE 1`, `vault-rag-api` (restart).

- [ ] **Step 3: Verify cost endpoints return expected numbers**

```bash
TOKEN=$(grep VAULT_RAG_API_TOKEN .env | cut -d= -f2)
curl -s "https://brain.itiswednesdaymydud.es/fleet/cost/summary?days=7" -H "Authorization: Bearer $TOKEN" | jq '.usd, .msgs'
```

**Expected**: numbers IDENTICAL for events whose model matches `claude-opus-*`, `claude-sonnet-*`, or `claude-haiku-*` (today: all production events fall into these). If your tokmon has events with non-Claude models (gpt, gemini, local), those events now show $0 (matched by `%` fallback row, flagged) — this is intentional per spec §13.4. The old code mapped any unknown model to sonnet defaults — that bug is being fixed. Verify by:

```bash
# Count events grouped by whether their model matched a Claude family:
docker exec vault-rag-postgres psql -U postgres -d tokmon -c "
  SELECT
    CASE
      WHEN model LIKE 'claude-opus-%'   THEN 'opus'
      WHEN model LIKE 'claude-sonnet-%' THEN 'sonnet'
      WHEN model LIKE 'claude-haiku-%'  THEN 'haiku'
      ELSE 'other (now \$0 flagged)' END AS class,
    COUNT(*) AS msgs
  FROM events WHERE ts > now() - interval '7 days'
  GROUP BY class"
```

If "other" count is 0 — pre/post numbers identical. If > 0 — explain to operator that those rows are now $0 + flagged; if they want them priced like sonnet (legacy behavior), add a `claude-%` priority-50 row matching sonnet rates as a manual step.

- [ ] **Step 4: Verify /fleet/prices endpoint works**

```bash
curl -s https://brain.itiswednesdaymydud.es/fleet/prices -H "Authorization: Bearer $TOKEN" | jq 'length'
```

Expected: 4 (3 Claude families + default).

- [ ] **Step 5: Verify UI renders**

Open `https://brain.itiswednesdaymydud.es/fleet/` in browser, hard-refresh (Ctrl+Shift+R). Click `$ prices` in nav. Expected: table with 4 rows.

Click `+ new pattern`, enter `gpt-4o%` / priority 200 / input 2.50 / output 10.00. Save. New row appears.

Click `edit` on the new row, change input to 3.00. Save. New snapshot row appears (now 2 gpt-4o rows; original visible only with "show history" toggle).

- [ ] **Step 6: Close vt task**

```bash
scripts/bin/vt close <task-id> --reason "configurable pricing shipped: schema 010 + fleet-prices resolver + REST + UI, deployed prod"
git status  # MUST show 'up to date with origin'
```

---

## Self-Review

**Spec coverage:**
- §3 Architecture (hub-embedded, in-memory cache) — Tasks 2 + 3.
- §4 Schema — Task 1.
- §5 Resolution algorithm (LIKE + priority + valid_from) — Task 2 (`likeMatch`, `priceFor`).
- §6 fleet-cost refactor — Task 3.
- §7 fleet-prices module — Task 2.
- §8 REST API (GET/POST/DELETE + resolve) — Task 4.
- §9 UI page — Task 5.
- §10 Migration order — Tasks 1, 3, 5 + Task 6 (prod).
- §13 Success criteria all checked in Task 6.
- §14 Open question — went with TTL 60s + invalidate (per user "давай делать").

**Placeholder scan:** No TBD/TODO. All commands and code blocks are concrete.

**Type consistency:**
- `priceFor` signature: `priceFor(db, model, ts?)` consistent across fleet-prices.js, tests, and routes.
- `rowCost` signature: `rowCost(r, ts, vaultPg)` consistent in fleet-cost.js callers.
- Price object shape: `{input, output, cache_create, cache_read, flagged, id}` consistent.
- Column names: `input_per_mtok` / `output_per_mtok` / `cache_create_per_mtok` / `cache_read_per_mtok` consistent SQL ↔ JS ↔ UI.

One bit I caught & fixed inline: Task 3 introduces `MAX(ts) AS last_ts` in aggregateRows so rowCost gets an event timestamp for temporal lookup. This is required by §3/§5 of spec — temporal pricing per event. Original aggregateRows didn't have this column.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-15-agent-fleet-configurable-pricing-implementation.md`.

Per project CLAUDE.md (cost control), `subagent-driven-development` is disabled. Default execution mode is `superpowers:executing-plans` (inline batched).

User has chosen — proceeding with inline execution next.
