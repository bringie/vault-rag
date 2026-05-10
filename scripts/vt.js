#!/usr/bin/env node
// vt: vault-task CLI. Replaces beads. Tasks live as markdown in obsidian-vault/04-tasks/.

const fs = require('fs');
const path = require('path');
const { resolveConfig } = require('./lib/vt-config');
const {
  ID_RE, slug, padId, nowIso, ensureDir,
  findTaskFile, readTask, writeTask, listTasks, createTask,
} = require('./lib/vt-fs');
const { readyTasks, blockingChain } = require('./lib/vt-graph');

function die(msg, code = 1) {
  process.stderr.write(`vt: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
        else { flags[a.slice(2)] = next; i++; }
      }
    } else if (a.startsWith('-') && a.length > 1) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) flags[a.slice(1)] = true;
      else { flags[a.slice(1)] = next; i++; }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function fmt(t) {
  const pri = t.fm.priority ?? 2;
  const blocked = (t.fm.blocked_by || []).length;
  const claim = t.fm.claimed_by ? ` @${t.fm.claimed_by}` : '';
  const epic = t.fm.epic ? ` epic=${t.fm.epic}` : '';
  const dep = blocked ? ` blocked_by=${blocked}` : '';
  return `${t.fm.id}  [${t.fm.status.padEnd(11)}] p${pri} ${t.fm.type.padEnd(5)} ${t.fm.title}${claim}${epic}${dep}`;
}

function cmdCreate(cfg, args) {
  const { flags, positional } = args;
  const title = positional.join(' ').trim();
  if (!title) die('create: title required. usage: vt create -t task -p 1 "Title"');
  const type = flags.t || flags.type || 'task';
  const priority = flags.p !== undefined ? parseInt(flags.p, 10) : (flags.priority !== undefined ? parseInt(flags.priority, 10) : 2);
  const epic = flags.epic || null;
  const blocked_by = flags['blocked-by']
    ? String(flags['blocked-by']).split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const tags = flags.tags ? String(flags.tags).split(',').map(s => s.trim()).filter(Boolean) : [];
  const body = flags.body || flags.b || null;
  const t = createTask(cfg, { title, type, priority, epic, blocked_by, tags, body });
  process.stdout.write(`${t.id}\t${t.file}\n`);
}

function cmdList(cfg, args) {
  const { flags } = args;
  const tasks = listTasks(cfg.tasksDir);
  let filtered = tasks;
  if (flags.status) {
    const set = new Set(String(flags.status).split(',').map(s => s.trim()));
    filtered = filtered.filter(t => set.has(t.fm.status));
  } else if (!flags.all) {
    filtered = filtered.filter(t => t.fm.status !== 'closed');
  }
  if (flags.type) {
    const set = new Set(String(flags.type).split(',').map(s => s.trim()));
    filtered = filtered.filter(t => set.has(t.fm.type));
  }
  if (flags.epic) filtered = filtered.filter(t => t.fm.epic === flags.epic);
  if (flags.mine) filtered = filtered.filter(t => t.fm.claimed_by === cfg.agentId);
  if (flags.json) {
    process.stdout.write(JSON.stringify(filtered.map(t => t.fm), null, 2) + '\n');
    return;
  }
  if (!filtered.length) { process.stdout.write('(no tasks)\n'); return; }
  for (const t of filtered) process.stdout.write(fmt(t) + '\n');
}

function cmdShow(cfg, args) {
  const id = args.positional[0];
  if (!id) die('show: id required');
  const t = readTask(cfg.tasksDir, id);
  if (!t) die(`show: ${id} not found`);
  if (args.flags.json) {
    process.stdout.write(JSON.stringify({ ...t.fm, body: t.body, file: t.file }, null, 2) + '\n');
  } else {
    process.stdout.write(t.text);
  }
}

function cmdReady(cfg, args) {
  const tasks = listTasks(cfg.tasksDir);
  const ready = readyTasks(tasks);
  if (args.flags.json) {
    process.stdout.write(JSON.stringify(ready.map(t => t.fm), null, 2) + '\n');
    return;
  }
  if (!ready.length) { process.stdout.write('(no ready tasks)\n'); return; }
  for (const t of ready) process.stdout.write(fmt(t) + '\n');
}

function cmdClaim(cfg, args) {
  const id = args.positional[0];
  if (!id) die('claim: id required');
  const t = readTask(cfg.tasksDir, id);
  if (!t) die(`claim: ${id} not found`);
  const by = args.flags.by || cfg.agentId;
  if (t.fm.claimed_by && t.fm.claimed_by !== by && t.fm.status === 'in_progress') {
    if (!args.flags.force) die(`claim: ${id} already claimed by ${t.fm.claimed_by} (use --force)`);
  }
  t.fm.claimed_by = by;
  t.fm.claimed_at = nowIso();
  t.fm.status = 'in_progress';
  writeTask(t.file, t.fm, t.body);
  process.stdout.write(`claimed ${id} by ${by}\n`);
}

function cmdUpdate(cfg, args) {
  const id = args.positional[0];
  if (!id) die('update: id required');
  const t = readTask(cfg.tasksDir, id);
  if (!t) die(`update: ${id} not found`);
  let changed = 0;
  const f = args.flags;
  const setIf = (key, val) => { if (val !== undefined) { t.fm[key] = val; changed++; } };
  if (f.status) {
    const valid = ['open', 'in_progress', 'blocked', 'done', 'closed'];
    if (!valid.includes(f.status)) die(`update: bad status ${f.status} (valid: ${valid.join(',')})`);
    t.fm.status = f.status; changed++;
  }
  if (f.priority !== undefined) { t.fm.priority = parseInt(f.priority, 10); changed++; }
  if (f.title) { t.fm.title = f.title; changed++; }
  if (f.epic !== undefined) setIf('epic', f.epic === 'null' ? null : f.epic);
  if (f.tags !== undefined) { t.fm.tags = String(f.tags).split(',').map(s => s.trim()).filter(Boolean); changed++; }
  if (f.body !== undefined) {
    if (f.body === '-') t.body = fs.readFileSync(0, 'utf8');
    else t.body = f.body;
    changed++;
  }
  if (!changed) die('update: nothing to change');
  writeTask(t.file, t.fm, t.body);
  process.stdout.write(`updated ${id}\n`);
}

function cmdClose(cfg, args) {
  const id = args.positional[0];
  if (!id) die('close: id required');
  const t = readTask(cfg.tasksDir, id);
  if (!t) die(`close: ${id} not found`);
  t.fm.status = 'closed';
  t.fm.closed = nowIso();
  t.fm.closed_reason = args.flags.reason || args.flags.r || 'Done';
  writeTask(t.file, t.fm, t.body);
  process.stdout.write(`closed ${id}\n`);
}

function cmdDep(cfg, args) {
  const sub = args.positional[0];
  const id = args.positional[1];
  if (!sub || !['add', 'rm'].includes(sub)) die('dep: usage: vt dep add|rm <id> --blocked-by <other>');
  if (!id) die('dep: id required');
  const t = readTask(cfg.tasksDir, id);
  if (!t) die(`dep: ${id} not found`);
  const other = args.flags['blocked-by'] || args.flags.blockedBy;
  if (!other) die('dep: --blocked-by <other-id> required');
  t.fm.blocked_by = t.fm.blocked_by || [];
  if (sub === 'add') {
    if (!t.fm.blocked_by.includes(other)) t.fm.blocked_by.push(other);
  } else {
    t.fm.blocked_by = t.fm.blocked_by.filter(x => x !== other);
  }
  writeTask(t.file, t.fm, t.body);
  process.stdout.write(`dep ${sub} ${id} blocked_by ${other}\n`);
}

async function cmdSearch(cfg, args) {
  const q = args.positional.join(' ').trim();
  if (!q) die('search: query required');
  if (!cfg.apiBase || !cfg.apiToken) die('search: VAULT_RAG_API_URL/DOMAIN + VAULT_RAG_API_TOKEN required');
  const k = parseInt(args.flags.limit || args.flags.k || '10', 10);
  const url = `${cfg.apiBase.replace(/\/$/, '')}/api/search`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: q, k }),
  });
  if (!res.ok) die(`search: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (args.flags.json) { process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return; }
  const items = data.results || data.matches || data;
  if (!Array.isArray(items)) { process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return; }
  for (const it of items) {
    const score = it.score !== undefined ? `[${Number(it.score).toFixed(3)}]` : '';
    process.stdout.write(`${score} ${it.path || it.id || ''}\n`);
    if (it.snippet || it.content) {
      const s = (it.snippet || it.content).replace(/\s+/g, ' ').slice(0, 160);
      process.stdout.write(`    ${s}\n`);
    }
  }
}

async function cmdRemember(cfg, args) {
  const text = args.positional.join(' ').trim();
  if (!text) die('remember: note text required');
  ensureDir(cfg.notesDir);
  const date = new Date().toISOString().slice(0, 10);
  const titleLine = text.split('\n')[0].slice(0, 80);
  const fname = `${date}-${slug(titleLine)}.md`;
  const file = path.join(cfg.notesDir, fname);
  const tags = args.flags.tags ? String(args.flags.tags).split(',').map(s => s.trim()) : [];
  const fm = `---\ntype: note\ncreated: ${nowIso()}\ntags: ${JSON.stringify(tags)}\n---\n`;
  const body = `# ${titleLine}\n\n${text}\n`;
  const fileContent = fm + body;
  fs.writeFileSync(file, fileContent);
  process.stdout.write(`remembered → ${file}\n`);

  if (args.flags['no-sync']) return;
  if (!cfg.apiBase || !cfg.apiToken) {
    if (!args.flags.quiet) {
      process.stderr.write(`vt: local-only (no VAULT_RAG_API_URL/TOKEN — note NOT pushed to prod)\n`);
    }
    return;
  }
  const relPath = path.relative(cfg.vaultDir, file).split(path.sep).join('/');
  const url = `${cfg.apiBase.replace(/\/$/, '')}/api/put`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: relPath, content: fileContent, mode: 'upsert' }),
    });
    if (!res.ok) {
      process.stderr.write(`vt: prod sync failed: HTTP ${res.status} ${await res.text()}\n`);
      return;
    }
    const data = await res.json();
    process.stdout.write(`synced → ${cfg.apiBase}/api/get?path=${encodeURIComponent(relPath)} (chunks=${data.chunks ?? '?'})\n`);
  } catch (e) {
    process.stderr.write(`vt: prod sync error: ${e.message}\n`);
  }
}

function cmdPrime() {
  const help = `vt - vault-task CLI. Tasks as markdown in obsidian-vault/04-tasks/.

Commands:
  vt create -t task|epic|bug -p N "Title"  Create task. Returns vt-NNNN.
  vt list [--status open] [--type task] [--epic vt-X] [--mine] [--json] [--all]
  vt show <id> [--json]
  vt ready [--json]                        Open tasks not blocked by active deps.
  vt claim <id> [--by AGENT] [--force]     status=in_progress + claimed_by.
  vt update <id> --status|--priority|--title|--epic|--tags|--body=-
  vt close <id> --reason "..."
  vt dep add|rm <id> --blocked-by <other>
  vt search <query> [--limit N] [--json]   Vector search via /api/search (POST + Bearer).
  vt remember "note" [--tags a,b] [--no-sync] [--quiet]
                                           Save note → 06-resources/notes/, then auto-sync to prod
                                           via /api/put (requires VAULT_RAG_API_URL + _TOKEN env).
  vt prime                                  This help.

Workflow:
  1. vt ready                    pick unblocked work
  2. vt claim <id>               mark in_progress
  3. <do work, commit code>
  4. vt close <id> --reason "..."

Frontmatter schema:
  id, title, type (task|epic|bug), status (open|in_progress|blocked|done|closed),
  priority (0-3), created, updated, closed, closed_reason, claimed_by, claimed_at,
  blocked_by[], discovered_from, epic, tags[]

Storage: obsidian-vault/04-tasks/vt-NNNN-slug.md
Counter: obsidian-vault/.vt/seq (atomic O_EXCL lock)
`;
  process.stdout.write(help);
}

const COMMANDS = {
  create: cmdCreate,
  list: cmdList,
  ls: cmdList,
  show: cmdShow,
  ready: cmdReady,
  claim: cmdClaim,
  update: cmdUpdate,
  close: cmdClose,
  dep: cmdDep,
  search: cmdSearch,
  remember: cmdRemember,
  prime: cmdPrime,
  help: cmdPrime,
  '--help': cmdPrime,
  '-h': cmdPrime,
};

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd) { cmdPrime(); process.exit(0); }
  const fn = COMMANDS[cmd];
  if (!fn) die(`unknown command: ${cmd}. Run 'vt prime' for help.`, 2);
  if (cmd === 'prime' || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    fn();
    return;
  }
  let cfg;
  try { cfg = resolveConfig(); } catch (e) { die(e.message); }
  const args = parseArgs(argv.slice(1));
  try {
    await fn(cfg, args);
  } catch (e) {
    die(e.stack || e.message);
  }
}

main();
