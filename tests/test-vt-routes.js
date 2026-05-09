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
