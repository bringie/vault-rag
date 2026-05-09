// vt: dependency graph - "ready" computation.

const ACTIVE = new Set(['open', 'in_progress', 'blocked']);

function isReady(task, byId) {
  if (task.fm.status !== 'open') return false;
  for (const dep of task.fm.blocked_by || []) {
    const t = byId.get(dep);
    if (!t) continue; // unknown dep -> treat as not blocking
    if (ACTIVE.has(t.fm.status)) return false;
  }
  return true;
}

function readyTasks(tasks) {
  const byId = new Map(tasks.map(t => [t.fm.id, t]));
  const ready = tasks.filter(t => isReady(t, byId));
  // priority asc (0 = highest), then created asc
  ready.sort((a, b) => {
    const pa = a.fm.priority ?? 2;
    const pb = b.fm.priority ?? 2;
    if (pa !== pb) return pa - pb;
    return String(a.fm.created || '').localeCompare(String(b.fm.created || ''));
  });
  return ready;
}

function blockingChain(tasks, id) {
  const byId = new Map(tasks.map(t => [t.fm.id, t]));
  const seen = new Set();
  const out = [];
  function walk(cur) {
    if (seen.has(cur)) return;
    seen.add(cur);
    const t = byId.get(cur);
    if (!t) return;
    for (const dep of t.fm.blocked_by || []) {
      const d = byId.get(dep);
      if (!d) continue;
      if (ACTIVE.has(d.fm.status)) {
        out.push(d);
        walk(dep);
      }
    }
  }
  walk(id);
  return out;
}

module.exports = { isReady, readyTasks, blockingChain, ACTIVE };
