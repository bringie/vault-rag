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
    if (a === '--') {
      // bare '--' is a stop-parsing separator; everything after is positional.
      positional.push('--');
      for (let j = i + 1; j < argv.length; j++) positional.push(argv[j]);
      break;
    }
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
  const serverOnly = !!args.flags['server-only'];
  if (!serverOnly) {
    fs.writeFileSync(file, fileContent);
    process.stdout.write(`remembered → ${file}\n`);
  }

  if (args.flags['no-sync']) return;
  if (!cfg.apiBase || !cfg.apiToken) {
    if (serverOnly) {
      die('vt: --server-only requires VAULT_RAG_API_URL + VAULT_RAG_API_TOKEN');
    }
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

async function cmdSecrets(cfg, args) {
  if (!cfg.apiBase || !cfg.apiToken) {
    die('secrets: VAULT_RAG_API_URL/DOMAIN + VAULT_RAG_API_TOKEN required');
  }
  const sub = args.positional[0];
  const rest = args.positional.slice(1);
  // C1 (audit 2026-05-17): set/delete/rotate are admin-gated server-side.
  // Pick the admin token when present; fall back to the viewer token so
  // read-only calls (get/list/verify) still work for vt deployments
  // without a separate admin token (those endpoints accept viewer).
  const adminTok = process.env.VAULT_RAG_FLEET_ADMIN_TOKEN || cfg.apiToken;
  const ADMIN_ROUTES = new Set(['/secrets/set', '/secrets/delete', '/secrets/rotate']);
  const apiPost = async (route, body) => {
    const tok = ADMIN_ROUTES.has(route) ? adminTok : cfg.apiToken;
    const url = `${cfg.apiBase.replace(/\/$/, '')}/api${route}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { code: res.status, body: json };
  };

  if (sub === 'get') {
    const name = rest[0];
    if (!name) die('usage: vt secrets get NAME');
    const r = await apiPost('/secrets/get', { name });
    if (r.code !== 200) die(`secrets get: HTTP ${r.code} ${JSON.stringify(r.body)}`);
    process.stdout.write(r.body.value);
    return;
  }
  if (sub === 'list') {
    const r = await apiPost('/secrets/list', {});
    if (r.code !== 200) die(`secrets list: HTTP ${r.code} ${JSON.stringify(r.body)}`);
    for (const n of r.body.names) process.stdout.write(n + '\n');
    return;
  }
  if (sub === 'set') {
    const name = rest[0];
    let value = rest[1];
    if (!name) die('usage: vt secrets set NAME [VALUE]');
    if (value === undefined) {
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      value = await new Promise((r) => rl.question(`value for ${name}: `, (v) => { rl.close(); r(v); }));
    }
    const r = await apiPost('/secrets/set', { name, value });
    if (r.code !== 200) die(`secrets set: HTTP ${r.code} ${JSON.stringify(r.body)}`);
    process.stdout.write(`ok sha=${r.body.committed_sha}\n`);
    return;
  }
  if (sub === 'delete') {
    const name = rest[0];
    if (!name) die('usage: vt secrets delete NAME');
    const r = await apiPost('/secrets/delete', { name });
    if (r.code !== 200) die(`secrets delete: HTTP ${r.code} ${JSON.stringify(r.body)}`);
    process.stdout.write(`ok sha=${r.body.committed_sha}\n`);
    return;
  }
  if (sub === 'rotate') {
    const name = rest[0];
    const value = rest[1] ?? null;
    if (!name) die('usage: vt secrets rotate NAME [VALUE]');
    const r = await apiPost('/secrets/rotate', { name, value });
    if (r.code !== 200) die(`secrets rotate: HTTP ${r.code} ${JSON.stringify(r.body)}`);
    process.stdout.write(`ok sha=${r.body.committed_sha}\n`);
    return;
  }
  if (sub === 'verify') {
    const r = await apiPost('/secrets/verify', {});
    process.stdout.write(JSON.stringify(r.body, null, 2) + '\n');
    return;
  }
  if (sub === 'export-env') {
    const list = await apiPost('/secrets/list', {});
    if (list.code !== 200) die(`secrets list: HTTP ${list.code} ${JSON.stringify(list.body)}`);
    for (const n of list.body.names) {
      if (n.endsWith('_env')) continue;
      const v = await apiPost('/secrets/get', { name: n });
      if (v.code !== 200) {
        process.stderr.write(`# error fetching ${n}: ${JSON.stringify(v.body)}\n`);
        continue;
      }
      process.stdout.write(`export ${n}=${JSON.stringify(v.body.value)}\n`);
    }
    return;
  }
  die('usage: vt secrets {get|list|set|delete|rotate|verify|export-env} ...', 2);
}

async function cmdRemote(cfg, args) {
  if (!cfg.apiBase || !cfg.apiToken) {
    die('remote: VAULT_RAG_API_URL/DOMAIN + VAULT_RAG_API_TOKEN required');
  }
  const sub = args.positional[0];
  const rest = args.positional.slice(1);
  const base = cfg.apiBase.replace(/\/$/, '');
  const wsBase = base.replace(/^http/, 'ws');

  const req = async (method, route, body) => {
    const res = await fetch(`${base}/api${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = { raw: text }; } }
    return { code: res.status, body: json };
  };

  async function listHosts() {
    const r = await req('GET', '/fleet/hosts');
    if (r.code !== 200) die(`hosts: HTTP ${r.code}`);
    if (args.flags.json) { process.stdout.write(JSON.stringify(r.body, null, 2) + '\n'); return; }
    if (!r.body.length) { process.stdout.write('(no hosts)\n'); return; }
    const w = (s, n) => String(s).padEnd(n).slice(0, n);
    for (const h of r.body) {
      const sym = h.status === 'online' ? '●' : '○';
      process.stdout.write(`${sym} ${w(h.name, 16)} ${w(h.id.slice(0, 8), 9)} ${w(h.os || '?', 8)} ${(h.capabilities || []).join(',')}\n`);
    }
  }

  async function listSessions() {
    const q = args.flags.host ? `?host_id=${args.flags.host}` : '';
    const r = await req('GET', `/fleet/sessions${q}`);
    if (r.code !== 200) die(`sessions: HTTP ${r.code}`);
    if (args.flags.json) { process.stdout.write(JSON.stringify(r.body, null, 2) + '\n'); return; }
    const hostsR = await req('GET', '/fleet/hosts');
    const hosts = new Map((hostsR.body || []).map(h => [h.id, h.name]));
    for (const s of r.body) {
      const sym = { running: '▶', exited: '◇', killed: '✕', orphaned: '?', pending: '·' }[s.status] || '·';
      const hostName = hosts.get(s.host_id) || s.host_id.slice(0, 8);
      process.stdout.write(`${sym} ${s.id.slice(0, 8)}  ${String(hostName).padEnd(14)} ${s.status.padEnd(10)} ${s.started_at}\n`);
    }
  }

  async function spawn() {
    const hostName = args.flags.host;
    if (!hostName) die('usage: vt remote run --host=NAME -- <args...>');
    const cwd = args.flags.cwd || process.cwd();
    // split: everything after '--' becomes args
    const dashdash = args.positional.indexOf('--');
    const spawnArgs = dashdash >= 0 ? args.positional.slice(dashdash + 1) : args.positional.slice(1);
    // resolve host name → id
    const hostsR = await req('GET', '/fleet/hosts');
    if (hostsR.code !== 200) die(`hosts lookup: HTTP ${hostsR.code}`);
    const host = (hostsR.body || []).find(h => h.name === hostName || h.id === hostName);
    if (!host) die(`host not found: ${hostName}`);
    if (host.status !== 'online') die(`host ${host.name} is offline`);
    const r = await req('POST', '/fleet/sessions', { host_id: host.id, cwd, args: spawnArgs });
    if (r.code !== 201) die(`spawn: HTTP ${r.code} ${JSON.stringify(r.body)}`);
    const sid = r.body.session_id;
    process.stderr.write(`spawned ${sid} on ${host.name}\n`);
    if (args.flags['no-tail']) { process.stdout.write(sid + '\n'); return; }
    // auto-tail
    await streamSession(sid, /*interactive=*/!!args.flags.interactive);
  }

  async function streamSession(sid, interactive) {
    const WebSocket = require('ws');
    const url = `${wsBase}/api/fleet/ws?role=viewer&session_id=${sid}`;
    const ws = new WebSocket(url, ['bearer.' + cfg.apiToken]);
    let exitCode = 0;
    let isRaw = false;
    function restoreTty() {
      if (isRaw && process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
      try { process.stdin.pause(); } catch {}
    }
    await new Promise((resolve, reject) => {
      ws.on('open', () => {
        if (interactive && process.stdin.isTTY) {
          process.stdin.setRawMode?.(true);
          isRaw = true;
          process.stdin.resume();
          process.stdin.on('data', (chunk) => {
            try { ws.send(JSON.stringify({ type: 'input', data: chunk.toString('binary') })); } catch {}
          });
          // Forward terminal size + resize events
          const sendResize = () => {
            try {
              ws.send(JSON.stringify({ type: 'resize', cols: process.stdout.columns, rows: process.stdout.rows }));
            } catch {}
          };
          sendResize();
          process.stdout.on('resize', sendResize);
          process.on('SIGINT', () => { try { ws.send(JSON.stringify({ type: 'input', data: '' })); } catch {} });
        }
      });
      ws.on('message', (raw) => {
        let f;
        try { f = JSON.parse(raw.toString()); } catch { return; }
        if (f.type === 'pty_data' || f.type === 'backfill') {
          try { process.stdout.write(Buffer.from(f.data, 'base64')); } catch {}
        } else if (f.type === 'session_exit') {
          exitCode = f.exit_code === 0 ? 0 : (f.exit_code || 1);
          process.stderr.write(`\n[session ${sid.slice(0,8)} exit=${f.exit_code}]\n`);
          try { ws.close(); } catch {}
        }
      });
      ws.on('close', () => { restoreTty(); resolve(); });
      ws.on('error', (e) => { restoreTty(); reject(e); });
    });
    process.exit(exitCode);
  }

  async function transcript(sid) {
    const r = await fetch(`${base}/api/fleet/sessions/${sid}/transcript.txt`, {
      headers: { Authorization: `Bearer ${cfg.apiToken}` },
    });
    if (r.status !== 200) die(`transcript: HTTP ${r.status}`);
    process.stdout.write(await r.text());
  }

  async function killSession(sid) {
    const r = await req('POST', `/fleet/sessions/${sid}/kill`, {});
    if (r.code !== 204 && r.code !== 200) die(`kill: HTTP ${r.code}`);
    process.stderr.write(`killed ${sid}\n`);
  }

  if (sub === 'hosts')      return listHosts();
  if (sub === 'ls' || sub === 'list' || sub === 'sessions') return listSessions();
  if (sub === 'run')        return spawn();
  if (sub === 'attach')     return streamSession(rest[0] || die('usage: vt remote attach <id>'), true);
  if (sub === 'tail')       return streamSession(rest[0] || die('usage: vt remote tail <id>'), false);
  if (sub === 'cat')        return transcript(rest[0] || die('usage: vt remote cat <id>'));
  if (sub === 'kill')       return killSession(rest[0] || die('usage: vt remote kill <id>'));
  die(`unknown remote subcommand: ${sub || '(missing)'}\nUsage: vt remote {hosts|ls|run|attach|tail|cat|kill}`);
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
  vt remember "note" [--tags a,b] [--no-sync] [--quiet] [--server-only]
                                           Save note → 06-resources/notes/, then auto-sync to prod
                                           via /api/put (requires VAULT_RAG_API_URL + _TOKEN env).
                                           --server-only: skip local write, push to brain only
                                           (brain commits + pushes; avoids local/brain race).
  vt secrets {get|list|set|delete|rotate|verify|export-env}
                                           Manage encrypted secrets via /api/secrets/*.
                                           See docs/superpowers/agent-onboarding-secrets.md.
  vt remote {hosts|ls|run|attach|tail|cat|kill}
                                           Drive agent-fleet sessions on remote hosts via REST/WS.
                                           Examples:
                                             vt remote hosts
                                             vt remote run --host=mac1 -- claude -p "fix bug X"
                                             vt remote attach <session_id>    # interactive
                                             vt remote tail   <session_id>    # read-only stream
                                             vt remote cat    <session_id>    # full transcript
                                             vt remote kill   <session_id>
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

// vt-0218: doctor — diagnostics for a fresh install. Each check returns
// {name, status: 'ok'|'warn'|'error', detail}. Prints a traffic-light
// summary, exits non-zero if any are 'error' (CI-friendly).
async function cmdDoctor(_cfg, args) {
  const checks = [];
  function check(name, status, detail) { checks.push({ name, status, detail }); }
  const fs = require('fs');
  const path = require('path');
  const https = require('https');

  // .env presence + key set
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    check('.env', 'warn', 'no .env in cwd (using shell env only)');
  } else {
    const env = fs.readFileSync(envPath, 'utf8');
    const has = (k) => new RegExp(`^${k}=.+`, 'm').test(env);
    const need = ['VAULT_RAG_API_URL', 'VAULT_RAG_API_TOKEN'];
    const missing = need.filter(k => !has(k) && !process.env[k]);
    if (missing.length) check('.env vars', 'error', `missing: ${missing.join(', ')}`);
    else check('.env vars', 'ok', `${need.join(', ')} all present`);
  }

  // API reachable
  const apiUrl = process.env.VAULT_RAG_API_URL || process.env.VT_API_BASE;
  const apiTok = process.env.VAULT_RAG_API_TOKEN || process.env.VT_API_TOKEN;
  if (!apiUrl || !apiTok) {
    check('hub /readyz', 'error', 'VAULT_RAG_API_URL/_TOKEN not set');
  } else {
    try {
      const res = await new Promise((resolve, reject) => {
        const req = https.request(`${apiUrl}/api/readyz`, { method: 'GET' }, (r) => {
          const chunks = []; r.on('data', c => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('timeout')));
        req.end();
      });
      if (res.status === 200) check('hub /readyz', 'ok', '200 — all subsystems ready');
      else check('hub /readyz', 'error', `${res.status}: ${res.body.slice(0, 200)}`);
    } catch (e) {
      check('hub /readyz', 'error', e.message);
    }
  }

  // secrets reachable
  if (apiUrl && apiTok) {
    try {
      const res = await new Promise((resolve, reject) => {
        const req = https.request(`${apiUrl}/api/secrets/list`, {
          method: 'POST',
          headers: { 'authorization': `Bearer ${apiTok}`, 'content-type': 'application/json' },
        }, (r) => {
          const chunks = []; r.on('data', c => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('timeout')));
        req.write('{}'); req.end();
      });
      if (res.status === 200) {
        const n = (JSON.parse(res.body).names || []).length;
        check('secrets backend', 'ok', `${n} secrets visible`);
      } else if (res.status === 401) {
        check('secrets backend', 'error', '401 — token rejected');
      } else {
        check('secrets backend', 'warn', `${res.status}: ${res.body.slice(0, 100)}`);
      }
    } catch (e) { check('secrets backend', 'error', e.message); }
  }

  // vault dir (for vt task ops)
  try {
    const { resolveConfig } = { resolveConfig: () => null };  // best-effort
    const vaultDir = process.env.VT_VAULT_DIR || process.env.VAULT_DIR;
    if (vaultDir && fs.existsSync(vaultDir)) {
      check('vault dir', 'ok', vaultDir);
    } else {
      check('vault dir', 'warn', `not found (set VT_VAULT_DIR)`);
    }
  } catch (e) { check('vault dir', 'warn', e.message); }

  // node version
  const major = parseInt(process.version.replace('v', '').split('.')[0], 10);
  if (major >= 20) check('node version', 'ok', process.version);
  else check('node version', 'warn', `${process.version} (recommend ≥20)`);

  // Print
  const W = Math.max(...checks.map(c => c.name.length)) + 2;
  const glyph = { ok: '\x1b[32m●\x1b[0m', warn: '\x1b[33m◐\x1b[0m', error: '\x1b[31m✕\x1b[0m' };
  console.log('vt doctor:');
  for (const c of checks) {
    console.log(`  ${glyph[c.status] || '?'} ${c.name.padEnd(W)} ${c.detail || ''}`);
  }
  const errors = checks.filter(c => c.status === 'error').length;
  if (errors) {
    console.log(`\n${errors} error(s) — fix above and re-run.`);
    process.exit(1);
  }
  console.log('\nAll critical checks passed.');
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
  secrets: cmdSecrets,
  remote: cmdRemote,
  doctor: cmdDoctor,           // vt-0218
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
  if (cmd === 'secrets' || cmd === 'remote') {
    // secrets/remote subcommands only need apiBase/apiToken — no vault directory.
    cfg = {
      apiBase: process.env.VT_API_BASE
        || process.env.VAULT_RAG_API_URL
        || (process.env.VAULT_RAG_DOMAIN ? `https://${process.env.VAULT_RAG_DOMAIN}` : null),
      apiToken: process.env.VT_API_TOKEN || process.env.VAULT_RAG_API_TOKEN,
    };
  } else {
    try { cfg = resolveConfig(); } catch (e) { die(e.message); }
  }
  const args = parseArgs(argv.slice(1));
  try {
    await fn(cfg, args);
  } catch (e) {
    die(e.stack || e.message);
  }
}

main();
