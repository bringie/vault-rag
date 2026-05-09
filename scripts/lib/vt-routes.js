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

const handlers = { create };

module.exports = { handlers, cfgFor };
