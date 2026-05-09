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

