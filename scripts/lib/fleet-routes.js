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
// vt-0354: shared targeting helper used by spawnClaudeForWorkflow below
// and re-used inside the sub-modules (dispatch / sessions).
const { resolveCandidates } = require('./fleet/_shared');

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
// vt-0277: 60s default is generous enough for ws-upgrade RTT but short
// enough that a stolen ticket (DevTools, proxy log) expires before
// post-exfiltration replay. Tighten via env on hot deployments.
const WS_TICKET_TTL_MS = parseInt(process.env.VAULT_RAG_WS_TICKET_TTL_MS || '60000', 10);
const WS_TICKET_DERIVATION = 'fleet-ws-ticket-v1';
const _consumedTickets = new Map();
// vt-0295: hard cap defends against operators who set
// WS_TICKET_TTL_MS=86400000 for convenience and then leak xterm tabs:
// the Map would grow unbounded across the long TTL window.
const CONSUMED_TICKETS_MAX = 10000;
const _consumedSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [sig, exp] of _consumedTickets) if (exp < now) _consumedTickets.delete(sig);
}, 30_000);
_consumedSweepTimer.unref?.();
// H1 (audit 2026-05-17): when the consumed-ticket Map is full, NEVER
// evict a live (unexpired) entry — that opens a replay window for the
// evicted sig until its natural expiry. Previously the cap hit triggered
// FIFO eviction of the oldest insertion regardless of expiry. Now we
// sweep expired entries first; if no room can be made, the new ticket
// is REFUSED (returns false) and the caller closes the WS upgrade.
// Returns true when the ticket was recorded, false otherwise.
function _recordConsumedTicket(sigHash, exp) {
  if (_consumedTickets.size >= CONSUMED_TICKETS_MAX) {
    log.warn('consumed_tickets_cap_hit', { size: _consumedTickets.size, cap: CONSUMED_TICKETS_MAX });
    const now = Date.now();
    for (const [sig, e] of _consumedTickets) {
      if (e < now) _consumedTickets.delete(sig);
      if (_consumedTickets.size < CONSUMED_TICKETS_MAX) break;
    }
    if (_consumedTickets.size >= CONSUMED_TICKETS_MAX) {
      log.error('consumed_tickets_refused', { size: _consumedTickets.size, cap: CONSUMED_TICKETS_MAX });
      return false;
    }
  }
  _consumedTickets.set(sigHash, exp);
  return true;
}
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
// H4 (audit 2026-05-17): tickets now carry a `scope` string the caller
// commits to at mint time. acceptWsUpgrade matches it against the
// URL's resource id (session_id for role=viewer, run_id for
// workflow_viewer, host_id for metrics_viewer). Empty scope still
// passes legacy clients but emits a warn log — once the SPA always
// supplies scope, the empty-scope branch can be removed.
function signWsTicket(ctx, role, scope) {
  const payload = { role, scope: scope || '', exp: Date.now() + WS_TICKET_TTL_MS };
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
  if (payload.scope !== undefined && typeof payload.scope !== 'string') return null;
  return payload;
}

async function handleWsTicket({ req, res, body, ctx }) {
  // Auth: viewer-or-admin already enforced by dispatchHttp before we land here.
  // Role: ticket carries the role the bearer was admitted under. Daemons never
  // call this (they use Authorization header on the WS upgrade); we still
  // refuse to mint daemon tickets via this endpoint to avoid future bypass.
  const requested = (body && body.role) ? String(body.role) : 'viewer';
  const callerId = _workflowCallerFp(req);
  // vt-0364: use realClientIp helper so audit records the real X-Forwarded-For
  // (Caddy preserves the client IP), not the docker bridge address.
  const callerIp = realClientIp(req);
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
  // H4: scope the ticket to a specific resource id. Caller (SPA) sends
  // body.scope_id = session/run/host id; signed into the ticket and
  // re-checked at WS upgrade. Empty scope is accepted for back-compat
  // but warn-logged so we can spot non-upgraded callers.
  const scope = body && typeof body.scope_id === 'string' ? body.scope_id.slice(0, 64) : '';
  // Admin-bearer holders may request any viewer role; viewer-bearer holders
  // may only request the same. Auth check is uniform — we already passed
  // checkAuth in dispatchHttp.
  const ticket = signWsTicket(ctx, requested, scope);
  if (!scope) log.warn('ws_ticket_unscoped', { role: requested, caller: callerId });
  await audit('ok', scope ? { scope } : null);
  send(res, 200, { ticket, role: requested, scope, expires_in_ms: WS_TICKET_TTL_MS });
}

const SID_RE = '[0-9a-f-]{36}';

// vt-0284: known Claude/Codex tool names. Validated at role
// create/update time so typos ("Reaad") fail loud instead of being
// silently dropped at spawn. Set the env to expand:
//   VAULT_RAG_KNOWN_TOOLS=Read,Edit,Write,Bash,…,MyCustomTool
// If unset, this default is used. Daemons can still tighten further
// via AGENT_FLEET_TOOLS_WHITELIST (vt-0276).
const KNOWN_TOOLS = new Set(
  (process.env.VAULT_RAG_KNOWN_TOOLS ||
    'Read,Edit,Write,Bash,Grep,Glob,Task,WebFetch,WebSearch,TaskCreate,TaskList,TaskUpdate,TaskStop,TaskOutput,TaskGet,NotebookEdit,Skill,ScheduleWakeup,SendMessage,RemoteTrigger,Monitor,EnterWorktree,ExitWorktree,EnterPlanMode,ExitPlanMode,CronCreate,CronDelete,CronList,PushNotification,ToolSearch,AskUserQuestion'
  ).split(',').map(s => s.trim()).filter(Boolean)
);
function validateAllowedToolsField(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw Object.assign(new Error('allowed_tools must be array'), { statusCode: 422 });
  if (value.length > 64) throw Object.assign(new Error('allowed_tools: too many entries (max 64)'), { statusCode: 422 });
  const bad = value.filter(t => typeof t !== 'string' || !KNOWN_TOOLS.has(t));
  if (bad.length) {
    throw Object.assign(
      new Error(`allowed_tools: unknown tool(s): ${bad.join(', ')} (set VAULT_RAG_KNOWN_TOOLS to widen)`),
      { statusCode: 422 });
  }
  return value;
}

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

// vt-0287 slice 5: host CRUD + inventory/metrics/file ops moved to
// scripts/lib/fleet/hosts.js.

// vt-0287 slice 9: handleExec + handleDispatch moved to scripts/lib/fleet/dispatch.js.


// vt-0287 slice 6: cost + timeline handlers moved to scripts/lib/fleet/cost.js.
// vt-0287 slice 8: session CRUD + broadcast + cleanup moved to
// scripts/lib/fleet/sessions.js.

// vt-0287 slice 5: host file ops moved to scripts/lib/fleet/hosts.js.

// vt-0287 slice 7: transcripts → scripts/lib/fleet/transcripts.js.
// vt-0287 slice 8: sessions   → scripts/lib/fleet/sessions.js.
// vt-0287 slice 9: dispatch+exec → scripts/lib/fleet/dispatch.js.
// vt-0353: shared spawn/ANSI helpers live in fleet/_shared.js.
// vt-0354: shared host-targeting + auto-log of 5xx also in _shared.

// vt-0287 slice 2: pricing handlers moved to scripts/lib/fleet/prices.js
// — routed via the sub-module dispatcher in dispatchHttp.

// --- Workflow handlers ---

// vt-0287 slice 3: workflow CRUD + run dispatch + approvals/events/trigger
// handlers moved to scripts/lib/fleet/workflows.js. _workflowCallerFp
// remains here (still used by /fleet/features audit and the slice-1
// sub-modules). The runner + concurrency-cap stateful helpers (next
// def block) stay in this file and are passed as deps to the workflows
// sub-module via _getSubRoutes above.
// vt-0364: callerFingerprint moved to lib/shared-auth.js; alias kept
// for the sub-module deps bundle.
const { callerFingerprint: _workflowCallerFp, realClientIp } = require('./shared-auth');

async function ensureWorkflowRunner(ctx) {
  if (ctx.workflowRunner) return ctx.workflowRunner;
  if (!ctx.db) return null;
  // Concurrency guard: cache the in-flight init promise synchronously so
  // parallel calls await the same single-init, never racing past the guard.
  // vt-0325 (audit 2026-05-17): on init failure, clear the cached
  // promise so subsequent /run calls retry. Previously a rejected
  // init promise sat in ctx._workflowRunnerInit forever and every
  // future workflow dispatch awaited the same rejection until the
  // hub restarted.
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
    })().catch((e) => {
      log.error('workflow_runner_init_failed', { msg: e.message });
      ctx._workflowRunnerInit = null;
      throw e;
    });
  }
  return ctx._workflowRunnerInit;
}

// vt-0318: global cross-workflow concurrency cap. Without it, 20 cron
// triggers in the same minute spawn 20 parallel runs, exhaust the pg
// pool (max=10) + saturate ARG_MAX on the daemon side. Cap is a
// soft semaphore — we count active rows + reject (429) at the entry
// gate. Scheduler does the same check before firing a cron trigger.
const WORKFLOW_MAX_CONCURRENT = parseInt(process.env.VAULT_RAG_WORKFLOW_MAX_CONCURRENT || '5', 10);
async function _checkWorkflowConcurrency(ctx) {
  try {
    const n = await wfDb.countActiveRuns(ctx.db);
    return { ok: n < WORKFLOW_MAX_CONCURRENT, active: n, cap: WORKFLOW_MAX_CONCURRENT };
  } catch (e) {
    // Fail-open on DB glitch — same convention as feature gate.
    log.warn('workflow_concurrency_check_failed', { msg: e.message });
    return { ok: true, active: -1, cap: WORKFLOW_MAX_CONCURRENT };
  }
}

// vt-0287 slice 3: handleRunWorkflow, handleListRuns, handleGetRun,
// handleCancelRun moved to scripts/lib/fleet/workflows.js. The
// stateful ensureWorkflowRunner + _checkWorkflowConcurrency helpers
// stay here and are passed in via deps.

// vt-0115: docker stack self-status. The host writes a JSON file every 30s
// via systemd timer (scripts/bin/stack-status-writer.sh); we just serve it.
// Auth-gated — operator-only data, no need to expose container names publicly.
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

// vt-0287 slice 3: handleListPendingApprovals, handleApprovalDecision,
// handleFireWorkflowEvent, handleSetWorkflowTrigger moved to
// scripts/lib/fleet/workflows.js.

// Spawn a claude session and wait for completion, returning {output, exit_code, session_id}.
// Used by workflow runner as deps.spawnClaude. signal (optional AbortSignal) lets
// runner.cancel() short-circuit the poll loop instead of waiting full timeout_s.
async function spawnClaudeForWorkflow(ctx, node, prompt, runId, signal) {
  // vt-0354: shared host-targeting filter — same as dispatch + broadcast.
  // Throws on group-not-found (`.notFound = 'group'`); the workflow runner
  // catches and marks the node failed.
  const { candidates } = await resolveCandidates(fleetDb, ctx, node.target || {});
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

// vt-0287: sub-module route registry. Each per-domain file in
// scripts/lib/fleet/ exports `register({deps}) → [{method, pattern,
// handler}]`. Built lazily on first dispatchHttp call (so module-load
// order doesn't matter) and memoised in _subRoutesCache.
let _subRoutesCache = null;
function _getSubRoutes() {
  if (_subRoutesCache) return _subRoutesCache;
  const deps = {
    fleetDb,
    fleetWorkflowDb: wfDb,
    checkAdminAuth,
    validateAllowedToolsField,
    callerFp: _workflowCallerFp,
  };
  const modules = [
    require('./fleet/recycle'),
    require('./fleet/features'),
    require('./fleet/agent-roles'),
    require('./fleet/prices'),
    require('./fleet/workflows'),
    require('./fleet/webhooks'),
    require('./fleet/config-export'),
    require('./fleet/groups'),
    require('./fleet/hosts'),
    require('./fleet/cost'),
    require('./fleet/transcripts'),
    require('./fleet/sessions'),
    require('./fleet/dispatch'),
  ];
  const extDeps = {
    ...deps,
    fleetPrices,
    fleetCost,
    validateDefinition,
    ensureWorkflowRunner,
    checkWorkflowConcurrency: _checkWorkflowConcurrency,
  };
  _subRoutesCache = modules.flatMap(m => m.register(extDeps));
  return _subRoutesCache;
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
  // vt-0271-followup: source-IP belt-and-suspenders. Only accept calls
  // from RFC1918 + docker-bridge ranges + loopback. If you front-proxy
  // through Caddy (which preserves the real client IP via X-Forwarded-
  // For), set VAULT_RAG_ALERT_SINK_TRUST_XFF=1.
  if (method === 'POST' && path === '/fleet/_alert-sink') {
    // vt-0309: IPv6 ULA (fc00::/7 covers fc00-fdff::/16) + IPv6 link-
    // local (fe80::/10) + rightmost X-Forwarded-For when proxied. The
    // earlier impl took the LEFTMOST XFF entry which is client-
    // controlled when more than one proxy hop exists. Rightmost is
    // the closest proxy (us). Operator who is NOT behind another
    // proxy keeps VAULT_RAG_ALERT_SINK_TRUST_XFF unset, falling back
    // to req.socket.remoteAddress which is unspoofable.
    const trustXff = process.env.VAULT_RAG_ALERT_SINK_TRUST_XFF === '1';
    const xffHeader = trustXff ? (req.headers['x-forwarded-for'] || '') : '';
    const xffParts = xffHeader ? xffHeader.split(',').map(s => s.trim()).filter(Boolean) : [];
    const xff = xffParts.length ? xffParts[xffParts.length - 1] : '';
    const ip = xff || req.socket?.remoteAddress || '';
    const ipBare = ip.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
    const isLocal =
      // IPv4 loopback + RFC1918
      ipBare === '127.0.0.1' ||
      /^10\./.test(ipBare) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(ipBare) ||
      /^192\.168\./.test(ipBare) ||
      // IPv6 loopback + ULA fc00::/7 (fc/fd prefix) + link-local fe80::/10
      ipBare === '::1' ||
      /^f[cd][0-9a-f]{2}:/i.test(ipBare) ||
      /^fe[89ab][0-9a-f]:/i.test(ipBare);
    if (!isLocal) {
      log.warn('alert_sink_rejected', { ip: ipBare });
      return send(res, 403, { error: 'alert sink accepts only local network sources' });
    }
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
  // vt-0287: route-table dispatch for extracted sub-modules. Each
  // submodule exports `register({deps}) → [{method, pattern, handler, admin?}]`.
  // Built once and memoised. vt-0363: admin gating moved into the loop —
  // per-route `admin` metadata replaces the negative-allowlist isAdminPath
  // (where a typo in the exception list silently downgrades a route).
  // Default is method-based (non-GET ⇒ admin); routes declare `admin: false`
  // to explicitly opt out (e.g. cost-batch is POST due to body size but is
  // viewer-readable). Order inside the table doesn't matter — patterns are
  // mutually exclusive by path+method.
  const subRoutes = _getSubRoutes();
  for (const r of subRoutes) {
    if (r.method !== method) continue;
    const m = path.match(r.pattern);
    if (!m) continue;
    const adminRequired = r.admin === undefined ? (r.method !== 'GET') : Boolean(r.admin);
    if (adminRequired && !checkAdminAuth(req, ctx)) {
      return send(res, 403, { error: 'admin token required for this operation' });
    }
    return r.handler(req, res, ctx, m);
  }
  // vt-0124/vt-0363: inline routes still use the old gate. The cost-batch
  // and ws-ticket carve-outs ride the sub-route table; only routes added
  // BELOW this point would re-enter the legacy default-deny path.
  if (isAdminPath(method, path) && !checkAdminAuth(req, ctx)) {
    return send(res, 403, { error: 'admin token required for this operation' });
  }

  // vt-0150: shared backend → config-files map (web UI consults this to
  // render per-host edit buttons). Static; no DB hit.
  if (method === 'GET' && path === '/fleet/backend-configs') {
    return send(res, 200, require('./backend-configs').BACKEND_CONFIGS);
  }

  // Returns the caller's role (admin|viewer) so the SPA can branch UI
  // without faking a POST /fleet/dispatch probe (which left a red 422
  // in DevTools and ran the dispatch validator for no reason). Always
  // 200 when reached — the auth gate above already accepted the bearer.
  if (method === 'GET' && path === '/fleet/auth/whoami') {
    const role = checkAdminAuth(req, ctx) ? 'admin' : 'viewer';
    return send(res, 200, { role });
  }

  // vt-0287 slice 5: hosts → scripts/lib/fleet/hosts.js (sub-module).
  // vt-0287 slice 9: /fleet/dispatch + /fleet/exec → scripts/lib/fleet/dispatch.js.

  // vt-0287 slice 8: /fleet/sessions CRUD + cleanup + /fleet/broadcast +
  // session :id GET/PATCH/input/kill dispatched via sub-module router
  // (scripts/lib/fleet/sessions.js).
  // vt-0287 slice 6: /fleet/cost/* + /fleet/sessions/:id/{cost,timeline} +
  // /fleet/sessions/{cost-batch,by-bucket} (scripts/lib/fleet/cost.js).
  // vt-0287 slice 7: transcript .txt/.bin (scripts/lib/fleet/transcripts.js).

  // Pricing
  // vt-0287 slice 2: /fleet/prices/* moved to scripts/lib/fleet/prices.js
  // (dispatched via sub-module table above).

  // vt-0287 slice 3: workflow CRUD + runs + approvals/events/trigger
  // dispatched via the sub-module table above (scripts/lib/fleet/workflows.js).

  // Stack status (docker compose health for the operator)
  if (method === 'GET' && path === '/fleet/stack-status') return handleStackStatus({ res, ctx });

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
  // vt-0313: forward the current feature mask in the welcome frame.
  // Daemon uses this to skip collectors for disabled modules.
  let features = {};
  try {
    const rows = await fleetDb.listFeatures(ctx.db);
    for (const r of rows) features[r.name] = !!r.enabled;
  } catch (e) {
    log.warn('welcome_features_lookup_failed', { msg: e.message });
  }
  ws.send(JSON.stringify({
    type: 'welcome',
    host_id: host.id,
    server_version: ctx.version || '0.0.1',
    features,
  }));
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
        // vt-0304: ring.append now returns false for dup seq (replay
        // overlap). Skip broadcasting + batcher push in that case so
        // viewers see each byte once and audit doesn't double-store.
        const accepted = rb.append({ seq, data: buf });
        if (!accepted) return;
        ctx.batcher.push({ sessionId: f.session_id, kind: 'pty_out', seq, payload: buf });
        ctx.bus.broadcastViewers(f.session_id, { type: 'pty_data', seq, data: f.data, replayed: !!f.replayed });
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
      if (f.type === 'pty_gap') {
        // vt-0290: daemon dropped pty_data bytes during a WS outage.
        // Forward the marker to viewers; they render an explicit gap
        // line instead of silently splicing post-reconnect output.
        ctx.bus.broadcastViewers(f.session_id, {
          type: 'pty_gap',
          session_id: f.session_id,
          dropped_bytes: Number(f.dropped_bytes) || 0,
        });
        return;
      }
      if (f.type === 'reconciliation') {
        for (const s of (f.sessions || [])) {
          if (s.alive) {
            await fleetDb.markSessionRunning(ctx.db, s.session_id, s.pid);
            // vt-0304: ask daemon to replay anything we missed since
            // last_seq we know about. ctx.rings has hub-side ring; the
            // highest seq there is what we tell the daemon to replay
            // FROM. If we have no ring (fresh hub), s.last_seq tells
            // the daemon how far we got pre-restart.
            try {
              const hubRing = ctx.rings?.get(s.session_id);
              const sinceSeq = hubRing && hubRing.lastSeq != null ? hubRing.lastSeq
                : (Number.isFinite(s.last_seq) ? s.last_seq : -1);
              ws.send(JSON.stringify({ type: 'replay', session_id: s.session_id, since_seq: sinceSeq }));
            } catch (e) { log.warn('replay_request_failed', { session_id: s.session_id, msg: e.message }); }
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
      if (f.type === 'replay_end') {
        // vt-0304: daemon finished replaying — log for diagnostics.
        log.info('replay_completed', { session_id: f.session_id, since_seq: f.since_seq, count: f.count });
        return;
      }
      // vt-chat-1b: structured frames from daemon's jsonl-tailer.
      // Hub does not persist (jsonl on daemon host is authoritative);
      // we just fan out to attached viewers. SPA chat-view subscribes
      // to these; raw-terminal tab keeps consuming pty_data.
      if (f.type === 'claude_msg' || f.type === 'compact_boundary'
          || f.type === 'session_lifecycle') {
        if (!f.session_id) return;
        ctx.bus.broadcastViewers(f.session_id, f);
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

// vt-0287 slice 5: host metrics + inventory moved to scripts/lib/fleet/hosts.js.

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
          log.warn('ws_ticket_replay_refused', { sig: sigHash });
          return ws.close(4001, 'ticket already used');
        }
        // H1: refuse the upgrade when the consumed-ticket Map can't
        // make room without evicting still-live entries. Forces the
        // operator to bump CONSUMED_TICKETS_MAX or shorten WS_TICKET_TTL
        // rather than silently weakening the single-use guarantee.
        if (sigHash && !_recordConsumedTicket(sigHash, verified.exp)) {
          return ws.close(4001, 'ticket store full — retry shortly');
        }
        // H4 (audit 2026-05-17): when the ticket carries a non-empty
        // scope, it must match the resource id in the URL. Each WS
        // role binds to a different param: viewer → session_id,
        // workflow_viewer → run_id, metrics_viewer → host_id. Empty
        // scope ('') is accepted for legacy clients while we roll
        // the SPA upgrade — a warn log fires server-side to surface
        // the laggards.
        if (verified.scope) {
          const paramName = role === 'viewer' ? 'session_id'
            : role === 'workflow_viewer' ? 'run_id'
            : role === 'metrics_viewer' ? 'host_id' : null;
          const urlScope = paramName ? params.get(paramName) : null;
          if (urlScope !== verified.scope) {
            log.warn('ws_ticket_scope_mismatch', {
              role, ticket_scope: verified.scope, url_scope: urlScope,
            });
            return ws.close(4001, 'ticket scope mismatch');
          }
        }
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
