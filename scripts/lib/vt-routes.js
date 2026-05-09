// vt: HTTP-shaped handlers backed by vt-fs primitives.
// Each handler signature: ({ vault, body }) -> { status, body }.

const path = require('node:path');
const vtfs = require('./vt-fs');

const TYPES = new Set(['task', 'epic', 'bug', 'chore']);

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

const handlers = { create, list, close };

module.exports = { handlers, cfgFor };
