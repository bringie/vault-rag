// vt: HTTP-shaped handlers backed by vt-fs primitives.
// Each handler signature: ({ vault, body }) -> { status, body }.

const fs = require('node:fs');
const path = require('node:path');
const vtfs = require('./vt-fs');
const vtgraph = require('./vt-graph');

const TYPES = new Set(['task', 'epic', 'bug', 'chore']);
const STATUSES = new Set(['open', 'in_progress', 'blocked', 'closed']);

function cfgFor(vault) {
  return {
    tasksDir: path.join(vault, '06-tasks'),
    seqFile: path.join(vault, '.vt', 'seq'),
  };
}

async function create({ vault, body }) {
  const b = body || {};
  const { title, type = 'task', priority = 2, epic, blocked_by } = b;
  if (!title || typeof title !== 'string') {
    return { status: 400, body: { error: 'title required' } };
  }
  if (!TYPES.has(type)) {
    return { status: 400, body: { error: `invalid type: ${type}` } };
  }
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 3) {
    return { status: 400, body: { error: 'priority must be integer 0..3' } };
  }
  const cfg = cfgFor(vault);
  const { id, file } = vtfs.createTask(cfg, { title, type, priority, epic, blocked_by });
  return { status: 200, body: { id, path: path.relative(vault, file) } };
}

async function list({ vault, body }) {
  const cfg = cfgFor(vault);
  const { all, status, type } = body || {};
  let tasks = vtfs.listTasks(cfg.tasksDir).map(t => t.fm);
  if (!all && !status) tasks = tasks.filter(t => t.status !== 'closed');
  if (status) tasks = tasks.filter(t => t.status === status);
  if (type) tasks = tasks.filter(t => t.type === type);
  const slim = tasks.map(t => ({
    id: t.id, title: t.title, type: t.type, status: t.status, priority: t.priority,
    claimed_by: t.claimed_by || null, blocked_by: t.blocked_by || [],
    epic: t.epic || null, created: t.created,
  }));
  return { status: 200, body: slim };
}

async function show({ vault, body }) {
  const b = body || {};
  const { id, json = true } = b;
  if (!id) return { status: 400, body: { error: 'id required' } };
  const cfg = cfgFor(vault);
  const t = vtfs.readTask(cfg.tasksDir, id);
  if (!t) return { status: 404, body: { error: `task not found: ${id}` } };
  if (!json) return { status: 200, body: { markdown: t.text } };
  return { status: 200, body: { ...t.fm, body: t.body } };
}

async function claim({ vault, body }) {
  const b = body || {};
  const { id, by = 'agent', force = false } = b;
  if (!id) return { status: 400, body: { error: 'id required' } };
  const cfg = cfgFor(vault);
  const t = vtfs.readTask(cfg.tasksDir, id);
  if (!t) return { status: 404, body: { error: `task not found: ${id}` } };
  if (t.fm.claimed_by && t.fm.claimed_by !== by && !force) {
    return { status: 409, body: { error: `already claimed by ${t.fm.claimed_by}; use force=true` } };
  }
  t.fm.status = 'in_progress';
  t.fm.claimed_by = by;
  t.fm.claimed_at = vtfs.nowIso();
  vtfs.writeTask(t.file, t.fm, t.body);
  return { status: 200, body: { id, claimed_by: by } };
}

async function update({ vault, body }) {
  const b = body || {};
  const { id, status, priority } = b;
  const newBody = b.body;
  if (!id) return { status: 400, body: { error: 'id required' } };
  if (status && !STATUSES.has(status)) return { status: 400, body: { error: `invalid status: ${status}` } };
  if (priority !== undefined && (!Number.isInteger(priority) || priority < 0 || priority > 3)) {
    return { status: 400, body: { error: 'priority must be 0..3' } };
  }
  const cfg = cfgFor(vault);
  const t = vtfs.readTask(cfg.tasksDir, id);
  if (!t) return { status: 404, body: { error: `task not found: ${id}` } };
  if (status) t.fm.status = status;
  if (priority !== undefined) t.fm.priority = priority;
  const finalBody = (typeof newBody === 'string') ? newBody : t.body;
  vtfs.writeTask(t.file, t.fm, finalBody);
  return { status: 200, body: { id, status: t.fm.status, priority: t.fm.priority } };
}

async function ready({ vault }) {
  const cfg = cfgFor(vault);
  const tasks = vtfs.listTasks(cfg.tasksDir);
  const r = vtgraph.readyTasks(tasks).map(t => ({
    id: t.fm.id, title: t.fm.title, type: t.fm.type, priority: t.fm.priority,
    epic: t.fm.epic || null,
    blocked_by: t.fm.blocked_by || [], created: t.fm.created,
  }));
  return { status: 200, body: r };
}

async function dep_add({ vault, body }) {
  const { id, blocked_by } = body || {};
  if (!id || !blocked_by) return { status: 400, body: { error: 'id and blocked_by required' } };
  const cfg = cfgFor(vault);
  const t = vtfs.readTask(cfg.tasksDir, id);
  if (!t) return { status: 404, body: { error: `task not found: ${id}` } };
  const arr = Array.isArray(t.fm.blocked_by) ? t.fm.blocked_by : [];
  if (!arr.includes(blocked_by)) arr.push(blocked_by);
  t.fm.blocked_by = arr;
  vtfs.writeTask(t.file, t.fm, t.body);
  return { status: 200, body: { id, blocked_by: arr } };
}

async function dep_rm({ vault, body }) {
  const { id, blocked_by } = body || {};
  if (!id || !blocked_by) return { status: 400, body: { error: 'id and blocked_by required' } };
  const cfg = cfgFor(vault);
  const t = vtfs.readTask(cfg.tasksDir, id);
  if (!t) return { status: 404, body: { error: `task not found: ${id}` } };
  const arr = (t.fm.blocked_by || []).filter(x => x !== blocked_by);
  t.fm.blocked_by = arr;
  vtfs.writeTask(t.file, t.fm, t.body);
  return { status: 200, body: { id, blocked_by: arr } };
}

async function close({ vault, body }) {
  const { id, reason } = body || {};
  if (!id) return { status: 400, body: { error: 'id required' } };
  if (!reason) return { status: 400, body: { error: 'reason required' } };
  const cfg = cfgFor(vault);
  const t = vtfs.readTask(cfg.tasksDir, id);
  if (!t) return { status: 404, body: { error: `task not found: ${id}` } };
  t.fm.status = 'closed';
  t.fm.closed_reason = reason;
  t.fm.closed = vtfs.nowIso();
  vtfs.writeTask(t.file, t.fm, t.body);
  return { status: 200, body: { id, status: 'closed' } };
}

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

const handlers = { create, list, show, claim, update, close, ready, dep_add, dep_rm, import_task };

module.exports = { handlers, cfgFor };
