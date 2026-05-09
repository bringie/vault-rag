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
  let res;
  try {
    res = await fetch(`${c.url}/api/task/${route}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  } catch (e) { die(`network: ${e.message}`); }
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
