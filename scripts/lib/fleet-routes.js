'use strict';
// fleet-routes: HTTP + WS handlers for agent-fleet. Mounted by rag-api.js.

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const fleetDb = require('./fleet-db');
const fleetStatic = require('./fleet-static');
const fleetCost = require('./fleet-cost');
const fleetPrices = require('./fleet-prices');
const wfDb = require('./fleet-workflow-db');
const { createRunner, validateDefinition } = require('./fleet-workflow-runner');
const { RingBuffer } = require('./fleet-ring-buffer');
const { EventBatcher } = require('./fleet-event-batcher');
const log = require('./log').for('fleet-routes');

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// vt-0126: cap incoming body at 1 MiB so a hostile caller can't OOM the API
// via an unbounded POST (e.g. `body.content` on /fleet/hosts/:id/file used to
// be forwarded as a single WS frame to the daemon with no size check). Per-
// route caps are applied in handlers when stricter limits make sense.
const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let bytes = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      bytes += c.length;
      if (bytes > maxBytes) {
        aborted = true;
        const err = new Error(`body exceeds ${maxBytes} bytes`);
        err.statusCode = 413;
        // Stop buffering; let any remaining bytes drain into /dev/null so the
        // TCP socket doesn't stall the response we're about to send.
        buf = '';
        return reject(err);
      }
      buf += c;
    });
    req.on('end', () => {
      if (aborted) return;
      if (!buf) return resolve(null);
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on('error', (e) => { if (!aborted) reject(e); });
  });
}

// C2 (audit pass 2): constant-time bearer compare. Plain `===` is vulnerable
// to a network-side timing oracle that recovers the token byte-by-byte. The
// same helper is in mcp-shim.js — keep them in sync if the format changes.
function tokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkAuth(req, token) {
  const auth = req.headers.authorization || '';
  return tokenEqual(auth, `Bearer ${token}`);
}

// vt-0124: split admin from viewer. When VAULT_RAG_FLEET_ADMIN_TOKEN is set,
// non-GET endpoints (mutate state, execute code on hosts, edit workflows) require
// the admin token. When NOT set, fall back to the viewer token for backwards
// compatibility — existing deployments keep working until the operator chooses
// to lock it down.
function checkAdminAuth(req, ctx) {
  const auth = req.headers.authorization || '';
  if (ctx.adminToken) return tokenEqual(auth, `Bearer ${ctx.adminToken}`);
  return tokenEqual(auth, `Bearer ${ctx.token}`);
}

// Endpoints that mutate state, execute code on a host, edit workflows, or
// otherwise produce side effects beyond reading. Workflow CRUD specifically
// is RCE-capable via vm.runInContext on expression nodes — see audit vt-0124.
function isAdminPath(method, path) {
  if (method === 'GET') return false;
  // POST shape but read-only: cost batch is POST due to body size.
  if (path === '/fleet/sessions/cost-batch') return false;
  // vt-0136: ticket endpoint mints a ticket scoped to the bearer that called
  // it — no privilege escalation, viewer can ask for viewer ticket.
  if (path === '/fleet/auth/ws-ticket') return false;
  // POST workflow-pending-approvals fan-out — currently GET only, but guard
  // by allowing only known read-shaped POSTs above.
  return true;
}

function requireAdmin(req, res, ctx) {
  if (checkAdminAuth(req, ctx)) return true;
  send(res, 403, { error: 'admin token required for this operation' });
  return false;
}

// vt-0136: short-lived signed WS tickets for browsers. The old path put the
// raw bearer in the `Sec-WebSocket-Protocol` subprotocol where it leaks into
// browser DevTools + reverse-proxy access logs and stays valid until token
// rotation. Tickets are HMAC(role|exp), valid 60s.
// vt-0179: ticket is SINGLE-USE — once consumed by a WS upgrade, the sig is
// recorded in _consumedTickets (Map<sigHash,expiry>) and any second use in
// the 60s window 4001s. Map is GC'd every 30s by sweeping expired entries.
const WS_TICKET_TTL_MS = 60_000;
const WS_TICKET_DERIVATION = 'fleet-ws-ticket-v1';
const _consumedTickets = new Map();
const _consumedSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [sig, exp] of _consumedTickets) if (exp < now) _consumedTickets.delete(sig);
}, 30_000);
_consumedSweepTimer.unref?.();
// vt-0187: transactional helper for write pairs that must land together.
// Each ctx.db is a pg.Pool (vt-0186) so we acquire a dedicated client for
// BEGIN/COMMIT — Pool.query() per call would dispatch each statement to a
// different connection, defeating the transaction.
async function withTx(ctx, fn) {
  const c = await ctx.db.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    try { c.release(); } catch {}
  }
}

function _ticketSigHash(ticket) {
  // Hash only the signature half — full ticket is bulky and the sig alone
  // is unique per (role,exp,secret) tuple.
  const parts = String(ticket).split('.');
  return parts.length === 2 ? crypto.createHash('sha256').update(parts[1]).digest('hex').slice(0, 16) : null;
}
function wsTicketSecret(ctx) {
  // Per-process deterministic derivation from the viewer token — operators
  // who want explicit rotation can set VAULT_RAG_FLEET_WS_SECRET. Tickets are
  // ephemeral; rotating the viewer token invalidates all in-flight tickets
  // (acceptable: a manual rotation is already a security event).
  const base = process.env.VAULT_RAG_FLEET_WS_SECRET || ctx.token || '';
  return crypto.createHmac('sha256', base).update(WS_TICKET_DERIVATION).digest();
}
function signWsTicket(ctx, role) {
  const payload = { role, exp: Date.now() + WS_TICKET_TTL_MS };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', wsTicketSecret(ctx)).update(b64).digest('hex');
  return `${b64}.${sig}`;
}
function verifyWsTicket(ctx, ticket) {
  if (typeof ticket !== 'string') return null;
  const parts = ticket.split('.');
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', wsTicketSecret(ctx)).update(b64).digest('hex');
  // Constant-time compare; mismatched length is also rejected via tokenEqual.
  if (!tokenEqual(sig, expectedSig)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!payload || typeof payload.role !== 'string' || typeof payload.exp !== 'number') return null;
  if (Date.now() > payload.exp) return null;
  return payload;
}

async function handleWsTicket({ req, res, body, ctx }) {
  // Auth: viewer-or-admin already enforced by dispatchHttp before we land here.
  // Role: ticket carries the role the bearer was admitted under. Daemons never
  // call this (they use Authorization header on the WS upgrade); we still
  // refuse to mint daemon tickets via this endpoint to avoid future bypass.
  const requested = (body && body.role) ? String(body.role) : 'viewer';
  const callerId = _workflowCallerFp(req);
  const callerIp = req.socket?.remoteAddress || null;
  const userAgent = (req.headers['user-agent'] || '').slice(0, 200);
  async function audit(outcome, detail) {
    if (!ctx.db) return;
    try {
      await ctx.db.query(
        `INSERT INTO auth_audit (op, role, caller_id, caller_ip, user_agent, outcome, detail)
         VALUES ('ws_ticket_grant', $1, $2, $3, $4, $5, $6)`,
        [requested, callerId, callerIp, userAgent, outcome, detail ? JSON.stringify(detail) : null]);
    } catch (e) {
      log.error('auth_audit_insert_failed', { msg: e.message });
    }
  }
  if (requested === 'daemon') {
    await audit('denied', { reason: 'daemon_role_disallowed' });
    return send(res, 403, { error: 'daemon role uses Authorization header, not tickets' });
  }
  if (!['viewer', 'workflow_viewer', 'metrics_viewer'].includes(requested)) {
    await audit('denied', { reason: 'unknown_role' });
    return send(res, 422, { error: `unknown role: ${requested}` });
  }
  // Admin-bearer holders may request any viewer role; viewer-bearer holders
  // may only request the same. Auth check is uniform — we already passed
  // checkAuth in dispatchHttp.
  const ticket = signWsTicket(ctx, requested);
  await audit('ok');
  send(res, 200, { ticket, role: requested, expires_in_ms: WS_TICKET_TTL_MS });
}

function pathMatch(url, prefix) {
  const path = url.split('?')[0];
  if (!path.startsWith(prefix + '/')) return null;
  return path.slice(prefix.length + 1);
}

const SID_RE = '[0-9a-f-]{36}';
const SID_RE_BARE = /^[0-9a-f-]{36}$/i;

function makeBus() {
  const daemonsByHost = new Map();          // host_id -> ws
  const viewersBySession = new Map();       // session_id -> Set<ws>
  const hooksBySession = new Map();         // session_id -> Set<fn(frame)>
  const pendingFileReqs = new Map();        // req_id -> {resolve, reject, timer}
  const workflowViewers = new Map();        // run_id -> Set<ws>
  const metricsViewersByHost = new Map();   // host_id -> Set<ws>
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
      // H4 (audit pass 2): unpredictable req_id so a compromised co-daemon
      // can't race-resolve another daemon's pending fileOp by spoofing the id.
      const req_id = crypto.randomBytes(8).toString('hex');
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
    addWorkflowViewer(runId, ws) {
      let set = workflowViewers.get(runId);
      if (!set) { set = new Set(); workflowViewers.set(runId, set); }
      set.add(ws);
      ws.on('close', () => { set.delete(ws); if (!set.size) workflowViewers.delete(runId); });
    },
    broadcastWorkflow(runId, frame) {
      const set = workflowViewers.get(runId);
      if (!set) return;
      const payload = JSON.stringify(frame);
      for (const v of set) { try { v.send(payload); } catch {} }
    },
    addMetricsViewer(hostId, ws) {
      let set = metricsViewersByHost.get(hostId);
      if (!set) { set = new Set(); metricsViewersByHost.set(hostId, set); }
      set.add(ws);
      ws.on('close', () => { set.delete(ws); if (!set.size) metricsViewersByHost.delete(hostId); });
    },
    broadcastHostMetrics(hostId, frame) {
      const set = metricsViewersByHost.get(hostId);
      if (!set) return;
      const payload = JSON.stringify(frame);
      for (const v of set) { try { v.send(payload); } catch {} }
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
  h.groups = await fleetDb.listGroupsForHost(ctx.db, id);
  const eff = await fleetDb.getEffectiveCapabilities(ctx.db, id);
  if (eff) {
    h.effective_capabilities = eff.effective;
    h.inherited_labels = eff.inherited;
  }
  send(res, 200, h);
}

async function handleDeleteHost({ req, res, ctx }) {
  const id = pathMatch(req.url, '/fleet/hosts');
  // vt-0183: require ?confirm=1 — DELETE cascades to sessions+events+
  // metrics+groups, so a typo'd UUID wipes a host's full history.
  const u = new URL(req.url, 'http://x');
  if (u.searchParams.get('confirm') !== '1') {
    return send(res, 400, { error: 'add ?confirm=1 to delete (cascades to sessions+events+metrics)' });
  }
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
  if (tag) {
    const taggedHosts = await fleetDb.listHostsByEffectiveTag(ctx.db, tag);
    const taggedIds = new Set(taggedHosts.map(h => h.id));
    candidates = candidates.filter(h => taggedIds.has(h.id));
  }
  if (!candidates.length) return send(res, 404, { error: 'no online host matches' });
  const sessions = await fleetDb.listSessions(ctx.db, { status: 'running' });
  const busyByHost = {};
  for (const s of sessions) busyByHost[s.host_id] = (busyByHost[s.host_id] || 0) + 1;
  candidates.sort((a, b) => (busyByHost[a.id] || 0) - (busyByHost[b.id] || 0));
  const host = candidates[0];
  // vt-0133: cap concurrent exec sessions per host. Without this, 100 parallel
  // /fleet/exec POSTs pin every host to its slowest task, each holding a
  // session row + viewer hook + 600s default timeout = OOM + fd exhaustion.
  const MAX_EXEC_PER_HOST = Math.max(1, parseInt(
    process.env.VAULT_RAG_FLEET_EXEC_MAX_PER_HOST || '5', 10));
  if ((busyByHost[host.id] || 0) >= MAX_EXEC_PER_HOST) {
    res.setHeader('retry-after', '5');
    return send(res, 429, {
      error: `host ${host.name} at capacity (${busyByHost[host.id]} running, cap ${MAX_EXEC_PER_HOST})`,
      retry_after_seconds: 5,
    });
  }

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
  // Subscribe to session_exit. Use a plain Promise executor (no async) and a
  // single unsubscribe() closure so the hook is guaranteed freed on every
  // resolution path — including orphan reconciliation and spawn_err (which
  // both now also emit session_exit to viewers, see handleDaemonWs).
  // N7 (audit): coerce timeout_ms safely — `parseInt("abc")` → NaN propagates
  // through Math.min/max as NaN → setTimeout(NaN) ≈ 0ms → instant timeout.
  const rawTimeout = Number.parseInt(timeout_ms, 10);
  const TIMEOUT = Math.min(Math.max(Number.isFinite(rawTimeout) ? rawTimeout : 120000, 5000), 600000);
  let unsubscribed = false;
  let timeoutHandle = null;
  let handler = null;
  const result = await new Promise((resolve) => {
    const cleanup = () => {
      if (unsubscribed) return;
      unsubscribed = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (handler) ctx.bus.unsubscribeViewerHook(s.id, handler);
    };
    handler = (frame) => {
      if (frame.type === 'session_exit') {
        cleanup();
        resolve({ exitCode: frame.exit_code });
      }
    };
    ctx.bus.subscribeViewerHook(s.id, handler);
    timeoutHandle = setTimeout(() => {
      cleanup();
      ctx.bus.sendKill(s.id, host.id, 'SIGTERM');
      resolve({ exitCode: -1, timeout: true });
    }, TIMEOUT);
    timeoutHandle.unref?.();
  });
  // Read transcript (batcher flush already triggered by session_exit)
  const rows = await fleetDb.readTranscript(ctx.db, s.id, { sinceSeq: 0, kind: 'pty_out' });
  const raw = Buffer.concat(rows.map(r => r.payload || Buffer.alloc(0))).toString('utf8');
  const text = stripAnsi(raw);
  let cost = null;
  if (ctx.tokmonDb) {
    try { cost = await fleetCost.sessionCost(ctx.tokmonDb, ctx.db, host.name, s.started_at, new Date(), s.id); }
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
  const { tag, group, host_name, host_id, cwd, args, env, label, metadata } = body;
  if (!tag && !group && !host_name && !host_id) {
    return send(res, 422, { error: 'one of tag|group|host_name|host_id required' });
  }
  // Resolve candidate hosts
  const all = await fleetDb.listHosts(ctx.db);
  let candidates = all.filter(h => h.status === 'online');
  if (host_id)   candidates = candidates.filter(h => h.id === host_id);
  if (host_name) candidates = candidates.filter(h => h.name === host_name || h.display_name === host_name);
  if (tag) {
    // Effective tag: direct host.capabilities OR any of its groups' labels.
    const taggedHosts = await fleetDb.listHostsByEffectiveTag(ctx.db, tag);
    const taggedIds = new Set(taggedHosts.map(h => h.id));
    candidates = candidates.filter(h => taggedIds.has(h.id));
  }
  // vt-0151: hold the group record so we can inject its brain_prompt below.
  let resolvedGroup = null;
  if (group) {
    resolvedGroup = await fleetDb.getGroupByName(ctx.db, group);
    if (!resolvedGroup) return send(res, 404, { error: `group not found: ${group}` });
    const members = await fleetDb.listHostsInGroup(ctx.db, resolvedGroup.id);
    const memberIds = new Set(members.map(h => h.id));
    candidates = candidates.filter(h => memberIds.has(h.id));
  }
  if (!candidates.length) return send(res, 404, { error: 'no online host matches the criteria' });
  // Pick least-busy (running sessions ascending) as a small UX win.
  const sessions = await fleetDb.listSessions(ctx.db, { status: 'running' });
  const busyByHost = {};
  for (const s of sessions) busyByHost[s.host_id] = (busyByHost[s.host_id] || 0) + 1;
  candidates.sort((a, b) => (busyByHost[a.id] || 0) - (busyByHost[b.id] || 0));
  const host = candidates[0];

  // vt-0151: structured spawn fields (model/prompt/system_prompt/etc) are
  // forwarded to the daemon so backends like claude can apply --model,
  // --append-system-prompt, etc. When the dispatch targets a group with a
  // brain_prompt, prepend it to body.system_prompt — both are concatenated
  // server-side into a single string ("<brain>\n\n<per-call>"), which is
  // then handed to whichever backend handles system_prompt (claude:
  // --append-system-prompt, codex: --instructions, hermes wrapper: prepends
  // as <<SYSTEM>> block, etc.). Precedence is by string order, NOT by flag
  // order — per-call lands later in the combined text, so it acts as a
  // refinement on top of the group's shared context. An empty per-call
  // system_prompt just inherits the group's verbatim.
  // vt-0169: coerce structured spawn fields to safe types before forwarding
  // to the daemon. `dangerous` is boolean (claude --dangerously-skip-perms),
  // any truthy non-boolean (object/array) reaching the daemon would be a
  // surprise; string-typed prompt/model fields stay strings.
  const structured = {};
  for (const k of STRUCTURED_SPAWN_FIELDS) {
    if (body[k] == null) continue;
    if (k === 'dangerous') structured[k] = Boolean(body[k]);
    else if (k === 'allowed_tools') {
      // vt-0266: array of short strings — coerce + sanitize per element.
      // vt-0271: an explicit empty array IS a valid intent (= "deny all
      // tools for this dispatch"). Forward it; the role-union block
      // below will respect it and INTERSECT to [] regardless of role
      // grants.
      if (Array.isArray(body[k])) {
        structured[k] = body[k].filter(t => typeof t === 'string' && t.length <= 64);
      }
    }
    else if (typeof body[k] === 'string' || typeof body[k] === 'number') structured[k] = body[k];
    // silently drop objects/arrays for string-typed fields
  }
  if (resolvedGroup && resolvedGroup.brain_prompt) {
    structured.system_prompt = structured.system_prompt
      ? `${resolvedGroup.brain_prompt}\n\n${structured.system_prompt}`
      : resolvedGroup.brain_prompt;
  }
  // vt-0259: prepend assigned role prompts (ordered by position) to the
  // system_prompt. Roles compose with brain_prompt, not replace it; the
  // final stack is: <brain>\n\n<role1>\n\n<role2>\n\n<per-call>.
  // vt-0264: belt-and-suspenders cap on dispatch — the assignment-time
  // cap (≤8 roles, ≤64 KiB combined) prevents most bloat, but a role
  // edited AFTER assignment, or a per-call system_prompt added on top,
  // can still push the combined string over ARG_MAX. If we exceed
  // MAX_DISPATCH_SYSTEM_PROMPT_BYTES, drop the per-call addition (it's
  // the least essential — the operator can re-specify) and warn loud.
  let appliedRoleNames = [];
  if (resolvedGroup) {
    try {
      const roles = await fleetDb.listGroupRoles(ctx.db, resolvedGroup.id);
      if (roles.length) {
        const roleBlob = roles.map(r => r.prompt).filter(Boolean).join('\n\n');
        if (roleBlob) {
          structured.system_prompt = structured.system_prompt
            ? `${roleBlob}\n\n${structured.system_prompt}`
            : roleBlob;
        }
        appliedRoleNames = roles.map(r => r.name);
        // First role with a default_model wins if the caller didn't specify one.
        if (!structured.model) {
          const firstWithModel = roles.find(r => r.default_model);
          if (firstWithModel) structured.model = firstWithModel.default_model;
        }
        // vt-0266: forward the role-defined allowed_tools to the daemon.
        // Roles compose by UNION — if any role grants Bash, Bash is allowed.
        // If the caller already specified allowed_tools, INTERSECT with the
        // union so caller is always at-most-as-permissive as the roles
        // (defence-in-depth: caller can narrow but not widen).
        const roleTools = new Set();
        for (const r of roles) {
          const t = Array.isArray(r.allowed_tools) ? r.allowed_tools : [];
          for (const x of t) if (typeof x === 'string') roleTools.add(x);
        }
        if (roleTools.size > 0) {
          if (Array.isArray(structured.allowed_tools)) {
            structured.allowed_tools = structured.allowed_tools.filter(t => roleTools.has(t));
          } else {
            structured.allowed_tools = Array.from(roleTools);
          }
        }
      }
    } catch (e) {
      log.error('group_roles_lookup_failed', { group: resolvedGroup.name, msg: e.message });
    }
  }
  // ARG_MAX on Linux is ~128 KiB; daemon spawn argv carries system_prompt
  // as a single argument (--append-system-prompt). Cap at 96 KiB so other
  // argv (--model, --allowed-tools …) still fits.
  const MAX_DISPATCH_SYSTEM_PROMPT_BYTES = 96 * 1024;
  if (structured.system_prompt
      && Buffer.byteLength(structured.system_prompt, 'utf8') > MAX_DISPATCH_SYSTEM_PROMPT_BYTES) {
    log.warn('dispatch_system_prompt_truncated', {
      group: resolvedGroup ? resolvedGroup.name : null,
      original_bytes: Buffer.byteLength(structured.system_prompt, 'utf8'),
      cap: MAX_DISPATCH_SYSTEM_PROMPT_BYTES,
    });
    // Truncate at a UTF-8-safe boundary. Buffer.slice may cut mid-codepoint;
    // Buffer.toString('utf8') replaces the dangling bytes with U+FFFD rather
    // than dropping silently — downstream LLM sees one '�' which is
    // harmless. The trailing marker line is the operator-visible signal.
    const buf = Buffer.from(structured.system_prompt, 'utf8').slice(0, MAX_DISPATCH_SYSTEM_PROMPT_BYTES - 64);
    structured.system_prompt = buf.toString('utf8') + '\n\n[truncated by dispatcher: combined prompt exceeded cap]';
  }

  const sessionMetadata = { ...(metadata || {}), ...structured };
  if (resolvedGroup) sessionMetadata.dispatched_group = resolvedGroup.name;
  if (appliedRoleNames.length) sessionMetadata.applied_roles = appliedRoleNames;

  const s = await fleetDb.createSession(ctx.db, {
    hostId: host.id, cwd: cwd || '~',
    args: args || [], env: env || {},
    createdBy: 'dispatch',
    label: label || null, metadata: sessionMetadata,
  });
  if (ctx.bus) {
    const payload = { session_id: s.id, cwd: s.cwd, args: s.args, env: s.env, ...structured };
    ctx.bus.requestSpawn(host.id, payload);
  }
  send(res, 201, {
    session_id: s.id,
    host_id: host.id,
    host_name: host.name,
    display_name: host.display_name,
    group_brain_prompt_applied: !!(resolvedGroup && resolvedGroup.brain_prompt),
    applied_roles: appliedRoleNames,
  });
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
  const { tag, group, cwd, args, env, label, metadata } = body;
  if (!tag && !group && !body.all) return send(res, 422, { error: 'tag|group|all required' });
  const all = await fleetDb.listHosts(ctx.db);
  let candidates = all.filter(h => h.status === 'online');
  if (tag) {
    // Effective tag: direct h.capabilities ∪ group labels — matches handleDispatch (vt-0078)
    const taggedHosts = await fleetDb.listHostsByEffectiveTag(ctx.db, tag);
    const taggedIds = new Set(taggedHosts.map(h => h.id));
    candidates = candidates.filter(h => taggedIds.has(h.id));
  }
  if (group) {
    const g = await fleetDb.getGroupByName(ctx.db, group);
    if (!g) return send(res, 404, { error: `group not found: ${group}` });
    const members = await fleetDb.listHostsInGroup(ctx.db, g.id);
    const memberIds = new Set(members.map(h => h.id));
    candidates = candidates.filter(h => memberIds.has(h.id));
  }
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

// Allowlist for days — fleet-cost interpolates it into "($N || ' days')::interval".
// parseInt protects against SQL injection (returns NaN/integer), but malformed
// values leak raw Postgres errors out of the 500 handler. Allowlist is cleaner.
const COST_VALID_DAYS = new Set([1, 7, 14, 30, 90]);
async function handleCostTimeline({ req, res, ctx }) {
  if (!ctx.tokmonDb) return send(res, 503, { error: 'cost data unavailable' });
  const url = new URL(req.url, 'http://x');
  const days = parseInt(url.searchParams.get('days') || '7', 10);
  if (!COST_VALID_DAYS.has(days)) return send(res, 422, { error: 'invalid days', allowed: [...COST_VALID_DAYS] });
  const groupBy = url.searchParams.get('group_by') || 'model';
  const hosts = await fleetDb.listHosts(ctx.db);
  const rows = await fleetCost.timeline(ctx.tokmonDb, ctx.db, hosts.map(h => h.name), days, groupBy);
  send(res, 200, { days, group_by: groupBy, points: rows });
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

// Spawn schema (vt-0102). Two shapes accepted:
//   Legacy:  { host_id, cwd, args:[...], env? }
//   Generic: { host_id, cwd, agent?, prompt?, model?, system_prompt?,
//              allowed_tools?, resume_session_id?, dangerous?, args?, env? }
// Server stores raw fields in fleet_sessions.args/metadata; daemon picks
// backend on its side via vt-0096 contract.
const STRUCTURED_SPAWN_FIELDS = [
  'agent', 'prompt', 'model', 'system_prompt',
  'allowed_tools', 'resume_session_id', 'dangerous',
];
async function handleCreateSession({ body, res, ctx }) {
  if (!body || !body.host_id) return send(res, 422, { error: 'host_id required' });
  if (!body.cwd) return send(res, 422, { error: 'cwd required' });
  const host = await fleetDb.getHost(ctx.db, body.host_id);
  if (!host) return send(res, 422, { error: 'host_id not found' });
  // Carry structured fields into metadata so the row remains the source of
  // truth for a future re-run (POST /sessions with rerun_of: <sid>).
  const metadata = { ...(body.metadata || {}) };
  for (const k of STRUCTURED_SPAWN_FIELDS) {
    if (body[k] != null) metadata[k] = body[k];
  }
  const s = await fleetDb.createSession(ctx.db, {
    hostId: body.host_id, cwd: body.cwd,
    args: body.args, env: body.env,
    createdBy: body.created_by, label: body.label, metadata,
  });
  if (ctx.bus) {
    // Forward both legacy args and structured fields. The daemon decides
    // which path to take via hasStructuredFields() (see ws-client.js).
    const payload = {
      session_id: s.id, cwd: s.cwd, args: s.args, env: s.env || {},
    };
    for (const k of STRUCTURED_SPAWN_FIELDS) {
      if (body[k] != null) payload[k] = body[k];
    }
    ctx.bus.requestSpawn(host.id, payload);
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

// ============ Groups ============

async function handleListGroups({ res, ctx }) {
  const rows = await fleetDb.listGroups(ctx.db);
  send(res, 200, rows);
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
function validColor(c) {
  return c == null || c === '' || HEX_COLOR_RE.test(c);
}

async function handleCreateGroup({ res, body, ctx }) {
  if (!body || !body.name) return send(res, 422, { error: 'name required' });
  if (!validColor(body.color)) return send(res, 422, { error: 'color must be #rrggbb hex or null' });
  // vt-0170: size cap on brain_prompt (see handlePatchGroup).
  if (typeof body.brain_prompt === 'string' && body.brain_prompt.length > 32768) {
    return send(res, 422, { error: 'brain_prompt too long (max 32768 chars)' });
  }
  try {
    const g = await fleetDb.createGroup(ctx.db, {
      name: body.name, description: body.description, color: body.color || null,
      labels: Array.isArray(body.labels) ? body.labels : [],
      brain_prompt: typeof body.brain_prompt === 'string' ? body.brain_prompt : null,
    });
    send(res, 201, g);
  } catch (e) {
    if (e.code === '23505') return send(res, 409, { error: 'name already exists' });
    send(res, 500, { error: e.message });
  }
}

async function handlePatchGroup({ req, res, body, ctx }) {
  const id = pathMatch(req.url, '/fleet/groups');
  if (!body) return send(res, 422, { error: 'body required' });
  const patch = {};
  if ('name' in body)        patch.name = body.name;
  if ('description' in body) patch.description = body.description;
  if ('color' in body) {
    if (!validColor(body.color)) return send(res, 422, { error: 'color must be #rrggbb hex or null' });
    patch.color = body.color || null;
  }
  if ('labels' in body) {
    if (!Array.isArray(body.labels)) return send(res, 422, { error: 'labels must be array of strings' });
    patch.labels = body.labels;
  }
  if ('brain_prompt' in body) {
    if (body.brain_prompt !== null && typeof body.brain_prompt !== 'string') {
      return send(res, 422, { error: 'brain_prompt must be string or null' });
    }
    // vt-0170: cap to keep the merged spawn payload bounded. 32 KiB is
    // ~8000 words — generous for a brain prompt; anything larger is
    // misuse (manifesto, full doc) and would blow up every spawn.
    if (body.brain_prompt && body.brain_prompt.length > 32768) {
      return send(res, 422, { error: 'brain_prompt too long (max 32768 chars)' });
    }
    patch.brain_prompt = body.brain_prompt;
  }
  const expectedVersion = Number.isFinite(body.expected_version) ? body.expected_version : undefined;
  try {
    const g = await fleetDb.updateGroup(ctx.db, id, patch, expectedVersion);
    if (!g) return send(res, 404, { error: 'not found' });
    if (g.__conflict) return send(res, 409, { error: 'version conflict', current: g.current });
    send(res, 200, g);
  } catch (e) {
    if (e.code === '23505') return send(res, 409, { error: 'name already exists' });
    send(res, 400, { error: e.message });
  }
}

async function handleGetGroup({ req, res, ctx }) {
  const id = pathMatch(req.url, '/fleet/groups');
  const g = await fleetDb.getGroup(ctx.db, id);
  if (!g) return send(res, 404, { error: 'not found' });
  g.hosts = await fleetDb.listHostsInGroup(ctx.db, id);
  send(res, 200, g);
}

async function handleDeleteGroup({ req, res, ctx }) {
  const id = pathMatch(req.url, '/fleet/groups');
  await fleetDb.deleteGroup(ctx.db, id);
  res.writeHead(204); res.end();
}

async function handleGroupAddHost({ req, res, body, ctx }) {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(new RegExp(`^/fleet/groups/(${SID_RE})/hosts$`, 'i'));
  if (!m || !body || !body.host_id) return send(res, 422, { error: 'host_id required' });
  await fleetDb.addHostToGroup(ctx.db, body.host_id, m[1]);
  res.writeHead(204); res.end();
}

async function handleGroupRemoveHost({ req, res, ctx }) {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(new RegExp(`^/fleet/groups/(${SID_RE})/hosts/(${SID_RE})$`, 'i'));
  if (!m) return send(res, 404, { error: 'not found' });
  await fleetDb.removeHostFromGroup(ctx.db, m[2], m[1]);
  res.writeHead(204); res.end();
}

// Allowlist for older_than: avoids users bypassing intent (e.g. '0 seconds'
// would delete every closed session). Also blocks confusing Postgres errors
// from malformed interval strings leaking out of the 500 handler.
const CLEANUP_OLDER_THAN_ALLOWED = new Set([
  '1 hour', '6 hours', '12 hours', '1 day', '3 days', '7 days', '30 days',
]);
async function handleCleanupSessions({ req, res, body, ctx }) {
  const url = new URL(req.url, 'http://x');
  const olderThan = (body && body.older_than) || url.searchParams.get('older_than') || '1 hour';
  if (!CLEANUP_OLDER_THAN_ALLOWED.has(olderThan)) {
    return send(res, 422, {
      error: 'invalid older_than',
      allowed: [...CLEANUP_OLDER_THAN_ALLOWED],
    });
  }
  const r = await fleetDb.deleteClosedSessions(ctx.db, olderThan);
  send(res, 200, { deleted: r.deleted, limited: r.limited, older_than: olderThan });
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
  // vt-0126: content is forwarded as a single WS frame to the daemon — cap
  // at 128 KiB. The daemon's allowlist (CLAUDE.md, settings.json) is far
  // smaller in practice; an unbounded body would OOM both sides.
  const MAX_FILE_BYTES = 128 * 1024;
  if (Buffer.byteLength(body.content, 'utf8') > MAX_FILE_BYTES) {
    return send(res, 413, { error: `file content exceeds ${MAX_FILE_BYTES} bytes` });
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
  const cost = await fleetCost.sessionCost(ctx.tokmonDb, ctx.db, host.name, s.started_at, s.ended_at, s.id);
  send(res, 200, { session_id: s.id, host: host.name, ...cost });
}

// Batch cost lookup — replaces N concurrent /sessions/:id/cost calls from the
// archive page (one tokmon query instead of 50). Body: { ids: ['uuid', ...] }.
async function handleSessionCostBatch({ req, res, body, ctx }) {
  if (!body || !Array.isArray(body.ids)) return send(res, 422, { error: 'ids[] required' });
  if (body.ids.length > 200) return send(res, 422, { error: 'max 200 ids per request' });
  if (!ctx.tokmonDb) return send(res, 503, { error: 'cost data unavailable' });
  // N9 (audit): dedupe before passing to pg ANY($1) — duplicates are silently
  // collapsed by Postgres anyway, but trimming saves cycles and makes the
  // 200-cap apply to unique IDs rather than raw input.
  const ids = [...new Set(body.ids.filter(x => typeof x === 'string' && SID_RE_BARE.test(x)))];
  const costs = await fleetCost.sessionCostBatch(ctx.tokmonDb, ctx.db, ids);
  send(res, 200, costs);
}

// vt-0114: long-term cost timeline backed by fleet_cost_daily_rollup. The
// existing /fleet/cost/timeline only sees rows within tokmon retention
// (90 days default). This endpoint reads the rollup table so the UI can
// render 12-month windows even after events are purged.
async function handleCostRollupTimeline({ req, res, ctx }) {
  const url = new URL(req.url, 'http://x');
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '90', 10), 1), 730);
  const dim = url.searchParams.get('dim') || 'model';
  if (!['model', 'host'].includes(dim)) return send(res, 422, { error: 'dim must be model|host' });
  try {
    const rows = await fleetCost.timelineFromRollup(ctx.db, days, dim);
    send(res, 200, { days, dim, points: rows });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}

async function handleCostSummary({ req, res, ctx }) {
  if (!ctx.tokmonDb) return send(res, 503, { error: 'cost data unavailable (tokmon db not configured)' });
  const url = new URL(req.url, 'http://x');
  const days = parseInt(url.searchParams.get('days') || '7', 10);
  if (!COST_VALID_DAYS.has(days)) return send(res, 422, { error: 'invalid days', allowed: [...COST_VALID_DAYS] });
  const hosts = await fleetDb.listHosts(ctx.db);
  const r = await fleetCost.hostSummary(ctx.tokmonDb, ctx.db, hosts.map(h => h.name), days);
  const result = hosts.map(h => ({
    host_id: h.id, host: h.name, status: h.status,
    usd: r[h.name]?.usd || 0,
    msgs: r[h.name]?.msgs || 0,
    by_model: r[h.name]?.by_model || {},
  }));
  send(res, 200, { days, hosts: result });
}

// Strip both CSI sequences (\x1b[...) — including private-prefix variants like
// \x1b[?2004h — and 2-byte ESC sequences (\x1b7, \x1b8, \x1b], etc.), and OSC
// strings. Also flattens TUI cursor-control noise that survives ANSI removal:
//   - bare \r (cursor-to-col-0) → drop, otherwise renders as newline in <pre>
//   - \b (backspace) → drop
//   - BEL → drop
// Result: readable for archive transcript view. For full TUI fidelity use
// xterm replay (see vt-0116 follow-up).
function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC ...BEL or ...ST
    .replace(/\x1b\[[\d;?<>]*[A-Za-z]/g, '')              // CSI ...final
    .replace(/\x1b[()][\x20-\x7e]/g, '')                  // charset designate
    .replace(/\x1b[78=>cDEHMNOPVZ\\]/g, '')               // simple 2-byte ESC
    .replace(/\r\n/g, '\n')                               // CRLF → LF
    .replace(/\r/g, '')                                   // lone CR drop
    .replace(/[\x07\x08]/g, '');                          // BEL + BS drop
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

// vt-0117: raw transcript bytes — for xterm replay in the archive viewer.
// No stripping; full ANSI/escape stream so TUIs render correctly.
async function handleTranscriptBin(req, res, ctx) {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(new RegExp(`^/fleet/sessions/(${SID_RE})/transcript\\.bin$`, 'i'));
  if (!m) return send(res, 404, { error: 'not found' });
  const rows = await fleetDb.readTranscript(ctx.db, m[1], { sinceSeq: 0, kind: 'pty_out' });
  const buf = Buffer.concat(rows.map(r => r.payload || Buffer.alloc(0)));
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length });
  res.end(buf);
}

// --- Pricing handlers ---

async function handleListPrices({ req, res, ctx }) {
  const u = new URL(req.url, 'http://x');
  const withHistory = u.searchParams.get('history') === '1';
  const where = withHistory ? '' : 'WHERE deleted_at IS NULL';
  const { rows } = await ctx.db.query(`
    SELECT id, match_pattern, priority, valid_from,
           input_per_mtok, output_per_mtok,
           cache_create_per_mtok, cache_read_per_mtok,
           flagged, note, deleted_at, created_at
    FROM fleet_model_prices ${where}
    ORDER BY priority DESC, valid_from DESC`);
  send(res, 200, rows);
}

async function handleCreatePrice({ res, body, ctx }) {
  if (!body || !body.match_pattern || typeof body.input_per_mtok !== 'number' || typeof body.output_per_mtok !== 'number') {
    return send(res, 422, { error: 'match_pattern + numeric input_per_mtok + output_per_mtok required' });
  }
  const { rows } = await ctx.db.query(
    `INSERT INTO fleet_model_prices
       (match_pattern, priority, valid_from,
        input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok,
        flagged, note)
     VALUES ($1, $2, COALESCE($3, now()), $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      body.match_pattern,
      Number.isFinite(body.priority) ? body.priority : 100,
      body.valid_from || null,
      body.input_per_mtok,
      body.output_per_mtok,
      Number.isFinite(body.cache_create_per_mtok) ? body.cache_create_per_mtok : 0,
      Number.isFinite(body.cache_read_per_mtok) ? body.cache_read_per_mtok : 0,
      Boolean(body.flagged),
      body.note || null,
    ]);
  fleetPrices.invalidate();
  send(res, 201, rows[0]);
}

async function handleDeletePrice({ req, res, ctx }) {
  const id = req.url.split('?')[0].split('/')[3];
  await ctx.db.query(`UPDATE fleet_model_prices SET deleted_at = now() WHERE id = $1`, [id]);
  fleetPrices.invalidate();
  res.writeHead(204); res.end();
}

async function handleResolvePrice({ res, body, ctx }) {
  if (!body || !body.model) return send(res, 422, { error: 'model required' });
  const ts = body.at ? new Date(body.at) : new Date();
  const matched = await fleetPrices.priceFor(ctx.db, body.model, ts);
  send(res, 200, { matched, at: ts.toISOString() });
}

// --- Workflow handlers ---

async function handleListWorkflows({ res, ctx }) {
  const rows = await wfDb.listWorkflows(ctx.db);
  send(res, 200, rows);
}

async function handleGetWorkflow({ req, res, ctx }) {
  const id = req.url.split('?')[0].split('/')[3];
  const w = await wfDb.getWorkflow(ctx.db, id);
  if (!w) return send(res, 404, { error: 'not found' });
  send(res, 200, w);
}

// vt-0198: workflow_audit helper. Mirrors auditSecret() in rag-api.js —
// best-effort insert; never blocks the response or surfaces DB errors
// to the client. callerFingerprint is the same shape (sha256[:12] of
// bearer) so the upcoming audit UI can join rows across tables.
function _workflowCallerFp(req) {
  if (!req) return null;
  const auth = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!auth) return null;
  try { return crypto.createHash('sha256').update(auth).digest('hex').slice(0, 12); }
  catch { return null; }
}
async function auditWorkflow(ctx, req, { op, workflow_id = null, run_id = null, outcome = 'ok', definition_sha = null, detail = {}, via = 'http' }) {
  if (!ctx.db) return;
  try {
    await ctx.db.query(
      `INSERT INTO workflow_audit (op, workflow_id, run_id, caller_id, via, outcome, definition_sha, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [op, workflow_id, run_id, _workflowCallerFp(req), via, outcome, definition_sha, JSON.stringify(detail)]
    );
  } catch (e) {
    log.error('workflow_audit_insert_failed', { op, msg: e.message });
  }
}
function _defSha(def) {
  if (!def) return null;
  try { return crypto.createHash('sha256').update(JSON.stringify(def)).digest('hex'); } catch { return null; }
}

async function handleCreateWorkflow({ res, body, ctx, req }) {
  if (!body || !body.name || !body.definition) {
    await auditWorkflow(ctx, req, { op: 'create', outcome: 'denied', detail: { reason: 'validation' } });
    return send(res, 422, { error: 'name + definition required' });
  }
  try { validateDefinition(body.definition); }
  catch (e) {
    await auditWorkflow(ctx, req, { op: 'create', outcome: 'denied', detail: { reason: e.message } });
    return send(res, 422, { error: e.message });
  }
  try {
    const w = await wfDb.createWorkflow(ctx.db, body);
    await auditWorkflow(ctx, req, { op: 'create', workflow_id: w.id, definition_sha: _defSha(body.definition), detail: { name: body.name } });
    send(res, 201, w);
  } catch (e) {
    await auditWorkflow(ctx, req, { op: 'create', outcome: 'error', detail: { msg: e.message } });
    if (/duplicate key/.test(e.message)) return send(res, 409, { error: 'name exists' });
    throw e;
  }
}

async function handlePatchWorkflow({ req, res, body, ctx }) {
  const id = req.url.split('?')[0].split('/')[3];
  if (body && body.definition) {
    try { validateDefinition(body.definition); }
    catch (e) {
      await auditWorkflow(ctx, req, { op: 'patch', workflow_id: id, outcome: 'denied', detail: { reason: e.message } });
      return send(res, 422, { error: e.message });
    }
  }
  // vt-0205: optimistic concurrency
  const expectedVersion = body && Number.isFinite(body.expected_version) ? body.expected_version : undefined;
  const w = await wfDb.updateWorkflow(ctx.db, id, body || {}, expectedVersion);
  if (!w) {
    await auditWorkflow(ctx, req, { op: 'patch', workflow_id: id, outcome: 'denied', detail: { reason: 'not_found' } });
    return send(res, 404, { error: 'not found' });
  }
  if (w.__conflict) {
    await auditWorkflow(ctx, req, { op: 'patch', workflow_id: id, outcome: 'denied', detail: { reason: 'version_conflict' } });
    return send(res, 409, { error: 'version conflict', current: w.current });
  }
  await auditWorkflow(ctx, req, { op: 'patch', workflow_id: id, definition_sha: _defSha(w.definition) });
  send(res, 200, w);
}

async function handleDeleteWorkflow({ req, res, ctx }) {
  const id = req.url.split('?')[0].split('/')[3];
  const r = await wfDb.deleteWorkflow(ctx.db, id);
  if (!r.deleted) {
    await auditWorkflow(ctx, req, { op: 'delete', workflow_id: id, outcome: 'denied', detail: { reason: r.reason || 'not_found' } });
    return send(res, 409, { error: r.reason || 'not found or already deleted' });
  }
  await auditWorkflow(ctx, req, { op: 'delete', workflow_id: id });
  res.writeHead(204); res.end();
}

async function ensureWorkflowRunner(ctx) {
  if (ctx.workflowRunner) return ctx.workflowRunner;
  if (!ctx.db) return null;
  // Concurrency guard: cache the in-flight init promise synchronously so
  // parallel calls await the same single-init, never racing past the guard.
  if (!ctx._workflowRunnerInit) {
    ctx._workflowRunnerInit = (async () => {
      // Orphan stranded runs from previous hub lifetime BEFORE creating new ones
      try { await wfDb.orphanRunningRuns(ctx.db); }
      catch (e) { log.error('orphan_workflow_runs_failed', { msg: e.message }); }
      ctx.workflowRunner = createRunner({
        db: ctx.db,
        spawnClaude: ({ node, prompt, runId, signal }) => spawnClaudeForWorkflow(ctx, node, prompt, runId, signal),
        broadcast: (runId, frame) => ctx.bus.broadcastWorkflow(runId, frame),
      });
      return ctx.workflowRunner;
    })();
  }
  return ctx._workflowRunnerInit;
}

async function handleRunWorkflow({ req, res, body, ctx }) {
  const id = req.url.split('?')[0].split('/')[3];
  const w = await wfDb.getWorkflow(ctx.db, id);
  if (!w) {
    await auditWorkflow(ctx, req, { op: 'run', workflow_id: id, outcome: 'denied', detail: { reason: 'not_found' } });
    return send(res, 404, { error: 'workflow not found' });
  }
  const runner = await ensureWorkflowRunner(ctx);
  const run = await wfDb.createRun(ctx.db, {
    workflowId: w.id,
    snapshot: w.definition,
    state: { inputs: (body && body.inputs) || {} },
  });
  await auditWorkflow(ctx, req, { op: 'run', workflow_id: w.id, run_id: run.id, definition_sha: _defSha(w.definition) });
  if (runner) runner.start(run.id);
  send(res, 201, { run_id: run.id });
}

async function handleListRuns({ req, res, ctx }) {
  const u = new URL(req.url, 'http://x');
  const rows = await wfDb.listRuns(ctx.db, {
    workflowId: u.searchParams.get('workflow_id') || undefined,
    status: u.searchParams.get('status') || undefined,
    limit: parseInt(u.searchParams.get('limit') || '100', 10),
  });
  send(res, 200, rows);
}

async function handleGetRun({ req, res, ctx }) {
  const id = req.url.split('?')[0].split('/')[3];
  const r = await wfDb.getRun(ctx.db, id);
  if (!r) return send(res, 404, { error: 'not found' });
  send(res, 200, r);
}

async function handleCancelRun({ req, res, ctx }) {
  const id = req.url.split('?')[0].split('/')[3];
  const runner = await ensureWorkflowRunner(ctx);
  if (runner) runner.cancel(id);
  // vt-0231: audit. Cancel is an admin-only op (admin gate at outer
  // dispatch); record it so a brief admin compromise leaves a trail.
  await auditWorkflow(ctx, req, { op: 'cancel', run_id: id });
  send(res, 200, { ok: true });
}

// vt-0115: docker stack self-status. The host writes a JSON file every 30s
// via systemd timer (scripts/bin/stack-status-writer.sh); we just serve it.
// Auth-gated — operator-only data, no need to expose container names publicly.
// vt-0113: drill-down — list sessions whose start_at falls on the requested
// day, optionally narrowed by host. The /fleet/cost chart calls this on
// click of a bar segment so the operator can pivot from "$X spent on
// host=Y on day Z" → the actual sessions behind that number.
async function handleSessionsByBucket({ req, res, ctx }) {
  const url = new URL(req.url, 'http://x');
  const day = url.searchParams.get('day');
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return send(res, 422, { error: 'day=YYYY-MM-DD required' });
  }
  const dim = url.searchParams.get('dim') || '';
  const value = url.searchParams.get('value') || '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);

  // vt-0125: drill-down used to silently return ALL sessions for the day when
  // dim was model/group/label (set dim_unfiltered:true). The UI rendered these
  // as "sessions behind the bar" → operator confusion + cross-bucket leaks.
  // Now: each dim narrows correctly, or 422 on invalid dim.
  const args = [day, limit];
  let where = `date_trunc('day', s.started_at) = $1::date`;

  if (dim === 'host') {
    if (!/^[0-9a-f-]{36}$/i.test(value)) {
      return send(res, 422, { error: 'dim=host requires value=<host-uuid>' });
    }
    args.push(value);
    where += ` AND s.host_id = $${args.length}`;
  } else if (dim === 'label') {
    // Cost chart labels sessions by `fleet_sessions.label`, falling back to
    // sentinels "(unlabeled)" / "(external/unlabeled)" for null / non-fleet
    // sessions. Map sentinels back to IS NULL; external rows aren't in
    // fleet_sessions so the bucket is naturally empty.
    if (value === '(unlabeled)' || value === '(external/unlabeled)') {
      where += ` AND s.label IS NULL`;
    } else {
      args.push(value);
      where += ` AND s.label = $${args.length}`;
    }
  } else if (dim === 'group') {
    if (value === '(ungrouped)') {
      where += ` AND NOT EXISTS (SELECT 1 FROM fleet_host_groups hg WHERE hg.host_id = s.host_id)`;
    } else {
      args.push(value);
      where += ` AND EXISTS (
        SELECT 1 FROM fleet_host_groups hg JOIN fleet_groups g ON g.id = hg.group_id
        WHERE hg.host_id = s.host_id AND g.name = $${args.length}
      )`;
    }
  } else if (dim === 'model') {
    if (!ctx.tokmonDb) {
      return send(res, 503, { error: 'dim=model requires tokmon db' });
    }
    // Find session_ids on `day` with at least one event for the model.
    const { rows: matchingIds } = await ctx.tokmonDb.query(
      `SELECT DISTINCT session_id
       FROM events
       WHERE date_trunc('day', ts) = $1::date AND model = $2
         AND session_id ~ '^[0-9a-f-]{36}$'`,
      [day, value]);
    const ids = matchingIds.map(r => r.session_id);
    if (!ids.length) {
      return send(res, 200, { day, dim, value, dim_unfiltered: false, sessions: [] });
    }
    args.push(ids);
    where += ` AND s.id::text = ANY($${args.length})`;
  } else if (dim) {
    return send(res, 422, { error: `unsupported dim: ${dim} (expected host|label|group|model)` });
  }

  const { rows } = await ctx.db.query(
    `SELECT s.id, s.label, s.started_at, s.ended_at, s.status, s.exit_code,
            s.host_id, h.name AS host_name, h.display_name AS host_display
     FROM fleet_sessions s
     LEFT JOIN fleet_hosts h ON h.id = s.host_id
     WHERE ${where}
     ORDER BY s.started_at DESC
     LIMIT $2`, args);
  send(res, 200, { day, dim, value, dim_unfiltered: false, sessions: rows });
}

async function handleStackStatus({ res, ctx }) {
  const fs = require('node:fs');
  const path = require('node:path');
  const p = process.env.VAULT_RAG_STACK_STATUS_FILE
    || path.resolve(__dirname, '..', '..', 'agent-fleet', 'stack-status.json');
  try {
    const stat = fs.statSync(p);
    const ageMs = Date.now() - stat.mtimeMs;
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    parsed.age_ms = ageMs;
    parsed.stale = ageMs > 90_000;   // writer ticks every 30s; 90s = missed 3
    send(res, 200, parsed);
  } catch (e) {
    send(res, 503, { error: 'stack status unavailable', detail: e.message });
  }
}

async function handleListPendingApprovals({ res, ctx }) {
  const rows = await wfDb.listPendingApprovals(ctx.db);
  send(res, 200, rows);
}

async function handleApprovalDecision({ req, res, body, ctx }) {
  // POST /fleet/workflow-runs/:runId/approvals/:nodeId  {decision, by, note}
  const m = req.url.match(new RegExp(`^/fleet/workflow-runs/(${SID_RE})/approvals/([\\w.-]+)$`, 'i'));
  if (!m) return send(res, 404, { error: 'not found' });
  if (!body || !['approve', 'reject'].includes(body.decision)) {
    return send(res, 422, { error: 'decision must be approve or reject' });
  }
  const row = await wfDb.recordApprovalDecision(ctx.db, m[1], m[2], {
    decision: body.decision, decided_by: body.by, note: body.note,
  });
  if (!row) {
    await auditWorkflow(ctx, req, { op: body.decision, run_id: m[1], outcome: 'denied', detail: { node: m[2], reason: 'already_decided' } });
    return send(res, 409, { error: 'no pending approval matches (already decided?)' });
  }
  // vt-0231: audit approval/reject — these gate whether an RCE-capable
  // workflow continues. By definition needs the same forensic trail.
  await auditWorkflow(ctx, req, { op: body.decision, run_id: m[1], detail: { node: m[2], by: body.by } });
  send(res, 200, row);
}

async function handleFireWorkflowEvent({ req, res, body, ctx }) {
  // POST /fleet/workflow-events  {name, payload}
  if (!body || !body.name) return send(res, 422, { error: 'name required' });
  const n = await wfDb.fireEvent(ctx.db, body.name, body.payload);
  // vt-0231: audit event fire — can unblock waiting workflows.
  await auditWorkflow(ctx, req, { op: 'fire_event', detail: { name: body.name, fired: n } });
  send(res, 200, { fired: n });
}

async function handleSetWorkflowTrigger({ req, res, body, ctx }) {
  // PUT /fleet/workflows/:id/trigger  {every_ms?: number} or {} to clear
  const m = req.url.match(new RegExp(`^/fleet/workflows/(${SID_RE})/trigger$`, 'i'));
  if (!m) return send(res, 404, { error: 'not found' });
  const trigger = body && Object.keys(body).length ? body : null;
  if (trigger && trigger.every_ms != null) {
    const ms = Number(trigger.every_ms);
    if (!Number.isFinite(ms) || ms < 60000) {
      return send(res, 422, { error: 'every_ms must be a number ≥ 60000' });
    }
  }
  await wfDb.setWorkflowTrigger(ctx.db, m[1], trigger);
  // vt-0231: audit trigger changes — adding a recurring trigger to a
  // malicious workflow is the classic post-compromise persistence move.
  await auditWorkflow(ctx, req, { op: trigger ? 'trigger_set' : 'trigger_clear', workflow_id: m[1], detail: trigger || {} });
  send(res, 200, { ok: true, trigger });
}

// Spawn a claude session and wait for completion, returning {output, exit_code, session_id}.
// Used by workflow runner as deps.spawnClaude. signal (optional AbortSignal) lets
// runner.cancel() short-circuit the poll loop instead of waiting full timeout_s.
async function spawnClaudeForWorkflow(ctx, node, prompt, runId, signal) {
  const t = node.target || {};
  const all = await fleetDb.listHosts(ctx.db);
  let candidates = all.filter(h => h.status === 'online');
  if (t.host_id)   candidates = candidates.filter(h => h.id === t.host_id);
  if (t.host_name) candidates = candidates.filter(h => h.name === t.host_name || h.display_name === t.host_name);
  // Effective tag/capability: direct h.capabilities ∪ group labels — matches handleDispatch (vt-0079)
  if (t.tag) {
    const taggedHosts = await fleetDb.listHostsByEffectiveTag(ctx.db, t.tag);
    const taggedIds = new Set(taggedHosts.map(h => h.id));
    candidates = candidates.filter(h => taggedIds.has(h.id));
  }
  if (t.capability) {
    const taggedHosts = await fleetDb.listHostsByEffectiveTag(ctx.db, t.capability);
    const taggedIds = new Set(taggedHosts.map(h => h.id));
    candidates = candidates.filter(h => taggedIds.has(h.id));
  }
  if (t.group) {
    const g = await fleetDb.getGroupByName(ctx.db, t.group);
    if (!g) throw new Error(`group not found: ${t.group}`);
    const members = await fleetDb.listHostsInGroup(ctx.db, g.id);
    const memberIds = new Set(members.map(h => h.id));
    candidates = candidates.filter(h => memberIds.has(h.id));
  }
  if (!candidates.length) throw new Error('no online host matches target');
  const host = candidates[0];

  const args = node.headless === false
    ? (node.args || [])
    : ['-p', prompt, ...(node.args || [])];
  const s = await fleetDb.createSession(ctx.db, {
    hostId: host.id, cwd: node.cwd || '~',
    args, env: node.env || {},
    createdBy: 'workflow',
    label: `wf-run-${runId.slice(0, 8)}/${node.id}`,
    metadata: { workflow_run_id: runId, workflow_node_id: node.id },
  });
  ctx.bus.requestSpawn(host.id, { session_id: s.id, cwd: s.cwd, args: s.args, env: s.env });

  const startedAt = Date.now();
  const timeoutMs = (node.timeout_s || 600) * 1000;
  while (true) {
    if (signal && signal.aborted) {
      ctx.bus.sendKill(s.id, host.id, 'SIGTERM');
      return { output: '[cancelled]', exit_code: -1, session_id: s.id };
    }
    if (Date.now() - startedAt > timeoutMs) {
      ctx.bus.sendKill(s.id, host.id, 'SIGTERM');
      return { output: '[timeout]', exit_code: 124, session_id: s.id };
    }
    // Jitter ±150ms so N concurrent workflow nodes don't align getSession
    // queries on 500ms boundaries (audit §7.3).
    await new Promise(r => setTimeout(r, 400 + Math.random() * 200));
    const cur = await fleetDb.getSession(ctx.db, s.id);
    if (!cur) return { output: '', exit_code: -1, session_id: s.id };
    if (['exited','killed','orphaned'].includes(cur.status)) {
      const events = await fleetDb.readTranscript(ctx.db, s.id, { kind: 'pty_out', limit: 10000 });
      const merged = Buffer.concat(events.map(e => e.payload || Buffer.alloc(0)));
      const output = merged.toString('utf8').slice(0, 65536);
      return { output, exit_code: cur.exit_code, session_id: s.id };
    }
  }
}

function dispatchHttp(req, res, ctx) {
  const method = req.method;
  const path = req.url.split('?')[0];

  // Static + index served before auth (page is public; APIs still gated)
  if (method === 'GET' && (path === '/fleet/' || path === '/fleet' || path.startsWith('/fleet/static/'))) {
    if (fleetStatic.serve(req, res)) return;
  }
  // Daemon download artifacts (tarball/deb/rpm/install scripts) served
  // unauthenticated — the install path is `curl | sudo bash` from a fresh
  // host that doesn't yet have a token. The bearer is supplied to the
  // installed daemon via /etc/agent-fleet/daemon.env, not at download time.
  //
  // N10 (audit): rate-limit these endpoints at the reverse proxy. Anyone
  // can scrape them to fingerprint the deployment + bot the install command
  // at scale. The Caddyfile in front of vault-rag-api should add a
  // `rate_limit` directive scoped to /fleet/download/* and /fleet/install*.
  // (Not enforced at the API layer because the same allowlist gates abuse
  // server-side already, and rate-limit state is better kept at the proxy.)
  if (method === 'GET' && path.startsWith('/fleet/download/')) {
    if (fleetStatic.serveDownload(req, res)) return;
  }
  if (method === 'GET' && (
      path === '/fleet/install.sh' ||
      path === '/fleet/install-macos.sh' ||
      path === '/fleet/install-windows.ps1'
  )) {
    if (fleetStatic.serveDownload(req, res)) return;
  }
  // healthz before auth
  if (method === 'GET' && path === '/fleet/healthz') {
    return send(res, 200, { ok: true });
  }
  // vt-0274: vmalert sink. No-auth because vmalert lives inside
  // vault-rag-net and the endpoint only writes a log line — it can't
  // mutate any state or read protected data. Same trust model as
  // secrets-server /metrics. Caddy never exposes /fleet/_alert-sink
  // externally (proxy lets it pass, but caller must reach the docker
  // bridge to abuse). For paranoid setups bind vmalert directly to
  // host loopback instead.
  if (method === 'POST' && path === '/fleet/_alert-sink') {
    return readBody(req, { maxBytes: 256 * 1024 }).then(b => {
      const alerts = Array.isArray(b?.alerts) ? b.alerts : [];
      for (const a of alerts) {
        log.warn('alert_fired', {
          name: a.labels?.alertname || 'unknown',
          severity: a.labels?.severity || 'unknown',
          service: a.labels?.service || null,
          state: a.status || null,
          summary: a.annotations?.summary || null,
          value: a.value || null,
          starts_at: a.startsAt || null,
        });
      }
      send(res, 204, {});
    }).catch(e => send(res, 400, { error: e.message }));
  }
  if (!checkAuth(req, ctx.token) && !(ctx.adminToken && checkAdminAuth(req, ctx))) {
    return send(res, 401, { error: 'unauthorized' });
  }
  // vt-0124: gate mutating + execution endpoints behind the admin token (when
  // configured). Viewer bearer alone gets reads only.
  if (isAdminPath(method, path) && !checkAdminAuth(req, ctx)) {
    return send(res, 403, { error: 'admin token required for this operation' });
  }

  // vt-0150: shared backend → config-files map (web UI consults this to
  // render per-host edit buttons). Static; no DB hit.
  if (method === 'GET' && path === '/fleet/backend-configs') {
    return send(res, 200, require('./backend-configs').BACKEND_CONFIGS);
  }

  // hosts
  if (method === 'GET'    && path === '/fleet/hosts')   return handleGetHosts({ req, res, ctx });
  if (method === 'GET'    && new RegExp(`^/fleet/hosts/${SID_RE}$`, 'i').test(path)) return handleGetHost({ req, res, ctx });
  if (method === 'DELETE' && new RegExp(`^/fleet/hosts/${SID_RE}$`, 'i').test(path)) return handleDeleteHost({ req, res, ctx });
  if (method === 'PATCH'  && new RegExp(`^/fleet/hosts/${SID_RE}$`, 'i').test(path)) {
    return readBody(req).then(b => handlePatchHost({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'POST'   && path === '/fleet/dispatch') {
    return readBody(req).then(b => handleDispatch({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'POST'   && path === '/fleet/exec') {
    return readBody(req).then(b => handleExec({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'GET' && new RegExp(`^/fleet/hosts/${SID_RE}/metrics$`, 'i').test(path))    return handleHostMetrics({ req, res, ctx });
  if (method === 'GET' && new RegExp(`^/fleet/hosts/${SID_RE}/inventory$`, 'i').test(path))  return handleHostInventory({ req, res, ctx });
  if (method === 'GET'    && new RegExp(`^/fleet/hosts/${SID_RE}/file$`, 'i').test(path)) return handleHostFileGet({ req, res, ctx });
  if (method === 'PUT'    && new RegExp(`^/fleet/hosts/${SID_RE}/file$`, 'i').test(path)) {
    // vt-0126: 256 KiB cap at the wire — handler also rejects content > 128 KiB
    // explicitly so partial reads still produce a clean 413.
    return readBody(req, { maxBytes: 256 * 1024 }).then(b => handleHostFilePut({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }

  // sessions
  if (method === 'GET'  && path === '/fleet/sessions') return handleListSessions({ req, res, ctx });
  if (method === 'POST' && path === '/fleet/sessions') {
    return readBody(req).then(b => handleCreateSession({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'POST' && path === '/fleet/sessions/cleanup') {
    return readBody(req).then(b => handleCleanupSessions({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'POST' && path === '/fleet/sessions/cost-batch') {
    return readBody(req).then(b => handleSessionCostBatch({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'PATCH' && new RegExp(`^/fleet/sessions/${SID_RE}$`, 'i').test(path)) {
    return readBody(req).then(b => handlePatchSession({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'GET' && new RegExp(`^/fleet/sessions/${SID_RE}/timeline$`, 'i').test(path)) {
    return handleSessionTimeline({ req, res, ctx });
  }
  if (method === 'POST' && path === '/fleet/broadcast') {
    return readBody(req).then(b => handleBroadcast({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'GET' && path === '/fleet/cost/timeline') return handleCostTimeline({ req, res, ctx });

  // vt-0225: recycle bin endpoints. GET lists soft-deleted; POST restores.
  // vt-0269: paginated. ?limit=&offset= (defaults 100/0, cap 500).
  if (method === 'GET' && path.startsWith('/fleet/recycle-bin')) {
    const u = new URL('http://x' + req.url);
    const limit  = parseInt(u.searchParams.get('limit')  || '100', 10);
    const offset = parseInt(u.searchParams.get('offset') || '0',  10);
    return Promise.all([
      fleetDb.listDeletedGroups(ctx.db, { limit, offset }),
      require('./fleet-workflow-db').listDeletedWorkflows(ctx.db, { limit, offset }),
    ]).then(([groups, workflows]) => send(res, 200, { groups, workflows }))
      .catch(e => send(res, 500, { error: e.message }));
  }
  if (method === 'POST' && new RegExp(`^/fleet/groups/${SID_RE}/restore$`, 'i').test(path)) {
    const id = path.split('/')[3];
    return fleetDb.restoreGroup(ctx.db, id).then(g =>
      g ? send(res, 200, g) : send(res, 404, { error: 'not found in trash' })
    ).catch(e => send(res, 500, { error: e.message }));
  }
  if (method === 'POST' && new RegExp(`^/fleet/workflows/${SID_RE}/restore$`, 'i').test(path)) {
    const id = path.split('/')[3];
    return require('./fleet-workflow-db').restoreWorkflow(ctx.db, id).then(w =>
      w ? send(res, 200, w) : send(res, 404, { error: 'not found in trash' })
    ).catch(e => send(res, 500, { error: e.message }));
  }

  // vt-0259: Agent roles. List is viewer; mutations are admin (handled by
  // the outer isAdminPath gate). assign/unassign hang under /fleet/groups/.
  // vt-0267: viewer bearer gets the redacted shape (prompt → prompt_sha,
  // prompt_bytes) so it never sees the raw prompt text. Admin bearer
  // gets the full row.
  if (method === 'GET'    && path === '/fleet/agent-roles') {
    const isAdmin = ctx.adminToken && checkAdminAuth(req, ctx);
    const fn = isAdmin ? fleetDb.listAgentRoles : fleetDb.listAgentRolesSummary;
    return fn(ctx.db).then(rs => send(res, 200, rs))
      .catch(e => send(res, 500, { error: e.message }));
  }
  if (method === 'POST'   && path === '/fleet/agent-roles') {
    return readBody(req).then(async (b) => {
      if (!b.name || typeof b.name !== 'string' || b.name.length > 64) {
        return send(res, 422, { error: 'name required (string, <=64 chars)' });
      }
      if (!b.prompt || typeof b.prompt !== 'string') {
        return send(res, 422, { error: 'prompt required (string)' });
      }
      if (b.prompt.length > 32768) return send(res, 422, { error: 'prompt too long (max 32768 chars)' });
      try {
        const r = await fleetDb.createAgentRole(ctx.db, {
          name: b.name, description: b.description, prompt: b.prompt,
          default_model: b.default_model, allowed_tools: b.allowed_tools,
        });
        send(res, 201, r);
      } catch (e) {
        if (/duplicate key|unique/i.test(e.message)) return send(res, 409, { error: 'name already exists' });
        send(res, 500, { error: e.message });
      }
    }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'GET'    && new RegExp(`^/fleet/agent-roles/${SID_RE}$`, 'i').test(path)) {
    const id = path.split('/')[3];
    const isAdmin = ctx.adminToken && checkAdminAuth(req, ctx);
    return fleetDb.getAgentRole(ctx.db, id).then(r => {
      if (!r) return send(res, 404, { error: 'role not found' });
      if (isAdmin) return send(res, 200, r);
      // vt-0267: redact prompt for viewer; keep sha + size for "is this the
      // role I think it is" UI checks.
      const crypto = require('node:crypto');
      const summary = {
        ...r,
        prompt_bytes: Buffer.byteLength(r.prompt || '', 'utf8'),
        prompt_sha: crypto.createHash('sha256').update(r.prompt || '').digest('hex'),
      };
      delete summary.prompt;
      send(res, 200, summary);
    }).catch(e => send(res, 500, { error: e.message }));
  }
  if (method === 'PATCH'  && new RegExp(`^/fleet/agent-roles/${SID_RE}$`, 'i').test(path)) {
    const id = path.split('/')[3];
    return readBody(req).then(async (b) => {
      if (b.prompt !== undefined && (typeof b.prompt !== 'string' || b.prompt.length > 32768)) {
        return send(res, 422, { error: 'prompt invalid (string, <=32768)' });
      }
      if (b.name !== undefined && (typeof b.name !== 'string' || b.name.length > 64)) {
        return send(res, 422, { error: 'name invalid' });
      }
      const r = await fleetDb.updateAgentRole(ctx.db, id, b);
      r ? send(res, 200, r) : send(res, 404, { error: 'role not found' });
    }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'DELETE' && new RegExp(`^/fleet/agent-roles/${SID_RE}$`, 'i').test(path)) {
    const id = path.split('/')[3];
    return fleetDb.deleteAgentRole(ctx.db, id).then(() => send(res, 204, {}))
      .catch(e => send(res, 500, { error: e.message }));
  }
  if (method === 'GET'    && new RegExp(`^/fleet/groups/${SID_RE}/roles$`, 'i').test(path)) {
    const id = path.split('/')[3];
    const isAdmin = ctx.adminToken && checkAdminAuth(req, ctx);
    return fleetDb.listGroupRoles(ctx.db, id).then(rs => {
      if (!isAdmin) {
        // vt-0267: redact prompt for viewers.
        const crypto = require('node:crypto');
        for (const r of rs) {
          r.prompt_bytes = Buffer.byteLength(r.prompt || '', 'utf8');
          r.prompt_sha = crypto.createHash('sha256').update(r.prompt || '').digest('hex');
          delete r.prompt;
        }
      }
      send(res, 200, rs);
    }).catch(e => send(res, 500, { error: e.message }));
  }
  // vt-0271: atomic batch reorder. Caller PUTs the full ordered role-id
  // array; we replace all assignments for the group in a single tx.
  if (method === 'PUT'    && new RegExp(`^/fleet/groups/${SID_RE}/roles$`, 'i').test(path)) {
    const groupId = path.split('/')[3];
    return readBody(req).then(async (b) => {
      if (!Array.isArray(b.role_ids)) return send(res, 422, { error: 'role_ids array required' });
      if (b.role_ids.length > 8) return send(res, 422, { error: 'max 8 roles per group' });
      // Validate each role exists and is not soft-deleted.
      for (const rid of b.role_ids) {
        const r = await fleetDb.getAgentRole(ctx.db, rid);
        if (!r) return send(res, 404, { error: `role not found: ${rid}` });
      }
      await fleetDb.reorderGroupRoles(ctx.db, groupId, b.role_ids);
      send(res, 200, { group_id: groupId, role_ids: b.role_ids });
    }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'POST'   && new RegExp(`^/fleet/groups/${SID_RE}/roles$`, 'i').test(path)) {
    const groupId = path.split('/')[3];
    return readBody(req).then(async (b) => {
      if (!b.role_id) return send(res, 422, { error: 'role_id required' });
      const role = await fleetDb.getAgentRole(ctx.db, b.role_id);
      if (!role) return send(res, 404, { error: 'role not found' });
      const grp = await fleetDb.getGroup(ctx.db, groupId);
      if (!grp) return send(res, 404, { error: 'group not found' });
      // vt-0264: cap composition. Hard limits: ≤ MAX_ROLES_PER_GROUP roles,
      // and combined-prompt size (brain + roles + 4 KiB headroom for the
      // per-call refinement) ≤ MAX_COMBINED_BYTES. Reject loudly at
      // assignment, not at dispatch (ARG_MAX-on-daemon is a confusing
      // place to debug "too many roles").
      const MAX_ROLES_PER_GROUP = 8;
      const MAX_COMBINED_BYTES  = 65536;
      const existing = await fleetDb.listGroupRoles(ctx.db, groupId);
      if (existing.some(r => r.id === b.role_id)) {
        // Re-assigning an existing role just updates position — skip cap.
      } else if (existing.length >= MAX_ROLES_PER_GROUP) {
        return send(res, 422, { error: `group already has ${MAX_ROLES_PER_GROUP} roles (max)` });
      } else {
        const brainBytes = Buffer.byteLength(grp.brain_prompt || '', 'utf8');
        const existingBytes = existing.reduce((sum, r) => sum + Buffer.byteLength(r.prompt || '', 'utf8'), 0);
        const newBytes = Buffer.byteLength(role.prompt || '', 'utf8');
        const headroom = 4096;
        const total = brainBytes + existingBytes + newBytes + headroom;
        if (total > MAX_COMBINED_BYTES) {
          return send(res, 422, {
            error: `combined prompt would exceed ${MAX_COMBINED_BYTES} bytes (current ${brainBytes + existingBytes}, role adds ${newBytes}, +${headroom} headroom)`,
          });
        }
      }
      await fleetDb.assignRoleToGroup(ctx.db, groupId, b.role_id,
        Number.isFinite(b.position) ? b.position : 0);
      send(res, 201, { group_id: groupId, role_id: b.role_id });
    }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'DELETE' && new RegExp(`^/fleet/groups/${SID_RE}/roles/${SID_RE}$`, 'i').test(path)) {
    const parts = path.split('/');
    const groupId = parts[3];
    const roleId  = parts[5];
    return fleetDb.unassignRoleFromGroup(ctx.db, groupId, roleId)
      .then(() => send(res, 204, {}))
      .catch(e => send(res, 500, { error: e.message }));
  }

  // Groups
  if (method === 'GET'    && path === '/fleet/groups') return handleListGroups({ req, res, ctx });
  if (method === 'GET'    && new RegExp(`^/fleet/groups/${SID_RE}$`, 'i').test(path)) return handleGetGroup({ req, res, ctx });
  if (method === 'POST'   && path === '/fleet/groups') {
    return readBody(req).then(b => handleCreateGroup({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'PATCH'  && new RegExp(`^/fleet/groups/${SID_RE}$`, 'i').test(path)) {
    return readBody(req).then(b => handlePatchGroup({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'DELETE' && new RegExp(`^/fleet/groups/${SID_RE}$`, 'i').test(path)) return handleDeleteGroup({ req, res, ctx });
  if (method === 'POST'   && new RegExp(`^/fleet/groups/${SID_RE}/hosts$`, 'i').test(path)) {
    return readBody(req).then(b => handleGroupAddHost({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'DELETE' && new RegExp(`^/fleet/groups/${SID_RE}/hosts/${SID_RE}$`, 'i').test(path)) {
    return handleGroupRemoveHost({ req, res, ctx });
  }
  if (method === 'GET' && new RegExp(`^/fleet/sessions/${SID_RE}$`, 'i').test(path)) return handleGetSession({ req, res, ctx });
  if (method === 'POST' && new RegExp(`^/fleet/sessions/${SID_RE}/input$`, 'i').test(path)) {
    return readBody(req).then(b => handlePostInput({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'POST' && new RegExp(`^/fleet/sessions/${SID_RE}/kill$`, 'i').test(path)) {
    return readBody(req).then(b => handlePostKill({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'GET' && new RegExp(`^/fleet/sessions/${SID_RE}/transcript\\.txt$`, 'i').test(path)) {
    return handleTranscriptTxt(req, res, ctx);
  }
  if (method === 'GET' && new RegExp(`^/fleet/sessions/${SID_RE}/transcript\\.bin$`, 'i').test(path)) {
    return handleTranscriptBin(req, res, ctx);
  }

  // Cost
  if (method === 'GET' && new RegExp(`^/fleet/sessions/${SID_RE}/cost$`, 'i').test(path)) {
    return handleSessionCost({ req, res, ctx });
  }
  if (method === 'GET' && path === '/fleet/cost/summary') return handleCostSummary({ req, res, ctx });

  // Pricing
  if (method === 'GET'    && path === '/fleet/prices')               return handleListPrices({ req, res, ctx });
  if (method === 'POST'   && path === '/fleet/prices') {
    return readBody(req).then(b => handleCreatePrice({ res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'POST'   && path === '/fleet/prices/resolve') {
    return readBody(req).then(b => handleResolvePrice({ res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'DELETE' && /^\/fleet\/prices\/\d+$/.test(path))    return handleDeletePrice({ req, res, ctx });

  // Workflows
  if (method === 'GET'    && path === '/fleet/workflows') return handleListWorkflows({ res, ctx });
  if (method === 'POST'   && path === '/fleet/workflows') {
    return readBody(req).then(b => handleCreateWorkflow({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'POST'   && new RegExp(`^/fleet/workflows/${SID_RE}/run$`, 'i').test(path)) {
    return readBody(req).then(b => handleRunWorkflow({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'GET'    && new RegExp(`^/fleet/workflows/${SID_RE}$`, 'i').test(path)) return handleGetWorkflow({ req, res, ctx });
  if (method === 'PATCH'  && new RegExp(`^/fleet/workflows/${SID_RE}$`, 'i').test(path)) {
    return readBody(req).then(b => handlePatchWorkflow({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'DELETE' && new RegExp(`^/fleet/workflows/${SID_RE}$`, 'i').test(path)) return handleDeleteWorkflow({ req, res, ctx });
  if (method === 'PUT'    && new RegExp(`^/fleet/workflows/${SID_RE}/trigger$`, 'i').test(path)) {
    return readBody(req).then(b => handleSetWorkflowTrigger({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }

  // Workflow runs
  if (method === 'GET'    && path === '/fleet/workflow-runs') return handleListRuns({ req, res, ctx });
  if (method === 'POST'   && new RegExp(`^/fleet/workflow-runs/${SID_RE}/cancel$`, 'i').test(path)) return handleCancelRun({ req, res, ctx });
  if (method === 'POST'   && new RegExp(`^/fleet/workflow-runs/${SID_RE}/approvals/[\\w.-]+$`, 'i').test(path)) {
    return readBody(req).then(b => handleApprovalDecision({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }
  if (method === 'GET'    && new RegExp(`^/fleet/workflow-runs/${SID_RE}$`, 'i').test(path)) return handleGetRun({ req, res, ctx });

  // Stack status (docker compose health for the operator)
  if (method === 'GET' && path === '/fleet/stack-status') return handleStackStatus({ res, ctx });
  // Cost-chart drill-down: sessions in a bucket
  if (method === 'GET' && path === '/fleet/sessions/by-bucket') return handleSessionsByBucket({ req, res, ctx });
  // Long-term cost timeline (post-retention) from rollup table
  if (method === 'GET' && path === '/fleet/cost/rollup-timeline') return handleCostRollupTimeline({ req, res, ctx });

  // Pending approvals + events
  if (method === 'GET'  && path === '/fleet/workflow-pending-approvals') return handleListPendingApprovals({ res, ctx });
  if (method === 'POST' && path === '/fleet/workflow-events') {
    return readBody(req).then(b => handleFireWorkflowEvent({ res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }

  // vt-0136: short-lived WS ticket for browsers. Lets us drop bearer.<token>
  // out of Sec-WebSocket-Protocol (where it leaks into DevTools + proxy logs).
  if (method === 'POST' && path === '/fleet/auth/ws-ticket') {
    return readBody(req).then(b => handleWsTicket({ req, res, body: b, ctx })).catch(e => send(res, e.statusCode || 400, { error: e.message }));
  }

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

  // Circuit-breaker: after 3 consecutive frame-handler exceptions on this WS,
  // close with 1011 so the daemon reconnects and triggers reconciliation
  // rather than keep pumping frames into a broken pipe (e.g. DB read-only).
  let consecutiveErrs = 0;

  async function dispatchFrame(f) {
      if (f.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
      if (f.type === 'hello') {
        // vt-0178: filter installed_backends to known names from
        // BACKEND_CONFIGS — a compromised daemon could otherwise send
        // arbitrary keys ("<script>", "../etc/passwd") that the UI
        // would iterate and surface as edit buttons.
        let filteredBackends = null;
        if (f.backends && typeof f.backends === 'object') {
          const { BACKEND_CONFIGS } = require('./backend-configs');
          const known = new Set(Object.keys(BACKEND_CONFIGS));
          filteredBackends = {};
          for (const [k, v] of Object.entries(f.backends)) {
            if (known.has(k)) filteredBackends[k] = v;
          }
        }
        // vt-0187: upsertHost + setHostMetadata are one logical write
        // (host hello frame). Wrap in a transaction so a crash between
        // them doesn't leave hostInfo stale.
        await withTx(ctx, async (c) => {
          await fleetDb.upsertHost(c, {
            name: hostName,
            os: f.os, arch: f.arch,
            capabilities: f.capabilities || [],
            daemonVersion: params.get('daemon_version'),
            claudeVersion: f.claude_version,
            backends: filteredBackends,
          });
          if (f.host_info && typeof f.host_info === 'object') {
            // vt-0177: allowlist host_info keys before merging into metadata.
            const ALLOWED = new Set([
              'os', 'kernel', 'kernel_version', 'distro', 'arch',
              'cpu_model', 'cpu_cores', 'cpu_threads',
              'ram_total_bytes', 'ram_free_bytes',
              'uptime_seconds', 'hostname', 'load1', 'load5', 'load15',
              'docker_version', 'node_version',
            ]);
            const safe = {};
            for (const [k, v] of Object.entries(f.host_info)) {
              if (ALLOWED.has(k)) safe[k] = v;
            }
            await fleetDb.setHostMetadata(c, host.id, safe);
          }
        });
        return;
      }
      // vt-0251: daemon sends 'bye' before clean shutdown with the list
      // of session_ids it's about to SIGTERM. Mark every OTHER running
      // session on this host as 'orphaned' (the daemon won't be there to
      // reconcile when it comes back). Listed sessions stay 'running' so
      // they're picked up by reconciliation on reconnect.
      if (f.type === 'bye') {
        const aliveSet = new Set(Array.isArray(f.alive_sessions) ? f.alive_sessions : []);
        try {
          const r = await ctx.db.query(
            `SELECT id FROM fleet_sessions WHERE host_id = $1 AND status = 'running'`, [host.id]);
          for (const row of r.rows) {
            if (!aliveSet.has(row.id)) {
              await fleetDb.markSessionExited(ctx.db, row.id, null, 'orphaned');
            }
          }
        } catch (e) { log.error('bye_reconcile_failed', { host_id: host.id, msg: e.message }); }
        return;
      }
      if (f.type === 'spawn_ok') {
        await fleetDb.markSessionRunning(ctx.db, f.session_id, f.pid);
        ctx.bus.broadcastViewers(f.session_id, { type: 'session_started', session_id: f.session_id });
        return;
      }
      if (f.type === 'spawn_err') {
        await fleetDb.markSessionExited(ctx.db, f.session_id, -1, 'exited');
        // Emit session_exit so handleExec waiters (and any attached viewer)
        // unblock instead of waiting for the timeout.
        ctx.bus.broadcastViewers(f.session_id, { type: 'session_exit', exit_code: -1 });
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
            // Notify handleExec waiters + viewers attached to a session the
            // daemon reports dead — otherwise their hooks leak in hooksBySession.
            ctx.bus.broadcastViewers(s.session_id, { type: 'session_exit', exit_code: s.exit_code ?? -1 });
          }
        }
        return;
      }
      if (f.type === 'metrics') {
        // vt-0187: atomic — without a tx, a crash between rows leaves the
        // time-series row but stale latest_metrics (or vice versa).
        await withTx(ctx, async (c) => {
          await fleetDb.insertHostMetric(c, host.id, f);
          await fleetDb.setHostLatestMetrics(c, host.id, f);
        });
        ctx.bus.broadcastHostMetrics(host.id, { type: 'metrics', host_id: host.id, ...f });
        return;
      }
      if (f.type === 'inventory') {
        await fleetDb.setHostInventory(ctx.db, host.id, f);
        ctx.bus.broadcastHostMetrics(host.id, { type: 'inventory', host_id: host.id, ...f });
        return;
      }
  }

  ws.on('message', async (raw) => {
    let f;
    try { f = JSON.parse(raw.toString()); } catch { return ws.close(4005, 'invalid frame'); }
    try {
      await dispatchFrame(f);
      consecutiveErrs = 0;
    } catch (e) {
      consecutiveErrs += 1;
      log.error('daemon_frame_error', { count: consecutiveErrs, max: 3, msg: e.message });
      if (consecutiveErrs >= 3) {
        try { ws.close(1011, 'consecutive frame errors'); } catch {}
      }
    }
  });
}

async function handleViewerWs(ws, params, ctx) {
  const sid = params.get('session_id');
  if (!sid) return ws.close(4002, 'session_id required');

  // Buffer incoming frames until session is loaded (avoids race with async DB lookup).
  // vt-0132: cap queue length so a chatty client can't OOM the hub by spamming
  // input frames while we await getSession. 256 is plenty for the ~ms gap.
  const MAX_PENDING_FRAMES = 256;
  let session = null;
  let droppedFrames = 0;
  const queue = [];
  const processFrame = (raw) => {
    let f;
    try { f = JSON.parse(raw.toString()); } catch { return; }
    if (!session) {
      if (queue.length >= MAX_PENDING_FRAMES) { droppedFrames++; return; }
      queue.push(f); return;
    }
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
  if (droppedFrames > 0) {
    try { ws.send(JSON.stringify({ type: 'warn', dropped_frames: droppedFrames, reason: 'pre-ready queue overflow' })); } catch {}
  }
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

async function handleWorkflowViewerWs(ws, params, ctx) {
  const runId = params.get('run_id');
  if (!runId) return ws.close(4002, 'run_id required');
  try {
    const r = await wfDb.getRun(ctx.db, runId);
    if (r) {
      ws.send(JSON.stringify({
        type: 'run_state', run_id: r.id, status: r.status,
        started_at: r.started_at, finished_at: r.finished_at,
      }));
      const outputs = (r.state && r.state.outputs) || {};
      for (const [nodeId, out] of Object.entries(outputs)) {
        ws.send(JSON.stringify({
          type: 'node_progress', run_id: r.id, node_id: nodeId, status: 'done',
          output: out.output, exit_code: out.exit_code, session_id: out.session_id,
        }));
      }
    }
  } catch (e) {
    log.error('workflow_viewer_init_failed', { run_id: runId, msg: e.message });
  }
  ctx.bus.addWorkflowViewer(runId, ws);
}

async function handleMetricsViewerWs(ws, params, ctx) {
  const hostId = params.get('host_id');
  if (!hostId) return ws.close(4002, 'host_id required');
  try {
    const h = await fleetDb.getHost(ctx.db, hostId);
    if (!h) return ws.close(4004, 'host not found');
    const meta = h.metadata || {};
    if (meta.latest_metrics) ws.send(JSON.stringify({ type: 'metrics', host_id: hostId, ...meta.latest_metrics }));
    if (meta.inventory)      ws.send(JSON.stringify({ type: 'inventory', host_id: hostId, ...meta.inventory }));
  } catch (e) { log.error('metrics_viewer_init_failed', { host_id: hostId, msg: e.message }); }
  ctx.bus.addMetricsViewer(hostId, ws);
}

async function handleHostMetrics({ req, res, ctx }) {
  const m = req.url.split('?')[0].match(new RegExp(`^/fleet/hosts/(${SID_RE})/metrics$`, 'i'));
  if (!m) return send(res, 404, { error: 'bad path' });
  const hostId = m[1];
  const u = new URL(req.url, 'http://x');
  const since = u.searchParams.get('since') || '1h';
  const allowedIntervals = { '15m': '15 minutes', '1h': '1 hour', '6h': '6 hours', '24h': '24 hours', '7d': '7 days' };
  const interval = allowedIntervals[since];
  if (!interval) return send(res, 422, { error: `invalid since (allowed: ${Object.keys(allowedIntervals).join(',')})` });
  const downsampled = u.searchParams.get('downsampled') === '1';
  const rows = downsampled
    ? await fleetDb.readMetricsRollupSince(ctx.db, hostId, interval)
    : await fleetDb.readMetricsSince(ctx.db, hostId, interval);
  send(res, 200, rows);
}

async function handleHostInventory({ req, res, ctx }) {
  const m = req.url.split('?')[0].match(new RegExp(`^/fleet/hosts/(${SID_RE})/inventory$`, 'i'));
  if (!m) return send(res, 404, { error: 'bad path' });
  const h = await fleetDb.getHost(ctx.db, m[1]);
  if (!h) return send(res, 404, { error: 'host not found' });
  send(res, 200, (h.metadata && h.metadata.inventory) || {});
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
  // Workflow runner is created lazily on first /run or /cancel — ctx.db may be
  // bound after attach() (see rag-api boot flow). See ensureWorkflowRunner.
  server._fleetCtx = merged;

  // C3 (audit pass 2): per-frame cap. A compromised daemon WS could send
  // an unbounded `pty_data` payload that lands in the ring buffer + transcript
  // batcher. 4 MiB covers any realistic terminal flush; bigger payloads abort
  // the socket.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
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
    // vt-0136: browsers send `ticket.<payload>.<sig>` as a Sec-WebSocket-Protocol
    // entry. Test-harness path doesn't auto-decode, but the wss is constructed
    // without handleProtocols so we have to peek at headers ourselves.
    const proto = req.headers['sec-websocket-protocol'] || '';
    const ticketProto = proto.split(',').map(s => s.trim()).find(s => s.startsWith('ticket.'));
    const ticket = ticketProto ? ticketProto.slice('ticket.'.length) : null;
    wss.handleUpgrade(req, sock, head, (ws) => {
      acceptWsUpgrade(ws, { role, auth, params: u.searchParams, ctx: server._fleetCtx, ticket });
    });
  });
}

// vt-N1 (audit): shared WS-upgrade auth + role dispatch helper. Used by both
// attach() (test harness) and attachUpgrade() (production) so they can't drift.
function acceptWsUpgrade(ws, { role, auth, params, ctx, ticket }) {
  const adminBearer = ctx.adminToken ? `Bearer ${ctx.adminToken}` : null;
  const viewerBearer = `Bearer ${ctx.token}`;
  // Daemon WS executes code on a host — requires admin token when configured.
  // Daemons never use tickets (they hold the long-lived token in their config
  // file and pass it via Authorization header).
  if (role === 'daemon') {
    const needed = adminBearer || viewerBearer;
    if (!tokenEqual(auth, needed)) return ws.close(4001, 'unauthorized');
  } else {
    // vt-0136: browsers may authenticate with a short-lived HMAC ticket
    // instead of the bearer. Daemon-style bearer header is still accepted
    // for CLI tools (vt.js, scripts).
    const viewerOk = tokenEqual(auth, viewerBearer);
    const adminOk = adminBearer && tokenEqual(auth, adminBearer);
    let ticketOk = false;
    if (!viewerOk && !adminOk && ticket) {
      const verified = verifyWsTicket(ctx, ticket);
      if (verified) {
        // vt-0179: single-use guard. Once consumed, the sig hash is parked
        // in _consumedTickets until its natural expiry; a replay 401s.
        const sigHash = _ticketSigHash(ticket);
        if (sigHash && _consumedTickets.has(sigHash)) {
          console.warn(`[fleet-routes] ws ticket replay refused (sig=${sigHash})`);
          return ws.close(4001, 'ticket already used');
        }
        if (sigHash) _consumedTickets.set(sigHash, verified.exp);
        // Ticket role must match (or be a generic 'viewer' that fits the requested role).
        if (verified.role === role || verified.role === 'viewer') ticketOk = true;
      }
    }
    if (!viewerOk && !adminOk && !ticketOk) return ws.close(4001, 'unauthorized');
  }
  if (role !== 'daemon' && role !== 'viewer' && role !== 'workflow_viewer' && role !== 'metrics_viewer') {
    return ws.close(4003, 'invalid role');
  }
  // vt-0136 follow-up: wrap async handlers so unhandled rejections (e.g. pg
  // connection terminated mid-stream) don't bubble out to the process — they
  // close the WS with 1011 and log, instead.
  const dispatch = role === 'daemon'           ? handleDaemonWs
                 : role === 'workflow_viewer'  ? handleWorkflowViewerWs
                 : role === 'metrics_viewer'   ? handleMetricsViewerWs
                 :                                handleViewerWs;
  Promise.resolve(dispatch(ws, params, ctx)).catch((e) => {
    log.error('ws_handler_error', { role, msg: e.stack || e.message });
    try { ws.close(1011, 'internal'); } catch {}
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
      // vt-0180: server-side log keeps the real message; client gets a
      // generic 500 so pg error strings, file paths, or stack content
      // don't leak. Request URL is in the log line for grep.
      log.error('http_handler_error', { url: req.url, msg: e.stack || e.message });
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    });
  return true;
}

function attachUpgrade(server, getCtx) {
  if (server._fleetUpgradeAttached) return;
  server._fleetUpgradeAttached = true;
  // Accept either `ticket.<payload>.<sig>` (vt-0136 preferred) or legacy
  // `bearer.<token>` (deprecated) as the Sec-WebSocket-Protocol entry.
  // C3: per-frame cap (see attach() for rationale).
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
    handleProtocols: (protos) => {
      for (const p of protos) {
        if (p.startsWith('ticket.') || p.startsWith('bearer.')) return p;
      }
      return false;
    },
  });
  server.on('upgrade', (req, sock, head) => {
    if (!req.url.startsWith('/fleet/ws') && !req.url.startsWith('/api/fleet/ws')) return;
    if (req.url.startsWith('/api/')) req.url = req.url.slice(4);
    const u = new URL(req.url, 'http://x');
    const role = u.searchParams.get('role');
    let auth = req.headers.authorization || '';
    let ticket = null;
    const proto = req.headers['sec-websocket-protocol'] || '';
    const parts = proto.split(',').map(s => s.trim());
    if (!auth) {
      const b = parts.find(s => s.startsWith('bearer.'));
      if (b) auth = `Bearer ${b.slice('bearer.'.length)}`;
    }
    const t = parts.find(s => s.startsWith('ticket.'));
    if (t) ticket = t.slice('ticket.'.length);
    wss.handleUpgrade(req, sock, head, (ws) => {
      acceptWsUpgrade(ws, { role, auth, params: u.searchParams, ctx: getCtx(), ticket });
    });
  });
}

function makeContext({ token, adminToken, db, version }) {
  const ctx = { token, adminToken: adminToken || null, db, version };
  ctx.bus = makeBus();
  ctx.rings = new Map();
  ctx.batcher = new EventBatcher({
    flushSize: 50, flushIntervalMs: 200,
    write: async (batch) => { if (ctx.db) await fleetDb.appendEvents(ctx.db, batch); },
  });
  // Workflow runner is created lazily — see ensureWorkflowRunner.
  return ctx;
}

module.exports = { attach, tryDispatch, attachUpgrade, makeContext, send, readBody, checkAuth, checkAdminAuth, ensureWorkflowRunner };
