# vt as REST + MCP first-class surface - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Note: subagent-driven-development is disabled per project CLAUDE.md - use inline execution only.

**Goal:** Ship vt task tracker as part of vault-rag: 9 REST endpoints (`/api/task/*`) + 9 MCP tools (`task_*`) + thin REST CLI client. Tasks remain markdown in `/vault/06-tasks/`.

**Architecture:** Reuse existing pure modules `lib/vt-fs.js` + `lib/vt-graph.js` server-side inside `rag-api.js`. New `lib/vt-routes.js` adapts those to HTTP handlers. `mcp-shim.js` gets 9 task_* tool stubs that proxy via existing `ragCall()`. `vt.js` becomes ~150 LOC fetch client. Migration is one-shot via gated `/api/task/import` endpoint.

**Tech Stack:** Node 22, raw `http.createServer`, `js-yaml`, `node --test`, bats. No new deps.

**Spec:** `docs/superpowers/specs/2026-05-09-vt-rest-mcp-design.md` (commit `6bdea5a`).

**Epic:** `vt-0003`.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/lib/vt-fs.js` | unchanged | Pure FS ops on tasks (already reusable) |
| `scripts/lib/vt-graph.js` | unchanged | Pure ready/blocking logic (already reusable) |
| `scripts/lib/vt-routes.js` | NEW | HTTP handlers for `/task/*`. Pure request->response, no IO outside delegating to vt-fs |
| `scripts/rag-api.js` | MODIFY | Mount task routes; extend WRITABLE_PREFIXES for `vt remember` |
| `scripts/mcp-shim.js` | MODIFY | Register 9 `task_*` tools |
| `scripts/vt.js` | REWRITE | Thin REST client |
| `scripts/vt-migrate.js` | NEW | One-shot migrator local->prod via `/api/task/import` |
| `scripts/bin/vt` | unchanged | Launcher |
| `scripts/lib/vt-config.js` | DELETE later | Unused after CLI rewrite |
| `tests/test-vt-routes.js` | NEW | `node --test` for handlers (in-process http) |
| `tests/test-vt-graph.js` | NEW | `node --test` for ready/dep filters |
| `tests/test-vt.bats` | REWRITE | bats against in-process rag-api fixture |
| `tests/fixtures/start-test-rag-api.sh` | NEW | Spin temp rag-api on free port for bats |
| `docs/api.md` | MODIFY | Add `/api/task/*` section |
| `docs/tasks.md` | NEW | Full vt CLI + agent workflow ref |
| `README.md` + `.ru.md` + `.es.md` | MODIFY | "Task Tracking" section |

---

## Phase 1: Server-side handlers

### Task 1: Skeleton `lib/vt-routes.js` + first handler `task_create`

**Files:**
- Create: `scripts/lib/vt-routes.js`
- Create: `tests/test-vt-routes.js`

- [ ] **Step 1: Failing test for create**

```js
// tests/test-vt-routes.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { handlers } = require('../scripts/lib/vt-routes');

function tmpVault() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-routes-'));
  fs.mkdirSync(path.join(d, '06-tasks'), { recursive: true });
  fs.mkdirSync(path.join(d, '.vt'), { recursive: true });
  return d;
}

test('task_create writes file and returns id', async () => {
  const vault = tmpVault();
  const res = await handlers.create({ vault, body: { title: 'First epic', type: 'epic', priority: 1, by: 'tester' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.id, 'vt-0001');
  assert.match(res.body.path, /06-tasks\/vt-0001-first-epic\.md$/);
  const fp = path.join(vault, res.body.path);
  assert.ok(fs.existsSync(fp));
  const md = fs.readFileSync(fp, 'utf8');
  assert.match(md, /^id: vt-0001/m);
  assert.match(md, /^type: epic/m);
  assert.match(md, /^priority: 1/m);
});

test('task_create rejects missing title', async () => {
  const vault = tmpVault();
  const res = await handlers.create({ vault, body: {} });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /title/);
});
```

- [ ] **Step 2: Run test - expect failure**

Run: `cd /root/work/vault-rag-oss && node --test tests/test-vt-routes.js`
Expected: `Cannot find module '../scripts/lib/vt-routes'`

- [ ] **Step 3: Implement skeleton + create handler**

```js
// scripts/lib/vt-routes.js
const path = require('node:path');
const vtfs = require('./vt-fs');

const STATUSES = new Set(['open', 'in_progress', 'blocked', 'closed']);
const TYPES = new Set(['task', 'epic', 'bug', 'chore']);

function cfgFor(vault) {
  return { tasksDir: path.join(vault, '06-tasks'), seqFile: path.join(vault, '.vt', 'seq') };
}

async function create({ vault, body }) {
  const { title, type = 'task', priority = 2, epic, blocked_by, by = 'agent' } = body || {};
  if (!title || typeof title !== 'string') return { status: 400, body: { error: 'title required' } };
  if (!TYPES.has(type)) return { status: 400, body: { error: `invalid type: ${type}` } };
  if (typeof priority !== 'number' || priority < 0 || priority > 3) return { status: 400, body: { error: 'priority must be 0..3' } };
  const cfg = cfgFor(vault);
  const { id, file } = vtfs.createTask(cfg, { title, type, priority, epic, blocked_by, agent: by });
  return { status: 200, body: { id, path: path.relative(vault, file) } };
}

const handlers = { create };

module.exports = { handlers };
```

- [ ] **Step 4: Run test - expect pass**

Run: `cd /root/work/vault-rag-oss && node --test tests/test-vt-routes.js`
Expected: `pass 2`

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/vt-routes.js tests/test-vt-routes.js
git commit -m "feat(vt): add task_create handler in vt-routes"
```

---

### Task 2: `task_list` handler + filtering

**Files:**
- Modify: `scripts/lib/vt-routes.js`
- Modify: `tests/test-vt-routes.js`

- [ ] **Step 1: Failing tests**

Append to `tests/test-vt-routes.js`:
```js
test('task_list returns open tasks by default', async () => {
  const vault = tmpVault();
  await handlers.create({ vault, body: { title: 'a' } });
  await handlers.create({ vault, body: { title: 'b' } });
  await handlers.close({ vault, body: { id: 'vt-0002', reason: 'done' } });
  const res = await handlers.list({ vault, body: {} });
  assert.strictEqual(res.status, 200);
  const ids = res.body.map(t => t.id);
  assert.deepStrictEqual(ids, ['vt-0001']);
});

test('task_list all=true returns closed too', async () => {
  const vault = tmpVault();
  await handlers.create({ vault, body: { title: 'a' } });
  await handlers.close({ vault, body: { id: 'vt-0001', reason: 'x' } });
  const res = await handlers.list({ vault, body: { all: true } });
  assert.strictEqual(res.body.length, 1);
});

test('task_list filters by status and type', async () => {
  const vault = tmpVault();
  await handlers.create({ vault, body: { title: 'a', type: 'epic' } });
  await handlers.create({ vault, body: { title: 'b', type: 'task' } });
  const res = await handlers.list({ vault, body: { type: 'epic' } });
  assert.strictEqual(res.body.length, 1);
  assert.strictEqual(res.body[0].type, 'epic');
});
```

- [ ] **Step 2: Run - tests for list/close fail**

Run: `node --test tests/test-vt-routes.js`
Expected: failures referencing `handlers.list`, `handlers.close`.

- [ ] **Step 3: Add list + close handlers**

Append to `scripts/lib/vt-routes.js` before `module.exports`:
```js
async function list({ vault, body }) {
  const cfg = cfgFor(vault);
  const { all, status, type } = body || {};
  let tasks = vtfs.listTasks(cfg);
  if (!all && !status) tasks = tasks.filter(t => t.status !== 'closed');
  if (status) tasks = tasks.filter(t => t.status === status);
  if (type) tasks = tasks.filter(t => t.type === type);
  const slim = tasks.map(t => ({
    id: t.id, title: t.title, type: t.type, status: t.status, priority: t.priority,
    claimed_by: t.claimed_by || null, blocked_by: t.blocked_by || [],
    epic: t.epic || null, created: t.created
  }));
  return { status: 200, body: slim };
}

async function close({ vault, body }) {
  const { id, reason } = body || {};
  if (!id) return { status: 400, body: { error: 'id required' } };
  if (!reason) return { status: 400, body: { error: 'reason required' } };
  const cfg = cfgFor(vault);
  const file = vtfs.findTaskFile(cfg, id);
  if (!file) return { status: 404, body: { error: `task not found: ${id}` } };
  const t = vtfs.readTask(file);
  t.status = 'closed';
  t.closed_reason = reason;
  t.closed = vtfs.nowIso();
  vtfs.writeTask(file, t);
  return { status: 200, body: { id, status: 'closed' } };
}
```
Add `list, close` to `handlers` object.

- [ ] **Step 4: Run - all pass**

Run: `node --test tests/test-vt-routes.js`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/vt-routes.js tests/test-vt-routes.js
git commit -m "feat(vt): add task_list and task_close handlers"
```

---

### Task 3: `task_show` handler (json + markdown modes)

**Files:**
- Modify: `scripts/lib/vt-routes.js`
- Modify: `tests/test-vt-routes.js`

- [ ] **Step 1: Failing tests**

```js
test('task_show returns full json by default', async () => {
  const vault = tmpVault();
  await handlers.create({ vault, body: { title: 'demo' } });
  const res = await handlers.show({ vault, body: { id: 'vt-0001' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.id, 'vt-0001');
  assert.strictEqual(res.body.title, 'demo');
  assert.ok(typeof res.body.body === 'string');
});

test('task_show json=false returns rendered markdown', async () => {
  const vault = tmpVault();
  await handlers.create({ vault, body: { title: 'demo' } });
  const res = await handlers.show({ vault, body: { id: 'vt-0001', json: false } });
  assert.strictEqual(res.status, 200);
  assert.match(res.body.markdown, /^---\nid: vt-0001/);
});

test('task_show 404 on missing', async () => {
  const vault = tmpVault();
  const res = await handlers.show({ vault, body: { id: 'vt-9999' } });
  assert.strictEqual(res.status, 404);
});
```

- [ ] **Step 2: Run - fail (no handlers.show)**

- [ ] **Step 3: Implement show**

```js
const fs = require('node:fs');

async function show({ vault, body }) {
  const { id, json = true } = body || {};
  if (!id) return { status: 400, body: { error: 'id required' } };
  const cfg = cfgFor(vault);
  const file = vtfs.findTaskFile(cfg, id);
  if (!file) return { status: 404, body: { error: `task not found: ${id}` } };
  if (!json) return { status: 200, body: { markdown: fs.readFileSync(file, 'utf8') } };
  const t = vtfs.readTask(file);
  return { status: 200, body: t };
}
```
Add `show` to handlers map.

- [ ] **Step 4: Run - pass**

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/vt-routes.js tests/test-vt-routes.js
git commit -m "feat(vt): add task_show handler"
```

---

### Task 4: `task_claim` + `task_update`

**Files:**
- Modify: `scripts/lib/vt-routes.js`
- Modify: `tests/test-vt-routes.js`

- [ ] **Step 1: Failing tests**

```js
test('task_claim sets in_progress and claimed_by', async () => {
  const vault = tmpVault();
  await handlers.create({ vault, body: { title: 'demo' } });
  const res = await handlers.claim({ vault, body: { id: 'vt-0001', by: 'alice' } });
  assert.strictEqual(res.status, 200);
  const show = await handlers.show({ vault, body: { id: 'vt-0001' } });
  assert.strictEqual(show.body.status, 'in_progress');
  assert.strictEqual(show.body.claimed_by, 'alice');
});

test('task_claim 409 on already-claimed without force', async () => {
  const vault = tmpVault();
  await handlers.create({ vault, body: { title: 'demo' } });
  await handlers.claim({ vault, body: { id: 'vt-0001', by: 'alice' } });
  const res = await handlers.claim({ vault, body: { id: 'vt-0001', by: 'bob' } });
  assert.strictEqual(res.status, 409);
});

test('task_claim force=true overrides', async () => {
  const vault = tmpVault();
  await handlers.create({ vault, body: { title: 'demo' } });
  await handlers.claim({ vault, body: { id: 'vt-0001', by: 'alice' } });
  const res = await handlers.claim({ vault, body: { id: 'vt-0001', by: 'bob', force: true } });
  assert.strictEqual(res.status, 200);
  const show = await handlers.show({ vault, body: { id: 'vt-0001' } });
  assert.strictEqual(show.body.claimed_by, 'bob');
});

test('task_update changes status', async () => {
  const vault = tmpVault();
  await handlers.create({ vault, body: { title: 'demo' } });
  const res = await handlers.update({ vault, body: { id: 'vt-0001', status: 'blocked' } });
  assert.strictEqual(res.status, 200);
  const show = await handlers.show({ vault, body: { id: 'vt-0001' } });
  assert.strictEqual(show.body.status, 'blocked');
});

test('task_update rejects bad status', async () => {
  const vault = tmpVault();
  await handlers.create({ vault, body: { title: 'demo' } });
  const res = await handlers.update({ vault, body: { id: 'vt-0001', status: 'weird' } });
  assert.strictEqual(res.status, 400);
});
```

- [ ] **Step 2: Run - fail**

- [ ] **Step 3: Implement**

```js
async function claim({ vault, body }) {
  const { id, by = 'agent', force = false } = body || {};
  if (!id) return { status: 400, body: { error: 'id required' } };
  const cfg = cfgFor(vault);
  const file = vtfs.findTaskFile(cfg, id);
  if (!file) return { status: 404, body: { error: `task not found: ${id}` } };
  const t = vtfs.readTask(file);
  if (t.claimed_by && t.claimed_by !== by && !force) {
    return { status: 409, body: { error: `already claimed by ${t.claimed_by}; use force=true` } };
  }
  t.status = 'in_progress';
  t.claimed_by = by;
  t.claimed_at = vtfs.nowIso();
  vtfs.writeTask(file, t);
  return { status: 200, body: { id, claimed_by: by } };
}

async function update({ vault, body }) {
  const { id, status, priority, body: newBody } = body || {};
  if (!id) return { status: 400, body: { error: 'id required' } };
  if (status && !STATUSES.has(status)) return { status: 400, body: { error: `invalid status: ${status}` } };
  if (priority !== undefined && (typeof priority !== 'number' || priority < 0 || priority > 3)) {
    return { status: 400, body: { error: 'priority must be 0..3' } };
  }
  const cfg = cfgFor(vault);
  const file = vtfs.findTaskFile(cfg, id);
  if (!file) return { status: 404, body: { error: `task not found: ${id}` } };
  const t = vtfs.readTask(file);
  if (status) t.status = status;
  if (priority !== undefined) t.priority = priority;
  if (typeof newBody === 'string') t.body = newBody;
  vtfs.writeTask(file, t);
  return { status: 200, body: { id, status: t.status, priority: t.priority } };
}
```
Add to handlers.

- [ ] **Step 4: Run - pass**

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/vt-routes.js tests/test-vt-routes.js
git commit -m "feat(vt): add task_claim and task_update handlers"
```

---

### Task 5: `task_ready` + `task_dep_add` + `task_dep_rm`

**Files:**
- Modify: `scripts/lib/vt-routes.js`
- Modify: `tests/test-vt-routes.js`

- [ ] **Step 1: Failing tests**

```js
test('task_ready returns unblocked open sorted by priority asc', async () => {
  const vault = tmpVault();
  await handlers.create({ vault, body: { title: 'low', priority: 3 } });
  await handlers.create({ vault, body: { title: 'high', priority: 0 } });
  const res = await handlers.ready({ vault, body: {} });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body[0].id, 'vt-0002');
});

test('task_dep_add blocks ready', async () => {
  const vault = tmpVault();
  await handlers.create({ vault, body: { title: 'a' } });
  await handlers.create({ vault, body: { title: 'b' } });
  await handlers.dep_add({ vault, body: { id: 'vt-0002', blocked_by: 'vt-0001' } });
  const res = await handlers.ready({ vault, body: {} });
  const ids = res.body.map(t => t.id);
  assert.deepStrictEqual(ids, ['vt-0001']);
});

test('task_dep_add idempotent', async () => {
  const vault = tmpVault();
  await handlers.create({ vault, body: { title: 'a' } });
  await handlers.create({ vault, body: { title: 'b' } });
  await handlers.dep_add({ vault, body: { id: 'vt-0002', blocked_by: 'vt-0001' } });
  await handlers.dep_add({ vault, body: { id: 'vt-0002', blocked_by: 'vt-0001' } });
  const show = await handlers.show({ vault, body: { id: 'vt-0002' } });
  assert.deepStrictEqual(show.body.blocked_by, ['vt-0001']);
});

test('task_dep_rm unblocks', async () => {
  const vault = tmpVault();
  await handlers.create({ vault, body: { title: 'a' } });
  await handlers.create({ vault, body: { title: 'b' } });
  await handlers.dep_add({ vault, body: { id: 'vt-0002', blocked_by: 'vt-0001' } });
  await handlers.dep_rm({ vault, body: { id: 'vt-0002', blocked_by: 'vt-0001' } });
  const show = await handlers.show({ vault, body: { id: 'vt-0002' } });
  assert.deepStrictEqual(show.body.blocked_by, []);
});
```

- [ ] **Step 2: Run - fail**

- [ ] **Step 3: Implement**

```js
const vtgraph = require('./vt-graph');

async function ready({ vault }) {
  const cfg = cfgFor(vault);
  const tasks = vtfs.listTasks(cfg);
  const r = vtgraph.readyTasks(tasks).map(t => ({
    id: t.id, title: t.title, type: t.type, priority: t.priority, epic: t.epic || null,
    blocked_by: t.blocked_by || [], created: t.created
  }));
  return { status: 200, body: r };
}

async function dep_add({ vault, body }) {
  const { id, blocked_by } = body || {};
  if (!id || !blocked_by) return { status: 400, body: { error: 'id and blocked_by required' } };
  const cfg = cfgFor(vault);
  const file = vtfs.findTaskFile(cfg, id);
  if (!file) return { status: 404, body: { error: `task not found: ${id}` } };
  const t = vtfs.readTask(file);
  const arr = Array.isArray(t.blocked_by) ? t.blocked_by : [];
  if (!arr.includes(blocked_by)) arr.push(blocked_by);
  t.blocked_by = arr;
  vtfs.writeTask(file, t);
  return { status: 200, body: { id, blocked_by: arr } };
}

async function dep_rm({ vault, body }) {
  const { id, blocked_by } = body || {};
  if (!id || !blocked_by) return { status: 400, body: { error: 'id and blocked_by required' } };
  const cfg = cfgFor(vault);
  const file = vtfs.findTaskFile(cfg, id);
  if (!file) return { status: 404, body: { error: `task not found: ${id}` } };
  const t = vtfs.readTask(file);
  const arr = (t.blocked_by || []).filter(x => x !== blocked_by);
  t.blocked_by = arr;
  vtfs.writeTask(file, t);
  return { status: 200, body: { id, blocked_by: arr } };
}
```
Add to handlers map.

- [ ] **Step 4: Run - pass (9 handlers covered)**

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/vt-routes.js tests/test-vt-routes.js
git commit -m "feat(vt): add task_ready and task_dep_add/rm handlers"
```

---

### Task 6: `task_import` (gated migration endpoint)

**Files:**
- Modify: `scripts/lib/vt-routes.js`
- Modify: `tests/test-vt-routes.js`

- [ ] **Step 1: Failing test**

```js
test('task_import refuses without env flag', async () => {
  const vault = tmpVault();
  delete process.env.VAULT_RAG_ALLOW_IMPORT;
  const res = await handlers.import_task({ vault, body: { path: '06-tasks/vt-0099-x.md', content: '---\nid: vt-0099\n---\n' } });
  assert.strictEqual(res.status, 403);
});

test('task_import writes file and bumps seq', async () => {
  const vault = tmpVault();
  process.env.VAULT_RAG_ALLOW_IMPORT = '1';
  const md = '---\nid: vt-0042\ntitle: x\ntype: task\nstatus: open\npriority: 2\ncreated: 2026-01-01T00:00:00.000Z\n---\nbody\n';
  const res = await handlers.import_task({ vault, body: { path: '06-tasks/vt-0042-x.md', content: md } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(fs.readFileSync(path.join(vault, '.vt', 'seq'), 'utf8').trim(), '42');
  delete process.env.VAULT_RAG_ALLOW_IMPORT;
});

test('task_import refuses overwrite', async () => {
  const vault = tmpVault();
  process.env.VAULT_RAG_ALLOW_IMPORT = '1';
  const md = '---\nid: vt-0001\ntitle: x\ntype: task\nstatus: open\npriority: 2\ncreated: 2026-01-01T00:00:00.000Z\n---\n';
  await handlers.import_task({ vault, body: { path: '06-tasks/vt-0001-x.md', content: md } });
  const res = await handlers.import_task({ vault, body: { path: '06-tasks/vt-0001-x.md', content: md } });
  assert.strictEqual(res.status, 409);
  delete process.env.VAULT_RAG_ALLOW_IMPORT;
});
```

- [ ] **Step 2: Run - fail**

- [ ] **Step 3: Implement**

```js
async function import_task({ vault, body }) {
  if (process.env.VAULT_RAG_ALLOW_IMPORT !== '1') {
    return { status: 403, body: { error: 'import disabled; set VAULT_RAG_ALLOW_IMPORT=1' } };
  }
  const { path: relPath, content } = body || {};
  if (!relPath || !content) return { status: 400, body: { error: 'path and content required' } };
  if (!relPath.startsWith('06-tasks/') || relPath.includes('..')) {
    return { status: 400, body: { error: 'path must start with 06-tasks/ and contain no ..' } };
  }
  const abs = path.join(vault, relPath);
  if (fs.existsSync(abs)) return { status: 409, body: { error: 'file already exists' } };
  vtfs.ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, content);
  const m = relPath.match(/vt-(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    const seqFile = path.join(vault, '.vt', 'seq');
    vtfs.ensureDir(path.dirname(seqFile));
    let cur = 0;
    if (fs.existsSync(seqFile)) cur = parseInt(fs.readFileSync(seqFile, 'utf8').trim(), 10) || 0;
    if (n > cur) fs.writeFileSync(seqFile, String(n));
  }
  return { status: 200, body: { path: relPath } };
}
```
Add `import: import_task` to handlers (note the alias - we'll wire route name `import` -> function `import_task` since `import` is a reserved word).

- [ ] **Step 4: Run - pass**

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/vt-routes.js tests/test-vt-routes.js
git commit -m "feat(vt): add gated task_import handler for migration"
```

---

## Phase 2: Wire into rag-api + mcp-shim

### Task 7: Mount `/task/*` routes in rag-api.js

**Files:**
- Modify: `scripts/rag-api.js`

- [ ] **Step 1: Read current rag-api.js to find ROUTES dict**

Run: `grep -n "ROUTES" /root/work/vault-rag-oss/scripts/rag-api.js`

- [ ] **Step 2: Add task route adapter**

Insert near top after `vault-lib` require:
```js
const vtRoutes = require('./lib/vt-routes');
const VAULT_PATH = process.env.VAULT_PATH || '/vault';

async function taskRoute(name) {
  return async (req, res, body) => {
    const handler = vtRoutes.handlers[name];
    if (!handler) return sendJson(res, 404, { error: `no handler: ${name}` });
    try {
      const out = await handler({ vault: VAULT_PATH, body });
      sendJson(res, out.status, out.body);
    } catch (e) {
      sendJson(res, 500, { error: String(e.message || e) });
    }
  };
}
```

(Use the actual sendJson helper name from the file - confirm by reading rag-api.js section first.)

- [ ] **Step 3: Register routes in ROUTES dict**

```js
'/task/create':  await taskRoute('create'),
'/task/list':    await taskRoute('list'),
'/task/ready':   await taskRoute('ready'),
'/task/show':    await taskRoute('show'),
'/task/claim':   await taskRoute('claim'),
'/task/close':   await taskRoute('close'),
'/task/update':  await taskRoute('update'),
'/task/dep_add': await taskRoute('dep_add'),
'/task/dep_rm':  await taskRoute('dep_rm'),
'/task/import':  await taskRoute('import_task'),
```

(If `taskRoute` is sync, drop the `await`. Match style of existing entries.)

- [ ] **Step 4: Smoke - start rag-api locally with tmp vault**

```bash
cd /root/work/vault-rag-oss
mkdir -p /tmp/vault-test/06-tasks /tmp/vault-test/.vt
VAULT_PATH=/tmp/vault-test VAULT_RAG_API_TOKEN=test PORT=15679 node scripts/rag-api.js &
sleep 1
curl -s -X POST http://127.0.0.1:15679/task/create \
  -H "Authorization: Bearer test" -H "Content-Type: application/json" \
  -d '{"title":"smoke"}'
# Expected: {"id":"vt-0001","path":"06-tasks/vt-0001-smoke.md"}
curl -s -X POST http://127.0.0.1:15679/task/list \
  -H "Authorization: Bearer test" -H "Content-Type: application/json" -d '{}'
# Expected: array with one task
kill %1
rm -rf /tmp/vault-test
```

- [ ] **Step 5: Commit**

```bash
git add scripts/rag-api.js
git commit -m "feat(rag-api): mount /task/* routes from vt-routes"
```

---

### Task 8: Extend WRITABLE_PREFIXES for `vt remember`

**Files:**
- Modify: `scripts/rag-api.js`

`vt remember` writes to `09-resources/notes/` which is currently not a writable prefix. Add it so the rewritten CLI can post via existing `/api/put`.

- [ ] **Step 1: Locate current WRITABLE_PREFIXES**

Run: `grep -n "WRITABLE_PREFIXES" /root/work/vault-rag-oss/scripts/rag-api.js`

- [ ] **Step 2: Add `09-resources/notes/`**

```js
// before
const WRITABLE_PREFIXES = ['00-inbox/', '05-sessions/'];
// after
const WRITABLE_PREFIXES = ['00-inbox/', '05-sessions/', '06-tasks/', '09-resources/notes/'];
```

(`06-tasks/` added so any future direct put works the same way; tasks themselves go through `/task/*` routes.)

- [ ] **Step 3: Smoke**

```bash
cd /root/work/vault-rag-oss
mkdir -p /tmp/vault-test/09-resources/notes /tmp/vault-test/06-tasks /tmp/vault-test/.vt
VAULT_PATH=/tmp/vault-test VAULT_RAG_API_TOKEN=test PORT=15679 node scripts/rag-api.js &
sleep 1
curl -s -X POST http://127.0.0.1:15679/put -H "Authorization: Bearer test" \
  -H "Content-Type: application/json" \
  -d '{"path":"09-resources/notes/test.md","content":"---\ntype: note\n---\nhi","reindex":false}'
# Expected: success
kill %1
rm -rf /tmp/vault-test
```

- [ ] **Step 4: Commit**

```bash
git add scripts/rag-api.js
git commit -m "feat(rag-api): allow writes to 09-resources/notes and 06-tasks"
```

---

### Task 9: Add 9 `task_*` tools to mcp-shim.js

**Files:**
- Modify: `scripts/mcp-shim.js`

- [ ] **Step 1: Read TOOLS array structure**

Run: `grep -n "TOOLS\|TOOL_IMPL\|ragCall" /root/work/vault-rag-oss/scripts/mcp-shim.js`

- [ ] **Step 2: Append 9 tool definitions**

In `TOOLS`:
```js
{ name: 'task_create', description: 'Create new vt task', inputSchema: {
  type: 'object', required: ['title'],
  properties: {
    title: { type: 'string' },
    type: { type: 'string', enum: ['task','epic','bug','chore'] },
    priority: { type: 'integer', minimum: 0, maximum: 3 },
    epic: { type: 'string' },
    blocked_by: { type: 'array', items: { type: 'string' } },
    by: { type: 'string', description: 'Agent identifier' }
  }
}},
{ name: 'task_list', description: 'List tasks (default: open only)', inputSchema: {
  type: 'object',
  properties: {
    all: { type: 'boolean' },
    status: { type: 'string', enum: ['open','in_progress','blocked','closed'] },
    type: { type: 'string' }
  }
}},
{ name: 'task_ready', description: 'List unblocked open tasks sorted by priority', inputSchema: { type: 'object' }},
{ name: 'task_show', description: 'Show task by id', inputSchema: {
  type: 'object', required: ['id'],
  properties: { id: { type: 'string' }, json: { type: 'boolean' } }
}},
{ name: 'task_claim', description: 'Claim a task (sets in_progress, claimed_by)', inputSchema: {
  type: 'object', required: ['id'],
  properties: { id: { type: 'string' }, by: { type: 'string' }, force: { type: 'boolean' } }
}},
{ name: 'task_close', description: 'Close a task with reason', inputSchema: {
  type: 'object', required: ['id','reason'],
  properties: { id: { type: 'string' }, reason: { type: 'string' } }
}},
{ name: 'task_update', description: 'Update status/priority/body', inputSchema: {
  type: 'object', required: ['id'],
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['open','in_progress','blocked','closed'] },
    priority: { type: 'integer', minimum: 0, maximum: 3 },
    body: { type: 'string' }
  }
}},
{ name: 'task_dep_add', description: 'Add blocked_by dependency', inputSchema: {
  type: 'object', required: ['id','blocked_by'],
  properties: { id: { type: 'string' }, blocked_by: { type: 'string' } }
}},
{ name: 'task_dep_rm', description: 'Remove blocked_by dependency', inputSchema: {
  type: 'object', required: ['id','blocked_by'],
  properties: { id: { type: 'string' }, blocked_by: { type: 'string' } }
}},
```

In `TOOL_IMPL`:
```js
task_create:  (args) => ragCall('/task/create',  args),
task_list:    (args) => ragCall('/task/list',    args || {}),
task_ready:   (args) => ragCall('/task/ready',   args || {}),
task_show:    (args) => ragCall('/task/show',    args),
task_claim:   (args) => ragCall('/task/claim',   args),
task_close:   (args) => ragCall('/task/close',   args),
task_update:  (args) => ragCall('/task/update',  args),
task_dep_add: (args) => ragCall('/task/dep_add', args),
task_dep_rm:  (args) => ragCall('/task/dep_rm',  args),
```

- [ ] **Step 3: Smoke - start rag-api + mcp-shim, list tools, call task_create**

```bash
cd /root/work/vault-rag-oss
mkdir -p /tmp/vault-test/06-tasks /tmp/vault-test/.vt
VAULT_PATH=/tmp/vault-test VAULT_RAG_API_TOKEN=test PORT=15679 node scripts/rag-api.js &
RAG_API_URL=http://127.0.0.1:15679 RAG_API_TOKEN=test VAULT_RAG_MCP_TOKEN=mcptest PORT=15680 node scripts/mcp-shim.js &
sleep 1
curl -s -X POST http://127.0.0.1:15680/mcp -H "X-Vault-Token: mcptest" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -c "import sys,json; d=json.load(sys.stdin); names=[t['name'] for t in d['result']['tools']]; print(names); assert 'task_create' in names and 'task_dep_rm' in names"
curl -s -X POST http://127.0.0.1:15680/mcp -H "X-Vault-Token: mcptest" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"task_create","arguments":{"title":"via mcp"}}}'
# Expected: id vt-0001
kill %1 %2
rm -rf /tmp/vault-test
```

(Adjust env var names to match what mcp-shim actually reads - read the file in step 1.)

- [ ] **Step 4: Commit**

```bash
git add scripts/mcp-shim.js
git commit -m "feat(mcp): expose 9 task_* tools proxying to /task/*"
```

---

## Phase 3: CLI rewrite

### Task 10: Rewrite `vt.js` as REST client

**Files:**
- Rewrite: `scripts/vt.js`

- [ ] **Step 1: Write replacement (~150 LOC)**

```js
#!/usr/bin/env node
const URL_ENV = 'VAULT_RAG_URL';
const TOKEN_ENV = 'VAULT_RAG_API_TOKEN';
const AGENT_ENV = 'VT_AGENT';

function die(msg, code = 1) { process.stderr.write(`vt: ${msg}\n`); process.exit(code); }

function cfg() {
  const url = process.env[URL_ENV];
  const token = process.env[TOKEN_ENV];
  if (!url) die(`set ${URL_ENV} (e.g. https://brain.itiswednesdaymydud.es)`);
  if (!token) die(`set ${TOKEN_ENV}`);
  return { url: url.replace(/\/$/, ''), token, agent: process.env[AGENT_ENV] || 'agent' };
}

async function call(route, body) {
  const c = cfg();
  const res = await fetch(`${c.url}/api/task/${route}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!res.ok) die(`${res.status}: ${data.error || text}`, 1);
  return data;
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--force') out.force = true;
    else if (a === '--json') out.json = true;
    else if (a.startsWith('--')) {
      const k = a.slice(2).replace(/-/g, '_');
      out[k] = argv[++i];
    } else if (a === '-t') out.type = argv[++i];
    else if (a === '-p') out.priority = parseInt(argv[++i], 10);
    else out._.push(a);
  }
  return out;
}

function fmtTask(t) {
  const claim = t.claimed_by ? ` [${t.claimed_by}]` : '';
  const blk = t.blocked_by && t.blocked_by.length ? ` blocked-by:${t.blocked_by.join(',')}` : '';
  return `${t.id} (p${t.priority} ${t.type} ${t.status})${claim} ${t.title}${blk}`;
}

const cmds = {
  async create(args) {
    const f = parseFlags(args);
    const title = f._.join(' ');
    if (!title) die('title required');
    const body = { title, by: cfg().agent };
    if (f.type) body.type = f.type;
    if (f.priority !== undefined) body.priority = f.priority;
    if (f.epic) body.epic = f.epic;
    if (f.blocked_by) body.blocked_by = f.blocked_by.split(',');
    const r = await call('create', body);
    process.stdout.write(`${r.id} ${r.path}\n`);
  },
  async list(args) {
    const f = parseFlags(args);
    const body = {};
    if (f.all) body.all = true;
    if (f.status) body.status = f.status;
    if (f.type) body.type = f.type;
    const tasks = await call('list', body);
    for (const t of tasks) process.stdout.write(fmtTask(t) + '\n');
  },
  async ready() {
    const tasks = await call('ready', {});
    for (const t of tasks) process.stdout.write(fmtTask(t) + '\n');
  },
  async show(args) {
    const f = parseFlags(args);
    const id = f._[0]; if (!id) die('id required');
    if (f.json) {
      const t = await call('show', { id, json: true });
      process.stdout.write(JSON.stringify(t) + '\n');
    } else {
      const r = await call('show', { id, json: false });
      process.stdout.write(r.markdown);
    }
  },
  async claim(args) {
    const f = parseFlags(args);
    const id = f._[0]; if (!id) die('id required');
    const body = { id, by: f.by || cfg().agent };
    if (f.force) body.force = true;
    await call('claim', body);
    process.stdout.write(`claimed ${id} by ${body.by}\n`);
  },
  async close(args) {
    const f = parseFlags(args);
    const id = f._[0]; if (!id) die('id required');
    if (!f.reason) die('--reason required');
    await call('close', { id, reason: f.reason });
    process.stdout.write(`closed ${id}\n`);
  },
  async update(args) {
    const f = parseFlags(args);
    const id = f._[0]; if (!id) die('id required');
    const body = { id };
    if (f.status) body.status = f.status;
    if (f.priority !== undefined) body.priority = parseInt(f.priority, 10);
    if (f.body === '-') body.body = require('fs').readFileSync(0, 'utf8');
    else if (f.body) body.body = f.body;
    await call('update', body);
    process.stdout.write(`updated ${id}\n`);
  },
  async dep(args) {
    const sub = args.shift();
    const f = parseFlags(args);
    const id = f._[0]; if (!id) die('id required');
    if (!f.blocked_by) die('--blocked-by required');
    if (sub === 'add') await call('dep_add', { id, blocked_by: f.blocked_by });
    else if (sub === 'rm') await call('dep_rm', { id, blocked_by: f.blocked_by });
    else die(`unknown dep subcommand: ${sub}`);
    process.stdout.write(`ok\n`);
  },
  async remember(args) {
    const f = parseFlags(args);
    const text = f._.join(' ');
    if (!text) die('text required');
    const tags = f.tags ? f.tags.split(',') : [];
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const fm = `---\ntype: note\ntags: [${tags.join(', ')}]\ncreated: ${new Date().toISOString()}\n---\n\n${text}\n`;
    const c = cfg();
    const res = await fetch(`${c.url}/api/put`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: `09-resources/notes/${stamp}-${slug}.md`, content: fm, mode: 'create', reindex: false }),
    });
    if (!res.ok) die(`remember failed: ${res.status} ${await res.text()}`);
    process.stdout.write(`remembered\n`);
  },
  prime() {
    process.stdout.write(`vt - vault task tracker (REST client)
env: VAULT_RAG_URL, VAULT_RAG_API_TOKEN, VT_AGENT
commands:
  create [-t TYPE] [-p PRIORITY] [--epic ID] [--blocked-by IDs] "title"
  list [--all] [--status S] [--type T]
  ready
  show <id> [--json]
  claim <id> [--by NAME] [--force]
  close <id> --reason "..."
  update <id> [--status S] [--priority P] [--body TEXT|-]
  dep add|rm <id> --blocked-by <other>
  remember "note" [--tags a,b]
`);
  },
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') return cmds.prime();
  const fn = cmds[cmd];
  if (!fn) die(`unknown command: ${cmd}. Run 'vt prime' for help.`);
  try { await fn(rest); } catch (e) { die(String(e.message || e)); }
}

main();
```

- [ ] **Step 2: Smoke against local rag-api**

```bash
cd /root/work/vault-rag-oss
mkdir -p /tmp/vault-test/06-tasks /tmp/vault-test/09-resources/notes /tmp/vault-test/.vt
VAULT_PATH=/tmp/vault-test VAULT_RAG_API_TOKEN=test PORT=15679 node scripts/rag-api.js &
sleep 1
export VAULT_RAG_URL=http://127.0.0.1:15679
export VAULT_RAG_API_TOKEN=test
export VT_AGENT=tester
node scripts/vt.js create -t epic -p 1 "smoke epic"
node scripts/vt.js list
node scripts/vt.js claim vt-0001
node scripts/vt.js show vt-0001 --json
node scripts/vt.js close vt-0001 --reason "test"
node scripts/vt.js list --all
kill %1; rm -rf /tmp/vault-test
```

- [ ] **Step 3: Commit**

```bash
git add scripts/vt.js
git commit -m "refactor(vt): rewrite CLI as thin REST client"
```

---

## Phase 4: Tests

### Task 11: Rewrite `tests/test-vt.bats` to use REST fixture

**Files:**
- Create: `tests/fixtures/start-test-rag-api.sh`
- Rewrite: `tests/test-vt.bats`

- [ ] **Step 1: Create fixture starter**

```bash
# tests/fixtures/start-test-rag-api.sh
#!/usr/bin/env bash
# Starts a test rag-api on a free port. Sets RAG_PID, RAG_PORT, VT_VAULT.
set -euo pipefail
VT_VAULT=$(mktemp -d)
mkdir -p "$VT_VAULT/06-tasks" "$VT_VAULT/.vt" "$VT_VAULT/09-resources/notes"
RAG_PORT=$((10000 + RANDOM % 50000))
VAULT_PATH="$VT_VAULT" VAULT_RAG_API_TOKEN=test PORT=$RAG_PORT \
  node /root/work/vault-rag-oss/scripts/rag-api.js >/tmp/rag-api-$$.log 2>&1 &
RAG_PID=$!
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -o /dev/null "http://127.0.0.1:$RAG_PORT/healthz"; then break; fi
  sleep 0.2
done
export RAG_PID RAG_PORT VT_VAULT
```

(Healthz path: confirm against rag-api - might be `/healthz` not `/api/healthz` since Caddy strips prefix.)

- [ ] **Step 2: Rewrite bats setup/teardown**

```bash
#!/usr/bin/env bats
# vt CLI tests via REST against an in-process rag-api.

setup() {
  source tests/fixtures/start-test-rag-api.sh
  export VAULT_RAG_URL="http://127.0.0.1:$RAG_PORT"
  export VAULT_RAG_API_TOKEN=test
  export VT_AGENT=tester
  export VT="/root/work/vault-rag-oss/scripts/bin/vt"
}

teardown() {
  kill "$RAG_PID" 2>/dev/null || true
  rm -rf "$VT_VAULT"
}
```

- [ ] **Step 3: Update assertions that hit filesystem directly**

Tests like `[ -f "$TMPDIR_TEST/06-tasks/vt-0001-first-epic.md" ]` become `[ -f "$VT_VAULT/06-tasks/vt-0001-first-epic.md" ]`. Tests that grep frontmatter still work. Test `missing vault dir errors` is replaced with `unreachable server errors`:

```bash
@test "unreachable server errors" {
  export VAULT_RAG_URL="http://127.0.0.1:1"
  run "$VT" list
  [ "$status" -ne 0 ]
}
```

- [ ] **Step 4: Run bats**

```bash
cd /root/work/vault-rag-oss
bats tests/test-vt.bats
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add tests/test-vt.bats tests/fixtures/start-test-rag-api.sh
chmod +x tests/fixtures/start-test-rag-api.sh
git commit -m "test(vt): rewrite bats suite for REST-backed CLI"
```

---

### Task 12: Add `tests/test-vt-graph.js` for ready/dep filters

**Files:**
- Create: `tests/test-vt-graph.js`

- [ ] **Step 1: Write tests**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { isReady, readyTasks, ACTIVE } = require('../scripts/lib/vt-graph');

const t = (id, status, blocked_by = []) => ({ id, status, blocked_by, priority: 2 });

test('isReady: open with no blockers', () => {
  assert.strictEqual(isReady(t('vt-1', 'open'), new Map()), true);
});
test('isReady: in_progress excluded', () => {
  assert.strictEqual(isReady(t('vt-1', 'in_progress'), new Map()), false);
});
test('isReady: blocked by active task', () => {
  const map = new Map([['vt-2', t('vt-2', 'open')]]);
  assert.strictEqual(isReady(t('vt-1', 'open', ['vt-2']), map), false);
});
test('isReady: blocker closed -> ready', () => {
  const map = new Map([['vt-2', t('vt-2', 'closed')]]);
  assert.strictEqual(isReady(t('vt-1', 'open', ['vt-2']), map), true);
});
test('readyTasks sorts by priority asc', () => {
  const tasks = [
    { id: 'a', status: 'open', priority: 3, blocked_by: [] },
    { id: 'b', status: 'open', priority: 0, blocked_by: [] },
  ];
  const r = readyTasks(tasks).map(x => x.id);
  assert.deepStrictEqual(r, ['b', 'a']);
});
```

- [ ] **Step 2: Run - pass (vt-graph is unchanged, tests should pass first try)**

```bash
node --test tests/test-vt-graph.js
```

- [ ] **Step 3: Commit**

```bash
git add tests/test-vt-graph.js
git commit -m "test(vt): add unit tests for vt-graph ready/dep logic"
```

---

## Phase 5: Migration

### Task 13: Implement `vt-migrate.js`

**Files:**
- Create: `scripts/vt-migrate.js`

- [ ] **Step 1: Write migrator**

```js
#!/usr/bin/env node
// Reads local 06-tasks/*.md and POSTs each to /api/task/import.
// Requires VAULT_RAG_URL, VAULT_RAG_API_TOKEN, and source dir as argv[2].
const fs = require('node:fs');
const path = require('node:path');

const url = process.env.VAULT_RAG_URL;
const token = process.env.VAULT_RAG_API_TOKEN;
const src = process.argv[2];
if (!url || !token || !src) {
  console.error('usage: VAULT_RAG_URL=.. VAULT_RAG_API_TOKEN=.. node vt-migrate.js <local-vault-dir>');
  process.exit(1);
}
const tasksDir = path.join(src, '06-tasks');
if (!fs.existsSync(tasksDir)) { console.error(`no 06-tasks at ${tasksDir}`); process.exit(1); }

(async () => {
  const files = fs.readdirSync(tasksDir).filter(f => /^vt-\d+.*\.md$/.test(f));
  console.error(`migrating ${files.length} tasks from ${tasksDir}`);
  for (const f of files) {
    const content = fs.readFileSync(path.join(tasksDir, f), 'utf8');
    const res = await fetch(`${url}/api/task/import`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: `06-tasks/${f}`, content }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`FAIL ${f}: ${res.status} ${text}`);
      process.exit(2);
    }
    console.error(`ok ${f}`);
  }
  console.error('done');
})();
```

- [ ] **Step 2: Smoke locally (with import flag set)**

```bash
cd /root/work/vault-rag-oss
mkdir -p /tmp/v-src/06-tasks /tmp/v-dst/06-tasks /tmp/v-dst/.vt
echo -e '---\nid: vt-0001\ntitle: a\ntype: task\nstatus: open\npriority: 2\ncreated: 2026-01-01T00:00:00.000Z\n---\nbody' > /tmp/v-src/06-tasks/vt-0001-a.md
VAULT_PATH=/tmp/v-dst VAULT_RAG_API_TOKEN=test VAULT_RAG_ALLOW_IMPORT=1 PORT=15679 node scripts/rag-api.js &
sleep 1
VAULT_RAG_URL=http://127.0.0.1:15679 VAULT_RAG_API_TOKEN=test node scripts/vt-migrate.js /tmp/v-src
ls /tmp/v-dst/06-tasks
cat /tmp/v-dst/.vt/seq
kill %1
rm -rf /tmp/v-src /tmp/v-dst
```
Expected: file copied, `.vt/seq` shows 1.

- [ ] **Step 3: Commit**

```bash
git add scripts/vt-migrate.js
git commit -m "feat(vt): add vt-migrate.js for one-shot vault migration"
```

---

## Phase 6: Docs

### Task 14: Update `docs/api.md`

**Files:**
- Modify: `docs/api.md`

- [ ] **Step 1: Append after `/api/backlinks` section, before MCP heading**

```markdown
### `POST /api/task/create`
Body: `{"title": "...", "type": "task|epic|bug|chore", "priority": 0-3, "epic": "vt-NNNN", "blocked_by": [...], "by": "agent"}`. Returns `{id, path}`.

### `POST /api/task/list`
Body: `{all?, status?, type?}`. Defaults to open tasks.

### `POST /api/task/ready`
Body: `{}`. Returns unblocked open tasks sorted by priority asc.

### `POST /api/task/show`
Body: `{id, json?}`. Default `json:true` returns object; `json:false` returns `{markdown}`.

### `POST /api/task/claim`
Body: `{id, by?, force?}`. 409 if already claimed without `force`.

### `POST /api/task/close`
Body: `{id, reason}`. Sets status=closed.

### `POST /api/task/update`
Body: `{id, status?, priority?, body?}`.

### `POST /api/task/dep_add` / `POST /api/task/dep_rm`
Body: `{id, blocked_by}`. Idempotent.
```

In MCP section add:
```markdown
- `task_create`, `task_list`, `task_ready`, `task_show`, `task_claim`, `task_close`, `task_update`, `task_dep_add`, `task_dep_rm` (mirror `/api/task/*`)
```

- [ ] **Step 2: Commit**

```bash
git add docs/api.md
git commit -m "docs(api): document /api/task/* and task_* MCP tools"
```

---

### Task 15: Create `docs/tasks.md` (vt CLI reference)

**Files:**
- Create: `docs/tasks.md`

- [ ] **Step 1: Write reference**

```markdown
# vt - Vault Task Tracker

Tasks live as markdown in `<vault>/06-tasks/vt-NNNN-slug.md`. Counter at `<vault>/.vt/seq`. Edit by hand if needed.

## Setup

```bash
export VAULT_RAG_URL=https://brain.itiswednesdaymydud.es
export VAULT_RAG_API_TOKEN=<token>
export VT_AGENT=<your-name>     # optional
```

## Commands

| Command | Purpose |
|---|---|
| `vt create [-t TYPE] [-p N] "title"` | Create task. TYPE in task/epic/bug/chore (default task). N in 0..3 (default 2). |
| `vt list [--all] [--status S] [--type T]` | List tasks. Default: open only. |
| `vt ready` | Show unblocked open tasks, priority asc. |
| `vt show <id> [--json]` | Show task body or JSON object. |
| `vt claim <id> [--by NAME] [--force]` | Set in_progress + claimed_by. |
| `vt close <id> --reason "..."` | Mark closed with reason. |
| `vt update <id> [--status S] [--priority P] [--body TEXT|-]` | Update fields. `--body -` reads stdin. |
| `vt dep add <id> --blocked-by <other>` | Add dependency. |
| `vt dep rm <id> --blocked-by <other>` | Remove dependency. |
| `vt remember "note" [--tags a,b]` | Save note to `09-resources/notes/`. |

## Agent workflow

1. `vt ready` - find unblocked work.
2. `vt claim <id>` - mark yourself as owner.
3. Do the work.
4. `vt close <id> --reason "..."` - report outcome.
5. Side quests: `vt create -t bug --blocked-by <current>` - file blocker, keep working on parent.

## MCP

Same operations available as MCP tools `task_create`, `task_list`, `task_ready`, `task_show`, `task_claim`, `task_close`, `task_update`, `task_dep_add`, `task_dep_rm`. Argument schemas mirror REST bodies.
```

- [ ] **Step 2: Commit**

```bash
git add docs/tasks.md
git commit -m "docs: add vt CLI reference and agent workflow"
```

---

### Task 16: Add Task Tracking section to README files

**Files:**
- Modify: `README.md`
- Modify: `README.ru.md`
- Modify: `README.es.md`

- [ ] **Step 1: Add section between Indexing and FAQ in each file**

English version:
```markdown
## Task Tracking

vault-rag ships with `vt`, a task tracker. Tasks are markdown files in `<vault>/06-tasks/` indexed alongside the rest of the vault.

```bash
# REST
curl -X POST $VAULT_RAG_URL/api/task/create \
  -H "Authorization: Bearer $VAULT_RAG_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Refactor auth","type":"task","priority":1}'

# MCP (in agent config)
# tool: task_create, args: {"title":"Refactor auth"}

# CLI
vt create -t task -p 1 "Refactor auth"
vt ready
vt claim vt-0007
vt close vt-0007 --reason "Done in PR #42"
```

Full reference: [docs/tasks.md](docs/tasks.md).
```

Translate appropriately for `.ru.md` and `.es.md` (keep code blocks identical).

- [ ] **Step 2: Commit**

```bash
git add README.md README.ru.md README.es.md
git commit -m "docs: add Task Tracking section to README"
```

---

## Phase 7: Deploy + verify on prod

### Task 17: Push code to prod and restart services

**Files:**
- None (deploy only)

- [ ] **Step 1: scp scripts to prod**

```bash
cd /root/work/vault-rag-oss
scp -P 977 scripts/lib/vt-routes.js root@brain.itiswednesdaymydud.es:/opt/vault-rag/scripts/lib/
scp -P 977 scripts/rag-api.js scripts/mcp-shim.js scripts/vt.js scripts/vt-migrate.js \
  root@brain.itiswednesdaymydud.es:/opt/vault-rag/scripts/
```

- [ ] **Step 2: Restart api and mcp**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es 'cd /opt/vault-rag && docker compose -p vault-rag restart vault-rag-api vault-rag-mcp'
```

- [ ] **Step 3: Smoke prod endpoints**

```bash
TOKEN=$(ssh -p 977 root@brain.itiswednesdaymydud.es 'grep VAULT_RAG_API_TOKEN /opt/vault-rag/.env | cut -d= -f2')
curl -s -X POST https://brain.itiswednesdaymydud.es/api/task/list \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"all":true}'
# Expected: [] (empty until migration)
```

- [ ] **Step 4: Commit deploy log (optional - skip if no file changes)**

---

### Task 18: Run migration on prod

- [ ] **Step 1: Set import flag and restart**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es '
  cd /opt/vault-rag
  echo "VAULT_RAG_ALLOW_IMPORT=1" >> .env
  docker compose -p vault-rag restart vault-rag-api
'
```

- [ ] **Step 2: Run migrator from local laptop**

```bash
cd /root/work/vault-rag-oss
TOKEN=$(ssh -p 977 root@brain.itiswednesdaymydud.es 'grep ^VAULT_RAG_API_TOKEN= /opt/vault-rag/.env | cut -d= -f2')
VAULT_RAG_URL=https://brain.itiswednesdaymydud.es VAULT_RAG_API_TOKEN=$TOKEN \
  node scripts/vt-migrate.js /root/work/vault-rag-oss/obsidian-vault
```
Expected: `ok vt-0001-...md`, `ok vt-0002-...md`, `ok vt-0003-...md`, `done`.

- [ ] **Step 3: Verify on prod**

```bash
curl -s -X POST https://brain.itiswednesdaymydud.es/api/task/list \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"all":true}' \
  | python3 -m json.tool
# Expected: 3 tasks visible
ssh -p 977 root@brain.itiswednesdaymydud.es 'ls /root/obsidian-vault/06-tasks/'
# Expected: vt-0001-*.md vt-0002-*.md vt-0003-*.md
```

- [ ] **Step 4: Disable import flag**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es '
  cd /opt/vault-rag
  sed -i "/^VAULT_RAG_ALLOW_IMPORT=/d" .env
  docker compose -p vault-rag restart vault-rag-api
'
```

- [ ] **Step 5: Commit migration record (if any local state)**

No code changes - skip commit.

---

### Task 19: Remove `/task/import` route after verification

**Files:**
- Modify: `scripts/lib/vt-routes.js`
- Modify: `scripts/rag-api.js`
- Modify: `tests/test-vt-routes.js`
- Delete: `scripts/vt-migrate.js`

- [ ] **Step 1: Remove `import_task` from vt-routes.js handlers**

- [ ] **Step 2: Remove `'/task/import'` from rag-api.js ROUTES**

- [ ] **Step 3: Remove import tests from test-vt-routes.js**

- [ ] **Step 4: Delete vt-migrate.js**

```bash
git rm scripts/vt-migrate.js
```

- [ ] **Step 5: Run all tests - pass**

```bash
node --test tests/test-vt-routes.js tests/test-vt-graph.js
bats tests/test-vt.bats
```

- [ ] **Step 6: Re-deploy and restart**

```bash
scp -P 977 scripts/lib/vt-routes.js scripts/rag-api.js root@brain.itiswednesdaymydud.es:/opt/vault-rag/scripts/...
ssh -p 977 root@brain.itiswednesdaymydud.es 'cd /opt/vault-rag && docker compose -p vault-rag restart vault-rag-api'
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(vt): remove migration endpoint after vault-rag prod cutover"
```

---

### Task 20: Switch local CLI to prod, sanity check, close epic

- [ ] **Step 1: Update local env for vt to point at prod**

```bash
# In /root/.bashrc or per-shell:
export VAULT_RAG_URL=https://brain.itiswednesdaymydud.es
export VAULT_RAG_API_TOKEN=<token from /opt/vault-rag/.env on prod>
export VT_AGENT=claude
```

- [ ] **Step 2: Sanity**

```bash
vt list --all
# Expected: vt-0001, vt-0002, vt-0003
vt show vt-0003
# Expected: this epic
```

- [ ] **Step 3: Mark epic done**

```bash
vt close vt-0003 --reason "Shipped: REST + MCP + CLI live in prod, migration complete"
```

- [ ] **Step 4: Push branch**

```bash
git pull --rebase
git push
git status   # MUST show "up to date"
```

---

## Self-Review (run before execution)

**Spec coverage:**
- create/list/ready/show/claim/close/update/dep_add/dep_rm endpoints: Tasks 1-5
- 9 MCP tools: Task 9
- vt CLI rewrite: Task 10
- migration: Tasks 13, 18
- README/api.md/tasks.md: Tasks 14-16
- testing layers (vt-graph unit, REST routes unit, bats end-to-end, smoke): Tasks 11, 12 + smokes in 7-9
- acceptance "vt-0001/vt-0002 visible after migration": Task 18 step 3 (plus vt-0003)

**No placeholders:** All TDD steps have concrete code. No "TBD" / "implement later" / "similar to Task N" without inlined code.

**Type consistency:**
- Handler shape: `({vault, body}) -> {status, body}` everywhere.
- Status set: `open|in_progress|blocked|closed` consistent in update + spec.
- Type set: `task|epic|bug|chore` consistent.
- `task_dep_add` / `task_dep_rm` spelled with underscore in REST + MCP + handler keys (NOT camelCase or hyphen). CLI uses `vt dep add/rm` (with space) which calls `dep_add`/`dep_rm` routes.

**Risk re-check:**
- Race on `nextId` -> O_EXCL retry in `lib/vt-fs.js` already handles. Single rag-api process means no cross-process contention.
- Race on `claim` -> `readTask` happens inside the same handler invocation; concurrent claims still last-writer-wins on file but the conflict-check works for the common case. Acceptable for v1 per spec.
- Indexer churn -> existing incremental indexer already reads `06-tasks/*.md`; no change needed.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-09-vt-rest-mcp.md`.

**Subagent-driven execution is DISABLED per project CLAUDE.md** (cost control). Execute inline via `superpowers:executing-plans` - batch tasks, checkpoint after each phase, full verification before declaring done.
