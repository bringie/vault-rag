'use strict';
// fleet-routes: HTTP + WS handlers for agent-fleet. Mounted by rag-api.js.

const { WebSocketServer } = require('ws');
const fleetDb = require('./fleet-db');
const fleetStatic = require('./fleet-static');
const fleetCost = require('./fleet-cost');
const { RingBuffer } = require('./fleet-ring-buffer');
const { EventBatcher } = require('./fleet-event-batcher');

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => buf += c);
    req.on('end', () => {
      if (!buf) return resolve(null);
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function checkAuth(req, token) {
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${token}`;
}

function pathMatch(url, prefix) {
  const path = url.split('?')[0];
  if (!path.startsWith(prefix + '/')) return null;
  return path.slice(prefix.length + 1);
}

const SID_RE = '[0-9a-f-]{36}';

function makeBus() {
  const daemonsByHost = new Map();          // host_id -> ws
  const viewersBySession = new Map();       // session_id -> Set<ws>
  const hooksBySession = new Map();         // session_id -> Set<fn(frame)>
  const pendingFileReqs = new Map();        // req_id -> {resolve, reject, timer}
  return {
    registerDaemon(hostId, ws) {
      const prev = daemonsByHost.get(hostId);
      if (prev && prev !== ws) try { prev.close(4004, 'replaced'); } catch {}
      daemonsByHost.set(hostId, ws);
      ws.on('close', () => { if (daemonsByHost.get(hostId) === ws) daemonsByHost.delete(hostId); });
    },
    getDaemon(hostId) { return daemonsByHost.get(hostId); },
    addViewer(sessionId, ws) {
      let set = viewersBySession.get(sessionId);
      if (!set) { set = new Set(); viewersBySession.set(sessionId, set); }
      set.add(ws);
      ws.on('close', () => { set.delete(ws); if (!set.size) viewersBySession.delete(sessionId); });
    },
    broadcastViewers(sessionId, frame) {
      const set = viewersBySession.get(sessionId);
      if (set) {
        const payload = JSON.stringify(frame);
        for (const v of set) {
          try { v.send(payload); } catch {}
        }
      }
      const hooks = hooksBySession.get(sessionId);
      if (hooks) {
        for (const fn of hooks) {
          try { fn(frame); } catch {}
        }
      }
    },
    subscribeViewerHook(sessionId, fn) {
      let set = hooksBySession.get(sessionId);
      if (!set) { set = new Set(); hooksBySession.set(sessionId, set); }
      set.add(fn);
    },
    unsubscribeViewerHook(sessionId, fn) {
      const set = hooksBySession.get(sessionId);
      if (!set) return;
      set.delete(fn);
      if (!set.size) hooksBySession.delete(sessionId);
    },
    requestSpawn(hostId, payload) {
      const d = daemonsByHost.get(hostId);
      if (!d) return false;
      try { d.send(JSON.stringify({ type: 'spawn', ...payload })); return true; } catch { return false; }
    },
    sendInput(sessionId, hostId, dataStr) {
      const d = daemonsByHost.get(hostId);
      if (!d) return false;
      try { d.send(JSON.stringify({ type: 'input', session_id: sessionId, data: dataStr })); return true; } catch { return false; }
    },
    sendKill(sessionId, hostId, signal) {
      const d = daemonsByHost.get(hostId);
      if (!d) return false;
      try { d.send(JSON.stringify({ type: 'kill', session_id: sessionId, signal })); return true; } catch { return false; }
    },
    // Request file read/write from a daemon. Returns a Promise resolved by file_data/file_ok
    // frame, or rejected on timeout / file_err.
    async fileOp(hostId, op, path, content) {
      const d = daemonsByHost.get(hostId);
      if (!d) throw new Error('host offline');
      const req_id = Math.random().toString(36).slice(2);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingFileReqs.delete(req_id);
          reject(new Error('daemon timeout'));
        }, 5000);
        pendingFileReqs.set(req_id, { resolve, reject, timer });
        try {
          d.send(JSON.stringify({ type: op, req_id, path, content }));
        } catch (e) {
          clearTimeout(timer);
          pendingFileReqs.delete(req_id);
          reject(e);
        }
      });
    },
    resolveFileReq(req_id, payload, isError) {
      const p = pendingFileReqs.get(req_id);
      if (!p) return;
      clearTimeout(p.timer);
      pendingFileReqs.delete(req_id);
      if (isError) p.reject(new Error(payload.error || 'unknown')); else p.resolve(payload);
    },
  };
}

// --- HTTP handlers ---

async function handleGetHosts({ res, ctx }) {
  const rows = await fleetDb.listHosts(ctx.db);
  send(res, 200, rows);
}

async function handleGetHost({ req, res, ctx }) {
  const id = pathMatch(req.url, '/fleet/hosts');
  const h = await fleetDb.getHost(ctx.db, id);
  if (!h) return send(res, 404, { error: 'host not found' });
  send(res, 200, h);
}

async function handleDeleteHost({ req, res, ctx }) {
  const id = pathMatch(req.url, '/fleet/hosts');
  await fleetDb.deleteHost(ctx.db, id);
  res.writeHead(204); res.end();
}

async function handlePatchHost({ req, res, body, ctx }) {
  const id = pathMatch(req.url, '/fleet/hosts');
  if (!body) return send(res, 422, { error: 'body required' });
  const patch = {};
  if ('display_name' in body) patch.display_name = body.display_name;
  if ('capabilities' in body) {
    if (!Array.isArray(body.capabilities)) return send(res, 422, { error: 'capabilities must be array of strings' });
    patch.capabilities = body.capabilities.map(String).filter(Boolean);
  }
  const updated = await fleetDb.updateHost(ctx.db, id, patch);
  if (!updated) return send(res, 404, { error: 'host not found' });
  send(res, 200, updated);
}

// Synchronous "ask claude on host X" — spawns claude --print, waits for exit,
// returns transcript text + cost. Convenient for API consumers that just want
// a prompt → answer roundtrip without managing websockets.
async function handleExec({ req, res, body, ctx }) {
  if (!body) return send(res, 422, { error: 'body required' });
  const { tag, host_name, host_id, prompt, model, timeout_ms, cwd } = body;
  if (!prompt || typeof prompt !== 'string') return send(res, 422, { error: 'prompt (string) required' });
  if (!tag && !host_name && !host_id) {
    return send(res, 422, { error: 'one of tag|host_name|host_id required' });
  }
  // Reuse dispatch routing logic
  const all = await fleetDb.listHosts(ctx.db);
  let candidates = all.filter(h => h.status === 'online');
  if (host_id)   candidates = candidates.filter(h => h.id === host_id);
  if (host_name) candidates = candidates.filter(h => h.name === host_name || h.display_name === host_name);
  if (tag)       candidates = candidates.filter(h => (h.capabilities || []).includes(tag));
  if (!candidates.length) return send(res, 404, { error: 'no online host matches' });
  const sessions = await fleetDb.listSessions(ctx.db, { status: 'running' });
  const busyByHost = {};
  for (const s of sessions) busyByHost[s.host_id] = (busyByHost[s.host_id] || 0) + 1;
  candidates.sort((a, b) => (busyByHost[a.id] || 0) - (busyByHost[b.id] || 0));
  const host = candidates[0];

  const args = ['--print'];
  if (model) args.push('--model', String(model));
  args.push(prompt);
  const s = await fleetDb.createSession(ctx.db, {
    hostId: host.id, cwd: cwd || '~',
    args, env: {},
    createdBy: 'exec',
    label: prompt.slice(0, 80),
    metadata: { exec: true },
  });
  if (!ctx.bus.requestSpawn(host.id, { session_id: s.id, cwd: s.cwd, args: s.args, env: {} })) {
    return send(res, 502, { error: 'daemon vanished mid-dispatch' });
  }
  // Subscribe to session_exit
  const TIMEOUT = Math.min(Math.max(parseInt(timeout_ms || 120000, 10), 5000), 600000);
  let finished = false;
  const result = await new Promise(async (resolve) => {
    const handler = (frame) => {
      if (frame.type === 'session_exit') { finished = true; resolve({ exitCode: frame.exit_code }); }
    };
    ctx.bus.subscribeViewerHook(s.id, handler);
    setTimeout(() => {
      if (!finished) {
        ctx.bus.unsubscribeViewerHook(s.id, handler);
        ctx.bus.sendKill(s.id, host.id, 'SIGTERM');
        resolve({ exitCode: -1, timeout: true });
      }
    }, TIMEOUT).unref?.();
  });
  // Read transcript (batcher flush already triggered by session_exit)
  const rows = await fleetDb.readTranscript(ctx.db, s.id, { sinceSeq: 0, kind: 'pty_out' });
  const raw = Buffer.concat(rows.map(r => r.payload || Buffer.alloc(0))).toString('utf8');
  const text = stripAnsi(raw);
  let cost = null;
  if (ctx.tokmonDb) {
    try { cost = await fleetCost.sessionCost(ctx.tokmonDb, host.name, s.started_at, new Date(), s.id); }
    catch {}
  }
  send(res, 200, {
    session_id: s.id,
    host_id: host.id, host_name: host.name, display_name: host.display_name,
    exit_code: result.exitCode,
    timeout: !!result.timeout,
    output: text,
    cost,
  });
}

async function handleDispatch({ req, res, body, ctx }) {
  if (!body) return send(res, 422, { error: 'body required' });
  const { tag, host_name, host_id, cwd, args, env, label, metadata } = body;
  if (!tag && !host_name && !host_id) {
    return send(res, 422, { error: 'one of tag|host_name|host_id required' });
  }
  // Resolve candidate hosts
  const all = await fleetDb.listHosts(ctx.db);
  let candidates = all.filter(h => h.status === 'online');
  if (host_id)   candidates = candidates.filter(h => h.id === host_id);
  if (host_name) candidates = candidates.filter(h => h.name === host_name || h.display_name === host_name);
  if (tag)       candidates = candidates.filter(h => (h.capabilities || []).includes(tag));
  if (!candidates.length) return send(res, 404, { error: 'no online host matches the criteria' });
  // Pick least-busy (running sessions ascending) as a small UX win.
  const sessions = await fleetDb.listSessions(ctx.db, { status: 'running' });
  const busyByHost = {};
  for (const s of sessions) busyByHost[s.host_id] = (busyByHost[s.host_id] || 0) + 1;
  candidates.sort((a, b) => (busyByHost[a.id] || 0) - (busyByHost[b.id] || 0));
  const host = candidates[0];
  const s = await fleetDb.createSession(ctx.db, {
    hostId: host.id, cwd: cwd || '~',
    args: args || [], env: env || {},
    createdBy: 'dispatch',
    label: label || null, metadata: metadata || {},
  });
  if (ctx.bus) {
    ctx.bus.requestSpawn(host.id, { session_id: s.id, cwd: s.cwd, args: s.args, env: s.env });
  }
  send(res, 201, { session_id: s.id, host_id: host.id, host_name: host.name, display_name: host.display_name });
}

async function handleListSessions({ req, res, ctx }) {
  const url = new URL(req.url, 'http://x');
  const filter = {
    hostId: url.searchParams.get('host_id') || undefined,
    status: url.searchParams.get('status') || undefined,
    since:  url.searchParams.get('since')   || undefined,
    until:  url.searchParams.get('until')   || undefined,
    query:  url.searchParams.get('q')       || undefined,
    limit:  parseInt(url.searchParams.get('limit') || '100', 10),
    offset: parseInt(url.searchParams.get('offset') || '0', 10),
  };
  if (url.searchParams.get('with_count') === '1') {
    const [rows, total] = await Promise.all([
      fleetDb.listSessions(ctx.db, filter),
      fleetDb.countSessions(ctx.db, filter),
    ]);
    send(res, 200, { rows, total, limit: filter.limit, offset: filter.offset });
  } else {
    const rows = await fleetDb.listSessions(ctx.db, filter);
    send(res, 200, rows);
  }
}

async function handlePatchSession({ req, res, body, ctx }) {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(new RegExp(`^/fleet/sessions/(${SID_RE})$`, 'i'));
  if (!m) return send(res, 404, { error: 'not found' });
  if (!body) return send(res, 422, { error: 'body required' });
  const patch = {};
  if ('notes' in body) patch.notes = body.notes;
  if ('label' in body) patch.label = body.label;
  const s = await fleetDb.updateSession(ctx.db, m[1], patch);
  if (!s) return send(res, 404, { error: 'session not found' });
  send(res, 200, s);
}

async function handleBroadcast({ req, res, body, ctx }) {
  if (!body) return send(res, 422, { error: 'body required' });
  const { tag, cwd, args, env, label, metadata } = body;
  if (!tag && !body.all) return send(res, 422, { error: 'tag or all=true required' });
  const all = await fleetDb.listHosts(ctx.db);
  let candidates = all.filter(h => h.status === 'online');
  if (tag) candidates = candidates.filter(h => (h.capabilities || []).includes(tag));
  if (!candidates.length) return send(res, 404, { error: 'no matching online hosts' });
  const results = [];
  for (const host of candidates) {
    try {
      const s = await fleetDb.createSession(ctx.db, {
        hostId: host.id, cwd: cwd || '~',
        args: args || [], env: env || {},
        createdBy: 'broadcast',
        label: label || (tag ? `bcast:${tag}` : 'bcast:all'),
        metadata: { ...(metadata || {}), broadcast: true, tag: tag || null },
      });
      if (ctx.bus) ctx.bus.requestSpawn(host.id, { session_id: s.id, cwd: s.cwd, args: s.args, env: s.env });
      results.push({ session_id: s.id, host_id: host.id, host_name: host.name, display_name: host.display_name, ok: true });
    } catch (e) {
      results.push({ host_id: host.id, host_name: host.name, ok: false, error: e.message });
    }
  }
  send(res, 201, { count: results.length, results });
}

async function handleCostTimeline({ req, res, ctx }) {
  if (!ctx.tokmonDb) return send(res, 503, { error: 'cost data unavailable' });
  const url = new URL(req.url, 'http://x');
  const days = parseInt(url.searchParams.get('days') || '7', 10);
  const hosts = await fleetDb.listHosts(ctx.db);
  const rows = await fleetCost.timeline(ctx.tokmonDb, hosts.map(h => h.name), days);
  send(res, 200, { days, points: rows });
}

async function handleSessionTimeline({ req, res, ctx }) {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(new RegExp(`^/fleet/sessions/(${SID_RE})/timeline$`, 'i'));
  if (!m) return send(res, 404, { error: 'not found' });
  const sid = m[1];
  const s = await fleetDb.getSession(ctx.db, sid);
  if (!s) return send(res, 404, { error: 'session not found' });
  // Build a lifecycle timeline from the session row + lifecycle events.
  const { rows: lc } = await ctx.db.query(
    `SELECT ts, payload FROM fleet_events
     WHERE session_id = $1 AND kind = 'lifecycle'
     ORDER BY ts`, [sid]);
  const events = [
    { ts: s.started_at, kind: 'created', detail: { cwd: s.cwd, args: s.args, created_by: s.created_by } },
  ];
  if (s.pid != null) events.push({ ts: s.started_at, kind: 'spawned', detail: { pid: s.pid } });
  for (const r of lc) {
    let detail = null;
    try { detail = JSON.parse((r.payload || Buffer.alloc(0)).toString('utf8')); } catch {}
    events.push({ ts: r.ts, kind: 'lifecycle', detail });
  }
  if (s.ended_at) events.push({ ts: s.ended_at, kind: s.status, detail: { exit_code: s.exit_code } });
  send(res, 200, { session_id: sid, status: s.status, events });
}

async function handleCreateSession({ body, res, ctx }) {
  if (!body || !body.host_id) return send(res, 422, { error: 'host_id required' });
  if (!body.cwd) return send(res, 422, { error: 'cwd required' });
  const host = await fleetDb.getHost(ctx.db, body.host_id);
  if (!host) return send(res, 422, { error: 'host_id not found' });
  const s = await fleetDb.createSession(ctx.db, {
    hostId: body.host_id, cwd: body.cwd,
    args: body.args, env: body.env,
    createdBy: body.created_by, label: body.label, metadata: body.metadata,
  });
  if (ctx.bus) {
    ctx.bus.requestSpawn(host.id, { session_id: s.id, cwd: s.cwd, args: s.args, env: s.env });
  }
  send(res, 201, { session_id: s.id });
}

async function handleGetSession({ req, res, ctx }) {
  const id = pathMatch(req.url, '/fleet/sessions');
  const s = await fleetDb.getSession(ctx.db, id);
  if (!s) return send(res, 404, { error: 'session not found' });
  send(res, 200, s);
}

async function handlePostInput({ req, res, body, ctx }) {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(new RegExp(`^/fleet/sessions/(${SID_RE})/input$`, 'i'));
  if (!m) return send(res, 404, { error: 'not found' });
  if (!body || typeof body.data !== 'string') return send(res, 422, { error: 'data required' });
  const s = await fleetDb.getSession(ctx.db, m[1]);
  if (!s) return send(res, 404, { error: 'session not found' });
  if (ctx.bus) ctx.bus.sendInput(s.id, s.host_id, body.data);
  res.writeHead(204); res.end();
}

async function handlePostKill({ req, res, body, ctx }) {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(new RegExp(`^/fleet/sessions/(${SID_RE})/kill$`, 'i'));
  if (!m) return send(res, 404, { error: 'not found' });
  const signal = (body && body.signal) || 'SIGTERM';
  const s = await fleetDb.getSession(ctx.db, m[1]);
  if (!s) return send(res, 404, { error: 'session not found' });
  // Orphaned/pending sessions: pty is already gone (daemon restart). Mark dead
  // in DB and broadcast session_exit so any attached viewer unblocks.
  if (s.status === 'orphaned' || s.status === 'pending') {
    await fleetDb.markSessionExited(ctx.db, s.id, -1, 'killed');
    if (ctx.bus) ctx.bus.broadcastViewers(s.id, { type: 'session_exit', exit_code: -1 });
    res.writeHead(204); res.end();
    return;
  }
  if (s.status === 'exited' || s.status === 'killed') {
    res.writeHead(204); res.end();
    return;
  }
  // Running session: forward kill to daemon. If host offline, mark as killed.
  const sent = ctx.bus && ctx.bus.sendKill(s.id, s.host_id, signal);
  if (!sent) {
    await fleetDb.markSessionExited(ctx.db, s.id, -1, 'killed');
    if (ctx.bus) ctx.bus.broadcastViewers(s.id, { type: 'session_exit', exit_code: -1 });
  }
  res.writeHead(204); res.end();
}

async function handleCleanupSessions({ req, res, body, ctx }) {
  const url = new URL(req.url, 'http://x');
  const olderThan = (body && body.older_than) || url.searchParams.get('older_than') || '1 hour';
  const n = await fleetDb.deleteClosedSessions(ctx.db, olderThan);
  send(res, 200, { deleted: n, older_than: olderThan });
}

async function handleHostFileGet({ req, res, ctx }) {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(new RegExp(`^/fleet/hosts/(${SID_RE})/file$`, 'i'));
  if (!m) return send(res, 404, { error: 'not found' });
  const pathName = url.searchParams.get('path');
  if (!pathName) return send(res, 422, { error: 'path query required' });
  const host = await fleetDb.getHost(ctx.db, m[1]);
  if (!host) return send(res, 404, { error: 'host not found' });
  if (host.status !== 'online') return send(res, 410, { error: 'host offline' });
  try {
    const r = await ctx.bus.fileOp(host.id, 'read_file', pathName);
    send(res, 200, { path: r.path, exists: r.exists, content: r.content });
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}

async function handleHostFilePut({ req, res, body, ctx }) {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(new RegExp(`^/fleet/hosts/(${SID_RE})/file$`, 'i'));
  if (!m) return send(res, 404, { error: 'not found' });
  if (!body || !body.path || typeof body.content !== 'string') {
    return send(res, 422, { error: 'path and content required' });
  }
  const host = await fleetDb.getHost(ctx.db, m[1]);
  if (!host) return send(res, 404, { error: 'host not found' });
  if (host.status !== 'online') return send(res, 410, { error: 'host offline' });
  try {
    const r = await ctx.bus.fileOp(host.id, 'write_file', body.path, body.content);
    send(res, 200, { path: r.path, bytes: r.bytes });
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}

async function handleSessionCost({ req, res, ctx }) {
  const m = req.url.match(new RegExp(`^/fleet/sessions/(${SID_RE})/cost$`, 'i'));
  if (!m) return send(res, 404, { error: 'not found' });
  if (!ctx.tokmonDb) return send(res, 503, { error: 'cost data unavailable (tokmon db not configured)' });
  const s = await fleetDb.getSession(ctx.db, m[1]);
  if (!s) return send(res, 404, { error: 'session not found' });
  const host = await fleetDb.getHost(ctx.db, s.host_id);
  if (!host) return send(res, 404, { error: 'host not found' });
  const cost = await fleetCost.sessionCost(ctx.tokmonDb, host.name, s.started_at, s.ended_at, s.id);
  send(res, 200, { session_id: s.id, host: host.name, ...cost });
}

async function handleCostSummary({ req, res, ctx }) {
  if (!ctx.tokmonDb) return send(res, 503, { error: 'cost data unavailable (tokmon db not configured)' });
  const url = new URL(req.url, 'http://x');
  const days = parseInt(url.searchParams.get('days') || '7', 10);
  const hosts = await fleetDb.listHosts(ctx.db);
  const r = await fleetCost.hostSummary(ctx.tokmonDb, hosts.map(h => h.name), days);
  const result = hosts.map(h => ({
    host_id: h.id, host: h.name, status: h.status,
    usd: r[h.name]?.usd || 0,
    msgs: r[h.name]?.msgs || 0,
    by_model: r[h.name]?.by_model || {},
  }));
  send(res, 200, { days, hosts: result });
}

// Strip both CSI sequences (\x1b[...) — including private-prefix variants like
// \x1b[?2004h — and 2-byte ESC sequences (\x1b7, \x1b8, \x1b], etc.), and OSC strings.
function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC ...BEL or ...ST
    .replace(/\x1b\[[\d;?<>]*[A-Za-z]/g, '')              // CSI ...final
    .replace(/\x1b[()][\x20-\x7e]/g, '')                  // charset designate
    .replace(/\x1b[78=>cDEHMNOPVZ\\]/g, '');              // simple 2-byte ESC sequences
}

async function handleTranscriptTxt(req, res, ctx) {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(new RegExp(`^/fleet/sessions/(${SID_RE})/transcript\\.txt$`, 'i'));
  if (!m) return send(res, 404, { error: 'not found' });
  const rows = await fleetDb.readTranscript(ctx.db, m[1], { sinceSeq: 0, kind: 'pty_out' });
  const raw = Buffer.concat(rows.map(r => r.payload || Buffer.alloc(0))).toString('utf8');
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(stripAnsi(raw));
}

function dispatchHttp(req, res, ctx) {
  const method = req.method;
  const path = req.url.split('?')[0];

  // Static + index served before auth (page is public; APIs still gated)
  if (method === 'GET' && (path === '/fleet/' || path === '/fleet' || path.startsWith('/fleet/static/'))) {
    if (fleetStatic.serve(req, res)) return;
  }
  // healthz before auth
  if (method === 'GET' && path === '/fleet/healthz') {
    return send(res, 200, { ok: true });
  }
  if (!checkAuth(req, ctx.token)) return send(res, 401, { error: 'unauthorized' });

  // hosts
  if (method === 'GET'    && path === '/fleet/hosts')   return handleGetHosts({ req, res, ctx });
  if (method === 'GET'    && new RegExp(`^/fleet/hosts/${SID_RE}$`, 'i').test(path)) return handleGetHost({ req, res, ctx });
  if (method === 'DELETE' && new RegExp(`^/fleet/hosts/${SID_RE}$`, 'i').test(path)) return handleDeleteHost({ req, res, ctx });
  if (method === 'PATCH'  && new RegExp(`^/fleet/hosts/${SID_RE}$`, 'i').test(path)) {
    return readBody(req).then(b => handlePatchHost({ req, res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
  }
  if (method === 'POST'   && path === '/fleet/dispatch') {
    return readBody(req).then(b => handleDispatch({ req, res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
  }
  if (method === 'POST'   && path === '/fleet/exec') {
    return readBody(req).then(b => handleExec({ req, res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
  }
  if (method === 'GET'    && new RegExp(`^/fleet/hosts/${SID_RE}/file$`, 'i').test(path)) return handleHostFileGet({ req, res, ctx });
  if (method === 'PUT'    && new RegExp(`^/fleet/hosts/${SID_RE}/file$`, 'i').test(path)) {
    return readBody(req).then(b => handleHostFilePut({ req, res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
  }

  // sessions
  if (method === 'GET'  && path === '/fleet/sessions') return handleListSessions({ req, res, ctx });
  if (method === 'POST' && path === '/fleet/sessions') {
    return readBody(req).then(b => handleCreateSession({ req, res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
  }
  if (method === 'POST' && path === '/fleet/sessions/cleanup') {
    return readBody(req).then(b => handleCleanupSessions({ req, res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
  }
  if (method === 'PATCH' && new RegExp(`^/fleet/sessions/${SID_RE}$`, 'i').test(path)) {
    return readBody(req).then(b => handlePatchSession({ req, res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
  }
  if (method === 'GET' && new RegExp(`^/fleet/sessions/${SID_RE}/timeline$`, 'i').test(path)) {
    return handleSessionTimeline({ req, res, ctx });
  }
  if (method === 'POST' && path === '/fleet/broadcast') {
    return readBody(req).then(b => handleBroadcast({ req, res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
  }
  if (method === 'GET' && path === '/fleet/cost/timeline') return handleCostTimeline({ req, res, ctx });
  if (method === 'GET' && new RegExp(`^/fleet/sessions/${SID_RE}$`, 'i').test(path)) return handleGetSession({ req, res, ctx });
  if (method === 'POST' && new RegExp(`^/fleet/sessions/${SID_RE}/input$`, 'i').test(path)) {
    return readBody(req).then(b => handlePostInput({ req, res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
  }
  if (method === 'POST' && new RegExp(`^/fleet/sessions/${SID_RE}/kill$`, 'i').test(path)) {
    return readBody(req).then(b => handlePostKill({ req, res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
  }
  if (method === 'GET' && new RegExp(`^/fleet/sessions/${SID_RE}/transcript\\.txt$`, 'i').test(path)) {
    return handleTranscriptTxt(req, res, ctx);
  }

  // Cost
  if (method === 'GET' && new RegExp(`^/fleet/sessions/${SID_RE}/cost$`, 'i').test(path)) {
    return handleSessionCost({ req, res, ctx });
  }
  if (method === 'GET' && path === '/fleet/cost/summary') return handleCostSummary({ req, res, ctx });

  send(res, 404, { error: 'not found' });
}

// --- WS handlers ---

async function handleDaemonWs(ws, params, ctx) {
  const hostName = params.get('host_name');
  if (!hostName) return ws.close(4002, 'host_name required');
  const host = await fleetDb.upsertHost(ctx.db, {
    name: hostName,
    daemonVersion: params.get('daemon_version') || null,
  });
  ws.send(JSON.stringify({ type: 'welcome', host_id: host.id, server_version: ctx.version || '0.0.1' }));
  ctx.bus.registerDaemon(host.id, ws);
  ws.on('close', async () => {
    try { await fleetDb.setHostOffline(ctx.db, host.id); } catch {}
  });

  ws.on('message', async (raw) => {
    let f;
    try { f = JSON.parse(raw.toString()); } catch { return ws.close(4005, 'invalid frame'); }
    try {
      if (f.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
      if (f.type === 'hello') {
        await fleetDb.upsertHost(ctx.db, {
          name: hostName,
          os: f.os, arch: f.arch,
          capabilities: f.capabilities || [],
          daemonVersion: params.get('daemon_version'),
          claudeVersion: f.claude_version,
        });
        if (f.host_info && typeof f.host_info === 'object') {
          await fleetDb.setHostMetadata(ctx.db, host.id, f.host_info);
        }
        return;
      }
      if (f.type === 'spawn_ok') {
        await fleetDb.markSessionRunning(ctx.db, f.session_id, f.pid);
        ctx.bus.broadcastViewers(f.session_id, { type: 'session_started', session_id: f.session_id });
        return;
      }
      if (f.type === 'spawn_err') {
        await fleetDb.markSessionExited(ctx.db, f.session_id, -1, 'exited');
        return;
      }
      if (f.type === 'pty_data') {
        const buf = Buffer.from(f.data, 'base64');
        const seq = Number(f.seq);
        let rb = ctx.rings.get(f.session_id);
        if (!rb) { rb = new RingBuffer(64 * 1024); ctx.rings.set(f.session_id, rb); }
        rb.append({ seq, data: buf });
        ctx.batcher.push({ sessionId: f.session_id, kind: 'pty_out', seq, payload: buf });
        ctx.bus.broadcastViewers(f.session_id, { type: 'pty_data', seq, data: f.data });
        return;
      }
      if (f.type === 'session_exit') {
        const status = f.signal ? 'killed' : 'exited';
        ctx.batcher.push({
          sessionId: f.session_id, kind: 'lifecycle', seq: Number.MAX_SAFE_INTEGER,
          payload: Buffer.from(JSON.stringify({ exit_code: f.exit_code, signal: f.signal || null })),
        });
        // Flush pending pty_data BEFORE marking exited so late viewers see transcript.
        try { await ctx.batcher.flush(); } catch {}
        await fleetDb.markSessionExited(ctx.db, f.session_id, f.exit_code, status);
        ctx.bus.broadcastViewers(f.session_id, { type: 'session_exit', exit_code: f.exit_code });
        ctx.rings.delete(f.session_id);
        return;
      }
      if (f.type === 'file_data' || f.type === 'file_ok') {
        ctx.bus.resolveFileReq(f.req_id, f, false); return;
      }
      if (f.type === 'file_err') {
        ctx.bus.resolveFileReq(f.req_id, f, true); return;
      }
      if (f.type === 'reconciliation') {
        for (const s of (f.sessions || [])) {
          if (s.alive) {
            await fleetDb.markSessionRunning(ctx.db, s.session_id, s.pid);
          } else {
            const status = (s.exit_code === 137 || s.signal) ? 'killed' : 'exited';
            await fleetDb.markSessionExited(ctx.db, s.session_id, s.exit_code ?? null, status);
          }
        }
        return;
      }
    } catch (e) {
      console.error(`[fleet-routes] daemon frame error: ${e.message}`);
    }
  });
}

async function handleViewerWs(ws, params, ctx) {
  const sid = params.get('session_id');
  if (!sid) return ws.close(4002, 'session_id required');

  // Buffer incoming frames until session is loaded (avoids race with async DB lookup)
  let session = null;
  const queue = [];
  const processFrame = (raw) => {
    let f;
    try { f = JSON.parse(raw.toString()); } catch { return; }
    if (!session) { queue.push(f); return; }
    if (f.type === 'input') ctx.bus.sendInput(session.id, session.host_id, f.data);
    else if (f.type === 'kill') ctx.bus.sendKill(session.id, session.host_id, f.signal || 'SIGTERM');
    else if (f.type === 'resize') {
      const d = ctx.bus.getDaemon(session.host_id);
      if (d) try { d.send(JSON.stringify({ type: 'resize', session_id: session.id, cols: f.cols, rows: f.rows })); } catch {}
    }
  };
  ws.on('message', processFrame);

  const s = await fleetDb.getSession(ctx.db, sid);
  if (!s) return ws.close(4404, 'session not found');
  session = s;

  ws.send(JSON.stringify({
    type: 'hello', session_id: s.id, host_id: s.host_id, status: s.status, cwd: s.cwd,
  }));
  // Always send backfill so the viewer has something to render. For running
  // sessions the content may be mis-positioned (it was captured at the PTY's
  // historical cols/rows), but the client will force claude to redraw at the
  // viewer's actual size via a dual SIGWINCH right after.
  const rb = ctx.rings.get(s.id);
  if (rb && rb.size() > 0) {
    const frames = rb.snapshot();
    const merged = Buffer.concat(frames.map(f => f.data));
    ws.send(JSON.stringify({
      type: 'backfill',
      from_seq: frames[0].seq,
      to_seq: frames[frames.length - 1].seq,
      data: merged.toString('base64'),
    }));
  } else {
    const rows = await fleetDb.readTranscript(ctx.db, s.id, { sinceSeq: 0, kind: 'pty_out', limit: 1024 });
    if (rows.length) {
      const merged = Buffer.concat(rows.map(r => r.payload || Buffer.alloc(0)));
      ws.send(JSON.stringify({
        type: 'backfill',
        from_seq: Number(rows[0].seq),
        to_seq: Number(rows[rows.length - 1].seq),
        data: merged.toString('base64'),
      }));
    }
  }
  ctx.bus.addViewer(s.id, ws);

  // Race recovery: session may have transitioned during our async setup above.
  // Re-fetch status; if terminal, replay any missed transcript + session_exit so the
  // viewer doesn't hang waiting for frames that already broadcasted to no one.
  const fresh = await fleetDb.getSession(ctx.db, s.id);
  if (fresh && (fresh.status === 'exited' || fresh.status === 'killed')) {
    const rows2 = await fleetDb.readTranscript(ctx.db, s.id, { sinceSeq: 0, kind: 'pty_out', limit: 1024 });
    if (rows2.length) {
      const merged = Buffer.concat(rows2.map(r => r.payload || Buffer.alloc(0)));
      ws.send(JSON.stringify({
        type: 'backfill',
        from_seq: Number(rows2[0].seq),
        to_seq: Number(rows2[rows2.length - 1].seq),
        data: merged.toString('base64'),
      }));
    }
    ws.send(JSON.stringify({ type: 'session_exit', exit_code: fresh.exit_code }));
  }

  // Drain queued frames now that session is ready
  while (queue.length) {
    const f = queue.shift();
    if (f.type === 'input') ctx.bus.sendInput(s.id, s.host_id, f.data);
    else if (f.type === 'kill') ctx.bus.sendKill(s.id, s.host_id, f.signal || 'SIGTERM');
    else if (f.type === 'resize') {
      const d = ctx.bus.getDaemon(s.host_id);
      if (d) try { d.send(JSON.stringify({ type: 'resize', session_id: s.id, cols: f.cols, rows: f.rows })); } catch {}
    }
  }
}

// --- Mount ---

function attach(server, ctx) {
  if (server._fleetCtx) {
    Object.assign(server._fleetCtx, ctx);
    return;
  }
  const merged = Object.assign({}, ctx);
  if (!merged.bus) merged.bus = makeBus();
  if (!merged.rings) merged.rings = new Map();
  if (!merged.batcher) {
    merged.batcher = new EventBatcher({
      flushSize: 50, flushIntervalMs: 200,
      write: async (batch) => { if (merged.db) await fleetDb.appendEvents(merged.db, batch); },
    });
  }
  server._fleetCtx = merged;

  const wss = new WebSocketServer({ noServer: true });
  server._fleetWss = wss;

  server.on('request', (req, res) => {
    if (!req.url.startsWith('/fleet/')) return;
    dispatchHttp(req, res, server._fleetCtx);
  });

  server.on('upgrade', (req, sock, head) => {
    if (!req.url.startsWith('/fleet/ws')) return;
    const u = new URL(req.url, 'http://x');
    const role = u.searchParams.get('role');
    const auth = req.headers.authorization || '';
    wss.handleUpgrade(req, sock, head, (ws) => {
      const ctx = server._fleetCtx;
      if (auth !== `Bearer ${ctx.token}`) return ws.close(4001, 'unauthorized');
      if (role !== 'daemon' && role !== 'viewer') return ws.close(4003, 'invalid role');
      if (role === 'daemon') handleDaemonWs(ws, u.searchParams, ctx);
      else handleViewerWs(ws, u.searchParams, ctx);
    });
  });
}

// tryDispatch: synchronous fast-path for rag-api callback integration.
// Returns true if the request belongs to fleet and was dispatched (response will be sent
// asynchronously by the handler). Returns false to let the caller proceed with its own
// routing.
function tryDispatch(req, res, ctx) {
  if (!req.url || !req.url.startsWith('/fleet/')) return false;
  // Guard: if db not yet ready, return 503 rather than crash on null.query
  const path = req.url.split('?')[0];
  const needsDb = path !== '/fleet/healthz';
  if (needsDb && !ctx.db) {
    send(res, 503, { error: 'fleet: database not ready' });
    return true;
  }
  Promise.resolve()
    .then(() => dispatchHttp(req, res, ctx))
    .catch((e) => {
      console.error(`[fleet-routes] ${req.url}: ${e.stack || e.message}`);
      if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
    });
  return true;
}

function attachUpgrade(server, getCtx) {
  if (server._fleetUpgradeAttached) return;
  server._fleetUpgradeAttached = true;
  // Accept bearer.<token> subprotocol so browsers (no header API) can authenticate.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protos) => {
      for (const p of protos) if (p.startsWith('bearer.')) return p;
      return false;
    },
  });
  server.on('upgrade', (req, sock, head) => {
    if (!req.url.startsWith('/fleet/ws') && !req.url.startsWith('/api/fleet/ws')) return;
    if (req.url.startsWith('/api/')) req.url = req.url.slice(4);
    const u = new URL(req.url, 'http://x');
    const role = u.searchParams.get('role');
    let auth = req.headers.authorization || '';
    if (!auth) {
      const proto = req.headers['sec-websocket-protocol'] || '';
      const b = proto.split(',').map(s => s.trim()).find(s => s.startsWith('bearer.'));
      if (b) auth = `Bearer ${b.slice('bearer.'.length)}`;
    }
    wss.handleUpgrade(req, sock, head, (ws) => {
      const ctx = getCtx();
      if (auth !== `Bearer ${ctx.token}`) return ws.close(4001, 'unauthorized');
      if (role !== 'daemon' && role !== 'viewer') return ws.close(4003, 'invalid role');
      if (role === 'daemon') handleDaemonWs(ws, u.searchParams, ctx);
      else handleViewerWs(ws, u.searchParams, ctx);
    });
  });
}

function makeContext({ token, db, version }) {
  const ctx = { token, db, version };
  ctx.bus = makeBus();
  ctx.rings = new Map();
  ctx.batcher = new EventBatcher({
    flushSize: 50, flushIntervalMs: 200,
    write: async (batch) => { if (ctx.db) await fleetDb.appendEvents(ctx.db, batch); },
  });
  return ctx;
}

module.exports = { attach, tryDispatch, attachUpgrade, makeContext, send, readBody, checkAuth };
