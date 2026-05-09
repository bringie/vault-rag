// vt: file operations on tasks (CRUD + atomic id counter).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { parseFrontmatter, serializeFrontmatter } = require('./vault-lib');

const ID_RE = /^vt-(\d{4,})$/;
const FILE_RE = /^vt-(\d{4,})(?:-[a-z0-9-]+)?\.md$/;

function slug(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

function padId(n) { return 'vt-' + String(n).padStart(4, '0'); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

// Atomic increment of vault/.vt/seq using O_EXCL lockfile + rename.
function nextId(seqFile) {
  const dir = path.dirname(seqFile);
  ensureDir(dir);
  const lock = seqFile + '.lock';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Stale lock cleanup if older than 30s.
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > 30000) fs.unlinkSync(lock);
      } catch {}
      execSync('sleep 0.05');
      continue;
    }
    try {
      let cur = 0;
      try {
        cur = parseInt(fs.readFileSync(seqFile, 'utf8').trim(), 10);
        if (!Number.isFinite(cur) || cur < 0) cur = 0;
      } catch {}
      const next = cur + 1;
      const tmp = seqFile + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, String(next) + '\n');
      fs.renameSync(tmp, seqFile);
      return next;
    } finally {
      fs.closeSync(fd);
      try { fs.unlinkSync(lock); } catch {}
    }
  }
  throw new Error('vt: could not acquire seq lock');
}

function findTaskFile(tasksDir, id) {
  const m = String(id).match(ID_RE);
  if (!m) return null;
  if (!fs.existsSync(tasksDir)) return null;
  const num = m[1];
  for (const f of fs.readdirSync(tasksDir)) {
    const fm = f.match(FILE_RE);
    if (fm && fm[1] === num) return path.join(tasksDir, f);
  }
  return null;
}

function readTask(tasksDir, id) {
  const file = findTaskFile(tasksDir, id);
  if (!file) return null;
  const text = fs.readFileSync(file, 'utf8');
  const { fm, body } = parseFrontmatter(text);
  return { file, fm, body, text };
}

function writeTask(file, fm, body) {
  fm.updated = nowIso();
  const text = serializeFrontmatter(fm, body);
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return text;
}

function listTasks(tasksDir) {
  if (!fs.existsSync(tasksDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(tasksDir)) {
    if (!FILE_RE.test(f)) continue;
    const file = path.join(tasksDir, f);
    const text = fs.readFileSync(file, 'utf8');
    const { fm } = parseFrontmatter(text);
    if (!fm || !fm.id) continue;
    out.push({ file, fm });
  }
  out.sort((a, b) => {
    const an = parseInt((a.fm.id.match(ID_RE) || [])[1] || 0, 10);
    const bn = parseInt((b.fm.id.match(ID_RE) || [])[1] || 0, 10);
    return an - bn;
  });
  return out;
}

function createTask(cfg, opts) {
  ensureDir(cfg.tasksDir);
  const num = nextId(cfg.seqFile);
  const id = padId(num);
  const s = slug(opts.title);
  const file = path.join(cfg.tasksDir, `${id}-${s}.md`);
  const fm = {
    id,
    title: opts.title,
    type: opts.type || 'task',
    status: 'open',
    priority: Number.isInteger(opts.priority) ? opts.priority : 2,
    created: nowIso(),
    updated: nowIso(),
    closed: null,
    closed_reason: null,
    claimed_by: null,
    claimed_at: null,
    blocked_by: opts.blocked_by || [],
    discovered_from: opts.discovered_from || null,
    epic: opts.epic || null,
    tags: opts.tags || [],
  };
  const body = opts.body || `# ${opts.title}\n\n## Goal\n\n\n## Current state\n\n\n## Expected result\n\n`;
  writeTask(file, fm, body);
  return { id, file, fm };
}

module.exports = {
  ID_RE, FILE_RE,
  slug, padId, ensureDir, nowIso,
  nextId, findTaskFile, readTask, writeTask, listTasks, createTask,
};
