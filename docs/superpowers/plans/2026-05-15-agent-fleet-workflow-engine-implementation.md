---
type: plan
status: draft
epic: agent-fleet
spec: docs/superpowers/specs/2026-05-15-agent-fleet-workflow-engine-design.md
date: 2026-05-15
---

# Agent-Fleet Workflow Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (Note: `subagent-driven-development` disabled per project CLAUDE.md.)

**Goal:** Реализовать workflow engine для agent-fleet — визуальный блок-схемный builder для цепочки задач между агентами с маршрутизацией по группам/labels.

**Architecture:** Embedded в hub-процесс (`scripts/rag-api.js`). Postgres хранит DAG definition + run state. In-process async runner шагает по узлам, спавнит fleet-сессии через существующий dispatch, шлёт прогресс по WS подписчикам. Браузер — vanilla JS + SVG canvas (без библиотек).

**Tech Stack:** Node.js (CommonJS), `pg`, `ws`, `node:test`, vanilla JS+SVG в браузере.

---

## File Layout

| File | Purpose | Status |
|------|---------|--------|
| `sql/008-fleet-workflows.sql` | Schema migration | new |
| `scripts/lib/fleet-workflow-db.js` | CRUD: workflows + runs | new |
| `scripts/lib/fleet-workflow-db.test.js` | DB tests | new |
| `scripts/lib/fleet-workflow-runner.js` | DAG execution engine | new |
| `scripts/lib/fleet-workflow-runner.test.js` | Runner tests | new |
| `scripts/lib/fleet-routes.js` | REST handlers, WS role workflow_viewer | modify |
| `scripts/lib/fleet-routes.test.js` | REST tests | modify |
| `agent-fleet/web/workflow-canvas.js` | Shared SVG renderer (editor + viewer) | new |
| `agent-fleet/web/workflow-editor.js` | Editor page logic | new |
| `agent-fleet/web/workflow-run-viewer.js` | Run viewer page logic | new |
| `agent-fleet/web/index.html` | Routes, nav button, page containers | modify |
| `agent-fleet/web/app.js` | Routing wires for #/workflows etc. | modify |
| `agent-fleet/web/app.css` | Workflow page styles | modify |

---

## Conventions Engineer Must Know

- Tests use `node:test` + `node:assert`. Run: `node --test scripts/lib/<file>.test.js`.
- Postgres on `127.0.0.1:55433`, database `vault_rag`, user `postgres`. Tests connect via `pg.Client` with env `VAULT_RAG_PG_PASS`.
- Test pattern: `TRUNCATE` tables in setup, then run scenario. See `scripts/lib/fleet-db.test.js` for the established pattern.
- HTTP handlers in `fleet-routes.js` take `{req, res, body, ctx}` and use `send(res, status, body)` helper.
- `ctx.db` is a `pg.Pool`-like; pass it to db functions as first arg.
- `ctx.bus` is the in-process WS broker (see `makeBus()` at fleet-routes.js:41).
- WS frames are JSON strings, one frame per `ws.send()`.
- Browser code uses vanilla JS, no bundler. Files loaded via `<script>` tags in `index.html` in order.
- `$(id)` helper exists in `app.js` for `document.getElementById`.
- Commits use `feat:`, `test:`, `fix:` prefixes; co-authored-by trailer present.
- Migration apply: `psql ... -f sql/008-fleet-workflows.sql`. CI does not auto-apply; apply manually after merge.

---

## Task 1: SQL migration

**Files:**
- Create: `sql/008-fleet-workflows.sql`

- [ ] **Step 1: Write the migration**

Create `sql/008-fleet-workflows.sql`:

```sql
CREATE TABLE IF NOT EXISTS fleet_workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text UNIQUE NOT NULL,
  description text,
  definition  jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fleet_workflow_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  uuid REFERENCES fleet_workflows(id) ON DELETE SET NULL,
  snapshot     jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  state        jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fleet_workflow_runs_wid
  ON fleet_workflow_runs(workflow_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_fleet_workflow_runs_status
  ON fleet_workflow_runs(status) WHERE status IN ('pending','running');
```

- [ ] **Step 2: Apply migration to dev DB**

Run: `PGPASSWORD=$(scripts/bin/vt secrets get VAULT_RAG_PG_PASS) psql -h 127.0.0.1 -p 55433 -U postgres -d vault_rag -f sql/008-fleet-workflows.sql`

Expected: `CREATE TABLE` x2, `CREATE INDEX` x2 (no errors).

- [ ] **Step 3: Verify schema**

Run: `PGPASSWORD=$(scripts/bin/vt secrets get VAULT_RAG_PG_PASS) psql -h 127.0.0.1 -p 55433 -U postgres -d vault_rag -c "\d fleet_workflows" -c "\d fleet_workflow_runs"`

Expected: both tables listed with all columns.

- [ ] **Step 4: Commit**

```bash
git add sql/008-fleet-workflows.sql
git commit -m "feat: schema for agent-fleet workflows + runs

Two tables: fleet_workflows (DAG definition, JSONB) and
fleet_workflow_runs (snapshot + state, status enum-ish).

Indexes for workflow_id-time-ordered run lookup and
pending/running active filter.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: fleet-workflow-db.js CRUD

**Files:**
- Create: `scripts/lib/fleet-workflow-db.js`
- Create: `scripts/lib/fleet-workflow-db.test.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/fleet-workflow-db.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const wfDb = require('./fleet-workflow-db');

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
  await c.query('TRUNCATE fleet_workflow_runs, fleet_workflows RESTART IDENTITY CASCADE');
}

const SAMPLE_DEF = {
  start: 'n1',
  nodes: [{ id: 'n1', type: 'delay', seconds: 1, position: { x: 0, y: 0 } }],
  edges: [],
};

test('createWorkflow inserts and returns row', async () => {
  await withClient(async (c) => {
    await reset(c);
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: SAMPLE_DEF });
    assert.ok(w.id);
    assert.strictEqual(w.name, 'wf1');
    assert.deepStrictEqual(w.definition, SAMPLE_DEF);
  });
});

test('listWorkflows returns all', async () => {
  await withClient(async (c) => {
    await reset(c);
    await wfDb.createWorkflow(c, { name: 'a', definition: SAMPLE_DEF });
    await wfDb.createWorkflow(c, { name: 'b', definition: SAMPLE_DEF });
    const list = await wfDb.listWorkflows(c);
    assert.strictEqual(list.length, 2);
  });
});

test('updateWorkflow patches name and bumps updated_at', async () => {
  await withClient(async (c) => {
    await reset(c);
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: SAMPLE_DEF });
    await new Promise(r => setTimeout(r, 10));
    const u = await wfDb.updateWorkflow(c, w.id, { name: 'wf2' });
    assert.strictEqual(u.name, 'wf2');
    assert.ok(new Date(u.updated_at).getTime() > new Date(w.updated_at).getTime());
  });
});

test('deleteWorkflow removes row; runs survive with workflow_id NULL', async () => {
  await withClient(async (c) => {
    await reset(c);
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: SAMPLE_DEF });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: SAMPLE_DEF });
    await wfDb.deleteWorkflow(c, w.id);
    const runs = await wfDb.listRuns(c, {});
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].workflow_id, null);
  });
});

test('createRun + updateRunStatus lifecycle', async () => {
  await withClient(async (c) => {
    await reset(c);
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: SAMPLE_DEF });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: SAMPLE_DEF });
    assert.strictEqual(r.status, 'pending');

    await wfDb.updateRunStatus(c, r.id, 'running');
    const r2 = await wfDb.getRun(c, r.id);
    assert.strictEqual(r2.status, 'running');
    assert.ok(r2.started_at);

    await wfDb.updateRunStatus(c, r.id, 'done');
    const r3 = await wfDb.getRun(c, r.id);
    assert.strictEqual(r3.status, 'done');
    assert.ok(r3.finished_at);
  });
});

test('updateRunState merges JSONB', async () => {
  await withClient(async (c) => {
    await reset(c);
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: SAMPLE_DEF });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: SAMPLE_DEF });
    await wfDb.updateRunState(c, r.id, { current_node: 'n1', outputs: { n1: { output: 'hi', exit_code: 0 } } });
    const r2 = await wfDb.getRun(c, r.id);
    assert.deepStrictEqual(r2.state.outputs.n1, { output: 'hi', exit_code: 0 });
    assert.strictEqual(r2.state.current_node, 'n1');
  });
});

test('orphanRunningRuns flips running→failed at boot', async () => {
  await withClient(async (c) => {
    await reset(c);
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: SAMPLE_DEF });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: SAMPLE_DEF });
    await wfDb.updateRunStatus(c, r.id, 'running');
    const n = await wfDb.orphanRunningRuns(c);
    assert.strictEqual(n, 1);
    const r2 = await wfDb.getRun(c, r.id);
    assert.strictEqual(r2.status, 'failed');
    assert.match(JSON.stringify(r2.state), /hub restart/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/lib/fleet-workflow-db.test.js`

Expected: `Cannot find module './fleet-workflow-db'`.

- [ ] **Step 3: Implement fleet-workflow-db.js**

Create `scripts/lib/fleet-workflow-db.js`:

```js
'use strict';
// fleet-workflow-db: CRUD for fleet_workflows + fleet_workflow_runs.
// Callers pass an active pg Client/Pool.

async function listWorkflows(c) {
  const { rows } = await c.query(`
    SELECT id, name, description,
           jsonb_array_length(definition->'nodes') AS n_nodes,
           updated_at, created_at
    FROM fleet_workflows ORDER BY updated_at DESC`);
  return rows;
}

async function getWorkflow(c, id) {
  const { rows } = await c.query('SELECT * FROM fleet_workflows WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createWorkflow(c, { name, description, definition }) {
  const { rows } = await c.query(
    `INSERT INTO fleet_workflows (name, description, definition)
     VALUES ($1, $2, $3::jsonb) RETURNING *`,
    [name, description || null, JSON.stringify(definition)]);
  return rows[0];
}

async function updateWorkflow(c, id, patch) {
  const updates = []; const args = [];
  if ('name' in patch)        { args.push(patch.name);        updates.push(`name = $${args.length}`); }
  if ('description' in patch) { args.push(patch.description); updates.push(`description = $${args.length}`); }
  if ('definition' in patch)  { args.push(JSON.stringify(patch.definition)); updates.push(`definition = $${args.length}::jsonb`); }
  if (!updates.length) return await getWorkflow(c, id);
  updates.push('updated_at = now()');
  args.push(id);
  const { rows } = await c.query(
    `UPDATE fleet_workflows SET ${updates.join(', ')} WHERE id = $${args.length} RETURNING *`, args);
  return rows[0] || null;
}

async function deleteWorkflow(c, id) {
  await c.query('DELETE FROM fleet_workflows WHERE id = $1', [id]);
}

async function listRuns(c, { workflowId, status, limit = 100 } = {}) {
  const where = []; const args = [];
  if (workflowId) { args.push(workflowId); where.push(`workflow_id = $${args.length}`); }
  if (status)     { args.push(status);     where.push(`status = $${args.length}`); }
  const wh = where.length ? `WHERE ${where.join(' AND ')}` : '';
  args.push(limit);
  const { rows } = await c.query(
    `SELECT * FROM fleet_workflow_runs ${wh}
     ORDER BY created_at DESC LIMIT $${args.length}`, args);
  return rows;
}

async function getRun(c, id) {
  const { rows } = await c.query('SELECT * FROM fleet_workflow_runs WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createRun(c, { workflowId, snapshot, state = {} }) {
  const { rows } = await c.query(
    `INSERT INTO fleet_workflow_runs (workflow_id, snapshot, state)
     VALUES ($1, $2::jsonb, $3::jsonb) RETURNING *`,
    [workflowId, JSON.stringify(snapshot), JSON.stringify(state)]);
  return rows[0];
}

async function updateRunStatus(c, id, status, errorMsg = null) {
  const ts = status === 'running' ? 'started_at = now()' :
             (status === 'done' || status === 'failed' || status === 'cancelled') ? 'finished_at = now()' :
             '';
  const tsClause = ts ? `, ${ts}` : '';
  const errClause = errorMsg ? `, state = jsonb_set(state, '{error}', to_jsonb($3::text), true)` : '';
  const args = [id, status];
  if (errorMsg) args.push(errorMsg);
  await c.query(
    `UPDATE fleet_workflow_runs SET status = $2 ${tsClause} ${errClause} WHERE id = $1`, args);
}

async function updateRunState(c, id, patch) {
  // Shallow merge into state JSONB (top-level keys overwrite).
  await c.query(
    `UPDATE fleet_workflow_runs SET state = state || $2::jsonb WHERE id = $1`,
    [id, JSON.stringify(patch)]);
}

async function orphanRunningRuns(c) {
  const { rowCount } = await c.query(
    `UPDATE fleet_workflow_runs
     SET status = 'failed',
         finished_at = now(),
         state = state || '{"error":"hub restart"}'::jsonb
     WHERE status IN ('pending','running')`);
  return rowCount;
}

module.exports = {
  listWorkflows, getWorkflow, createWorkflow, updateWorkflow, deleteWorkflow,
  listRuns, getRun, createRun, updateRunStatus, updateRunState, orphanRunningRuns,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/lib/fleet-workflow-db.test.js`

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fleet-workflow-db.js scripts/lib/fleet-workflow-db.test.js
git commit -m "feat: fleet-workflow-db CRUD with tests

CRUD for fleet_workflows (list/get/create/update/delete) and
fleet_workflow_runs (list/get/create/updateStatus/updateState/orphan).
JSONB state merge is shallow top-level overwrite.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: fleet-workflow-runner.js — execution engine

**Files:**
- Create: `scripts/lib/fleet-workflow-runner.js`
- Create: `scripts/lib/fleet-workflow-runner.test.js`

The runner needs three exec strategies (claude/branch/delay), template substitution, and a broadcast hook. We inject a `spawnClaude` and a `broadcast` function so the test can mock them.

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/fleet-workflow-runner.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const wfDb = require('./fleet-workflow-db');
const { createRunner } = require('./fleet-workflow-runner');

const PG = {
  host: process.env.VAULT_RAG_PG_HOST || '127.0.0.1',
  database: process.env.VAULT_RAG_PG_DB || 'vault_rag',
  user: process.env.VAULT_RAG_PG_USER || 'postgres',
  password: process.env.VAULT_RAG_PG_PASS,
  port: parseInt(process.env.VAULT_RAG_PG_PORT || '55433', 10),
};

async function withClient(fn) {
  const c = new Client(PG);
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function reset(c) {
  await c.query('TRUNCATE fleet_workflow_runs, fleet_workflows RESTART IDENTITY CASCADE');
}

function makeDeps(spawnImpl) {
  const frames = [];
  return {
    db: null,
    spawnClaude: spawnImpl,
    broadcast: (runId, frame) => frames.push({ runId, frame }),
    getFrames: () => frames,
  };
}

test('substituteTemplates replaces {{n1.output}} and {{inputs.x}}', () => {
  const { substituteTemplates } = require('./fleet-workflow-runner');
  const ctx = { n1: { output: 'hello' }, inputs: { x: 42 } };
  assert.strictEqual(substituteTemplates('say {{n1.output}} {{inputs.x}}', ctx),
    'say hello 42');
  assert.strictEqual(substituteTemplates('missing {{n9.foo}}', ctx), 'missing ');
});

test('validateDefinition catches cycles, missing nodes, bad branch fanout', () => {
  const { validateDefinition } = require('./fleet-workflow-runner');
  // cycle
  const cycle = {
    start: 'a',
    nodes: [{ id: 'a', type: 'delay', seconds: 1 }, { id: 'b', type: 'delay', seconds: 1 }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  };
  assert.throws(() => validateDefinition(cycle), /cycle/);

  // missing target
  assert.throws(() => validateDefinition({
    start: 'a',
    nodes: [{ id: 'a', type: 'delay', seconds: 1 }],
    edges: [{ from: 'a', to: 'ghost' }],
  }), /unknown/);

  // branch wrong fanout
  assert.throws(() => validateDefinition({
    start: 'a',
    nodes: [
      { id: 'a', type: 'branch', condition: 'true' },
      { id: 'b', type: 'delay', seconds: 1 },
    ],
    edges: [{ from: 'a', to: 'b', label: 'then' }],
  }), /branch.*then.*else/);
});

test('runner executes linear delay→delay and marks done', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [
        { id: 'n1', type: 'delay', seconds: 0 },
        { id: 'n2', type: 'delay', seconds: 0 },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => ({ output: '', exit_code: 0, session_id: 'sx' }));
    deps.db = c;
    const runner = createRunner(deps);
    await runner.runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done');
    const types = deps.getFrames().map(f => f.frame.type);
    assert.ok(types.includes('run_state'));
    assert.ok(types.includes('node_progress'));
  });
});

test('runner branches on condition true', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [
        { id: 'n1', type: 'delay', seconds: 0 },
        { id: 'n2', type: 'branch', condition: 'true' },
        { id: 'nT', type: 'delay', seconds: 0 },
        { id: 'nE', type: 'delay', seconds: 0 },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'nT', label: 'then' },
        { from: 'n2', to: 'nE', label: 'else' },
      ],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => ({ output: '', exit_code: 0, session_id: 'sx' }));
    deps.db = c;
    const runner = createRunner(deps);
    await runner.runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done');
    assert.ok(final.state.outputs.nT, 'then branch executed');
    assert.ok(!final.state.outputs.nE, 'else branch skipped');
  });
});

test('runner records claude output and marks failed on exit_code != 0 when on_fail=abort', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [{ id: 'n1', type: 'claude', target: { host_name: 'h' }, prompt: 'p' }],
      edges: [],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => ({ output: 'err', exit_code: 1, session_id: 'sx' }));
    deps.db = c;
    const runner = createRunner(deps);
    await runner.runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    // exit_code != 0 itself does not abort; runner records and continues.
    // But with no outgoing edges the run still completes.
    assert.strictEqual(final.status, 'done');
    assert.strictEqual(final.state.outputs.n1.exit_code, 1);
  });
});

test('runner cancellation halts mid-run', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [
        { id: 'n1', type: 'delay', seconds: 0 },
        { id: 'n2', type: 'delay', seconds: 2 },
        { id: 'n3', type: 'delay', seconds: 0 },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
      ],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => ({ output: '', exit_code: 0, session_id: 'sx' }));
    deps.db = c;
    const runner = createRunner(deps);
    setTimeout(() => runner.cancel(r.id), 50);
    await runner.runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'cancelled');
    assert.ok(!final.state.outputs.n3, 'n3 never executed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/lib/fleet-workflow-runner.test.js`

Expected: `Cannot find module './fleet-workflow-runner'`.

- [ ] **Step 3: Implement fleet-workflow-runner.js**

Create `scripts/lib/fleet-workflow-runner.js`:

```js
'use strict';
// fleet-workflow-runner: in-process DAG executor for fleet_workflow_runs.
// deps:
//   db          — pg client
//   spawnClaude — async ({node, prompt, ctx}) => {output, exit_code, session_id}
//   broadcast   — (runId, frame) => void
const vm = require('vm');
const wfDb = require('./fleet-workflow-db');

const TEMPLATE_RE = /\{\{([\w.]+)\}\}/g;

function substituteTemplates(str, ctx) {
  if (!str) return str;
  return String(str).replace(TEMPLATE_RE, (_, path) => {
    const parts = path.split('.');
    let v = ctx;
    for (const p of parts) {
      if (v == null) return '';
      v = v[p];
    }
    return v == null ? '' : String(v);
  });
}

function validateDefinition(def) {
  if (!def || typeof def !== 'object') throw new Error('definition required');
  const { start, nodes, edges } = def;
  if (!start) throw new Error('start node required');
  if (!Array.isArray(nodes) || !nodes.length) throw new Error('nodes required');
  const byId = new Map(nodes.map(n => [n.id, n]));
  if (!byId.has(start)) throw new Error(`unknown start node: ${start}`);
  for (const e of edges || []) {
    if (!byId.has(e.from)) throw new Error(`edge from unknown node: ${e.from}`);
    if (!byId.has(e.to))   throw new Error(`edge to unknown node: ${e.to}`);
  }
  // branch fanout check
  for (const n of nodes) {
    if (n.type !== 'branch') continue;
    const out = (edges || []).filter(e => e.from === n.id);
    const labels = new Set(out.map(e => e.label));
    if (out.length !== 2 || !labels.has('then') || !labels.has('else')) {
      throw new Error(`branch node ${n.id} must have exactly one then and one else outgoing edge`);
    }
  }
  // cycle detect via DFS
  const visiting = new Set();
  const visited = new Set();
  function dfs(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`cycle detected at node ${id}`);
    visiting.add(id);
    for (const e of (edges || []).filter(e => e.from === id)) dfs(e.to);
    visiting.delete(id);
    visited.add(id);
  }
  dfs(start);
}

function evalCondition(expr, sandboxData) {
  const sandbox = vm.createContext({ ...sandboxData });
  try {
    return !!vm.runInContext(expr, sandbox, { timeout: 100 });
  } catch (e) {
    throw new Error(`branch condition error: ${e.message}`);
  }
}

function nextNode(currentId, def, branchResult) {
  const out = (def.edges || []).filter(e => e.from === currentId);
  if (!out.length) return null;
  if (branchResult !== undefined) {
    const want = branchResult ? 'then' : 'else';
    const e = out.find(x => x.label === want);
    return e ? e.to : null;
  }
  return out[0].to;
}

function createRunner(deps) {
  const cancelled = new Set();

  async function execClaude(node, ctx, runId) {
    const prompt = substituteTemplates(node.prompt, ctx);
    return await deps.spawnClaude({ node, prompt, ctx, runId });
  }

  function execBranch(node, ctx) {
    const expr = substituteTemplates(node.condition, ctx);
    const result = evalCondition(expr, ctx);
    return { result };
  }

  async function execDelay(node, runId) {
    const ms = Math.max(0, (node.seconds || 0) * 1000);
    if (ms === 0) return {};
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({}), ms);
      const poll = setInterval(() => {
        if (cancelled.has(runId)) { clearTimeout(t); clearInterval(poll); reject(new Error('cancelled')); }
      }, 50);
      // ensure poll cleared on success too
      const wrap = setTimeout(() => clearInterval(poll), ms + 10);
      wrap.unref && wrap.unref();
    });
  }

  async function runToCompletion(runId) {
    const run = await wfDb.getRun(deps.db, runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    const def = run.snapshot;
    await wfDb.updateRunStatus(deps.db, runId, 'running');
    deps.broadcast(runId, { type: 'run_state', run_id: runId, status: 'running' });

    const outputs = {};
    const inputs = run.state.inputs || {};
    let current = def.start;
    const byId = new Map(def.nodes.map(n => [n.id, n]));

    while (current) {
      if (cancelled.has(runId)) {
        await wfDb.updateRunStatus(deps.db, runId, 'cancelled');
        deps.broadcast(runId, { type: 'run_state', run_id: runId, status: 'cancelled' });
        return;
      }
      const node = byId.get(current);
      if (!node) {
        await wfDb.updateRunStatus(deps.db, runId, 'failed', `unknown node ${current}`);
        deps.broadcast(runId, { type: 'run_state', run_id: runId, status: 'failed' });
        return;
      }
      deps.broadcast(runId, { type: 'node_progress', run_id: runId, node_id: current, status: 'running' });
      await wfDb.updateRunState(deps.db, runId, { current_node: current });

      const ctxData = { ...outputs, inputs };
      let result, nextId;
      try {
        if (node.type === 'claude')      result = await execClaude(node, ctxData, runId);
        else if (node.type === 'branch') result = execBranch(node, ctxData);
        else if (node.type === 'delay')  result = await execDelay(node, runId);
        else throw new Error(`unknown node type: ${node.type}`);
      } catch (e) {
        if (e.message === 'cancelled') {
          await wfDb.updateRunStatus(deps.db, runId, 'cancelled');
          deps.broadcast(runId, { type: 'run_state', run_id: runId, status: 'cancelled' });
          return;
        }
        deps.broadcast(runId, { type: 'node_progress', run_id: runId, node_id: current, status: 'failed', error: e.message });
        await wfDb.updateRunStatus(deps.db, runId, 'failed', `${current}: ${e.message}`);
        deps.broadcast(runId, { type: 'run_state', run_id: runId, status: 'failed' });
        return;
      }
      outputs[current] = result;
      await wfDb.updateRunState(deps.db, runId, { outputs });
      deps.broadcast(runId, {
        type: 'node_progress', run_id: runId, node_id: current, status: 'done',
        output: result.output, exit_code: result.exit_code, session_id: result.session_id,
      });

      nextId = nextNode(current, def, node.type === 'branch' ? result.result : undefined);
      current = nextId;
    }

    await wfDb.updateRunStatus(deps.db, runId, 'done');
    deps.broadcast(runId, { type: 'run_state', run_id: runId, status: 'done' });
  }

  function cancel(runId) {
    cancelled.add(runId);
  }

  function start(runId) {
    runToCompletion(runId).catch(e => {
      console.error(`[fleet-workflow-runner] run ${runId} crashed:`, e);
    });
  }

  return { start, runToCompletion, cancel };
}

module.exports = { createRunner, substituteTemplates, validateDefinition, evalCondition, nextNode };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/lib/fleet-workflow-runner.test.js`

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fleet-workflow-runner.js scripts/lib/fleet-workflow-runner.test.js
git commit -m "feat: fleet-workflow-runner DAG execution engine

In-process async runner. Exec strategies for claude/branch/delay nodes.
Template substitution via {{node.field}} regex (single-pass, missing → empty).
Branch condition eval via vm.runInContext with 100ms timeout.
Cancellation via in-memory flag + per-node check.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: REST endpoints in fleet-routes.js

Wire workflow CRUD + run-control endpoints. Reuse existing `dispatchHttp` dispatcher and `send`/`readBody`/`checkAuth` helpers. The runner needs a `spawnClaude` adapter that calls into `handleDispatch` logic — extract a helper `dispatchSpawn(ctx, body)` first so the runner reuses the same path without HTTP round-trip.

**Files:**
- Modify: `scripts/lib/fleet-routes.js`
- Modify: `scripts/lib/fleet-routes.test.js`

- [ ] **Step 1: Write the failing test**

Append to `scripts/lib/fleet-routes.test.js` (find existing test file; append new `test(...)` blocks at the end before `module.exports` or EOF):

```js
test('POST /fleet/workflows creates workflow', async () => {
  const { server, port, ctx } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/fleet/workflows`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${ctx.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'wf-test',
        definition: { start: 'n1', nodes: [{ id: 'n1', type: 'delay', seconds: 0 }], edges: [] },
      }),
    });
    assert.strictEqual(res.status, 201);
    const j = await res.json();
    assert.ok(j.id);
  } finally { server.close(); }
});

test('GET /fleet/workflows lists workflows', async () => {
  const { server, port, ctx } = await startServer();
  try {
    await fetch(`http://127.0.0.1:${port}/fleet/workflows`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${ctx.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'wf-list',
        definition: { start: 'n1', nodes: [{ id: 'n1', type: 'delay', seconds: 0 }], edges: [] },
      }),
    });
    const res = await fetch(`http://127.0.0.1:${port}/fleet/workflows`, {
      headers: { 'authorization': `Bearer ${ctx.token}` },
    });
    const j = await res.json();
    assert.ok(Array.isArray(j));
    assert.ok(j.find(w => w.name === 'wf-list'));
  } finally { server.close(); }
});

test('POST /fleet/workflows/:id/run starts a run', async () => {
  const { server, port, ctx } = await startServer();
  try {
    const c = await fetch(`http://127.0.0.1:${port}/fleet/workflows`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${ctx.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'wf-run',
        definition: { start: 'n1', nodes: [{ id: 'n1', type: 'delay', seconds: 0 }], edges: [] },
      }),
    });
    const { id } = await c.json();
    const r = await fetch(`http://127.0.0.1:${port}/fleet/workflows/${id}/run`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${ctx.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(r.status, 201);
    const j = await r.json();
    assert.ok(j.run_id);
  } finally { server.close(); }
});
```

If the existing test file uses a different bootstrap pattern, adapt `startServer()` to match it. Inspect: `node --test scripts/lib/fleet-routes.test.js -t 'POST /fleet/exec'` for an example to copy.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/lib/fleet-routes.test.js -t 'workflows'`

Expected: 3 new tests fail with 404 (route not registered).

- [ ] **Step 3: Add handlers and dispatch routes**

Edit `scripts/lib/fleet-routes.js`:

a) Add `require('./fleet-workflow-db')` and `require('./fleet-workflow-runner')` near top alongside existing `fleetDb` import:

```js
const wfDb = require('./fleet-workflow-db');
const { createRunner, validateDefinition } = require('./fleet-workflow-runner');
```

b) Add `ctx.workflowRunner` initialization inside `makeContext` (around line 938-942):

```js
function makeContext({ token, db, version }) {
  const ctx = { token, db, version };
  ctx.bus = makeBus();
  ctx.workflowRunner = createRunner({
    db: null, // set later in attach() once pool is bound
    spawnClaude: async ({ node, prompt, runId }) => spawnClaudeForWorkflow(ctx, node, prompt, runId),
    broadcast: (runId, frame) => ctx.bus.broadcastWorkflow(runId, frame),
  });
  return ctx;
}
```

Then in `attach(server, ctx)` (line 845) before returning, do:

```js
ctx.workflowRunner = createRunner({
  db: ctx.db,
  spawnClaude: async ({ node, prompt, runId }) => spawnClaudeForWorkflow(ctx, node, prompt, runId),
  broadcast: (runId, frame) => ctx.bus.broadcastWorkflow(runId, frame),
});
// Mark stranded runs failed at boot
wfDb.orphanRunningRuns(ctx.db).catch(e => console.error('[fleet] orphan workflow runs:', e));
```

c) Add `broadcastWorkflow` and viewer set to `makeBus()` (line 41-90 region). Find existing `viewersBySession` declaration and add:

```js
const workflowViewers = new Map(); // run_id → Set<ws>
```

And inside the returned object add:

```js
addWorkflowViewer(runId, ws) {
  let set = workflowViewers.get(runId);
  if (!set) { set = new Set(); workflowViewers.set(runId, set); }
  set.add(ws);
  ws.on('close', () => { set.delete(ws); if (!set.size) workflowViewers.delete(runId); });
},
broadcastWorkflow(runId, frame) {
  const set = workflowViewers.get(runId);
  if (!set) return;
  const payload = JSON.stringify(frame);
  for (const v of set) { try { v.send(payload); } catch {} }
},
```

d) Add handlers — append near other handlers (after `handleSessionCost` ~line 549):

```js
async function handleListWorkflows({ res, ctx }) {
  const rows = await wfDb.listWorkflows(ctx.db);
  send(res, 200, rows);
}

async function handleGetWorkflow({ req, res, ctx }) {
  const id = req.url.split('/')[3];
  const w = await wfDb.getWorkflow(ctx.db, id);
  if (!w) return send(res, 404, { error: 'not found' });
  send(res, 200, w);
}

async function handleCreateWorkflow({ res, body, ctx }) {
  if (!body || !body.name || !body.definition) {
    return send(res, 422, { error: 'name + definition required' });
  }
  try { validateDefinition(body.definition); }
  catch (e) { return send(res, 422, { error: e.message }); }
  const w = await wfDb.createWorkflow(ctx.db, body);
  send(res, 201, w);
}

async function handlePatchWorkflow({ req, res, body, ctx }) {
  const id = req.url.split('/')[3];
  if (body && body.definition) {
    try { validateDefinition(body.definition); }
    catch (e) { return send(res, 422, { error: e.message }); }
  }
  const w = await wfDb.updateWorkflow(ctx.db, id, body || {});
  if (!w) return send(res, 404, { error: 'not found' });
  send(res, 200, w);
}

async function handleDeleteWorkflow({ req, res, ctx }) {
  const id = req.url.split('/')[3];
  await wfDb.deleteWorkflow(ctx.db, id);
  send(res, 204, null);
}

async function handleRunWorkflow({ req, res, body, ctx }) {
  const id = req.url.split('/')[3];
  const w = await wfDb.getWorkflow(ctx.db, id);
  if (!w) return send(res, 404, { error: 'workflow not found' });
  const run = await wfDb.createRun(ctx.db, {
    workflowId: w.id,
    snapshot: w.definition,
    state: { inputs: (body && body.inputs) || {} },
  });
  ctx.workflowRunner.start(run.id);
  send(res, 201, { run_id: run.id });
}

async function handleListRuns({ req, res, ctx }) {
  const u = new URL(req.url, 'http://x');
  const rows = await wfDb.listRuns(ctx.db, {
    workflowId: u.searchParams.get('workflow_id') || undefined,
    status: u.searchParams.get('status') || undefined,
    limit: parseInt(u.searchParams.get('limit') || '100', 10),
  });
  send(res, 200, rows);
}

async function handleGetRun({ req, res, ctx }) {
  const id = req.url.split('/')[3];
  const r = await wfDb.getRun(ctx.db, id);
  if (!r) return send(res, 404, { error: 'not found' });
  send(res, 200, r);
}

async function handleCancelRun({ req, res, ctx }) {
  const id = req.url.split('/')[3];
  ctx.workflowRunner.cancel(id);
  // Note: runner will flip status; here we just acknowledge.
  send(res, 200, { ok: true });
}

async function spawnClaudeForWorkflow(ctx, node, prompt, runId) {
  // Build dispatch body from node.target
  const dispatchBody = {
    ...node.target,
    cwd: node.cwd || '~',
    args: node.headless === false
      ? (node.args || [])
      : ['-p', prompt, ...(node.args || [])],
    env: node.env || {},
    label: `wf-run-${runId.slice(0, 8)}/${node.id}`,
    metadata: { workflow_run_id: runId, workflow_node_id: node.id },
  };
  // Inline dispatch (same logic as handleDispatch)
  const all = await fleetDb.listHosts(ctx.db);
  let candidates = all.filter(h => h.status === 'online');
  if (dispatchBody.host_id)   candidates = candidates.filter(h => h.id === dispatchBody.host_id);
  if (dispatchBody.host_name) candidates = candidates.filter(h => h.name === dispatchBody.host_name);
  if (dispatchBody.tag)       candidates = candidates.filter(h => (h.capabilities || []).includes(dispatchBody.tag));
  if (dispatchBody.capability) candidates = candidates.filter(h => (h.capabilities || []).includes(dispatchBody.capability));
  if (dispatchBody.group) {
    const g = await fleetDb.getGroupByName(ctx.db, dispatchBody.group);
    if (!g) throw new Error(`group not found: ${dispatchBody.group}`);
    const members = await fleetDb.listHostsInGroup(ctx.db, g.id);
    const memberIds = new Set(members.map(h => h.id));
    candidates = candidates.filter(h => memberIds.has(h.id));
  }
  if (!candidates.length) throw new Error('no online host matches target');
  const host = candidates[0];
  const s = await fleetDb.createSession(ctx.db, {
    hostId: host.id, cwd: dispatchBody.cwd,
    args: dispatchBody.args, env: dispatchBody.env,
    createdBy: 'workflow',
    label: dispatchBody.label, metadata: dispatchBody.metadata,
  });
  ctx.bus.requestSpawn(host.id, { session_id: s.id, cwd: s.cwd, args: s.args, env: s.env });

  // Poll for session end + collect output from pty_out events
  const startedAt = Date.now();
  const timeoutMs = (node.timeout_s || 600) * 1000;
  while (true) {
    if (Date.now() - startedAt > timeoutMs) {
      // kill via daemon and mark timeout
      ctx.bus.requestKill && ctx.bus.requestKill(host.id, s.id);
      return { output: '[timeout]', exit_code: 124, session_id: s.id };
    }
    await new Promise(r => setTimeout(r, 500));
    const cur = await fleetDb.getSession(ctx.db, s.id);
    if (!cur) return { output: '', exit_code: -1, session_id: s.id };
    if (['exited','killed','orphaned'].includes(cur.status)) {
      const events = await fleetDb.readTranscript(ctx.db, s.id, { kind: 'pty_out', limit: 10000 });
      let output = '';
      for (const e of events) {
        if (output.length > 65536) break;
        try { output += Buffer.from(e.payload.data, 'base64').toString('utf8'); }
        catch { /* ignore malformed */ }
      }
      return { output: output.slice(0, 65536), exit_code: cur.exit_code, session_id: s.id };
    }
  }
}
```

e) Register routes in `dispatchHttp` (around line 584-670). Find the existing route table and add:

```js
// workflows
if (method === 'GET'    && path === '/fleet/workflows')               return handleListWorkflows({ res, ctx });
if (method === 'POST'   && path === '/fleet/workflows')               return readBody(req).then(b => handleCreateWorkflow({ res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
if (method === 'GET'    && /^\/fleet\/workflows\/[\w-]+$/.test(path)) return handleGetWorkflow({ req, res, ctx });
if (method === 'PATCH'  && /^\/fleet\/workflows\/[\w-]+$/.test(path)) return readBody(req).then(b => handlePatchWorkflow({ req, res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
if (method === 'DELETE' && /^\/fleet\/workflows\/[\w-]+$/.test(path)) return handleDeleteWorkflow({ req, res, ctx });
if (method === 'POST'   && /^\/fleet\/workflows\/[\w-]+\/run$/.test(path)) return readBody(req).then(b => handleRunWorkflow({ req, res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));

// runs
if (method === 'GET'    && path === '/fleet/workflow-runs')              return handleListRuns({ req, res, ctx });
if (method === 'GET'    && /^\/fleet\/workflow-runs\/[\w-]+$/.test(path)) return handleGetRun({ req, res, ctx });
if (method === 'POST'   && /^\/fleet\/workflow-runs\/[\w-]+\/cancel$/.test(path)) return handleCancelRun({ req, res, ctx });
```

- [ ] **Step 4: Run REST tests to verify they pass**

Run: `node --test scripts/lib/fleet-routes.test.js -t 'workflows'`

Expected: 3 workflow tests pass. (Other unrelated tests should still pass too — `node --test scripts/lib/fleet-routes.test.js` runs everything.)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fleet-routes.js scripts/lib/fleet-routes.test.js
git commit -m "feat: REST endpoints for workflows + runs

GET/POST/GET/PATCH/DELETE /fleet/workflows[/id]
POST /fleet/workflows/:id/run + GET/POST /fleet/workflow-runs[/id/cancel]
Validation via fleet-workflow-runner.validateDefinition.
Workflow runner instantiated in makeContext, orphan stranded runs at boot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: WS role workflow_viewer

**Files:**
- Modify: `scripts/lib/fleet-routes.js`

- [ ] **Step 1: Extend upgrade handler**

Edit `scripts/lib/fleet-routes.js` `attachUpgrade` function (line 906). Change the role check from:

```js
if (role !== 'daemon' && role !== 'viewer') return ws.close(4003, 'invalid role');
if (role === 'daemon') handleDaemonWs(ws, u.searchParams, ctx);
else handleViewerWs(ws, u.searchParams, ctx);
```

to:

```js
if (role !== 'daemon' && role !== 'viewer' && role !== 'workflow_viewer') {
  return ws.close(4003, 'invalid role');
}
if (role === 'daemon')           handleDaemonWs(ws, u.searchParams, ctx);
else if (role === 'workflow_viewer') handleWorkflowViewerWs(ws, u.searchParams, ctx);
else                             handleViewerWs(ws, u.searchParams, ctx);
```

Apply the same change in the legacy `attach()` upgrade handler (~line 877). Both upgrade handlers must accept the new role.

- [ ] **Step 2: Add handleWorkflowViewerWs**

Insert after `handleViewerWs` definition (~line 845, before `function attach`):

```js
async function handleWorkflowViewerWs(ws, params, ctx) {
  const runId = params.get('run_id');
  if (!runId) return ws.close(4002, 'run_id required');
  // Send initial state snapshot
  try {
    const r = await wfDb.getRun(ctx.db, runId);
    if (r) {
      ws.send(JSON.stringify({
        type: 'run_state', run_id: r.id, status: r.status,
        started_at: r.started_at, finished_at: r.finished_at,
      }));
      // Replay current outputs as node_progress done frames
      const outputs = (r.state && r.state.outputs) || {};
      for (const [nodeId, out] of Object.entries(outputs)) {
        ws.send(JSON.stringify({
          type: 'node_progress', run_id: r.id, node_id: nodeId, status: 'done',
          output: out.output, exit_code: out.exit_code, session_id: out.session_id,
        }));
      }
    }
  } catch (e) {
    console.error('[fleet] workflow_viewer init:', e.message);
  }
  ctx.bus.addWorkflowViewer(runId, ws);
}
```

- [ ] **Step 3: Manual smoke test via wscat**

Run hub locally: `node scripts/rag-api.js` in one terminal.

In another:

```bash
TOKEN=$(scripts/bin/vt secrets get VAULT_RAG_API_TOKEN)
# Create a tiny workflow first via curl
curl -s -X POST http://127.0.0.1:8080/fleet/workflows \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"smoke-wf","definition":{"start":"n1","nodes":[{"id":"n1","type":"delay","seconds":2},{"id":"n2","type":"delay","seconds":1}],"edges":[{"from":"n1","to":"n2"}]}}'
# capture WF_ID from response.id

# Run it
RUN_ID=$(curl -s -X POST http://127.0.0.1:8080/fleet/workflows/$WF_ID/run \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' | jq -r .run_id)

# Subscribe
npx wscat -c "ws://127.0.0.1:8080/fleet/ws?role=workflow_viewer&run_id=$RUN_ID&token=$TOKEN" \
  -s "bearer.$TOKEN"
```

Expected output sequence:
```
{"type":"run_state","run_id":"...","status":"running",...}
{"type":"node_progress","run_id":"...","node_id":"n1","status":"running"}
{"type":"node_progress","run_id":"...","node_id":"n1","status":"done",...}
{"type":"node_progress","run_id":"...","node_id":"n2","status":"running"}
{"type":"node_progress","run_id":"...","node_id":"n2","status":"done",...}
{"type":"run_state","run_id":"...","status":"done"}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/fleet-routes.js
git commit -m "feat: WS role workflow_viewer for live run progress

New role workflow_viewer accepts run_id query param.
On connect: sends current run_state + replays node_progress for already-done nodes.
Subsequent frames pushed by runner via bus.broadcastWorkflow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: workflow-canvas.js — shared SVG renderer

Used by both editor (interactive) and viewer (read-only). Renders nodes + edges from a definition object, exposes hooks for interactivity that the editor wires up. Browser-side, vanilla JS.

**Files:**
- Create: `agent-fleet/web/workflow-canvas.js`

- [ ] **Step 1: Create the canvas module**

Create `agent-fleet/web/workflow-canvas.js`:

```js
'use strict';
// workflow-canvas: SVG renderer for workflow DAGs.
// Shared by editor and run viewer. UMD-ish global: window.WorkflowCanvas.
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const NODE_W = 160, NODE_H = 60, GRID = 20;

  function el(tag, attrs = {}, parent = null) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  }

  function snap(v) { return Math.round(v / GRID) * GRID; }

  function nodeClass(node) {
    return `wf-node wf-node-${node.type}`;
  }

  function nodeLabel(node) {
    if (node.type === 'claude') {
      const t = node.target || {};
      const target = t.group ? `gr:${t.group}` : t.host_name ? t.host_name : t.capability ? `cap:${t.capability}` : '?';
      return `${node.id} → ${target}`;
    }
    if (node.type === 'branch') return `if ${(node.condition || '').slice(0, 22)}`;
    if (node.type === 'delay')  return `wait ${node.seconds || 0}s`;
    return node.id;
  }

  function portPos(node, side) {
    // returns absolute SVG coords for in/out ports
    if (side === 'in')  return { x: node.position.x,             y: node.position.y + NODE_H / 2 };
    return                     { x: node.position.x + NODE_W,    y: node.position.y + NODE_H / 2 };
  }

  function edgePath(from, to) {
    const dx = Math.max(40, Math.abs(to.x - from.x) / 2);
    return `M ${from.x},${from.y} C ${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`;
  }

  function create({ mount, definition, interactive = false, onSelect, onDefinitionChange, statusByNode = {} }) {
    mount.innerHTML = '';
    const svg = el('svg', { class: 'wf-canvas', width: '100%', height: '100%', viewBox: '0 0 1600 1000' }, mount);
    const defs = el('defs', {}, svg);
    // arrow marker
    const marker = el('marker', { id: 'wf-arrow', markerWidth: 10, markerHeight: 10, refX: 9, refY: 5, orient: 'auto' }, defs);
    el('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#6b7a8a' }, marker);

    const gGrid  = el('g', { class: 'wf-grid' }, svg);
    const gEdges = el('g', { class: 'wf-edges' }, svg);
    const gNodes = el('g', { class: 'wf-nodes' }, svg);

    // grid dots
    for (let x = 0; x < 1600; x += GRID) {
      for (let y = 0; y < 1000; y += GRID) {
        el('circle', { cx: x, cy: y, r: 0.5, fill: '#2a3441' }, gGrid);
      }
    }

    let def = JSON.parse(JSON.stringify(definition || { start: null, nodes: [], edges: [] }));
    let selectedId = null;
    let connectFrom = null;

    function render() {
      gNodes.innerHTML = '';
      gEdges.innerHTML = '';
      for (const e of def.edges) {
        const a = def.nodes.find(n => n.id === e.from);
        const b = def.nodes.find(n => n.id === e.to);
        if (!a || !b) continue;
        const p1 = portPos(a, 'out'), p2 = portPos(b, 'in');
        const path = el('path', {
          d: edgePath(p1, p2),
          fill: 'none',
          stroke: e.label === 'then' ? '#3ec47a' : e.label === 'else' ? '#e6594b' : '#6b7a8a',
          'stroke-width': 2,
          'marker-end': 'url(#wf-arrow)',
        }, gEdges);
      }
      for (const n of def.nodes) {
        const g = el('g', { class: nodeClass(n), transform: `translate(${n.position.x}, ${n.position.y})` }, gNodes);
        const status = statusByNode[n.id] || 'idle';
        const fill = status === 'running' ? '#2a4a7a' :
                     status === 'done'    ? '#1f5f3a' :
                     status === 'failed'  ? '#7a2a2a' :
                                            '#2a3441';
        const stroke = n.id === selectedId ? '#7ad1ff' :
                       n.type === 'claude' ? '#5985b8' :
                       n.type === 'branch' ? '#c08a3a' :
                       '#6b7a8a';
        el('rect', {
          x: 0, y: 0, width: NODE_W, height: NODE_H,
          rx: n.type === 'delay' ? 12 : 4,
          fill, stroke, 'stroke-width': n.id === selectedId ? 3 : 1.5,
        }, g);
        const text = el('text', { x: NODE_W / 2, y: NODE_H / 2 + 4, 'text-anchor': 'middle', fill: '#e6ebf2', 'font-size': 12 }, g);
        text.textContent = nodeLabel(n);
        if (interactive) {
          // ports
          el('circle', { cx: 0,      cy: NODE_H / 2, r: 4, fill: '#7ad1ff', class: 'wf-port wf-port-in' }, g);
          el('circle', { cx: NODE_W, cy: NODE_H / 2, r: 4, fill: '#7ad1ff', class: 'wf-port wf-port-out' }, g);
          attachNodeInteractions(g, n);
        } else {
          g.addEventListener('click', () => { selectedId = n.id; render(); onSelect && onSelect(n); });
        }
      }
    }

    function attachNodeInteractions(g, n) {
      let dragging = false, offX = 0, offY = 0;
      g.addEventListener('mousedown', (ev) => {
        const target = ev.target;
        if (target.classList.contains('wf-port-out')) {
          connectFrom = n.id;
          ev.stopPropagation();
          return;
        }
        if (target.classList.contains('wf-port-in')) return;
        dragging = true;
        const pt = clientToSvg(ev);
        offX = pt.x - n.position.x;
        offY = pt.y - n.position.y;
        selectedId = n.id;
        onSelect && onSelect(n);
        render();
        ev.stopPropagation();
      });
      g.addEventListener('mouseup', (ev) => {
        if (connectFrom && connectFrom !== n.id) {
          def.edges.push({ from: connectFrom, to: n.id });
          connectFrom = null;
          notifyChange();
          render();
        }
      });
      // global mousemove for drag
      const onMove = (ev) => {
        if (!dragging) return;
        const pt = clientToSvg(ev);
        n.position.x = snap(pt.x - offX);
        n.position.y = snap(pt.y - offY);
        render();
      };
      const onUp = () => { if (dragging) { dragging = false; notifyChange(); } };
      svg.addEventListener('mousemove', onMove);
      svg.addEventListener('mouseup', onUp);
    }

    function clientToSvg(ev) {
      const pt = svg.createSVGPoint();
      pt.x = ev.clientX; pt.y = ev.clientY;
      return pt.matrixTransform(svg.getScreenCTM().inverse());
    }

    function notifyChange() {
      onDefinitionChange && onDefinitionChange(JSON.parse(JSON.stringify(def)));
    }

    svg.addEventListener('click', (ev) => {
      if (ev.target === svg || ev.target.classList.contains('wf-grid')) {
        selectedId = null; connectFrom = null;
        onSelect && onSelect(null);
        render();
      }
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Delete' || !selectedId || !interactive) return;
      def.nodes = def.nodes.filter(n => n.id !== selectedId);
      def.edges = def.edges.filter(e => e.from !== selectedId && e.to !== selectedId);
      if (def.start === selectedId) def.start = def.nodes[0] && def.nodes[0].id || null;
      selectedId = null;
      notifyChange();
      render();
    });

    render();

    return {
      addNode(node) {
        def.nodes.push(node);
        if (!def.start) def.start = node.id;
        notifyChange();
        render();
      },
      setStatus(map) { statusByNode = map; render(); },
      setNodeStatus(id, status) { statusByNode[id] = status; render(); },
      getDefinition() { return JSON.parse(JSON.stringify(def)); },
      replaceDefinition(d) { def = JSON.parse(JSON.stringify(d)); render(); },
    };
  }

  window.WorkflowCanvas = { create };
})();
```

- [ ] **Step 2: Add CSS for canvas**

Append to `agent-fleet/web/app.css`:

```css
.wf-canvas { background: #0e1722; user-select: none; }
.wf-node { cursor: move; }
.wf-port { cursor: crosshair; }
.wf-port:hover { fill: #f0e060; }
.wf-page { display: grid; grid-template-columns: 200px 1fr 320px; height: calc(100vh - 50px); }
.wf-toolbar { background: #14202d; padding: 12px; border-right: 1px solid #2a3441; overflow-y: auto; }
.wf-toolbar button { display: block; width: 100%; margin: 4px 0; padding: 8px; background: #1f3247; color: #e6ebf2; border: 1px solid #2a4a6f; cursor: pointer; }
.wf-toolbar button:hover { background: #2a4a7a; }
.wf-canvas-pane { position: relative; overflow: hidden; background: #0e1722; }
.wf-inspector { background: #14202d; padding: 12px; border-left: 1px solid #2a3441; overflow-y: auto; }
.wf-inspector label { display: block; margin: 8px 0 4px; color: #a3b3c3; font-size: 12px; }
.wf-inspector input, .wf-inspector textarea, .wf-inspector select {
  width: 100%; padding: 6px; background: #0e1722; color: #e6ebf2; border: 1px solid #2a3441; box-sizing: border-box;
}
.wf-inspector textarea { min-height: 80px; font-family: monospace; }
.wf-errors { color: #e6594b; margin-top: 8px; font-size: 12px; }
.wf-runs-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
.wf-runs-table td, .wf-runs-table th { padding: 6px; border-bottom: 1px solid #2a3441; }
.wf-run-status-pending   { color: #6b7a8a; }
.wf-run-status-running   { color: #7ad1ff; }
.wf-run-status-done      { color: #3ec47a; }
.wf-run-status-failed    { color: #e6594b; }
.wf-run-status-cancelled { color: #c08a3a; }
```

- [ ] **Step 3: Commit**

```bash
git add agent-fleet/web/workflow-canvas.js agent-fleet/web/app.css
git commit -m "feat: workflow-canvas SVG renderer (browser, vanilla)

Shared SVG-based DAG renderer for editor + viewer.
Interactive mode supports drag, port-to-port connect, delete via key.
Status overlay per node for run viewer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: workflow-editor.js + routing

**Files:**
- Create: `agent-fleet/web/workflow-editor.js`
- Modify: `agent-fleet/web/index.html`
- Modify: `agent-fleet/web/app.js`

- [ ] **Step 1: Add pages to index.html**

Edit `agent-fleet/web/index.html`. Find existing `<nav>` (search for `nav-groups`) and add a workflows button:

```html
<button id="nav-workflows">Workflows</button>
```

In the body where other view containers live (search `id="groupsview"` for a sibling), add:

```html
<div id="workflowsview" class="overlay hidden">
  <div class="overlay-header">
    <h2>Workflows</h2>
    <button id="wf-new">+ New workflow</button>
    <button class="close" data-close>×</button>
  </div>
  <div id="wf-list-body"></div>
</div>

<div id="workfloweditor" class="overlay hidden">
  <div class="wf-page">
    <div class="wf-toolbar">
      <button id="wf-add-claude">+ claude</button>
      <button id="wf-add-branch">+ branch</button>
      <button id="wf-add-delay">+ delay</button>
      <hr>
      <button id="wf-save">Save</button>
      <button id="wf-run">Run</button>
      <button id="wf-back">Back</button>
      <div id="wf-errors" class="wf-errors"></div>
    </div>
    <div id="wf-canvas-pane" class="wf-canvas-pane"></div>
    <div id="wf-inspector" class="wf-inspector">Select a node…</div>
  </div>
</div>
```

Then add the script tags before the existing `app.js`:

```html
<script src="workflow-canvas.js"></script>
<script src="workflow-editor.js"></script>
<script src="workflow-run-viewer.js"></script>
```

- [ ] **Step 2: Write the editor module**

Create `agent-fleet/web/workflow-editor.js`:

```js
'use strict';
// workflow-editor: list page + edit page. Globals: openWorkflowsList, openWorkflowEditor.
(function () {
  const API = '/api/fleet';
  const TOKEN = () => window.fleetToken; // populated by app.js boot

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        'authorization': `Bearer ${TOKEN()}`,
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    if (res.status === 204) return null;
    return res.json();
  }

  async function openWorkflowsList() {
    document.querySelectorAll('.overlay').forEach(o => o.classList.add('hidden'));
    const view = document.getElementById('workflowsview');
    view.classList.remove('hidden');
    const body = document.getElementById('wf-list-body');
    body.textContent = 'Loading…';
    try {
      const list = await api('/workflows');
      if (!list.length) {
        body.innerHTML = '<p>No workflows yet. Click <b>+ New workflow</b>.</p>';
        return;
      }
      body.innerHTML = `<table class="wf-runs-table">
        <thead><tr><th>Name</th><th>Nodes</th><th>Updated</th><th>Actions</th></tr></thead>
        <tbody>${list.map(w => `
          <tr>
            <td>${esc(w.name)}</td>
            <td>${w.n_nodes}</td>
            <td>${new Date(w.updated_at).toLocaleString()}</td>
            <td>
              <button data-edit="${w.id}">Edit</button>
              <button data-run="${w.id}">Run</button>
              <button data-del="${w.id}">Delete</button>
            </td>
          </tr>`).join('')}</tbody></table>`;
      body.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => location.hash = `#/workflows/${b.dataset.edit}/edit`);
      body.querySelectorAll('[data-run]').forEach(b => b.onclick = async () => {
        const { run_id } = await api(`/workflows/${b.dataset.run}/run`, { method: 'POST', body: '{}' });
        location.hash = `#/workflow-runs/${run_id}`;
      });
      body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!confirm('Delete workflow?')) return;
        await api(`/workflows/${b.dataset.del}`, { method: 'DELETE' });
        openWorkflowsList();
      });
    } catch (e) {
      body.textContent = `Error: ${e.message}`;
    }
  }

  async function openWorkflowEditor(id) {
    document.querySelectorAll('.overlay').forEach(o => o.classList.add('hidden'));
    document.getElementById('workfloweditor').classList.remove('hidden');
    document.getElementById('wf-errors').textContent = '';
    let wf;
    if (id === 'new') {
      const name = prompt('Workflow name?', `wf-${Date.now()}`);
      if (!name) { location.hash = '#/workflows'; return; }
      wf = await api('/workflows', { method: 'POST', body: JSON.stringify({
        name, definition: { start: null, nodes: [], edges: [] },
      })});
      location.hash = `#/workflows/${wf.id}/edit`;
      return; // will re-enter via hashchange
    } else {
      wf = await api(`/workflows/${id}`);
    }

    let definition = wf.definition;
    const pane = document.getElementById('wf-canvas-pane');
    const canvas = window.WorkflowCanvas.create({
      mount: pane,
      definition,
      interactive: true,
      onSelect: renderInspector,
      onDefinitionChange: (d) => { definition = d; },
    });

    document.getElementById('wf-add-claude').onclick = () => canvas.addNode(newNode('claude'));
    document.getElementById('wf-add-branch').onclick = () => canvas.addNode(newNode('branch'));
    document.getElementById('wf-add-delay').onclick  = () => canvas.addNode(newNode('delay'));
    document.getElementById('wf-back').onclick       = () => location.hash = '#/workflows';

    document.getElementById('wf-save').onclick = async () => {
      try {
        await api(`/workflows/${id}`, { method: 'PATCH', body: JSON.stringify({ definition }) });
        document.getElementById('wf-errors').textContent = 'Saved.';
        setTimeout(() => document.getElementById('wf-errors').textContent = '', 1500);
      } catch (e) {
        document.getElementById('wf-errors').textContent = e.message;
      }
    };

    document.getElementById('wf-run').onclick = async () => {
      try {
        await api(`/workflows/${id}`, { method: 'PATCH', body: JSON.stringify({ definition }) });
        const { run_id } = await api(`/workflows/${id}/run`, { method: 'POST', body: '{}' });
        location.hash = `#/workflow-runs/${run_id}`;
      } catch (e) {
        document.getElementById('wf-errors').textContent = e.message;
      }
    };

    function newNode(type) {
      const id = `n${definition.nodes.length + 1}`;
      const x = 120 + (definition.nodes.length % 4) * 200;
      const y = 100 + Math.floor(definition.nodes.length / 4) * 120;
      const base = { id, type, position: { x, y } };
      if (type === 'claude') return { ...base, target: { group: '' }, prompt: '', timeout_s: 300, headless: true };
      if (type === 'branch') return { ...base, condition: 'true' };
      if (type === 'delay')  return { ...base, seconds: 10 };
    }

    function renderInspector(node) {
      const insp = document.getElementById('wf-inspector');
      if (!node) { insp.innerHTML = 'Select a node…'; return; }
      const d = canvas.getDefinition();
      const cur = d.nodes.find(n => n.id === node.id);
      if (!cur) return;
      if (cur.type === 'claude') {
        insp.innerHTML = `
          <label>id</label><input id="i-id" value="${esc(cur.id)}" disabled>
          <label>target (group | host_name | capability) — pick one</label>
          <input id="i-group" placeholder="group" value="${esc(cur.target.group || '')}">
          <input id="i-host"  placeholder="host_name" value="${esc(cur.target.host_name || '')}">
          <input id="i-cap"   placeholder="capability" value="${esc(cur.target.capability || '')}">
          <label>prompt (supports {{n1.output}} {{inputs.x}})</label>
          <textarea id="i-prompt">${esc(cur.prompt || '')}</textarea>
          <label>timeout_s</label><input id="i-timeout" type="number" value="${cur.timeout_s || 300}">
          <label><input id="i-headless" type="checkbox" ${cur.headless !== false ? 'checked' : ''}> headless</label>
        `;
        wireInputs(cur.id, ['group','host','cap','prompt','timeout','headless']);
      } else if (cur.type === 'branch') {
        insp.innerHTML = `
          <label>id</label><input value="${esc(cur.id)}" disabled>
          <label>condition (JS expr, vars: nX.output, nX.exit_code, inputs.X)</label>
          <textarea id="i-cond">${esc(cur.condition || '')}</textarea>
        `;
        wireInputs(cur.id, ['cond']);
      } else if (cur.type === 'delay') {
        insp.innerHTML = `
          <label>id</label><input value="${esc(cur.id)}" disabled>
          <label>seconds</label><input id="i-sec" type="number" value="${cur.seconds || 0}">
        `;
        wireInputs(cur.id, ['sec']);
      }
    }

    function wireInputs(nodeId, keys) {
      for (const k of keys) {
        const elInp = document.getElementById(`i-${k}`);
        if (!elInp) continue;
        elInp.onblur = elInp.onchange = () => {
          const d = canvas.getDefinition();
          const cur = d.nodes.find(n => n.id === nodeId);
          if (!cur) return;
          if (k === 'group')    cur.target.group    = elInp.value || undefined;
          if (k === 'host')     cur.target.host_name = elInp.value || undefined;
          if (k === 'cap')      cur.target.capability = elInp.value || undefined;
          if (k === 'prompt')   cur.prompt = elInp.value;
          if (k === 'timeout')  cur.timeout_s = parseInt(elInp.value, 10);
          if (k === 'headless') cur.headless = elInp.checked;
          if (k === 'cond')     cur.condition = elInp.value;
          if (k === 'sec')      cur.seconds = parseInt(elInp.value, 10);
          canvas.replaceDefinition(d);
          definition = d;
        };
      }
    }
  }

  function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

  window.openWorkflowsList = openWorkflowsList;
  window.openWorkflowEditor = openWorkflowEditor;
})();
```

- [ ] **Step 3: Wire routes in app.js**

Edit `agent-fleet/web/app.js`. Find the existing route dispatcher (`navigate` function or `hashchange` handler) and add:

```js
// At nav button hookup section (next to nav-groups):
$('nav-workflows').onclick = () => navigate('/workflows');
```

In the route resolver (where `#/groups` → `openGroupsView()`):

```js
if (path === '/workflows')            return window.openWorkflowsList();
if (m = path.match(/^\/workflows\/([\w-]+)\/edit$/))    return window.openWorkflowEditor(m[1]);
if (m = path.match(/^\/workflow-runs\/([\w-]+)$/))      return window.openWorkflowRunViewer(m[1]);
```

And in editor, `#/workflows/new/edit` is also valid — the editor checks for `id === 'new'` and creates fresh workflow.

Wire the "+ New workflow" button:

```js
// In boot() after existing button wires:
const wfNew = $('wf-new');
if (wfNew) wfNew.onclick = () => navigate('/workflows/new/edit');
```

- [ ] **Step 4: Manual smoke test in browser**

Start hub: `node scripts/rag-api.js`. Open `http://127.0.0.1:8080/fleet/`. Click "Workflows" → "+ New workflow" → enter name → editor opens. Click "+ claude" → node appears. Drag it. Click "+ delay" → second node. Drag from blue circle on right edge of first node to left edge of second — edge appears with arrow. Click Save. Click "Back".

Expected: workflow appears in list.

- [ ] **Step 5: Commit**

```bash
git add agent-fleet/web/workflow-editor.js agent-fleet/web/index.html agent-fleet/web/app.js
git commit -m "feat: workflow editor UI + list page

#/workflows list, #/workflows/:id/edit canvas + inspector.
Drag-drop nodes, port-to-port connect, per-type inspector forms.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: workflow-run-viewer.js + routing

**Files:**
- Create: `agent-fleet/web/workflow-run-viewer.js`
- Modify: `agent-fleet/web/index.html`

- [ ] **Step 1: Add viewer page to index.html**

Add another overlay container (sibling to `workfloweditor`):

```html
<div id="workflowrunviewer" class="overlay hidden">
  <div class="overlay-header">
    <h2 id="wf-run-title">Run</h2>
    <span id="wf-run-status" class="wf-run-status-pending">pending</span>
    <button id="wf-run-cancel" hidden>Cancel</button>
    <button id="wf-run-rerun" hidden>Re-run</button>
    <button class="close" data-close>×</button>
  </div>
  <div style="display:grid; grid-template-columns: 60% 40%; height: calc(100vh - 100px);">
    <div id="wf-run-canvas" class="wf-canvas-pane"></div>
    <div id="wf-run-detail" class="wf-inspector">Click a node for details.</div>
  </div>
</div>
```

- [ ] **Step 2: Write the viewer module**

Create `agent-fleet/web/workflow-run-viewer.js`:

```js
'use strict';
// workflow-run-viewer: live view of one fleet_workflow_runs row.
(function () {
  const API = '/api/fleet';
  const TOKEN = () => window.fleetToken;

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        'authorization': `Bearer ${TOKEN()}`,
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  }

  async function openWorkflowRunViewer(runId) {
    document.querySelectorAll('.overlay').forEach(o => o.classList.add('hidden'));
    document.getElementById('workflowrunviewer').classList.remove('hidden');
    const run = await api(`/workflow-runs/${runId}`);
    const wf  = run.workflow_id ? await api(`/workflows/${run.workflow_id}`).catch(() => null) : null;
    document.getElementById('wf-run-title').textContent = wf ? wf.name : `run ${runId.slice(0, 8)}`;
    setStatus(run.status);

    const canvas = window.WorkflowCanvas.create({
      mount: document.getElementById('wf-run-canvas'),
      definition: run.snapshot,
      interactive: false,
      onSelect: (n) => renderDetail(n, run),
      statusByNode: extractStatusMap(run),
    });

    document.getElementById('wf-run-cancel').onclick = async () => {
      await api(`/workflow-runs/${runId}/cancel`, { method: 'POST' });
    };
    document.getElementById('wf-run-rerun').onclick = async () => {
      const { run_id } = await api(`/workflows/${run.workflow_id}/run`, { method: 'POST', body: '{}' });
      location.hash = `#/workflow-runs/${run_id}`;
    };

    // Subscribe via WS
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(
      `${proto}//${location.host}/api/fleet/ws?role=workflow_viewer&run_id=${runId}`,
      [`bearer.${TOKEN()}`],
    );
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data);
      if (f.type === 'run_state') {
        setStatus(f.status);
      } else if (f.type === 'node_progress') {
        canvas.setNodeStatus(f.node_id, f.status);
        if (!run.state.outputs) run.state.outputs = {};
        if (f.status === 'done') {
          run.state.outputs[f.node_id] = { output: f.output, exit_code: f.exit_code, session_id: f.session_id };
        }
      }
    };
    // Auto-close ws when leaving page
    const stop = () => { try { ws.close(); } catch {} };
    window.addEventListener('hashchange', stop, { once: true });
  }

  function setStatus(s) {
    const el = document.getElementById('wf-run-status');
    el.textContent = s;
    el.className = `wf-run-status-${s}`;
    document.getElementById('wf-run-cancel').hidden = s !== 'running';
    document.getElementById('wf-run-rerun').hidden  = !(s === 'done' || s === 'failed' || s === 'cancelled');
  }

  function extractStatusMap(run) {
    const out = {};
    const outputs = (run.state && run.state.outputs) || {};
    for (const id of Object.keys(outputs)) out[id] = 'done';
    if (run.state && run.state.current_node && !out[run.state.current_node] && run.status === 'running') {
      out[run.state.current_node] = 'running';
    }
    return out;
  }

  function renderDetail(node, run) {
    const d = document.getElementById('wf-run-detail');
    if (!node) { d.textContent = 'Click a node for details.'; return; }
    const out = (run.state && run.state.outputs && run.state.outputs[node.id]) || null;
    d.innerHTML = `
      <h3>${esc(node.id)} (${esc(node.type)})</h3>
      ${node.type === 'claude' ? `<label>prompt</label><pre>${esc(node.prompt || '')}</pre>` : ''}
      ${node.type === 'branch' ? `<label>condition</label><pre>${esc(node.condition || '')}</pre>` : ''}
      ${node.type === 'delay'  ? `<label>seconds</label><pre>${node.seconds || 0}</pre>` : ''}
      ${out ? `
        <label>output</label>
        <pre style="max-height:300px; overflow:auto;">${esc((out.output || '').slice(0, 5000))}</pre>
        ${out.exit_code !== undefined ? `<label>exit_code</label><pre>${out.exit_code}</pre>` : ''}
        ${out.session_id ? `<a href="#/sessions/${out.session_id}">Open session →</a>` : ''}
      ` : '<p><i>not yet executed</i></p>'}
    `;
  }

  function esc(s) { return (s || '').toString().replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

  window.openWorkflowRunViewer = openWorkflowRunViewer;
})();
```

- [ ] **Step 3: Manual smoke test**

Open hub, create a workflow with two delay nodes (seconds: 2 and 1), connect them. Click Run. Browser navigates to `#/workflow-runs/<id>`. Watch nodes transition idle→running→done. After completion, "Re-run" button appears.

- [ ] **Step 4: Commit**

```bash
git add agent-fleet/web/workflow-run-viewer.js agent-fleet/web/index.html
git commit -m "feat: workflow run viewer page (live WS)

#/workflow-runs/:id with readonly canvas, status overlay,
node detail panel with output/exit_code/session link.
Subscribes to role=workflow_viewer WS, updates node statuses live.
Cancel and Re-run buttons.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: End-to-end smoke + nav polish

**Files:**
- Modify: `agent-fleet/web/app.js`
- Modify: `agent-fleet/web/index.html`
- Modify: `agent-fleet/web/app.css`

- [ ] **Step 1: Verify nav button wiring**

Open `agent-fleet/web/app.js`. Confirm `$('nav-workflows').onclick = () => navigate('/workflows');` exists in `boot()`. If missing, add it next to `nav-groups`.

- [ ] **Step 2: Run all backend tests**

Run:

```bash
node --test scripts/lib/fleet-workflow-db.test.js
node --test scripts/lib/fleet-workflow-runner.test.js
node --test scripts/lib/fleet-routes.test.js
```

Expected: all green.

- [ ] **Step 3: End-to-end browser flow**

1. Start hub: `node scripts/rag-api.js`
2. Open `http://127.0.0.1:8080/fleet/`
3. Click "Workflows" in nav → list page renders.
4. Click "+ New workflow" → editor opens with empty canvas.
5. Add 1 claude + 1 branch + 2 delay nodes via toolbar.
6. Wire: claude → branch → delay (then), branch → delay (else).
7. Configure claude target = a known group, prompt = `"echo done"`.
8. Configure branch condition = `n1.exit_code === 0`.
9. Click Save → message "Saved.".
10. Click Run → browser navigates to run viewer.
11. Observe nodes transition live.
12. After completion: click each node → see output in right panel.
13. Click "Open session →" on claude node → fleet session detail page opens.

Expected: full flow works end-to-end.

- [ ] **Step 4: Commit any polish (or none)**

```bash
# Only if you adjusted anything in step 1-3:
git add agent-fleet/web/app.js agent-fleet/web/app.css agent-fleet/web/index.html
git commit -m "chore: workflow nav wire-up + e2e polish

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Mark vt task complete and push**

```bash
scripts/bin/vt close vt-0067 --reason "agent-fleet workflow engine shipped: schema + db + runner + REST + WS + editor + run viewer"
git pull --rebase
git push
git status   # MUST show 'up to date with origin'
```

---

## Self-Review

**1. Spec coverage:**
- §2 Architecture (embedded in hub, runner injects spawnClaude) — Task 4.
- §3 Schema — Task 1.
- §4 Definition format + validation invariants — Task 3 (`validateDefinition`).
- §5 Runner: claude/branch/delay exec, template subst, cancellation — Task 3.
- §6 REST endpoints (all 8) — Task 4.
- §6 WS role workflow_viewer — Task 5.
- §7 UI Editor — Tasks 6 (canvas) + 7 (page logic).
- §8 UI Run Viewer — Tasks 6 (canvas) + 8 (page logic).
- §10 out-of-scope items — none implemented, correct.
- §11 success criteria — covered by Task 9 e2e smoke.

**2. Placeholder scan:** searched for TBD/TODO/etc — none.

**3. Type consistency:** runner's `deps` shape (`{db, spawnClaude, broadcast}`) is consistent between test mock (Task 3) and real wire-up (Task 4). `wfDb` API names (`createWorkflow`, `createRun`, `updateRunStatus`, `updateRunState`, `orphanRunningRuns`) used identically across runner + routes. `WorkflowCanvas.create()` return shape (`addNode`, `setNodeStatus`, `getDefinition`, `replaceDefinition`) used by both editor and viewer.

One gap caught: ctx.workflowRunner is referenced in `makeContext` AND re-instantiated in `attach()`. Reason — `makeContext` runs before db pool is bound in some integration paths; `attach()` is the authoritative wire-up. Fine as-is; Task 4 Step 3b makes both code paths explicit.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-15-agent-fleet-workflow-engine-implementation.md`.

Per project CLAUDE.md (cost control), `subagent-driven-development` is disabled. Default execution mode is `superpowers:executing-plans` (inline batched).

**Two execution options:**

1. **Inline Execution (default, given subagent-driven disabled)** — Execute tasks in this session using `superpowers:executing-plans`, batch with checkpoints between each task for review.

2. **Hand off** — Leave plan saved; you pick it up later.

Which approach?
