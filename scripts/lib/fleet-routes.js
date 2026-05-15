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
      if (!set) return;
      const payload = JSON.stringify(frame);
      for (const v of set) {
        try { v.send(payload); } catch {}
      }
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

async function handleListSessions({ req, res, ctx }) {
  const url = new URL(req.url, 'http://x');
  const filter = {
    hostId: url.searchParams.get('host_id') || undefined,
    status: url.searchParams.get('status') || undefined,
    limit:  parseInt(url.searchParams.get('limit') || '100', 10),
    offset: parseInt(url.searchParams.get('offset') || '0', 10),
  };
  const rows = await fleetDb.listSessions(ctx.db, filter);
  send(res, 200, rows);
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
  const m = req.url.match(new RegExp(`^/fleet/sessions/(${SID_RE})/input$`, 'i'));
  if (!m) return send(res, 404, { error: 'not found' });
  if (!body || typeof body.data !== 'string') return send(res, 422, { error: 'data required' });
  const s = await fleetDb.getSession(ctx.db, m[1]);
  if (!s) return send(res, 404, { error: 'session not found' });
  if (ctx.bus) ctx.bus.sendInput(s.id, s.host_id, body.data);
  res.writeHead(204); res.end();
}

async function handlePostKill({ req, res, body, ctx }) {
  const m = req.url.match(new RegExp(`^/fleet/sessions/(${SID_RE})/kill$`, 'i'));
  if (!m) return send(res, 404, { error: 'not found' });
  const signal = (body && body.signal) || 'SIGTERM';
  const s = await fleetDb.getSession(ctx.db, m[1]);
  if (!s) return send(res, 404, { error: 'session not found' });
  if (ctx.bus) ctx.bus.sendKill(s.id, s.host_id, signal);
  res.writeHead(204); res.end();
}

async function handleSessionCost({ req, res, ctx }) {
  const m = req.url.match(new RegExp(`^/fleet/sessions/(${SID_RE})/cost$`, 'i'));
  if (!m) return send(res, 404, { error: 'not found' });
  if (!ctx.tokmonDb) return send(res, 503, { error: 'cost data unavailable (tokmon db not configured)' });
  const s = await fleetDb.getSession(ctx.db, m[1]);
  if (!s) return send(res, 404, { error: 'session not found' });
  const host = await fleetDb.getHost(ctx.db, s.host_id);
  if (!host) return send(res, 404, { error: 'host not found' });
  const cost = await fleetCost.sessionCost(ctx.tokmonDb, host.name, s.started_at, s.ended_at);
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

async function handleTranscriptTxt(req, res, ctx) {
  const m = req.url.match(new RegExp(`^/fleet/sessions/(${SID_RE})/transcript\\.txt$`, 'i'));
  if (!m) return send(res, 404, { error: 'not found' });
  const rows = await fleetDb.readTranscript(ctx.db, m[1], { sinceSeq: 0, kind: 'pty_out' });
  const text = Buffer.concat(rows.map(r => r.payload || Buffer.alloc(0))).toString('utf8')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
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

  // sessions
  if (method === 'GET'  && path === '/fleet/sessions') return handleListSessions({ req, res, ctx });
  if (method === 'POST' && path === '/fleet/sessions') {
    return readBody(req).then(b => handleCreateSession({ req, res, body: b, ctx })).catch(e => send(res, 400, { error: e.message }));
  }
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
        // Update host metadata
        await fleetDb.upsertHost(ctx.db, {
          name: hostName,
          os: f.os, arch: f.arch,
          capabilities: f.capabilities || [],
          daemonVersion: params.get('daemon_version'),
          claudeVersion: f.claude_version,
        });
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
  // Backfill: ring buffer first, else DB
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
    const rows = await fleetDb.readTranscript(ctx.db, s.id, { sinceSeq: 0, kind: 'pty_out', limit: 256 });
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
