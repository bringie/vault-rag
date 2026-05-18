'use strict';
const WebSocket = require('ws');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { collectMetrics } = require('./metrics-collector');
const { collectInventory, inventoryChanged, resetInventoryCache } = require('./inventory-collector');
const { PtyManager } = require('./pty-manager');
const { SessionStore } = require('./session-store');
const { JsonlTailer } = require('./jsonl-tailer');
const { SubagentTailer } = require('./subagent-tailer');
const backendsLib = require('./backends');

// True when the spawn frame uses the new generic schema rather than legacy
// {args:[...]} passthrough. Any of these fields means we should consult a
// backend.buildSpawnArgs() rather than ptyMgr.spawn(args) directly.
function hasStructuredFields(f) {
  return f.agent != null
    || f.prompt != null
    || f.model != null
    || f.system_prompt != null
    || f.allowed_tools != null
    || f.resume_session_id != null
    || f.dangerous != null;
}

// Spawn-frame handler. Extracted so daemon tests can drive it with a mock
// ptyMgr — backend modules build {argv, env, stdin} but until vt-0122 the
// daemon was dropping `stdin`, so hermes/opencode/codex/openclaw wrappers
// hung on `RAW=$(cat)` waiting for a prompt that never arrived.
// vt-0200: defensive validation of spawn frames before they reach pty.
// Authentication of the WS upgrade is enforced by the hub; this is a
// belt-and-suspenders layer for hub-bug / hub-compromise scenarios.
//
// Rules:
//  • cwd must be a string under HOME or under /tmp; '..'-escape rejected.
//    Absolute paths outside those roots are refused; '~' relative left to
//    the shell to expand.
//  • args must be an array of strings; reject argv entries that look like
//    the explicit dangerous flag, since the hub already coerces structured
//    `dangerous: bool` (vt-0169). Author-supplied raw `args` should not
//    smuggle it back in.
//  • env keys are constrained to [A-Z_][A-Z0-9_]* and a small denylist
//    rejects names that hijack wrapper resolution (OPENCLAW_BIN, etc.).
function validateSpawnFrame(f) {
  const home = process.env.HOME || os.homedir() || '/root';
  if (f.cwd !== undefined && f.cwd !== null) {
    if (typeof f.cwd !== 'string') throw new Error('cwd must be string');
    if (f.cwd.includes('..')) throw new Error('cwd: .. not allowed');
    if (f.cwd.startsWith('/')) {
      if (!f.cwd.startsWith(home + '/') && f.cwd !== home && !f.cwd.startsWith('/tmp/') && f.cwd !== '/tmp') {
        throw new Error(`cwd outside $HOME and /tmp: ${f.cwd}`);
      }
      // vt-0361 (security audit H4): resolve symlinks and re-verify the
      // prefix. Without this a symlink farm under $HOME pointing at /etc,
      // /var, or another protected root would let a hub-admin spawn claude
      // there (post-exploitation after admin-token compromise but trivial
      // hardening). Missing-path is allowed — the PTY spawn would fail
      // with a clean ENOENT instead of the realpath check faking a refusal.
      try {
        const real = fs.realpathSync(f.cwd);
        if (!real.startsWith(home + '/') && real !== home && !real.startsWith('/tmp/') && real !== '/tmp') {
          throw new Error(`cwd resolves outside $HOME and /tmp via symlink: ${f.cwd} → ${real}`);
        }
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }
  if (f.args !== undefined && f.args !== null) {
    if (!Array.isArray(f.args)) throw new Error('args must be array');
    for (const a of f.args) {
      if (typeof a !== 'string') throw new Error('args entries must be string');
      // vt-0169 makes `dangerous` boolean-coerced; raw flag in argv would
      // bypass that, even from a buggy hub.
      if (a === '--dangerously-skip-permissions') {
        throw new Error('--dangerously-skip-permissions must be passed via structured dangerous flag, not args');
      }
    }
  }
  // vt-0276: defence-in-depth. Hub admin compromise should not be enough
  // to spawn dangerous (--dangerously-skip-permissions / RCE-equivalent)
  // sessions on this host. Require explicit per-host opt-in via env.
  // The hub still validates its own ACL; this is a second layer in case
  // hub auth is bypassed (XSS, leaked admin token, etc.).
  if (f.dangerous === true && process.env.AGENT_FLEET_ALLOW_DANGEROUS !== '1') {
    throw new Error('dangerous spawn requested but daemon was not started with AGENT_FLEET_ALLOW_DANGEROUS=1');
  }
  // vt-0276: allowed_tools whitelist. The role + caller-side allowed_tools
  // value is sent over the wire; daemon-side whitelist defines the
  // operator's intent for THIS host. Set AGENT_FLEET_TOOLS_WHITELIST to a
  // comma list (e.g. "Read,Grep,Glob,Bash") to enforce. If unset, the
  // daemon accepts whatever the hub forwards (current default — backward
  // compat). If set, any tool not in the whitelist causes the spawn to
  // reject with a clear error.
  if (Array.isArray(f.allowed_tools) && f.allowed_tools.length > 0
      && process.env.AGENT_FLEET_TOOLS_WHITELIST) {
    const allow = new Set(process.env.AGENT_FLEET_TOOLS_WHITELIST.split(',').map(s => s.trim()).filter(Boolean));
    const denied = f.allowed_tools.filter(t => !allow.has(t));
    if (denied.length > 0) {
      throw new Error(`tools not on host whitelist: ${denied.join(', ')} (set AGENT_FLEET_TOOLS_WHITELIST to expand)`);
    }
  }
  if (f.env !== undefined && f.env !== null) {
    if (typeof f.env !== 'object' || Array.isArray(f.env)) throw new Error('env must be object');
    // vt-0202: refuse env keys that select wrapper binaries — hub-side
    // bug or compromise must not let the daemon resolve PATH to a shell.
    // vt-0238: extended loader/runtime denylist. Anything that can hijack
    // dynamic linker behaviour or pre-load scripting runtimes must NOT be
    // accepted from a (potentially compromised) hub frame.
    const DENY = new Set([
      // *_BIN — wrapper-binary selectors
      'OPENCLAW_BIN', 'NANOCLAW_BIN', 'HERMES_BIN',
      'AGENT_FLEET_CLAUDE_BIN', 'AGENT_FLEET_CODEX_BIN',
      'AGENT_FLEET_OPENCODE_BIN', 'AGENT_FLEET_HERMES_BIN',
      // glibc/macOS dynamic loader
      'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_BIND_NOW',
      'LD_DEBUG_OUTPUT', 'LD_PROFILE', 'LD_DYNAMIC_WEAK',
      'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH',
      'GCONV_PATH', 'MALLOC_CONF',
      // Node
      'NODE_OPTIONS', 'NODE_PATH',
      // Python
      'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'PYTHONINSPECT',
      // Ruby / Perl
      'RUBYLIB', 'RUBYOPT', 'PERL5LIB', 'PERL5OPT',
    ]);
    for (const k of Object.keys(f.env)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`env key invalid: ${k}`);
      if (DENY.has(k)) throw new Error(`env key denied: ${k}`);
    }
  }
}

function applySpawnFrame(f, { ptyMgr, backends, defaultBackend, baseBin }) {
  // vt-0200: validate before touching pty.
  validateSpawnFrame(f);
  let argv = f.args || [];
  let env = f.env || {};
  let bin = baseBin;
  let stdin = null;
  if (f.agent || hasStructuredFields(f)) {
    const backend = backendsLib.pick(backends, f.agent, defaultBackend);
    if (!backend) throw new Error(`no backend available for agent=${f.agent || defaultBackend}`);
    const built = backend.buildSpawnArgs({
      cwd: f.cwd, args: f.args, env,
      prompt: f.prompt, model: f.model,
      system_prompt: f.system_prompt,
      allowed_tools: f.allowed_tools,
      resume_session_id: f.resume_session_id,
      dangerous: f.dangerous,
    });
    argv = built.argv;
    env = { ...env, ...(built.env || {}) };
    // Some backends (e.g. nanoclaw) return a _shimBin so we run their argv
    // through /bin/sh instead of the backend's real binary — used to surface
    // "not supported" errors cleanly.
    bin = built._shimBin || backend.bin;
    stdin = built.stdin || null;
  }
  ptyMgr.spawn({
    sessionId: f.session_id, cwd: f.cwd,
    args: argv, env, binOverride: bin,
  });
  if (stdin) ptyMgr.writeInput(f.session_id, stdin.endsWith('\n') ? stdin : stdin + '\n');
}

function collectHostInfo() {
  const cpus = os.cpus();
  return {
    cpu_model: cpus[0]?.model || null,
    cpu_cores: cpus.length || 0,
    ram_total_bytes: os.totalmem(),
    ram_free_bytes: os.freemem(),
    node_version: process.version,
    hostname: os.hostname(),
    platform_release: os.release(),
    uptime_seconds: Math.floor(os.uptime()),
  };
}

// Daemon NEVER reads/writes outside the symbolic-name allowlist below
// (CLAUDE.md edit feature). resolveAllowedPath is the only gatekeeper.
// vt-0150: write allowlist is built from the shared backend-configs map.
// Resolved lazily so the require cycle stays clean.
// vt-0157: SIGHUP clears the cache so an operator who changes HOME in the
// systemd unit (or hot-edits the rel map) can refresh without a full
// daemon restart — mirrors the backends.json reload pattern.
let _allowMap = null;
process.on('SIGHUP', () => { _allowMap = null; });
function resolveAllowedPath(reqPath) {
  if (!_allowMap) {
    const home = process.env.HOME || os.homedir() || '/root';
    // Daemon doesn't depend on scripts/lib at runtime, so vendor a tiny
    // copy of flatPaths() inline.
    const rel = {
      'CLAUDE.md':         '.claude/CLAUDE.md',
      'settings.json':     '.claude/settings.json',
      'codex-config':      '.codex/config.toml',
      'opencode-config':   '.config/opencode/opencode.json',
      'GEMINI.md':         '.gemini/GEMINI.md',
    };
    _allowMap = Object.fromEntries(
      Object.entries(rel).map(([k, r]) => [k, path.join(home, r)])
    );
  }
  return _allowMap[reqPath] || null;
}

const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 30_000;

function computeBackoff(attempt) {
  const exp = Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** attempt);
  const jitter = (Math.random() * 0.5 - 0.25) * exp;
  // vt-0183: clamp BOTH sides — without the upper clamp, jitter at the
  // cap could push the result to ~37.5s (25% above MAX_BACKOFF).
  return Math.min(MAX_BACKOFF, Math.max(0, Math.round(exp + jitter)));
}

// vt-0290: per-session drop accounting. When the WS is down we still
// emit pty_data into safeSend, which silently no-ops. Tracking the
// dropped byte count lets us emit a `pty_gap` frame on reconnect.
// vt-0304: pty_data ALSO lands in a per-session ring buffer so the
// hub can ask `replay {since_seq}` and recover the bytes that were
// dropped during the outage. Buffer is 1 MiB per session by default
// (env override AGENT_FLEET_PTY_RING_BYTES). Beyond the cap we
// drop oldest frames AND emit the gap-marker — that's the upper
// bound on what an extended outage can lose without the operator
// even noticing.
const _droppedBySession = new Map();
// vt-0304: per-session ring of recent pty_data frames keyed by seq.
const PTY_RING_BYTES = parseInt(process.env.AGENT_FLEET_PTY_RING_BYTES || String(1024 * 1024), 10);
const _ringBySession = new Map();  // session_id → [{seq, base64, bytes}, ...]
function _ringPush(sessionId, seq, base64Data, decodedBytes) {
  let ring = _ringBySession.get(sessionId);
  if (!ring) { ring = []; _ringBySession.set(sessionId, ring); }
  ring.push({ seq, data: base64Data, bytes: decodedBytes });
  // Evict from the front until under cap. We also account the
  // dropped frames into _droppedBySession so the gap-marker still
  // tells the viewer about them.
  let total = ring.reduce((a, e) => a + e.bytes, 0);
  while (total > PTY_RING_BYTES && ring.length > 1) {
    const evicted = ring.shift();
    total -= evicted.bytes;
    _recordDrop(sessionId, evicted.bytes);
  }
}
function _ringDelete(sessionId) {
  _ringBySession.delete(sessionId);
}
function _ringReplayFrom(sessionId, sinceSeq) {
  const ring = _ringBySession.get(sessionId) || [];
  return ring.filter(e => e.seq > sinceSeq);
}
function _recordDrop(sessionId, bytes) {
  _droppedBySession.set(sessionId, (_droppedBySession.get(sessionId) || 0) + bytes);
}
// vt-0302: split take→peek + per-session consume so the daemon can
// retry the gap-emit later if the WS dies mid-handshake. The previous
// _takeDrops() cleared the map BEFORE any send was attempted — a
// reconnect that died right after the reconciliation frame lost the
// drop counters forever.
function _peekDrops() {
  const out = [];
  for (const [sid, bytes] of _droppedBySession) {
    if (bytes > 0) out.push({ session_id: sid, dropped_bytes: bytes });
  }
  return out;
}
function _consumeDrop(sessionId, bytes) {
  const cur = _droppedBySession.get(sessionId) || 0;
  if (cur <= bytes) _droppedBySession.delete(sessionId);
  else _droppedBySession.set(sessionId, cur - bytes);
}

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== 1) {
    // vt-0290: account for dropped pty_data bytes per session. We only
    // track pty_data drops because other frame types (metrics, ping,
    // inventory) are periodic and re-sent next tick; losing one of
    // those is invisible to the user.
    if (obj && obj.type === 'pty_data' && obj.session_id && typeof obj.data === 'string') {
      // vt-0302: precise decoded length. Standard base64: every 4 chars
      // = 3 bytes, minus 1 per '=' padding character. The earlier
      // length*3/4 over-counted by up to 2 bytes per frame.
      const len = obj.data.length;
      const padCount = obj.data.endsWith('==') ? 2 : (obj.data.endsWith('=') ? 1 : 0);
      const exactBytes = Math.max(0, Math.floor(len * 3 / 4) - padCount);
      _recordDrop(obj.session_id, exactBytes);
    }
    return;
  }
  try { ws.send(JSON.stringify(obj)); }
  catch (e) {
    // vt-0183: silent drop made circular-ref / oversized frames invisible.
    // Log type+error so operators can see a misbehaving collector.
    console.error(`[daemon] safeSend dropped frame type=${obj && obj.type}: ${e.message}`);
  }
}

async function runDaemon(opts) {
  fs.mkdirSync(opts.stateDir, { recursive: true });
  const backoff = opts.backoffOverride || computeBackoff;
  const store = new SessionStore(opts.stateDir);

  // vt-0251: graceful daemon shutdown. systemd default stop sends
  // SIGTERM then KILLs after 90s; without a handler the process drops
  // the WS dirty + every PTY gets SIGKILL'd, losing any unflushed
  // pty_data and producing zombie sessions on the hub.
  //
  // Declare ptyMgrRef / _currentWs BEFORE the signal handlers so the
  // handler body can never hit a TDZ ReferenceError on an early SIGTERM.
  const ptyMgrRef = { current: null };
  // vt-chat-1b: jsonl-tailers per spawned session, declared early for
  // daemonShutdown reachability. Populated by _startTailersFor().
  const _tailers = new Map();
  let _currentWs = null;
  let _daemonShuttingDown = false;
  // 5.5s grace matches PtyManager's killGraceMs=5000 (vt-0251 review fix
  // — earlier 1.5s would exit before the deferred SIGKILL had a chance
  // to fire, leaving PTYs reparented to PID 1).
  const SHUTDOWN_GRACE_MS = 5500;
  function daemonShutdown(signal) {
    if (_daemonShuttingDown) return;
    _daemonShuttingDown = true;
    console.log(`[daemon] ${signal} — graceful shutdown`);
    const ws = _currentWs && _currentWs.readyState === 1 ? _currentWs : null;
    try {
      if (ws) {
        const alive = [];
        for (const id of (ptyMgrRef.current?.sessions?.keys?.() || [])) alive.push(id);
        ws.send(JSON.stringify({ type: 'bye', alive_sessions: alive }));
      }
    } catch {}
    try {
      for (const id of (ptyMgrRef.current?.sessions?.keys?.() || [])) {
        ptyMgrRef.current.kill(id, 'SIGTERM');
      }
    } catch (e) { console.error(`[daemon] pty kill on shutdown: ${e.message}`); }
    // vt-chat-1b: stop tailers explicitly so fs.watch handles are closed
    // deterministically rather than relying on process-exit reaper.
    try {
      for (const t of _tailers.values()) {
        t.jsonl.stop().catch(()=>{});
        t.subagent.stop().catch(()=>{});
      }
      _tailers.clear();
    } catch (e) { console.error(`[daemon] tailer stop on shutdown: ${e.message}`); }
    setTimeout(() => {
      try { ws?.close(1001, 'shutdown'); } catch {}
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
  }
  process.on('SIGTERM', () => daemonShutdown('SIGTERM'));
  process.on('SIGINT',  () => daemonShutdown('SIGINT'));
  // Backend registry — built-in claude + anything declared in backends.json.
  // Config path defaults to /etc/agent-fleet/backends.json on prod installs;
  // dev overrides via --backends-config or AGENT_FLEET_BACKENDS_PATH.
  const backendsCfg = opts.backendsConfig
    || process.env.AGENT_FLEET_BACKENDS_PATH
    || '/etc/agent-fleet/backends.json';
  // Relative module paths in backends.json are resolved against the daemon's
  // bundled backends/ directory, NOT the config file's location — operators
  // shouldn't have to mirror JS modules into /etc/agent-fleet/.
  let backends, defaultBackend;
  const reloadBackends = () => {
    const out = backendsLib.loadBackends({
      configPath: backendsCfg,
      baseDir: path.join(__dirname, 'backends'),
    });
    backends = out.registry;
    defaultBackend = out.default;
    console.log(`[daemon] backends loaded: ${[...backends.keys()].join(', ')} (default=${defaultBackend})`);
  };
  // vt-0183: initial load may now throw on parse error (so hot-reloads
  // don't silently drop third-party backends). Fall back to claude-only
  // here so the daemon still starts.
  try { reloadBackends(); }
  catch (e) {
    console.error(`[daemon] initial backends load failed: ${e.message} — falling back to claude only`);
    backends = new Map();
    backends.set('claude', require('./backends').loadBackends({}).registry.get('claude'));
    defaultBackend = 'claude';
  }
  // vt-0103: hot-reload on SIGHUP (POSIX) so the operator can `kill -HUP $(pidof
  // agent-fleet-daemon)` after editing backends.json without restarting the
  // daemon (= no session loss). Also watch the file directly so even systems
  // without SIGHUP delivery (Windows) get hot-reload via fs.watch.
  process.on('SIGHUP', () => {
    try { reloadBackends(); } catch (e) { console.error('[daemon] SIGHUP reload failed:', e.message); }
  });
  try {
    if (fs.existsSync(backendsCfg)) {
      let reloadT = null;
      fs.watch(backendsCfg, () => {
        // Debounce — editors typically fire 2–3 events per save.
        if (reloadT) clearTimeout(reloadT);
        reloadT = setTimeout(() => {
          try { reloadBackends(); }
          catch (e) { console.error('[daemon] backends.json watcher reload failed:', e.message); }
        }, 500);
      });
    }
  } catch (e) {
    console.warn('[daemon] could not watch backends.json:', e.message);
  }
  // PtyManager keeps claudeBin as the default; per-spawn we override via env.
  const ptyMgr = new PtyManager({ claudeBin: opts.claudeBin });
  ptyMgrRef.current = ptyMgr;
  let ws = null;
  let attempt = 0;
  let hostId = null;
  const cfgPath = path.join(opts.stateDir, 'config.json');
  try { hostId = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).host_id; } catch {}

  // _tailers Map declared at top-of-runDaemon for SIGTERM reachability.
  // Per-session {jsonl, subagent} pair; started on ptyMgr 'spawn', stopped
  // on 'exit' or daemon shutdown.
  const _daemonHome = process.env.HOME || os.homedir() || '/root';

  function _emitTailerFrame(sessionId, frame) {
    // frame = { type: 'claude_msg' | 'compact_boundary', payload: {...} }
    // Flatten payload onto the WS frame and tag with session_id.
    // Note: when ws is down, safeSend silently drops these. No ring buffer
    // is needed because the daemon's byte-offset cursor + the viewer's
    // replay_request (spec § Cross-phase invariants) recover any gap on
    // reconnect. Do NOT add per-session caching here.
    safeSend(ws, { type: frame.type, session_id: sessionId, ...frame.payload });
  }

  function _startTailersFor(sessionId, cwd) {
    if (!cwd) return;
    if (_tailers.has(sessionId)) return;
    const jt = new JsonlTailer({
      sessionId, cwd, home: _daemonHome, store,
      emit: (frame) => _emitTailerFrame(sessionId, frame),
    });
    const st = new SubagentTailer({
      parentSessionId: sessionId, cwd, home: _daemonHome, store,
      emit: (frame) => _emitTailerFrame(sessionId, frame),
    });
    _tailers.set(sessionId, { jsonl: jt, subagent: st });
    jt.start().catch(e =>
      console.error(`[ws] jsonl-tailer ${sessionId} start failed: ${e.message}`));
    st.start().catch(e =>
      console.error(`[ws] subagent-tailer ${sessionId} start failed: ${e.message}`));
  }

  async function _stopTailersFor(sessionId) {
    const t = _tailers.get(sessionId);
    if (!t) return;
    _tailers.delete(sessionId);
    try { await t.jsonl.stop(); } catch {}
    try { await t.subagent.stop(); } catch {}
  }

  // PTY → WS bridge
  ptyMgr.on('spawn', ({ sessionId, pid, cwd }) => {
    const cur = store.get(sessionId) || {};
    store.put(sessionId, { ...cur, pid, last_seq: 0, cwd: cwd || cur.cwd });
    safeSend(ws, { type: 'spawn_ok', session_id: sessionId, pid });
    safeSend(ws, { type: 'session_lifecycle', session_id: sessionId, state: 'ready' });
    _startTailersFor(sessionId, cwd || cur.cwd);
  });
  ptyMgr.on('data', ({ sessionId, seq, data }) => {
    const cur = store.get(sessionId);
    if (cur) store.put(sessionId, { ...cur, last_seq: seq });
    const b64 = data.toString('base64');
    // vt-0304: push into the ring BEFORE we attempt to send. If safeSend
    // drops the frame (ws disconnected), the ring still holds it for
    // replay on reconnect.
    _ringPush(sessionId, seq, b64, data.length);
    safeSend(ws, { type: 'pty_data', session_id: sessionId, seq, data: b64 });
  });
  ptyMgr.on('exit', ({ sessionId, exitCode, signal }) => {
    safeSend(ws, { type: 'session_exit', session_id: sessionId, exit_code: exitCode, signal: signal || undefined });
    safeSend(ws, { type: 'session_lifecycle', session_id: sessionId, state: 'exit', code: exitCode, signal: signal || undefined });
    _stopTailersFor(sessionId).catch(()=>{});
    _ringDelete(sessionId);
    store.delete(sessionId);
  });

  // vt-0384: tokmon-watcher removed — duplicated tokmon-shipper.timer
  // which already ingests ~/.claude/projects/*.jsonl into the standalone
  // tokmon-ingest container (5681). Use the shipper systemd unit for any
  // host that should report cost telemetry.
  let _hubFeatures = null;  // vt-0313: most recent feature mask from hub

  while (!opts.abortSignal?.aborted) {
    try {
      const url = new URL(opts.hub);
      url.searchParams.set('role', 'daemon');
      url.searchParams.set('host_name', opts.hostName);
      url.searchParams.set('daemon_version', '0.1.0');
      ws = new WebSocket(url.toString(), { headers: { authorization: `Bearer ${opts.token}` } });
      _currentWs = ws;  // vt-0251: expose to shutdown handler
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
        ws.once('close', () => reject(new Error('closed before open')));
      });
      attempt = 0;
      const hostInfo = collectHostInfo();
      // Probe every backend IN PARALLEL — serial probes with 3s timeouts
      // each blocked the WS hello frame for ~18s on 6 backends (vt-0119).
      const probeEntries = await Promise.all(
        Array.from(backends, async ([name, b]) => {
          try { return [name, await b.detectVersion(b.bin)]; }
          catch { return [name, null]; }
        })
      );
      const backendVersions = Object.fromEntries(probeEntries);
      ws.send(JSON.stringify({
        type: 'hello', host_name: opts.hostName,
        os: process.platform, arch: process.arch,
        capabilities: opts.capabilities || [],
        claude_version: backendVersions.claude || null,
        backends: backendVersions,
        host_info: hostInfo,
      }));
      const local = store.list();
      const recon = local.map(([id, info]) => {
        const alive = ptyMgr.sessions.has(id);
        return { session_id: id, pid: info.pid, alive, last_seq: info.last_seq, ...(alive ? {} : { exit_code: -1 }) };
      });
      if (recon.length) ws.send(JSON.stringify({ type: 'reconciliation', sessions: recon }));
      // vt-0290: emit per-session pty_gap frames for any bytes the
      // daemon had to drop while the WS was down. Hub broadcasts these
      // to viewers so the transcript shows an explicit gap marker
      // instead of silently splicing post-reconnect output.
      // vt-0302: don't clear the drop counters until each send succeeds.
      // If the ws dies mid-handshake we'd lose the gap count forever
      // with the previous _takeDrops() implementation.
      const drops = _peekDrops();
      for (const d of drops) {
        try {
          ws.send(JSON.stringify({ type: 'pty_gap', session_id: d.session_id, dropped_bytes: d.dropped_bytes }));
          _consumeDrop(d.session_id, d.dropped_bytes);
        } catch (e) {
          console.error(`[daemon] pty_gap send failed for ${d.session_id}: ${e.message}`);
          break;  // stop trying — preserve remaining counts for next reconnect
        }
      }
      for (const [id] of local) if (!ptyMgr.sessions.has(id)) store.delete(id);

      // Initial inventory frame — fresh on every (re)connect.
      resetInventoryCache();
      safeSend(ws, { type: 'inventory', ...collectInventory() });

      await new Promise((resolve) => {
        const heartbeat = setInterval(() => safeSend(ws, { type: 'ping' }), 15_000);
        heartbeat.unref?.();
        const metricsTimer = setInterval(async () => {
          try {
            const m = await collectMetrics();
            safeSend(ws, { type: 'metrics', ...m });
          } catch {}
        }, 10_000);
        metricsTimer.unref?.();
        const invMtimeTimer = setInterval(() => {
          if (inventoryChanged()) safeSend(ws, { type: 'inventory', ...collectInventory() });
        }, 60_000);
        invMtimeTimer.unref?.();
        const invHeartbeatTimer = setInterval(() => {
          safeSend(ws, { type: 'inventory', ...collectInventory() });
        }, 900_000);
        invHeartbeatTimer.unref?.();
        ws.on('message', (raw) => {
          let f;
          try { f = JSON.parse(raw.toString()); } catch { return; }
          if (f.type === 'welcome' && f.host_id) {
            hostId = f.host_id;
            fs.writeFileSync(cfgPath, JSON.stringify({ host_id: hostId, host_name: opts.hostName }));
            // vt-0313: stash hub feature mask for future spawn-time checks
            // (workflows flag could refuse fan_out etc. on the daemon).
            // vt-0384: tokmon toggle dropped along with tokmon-watcher.
            if (f.features && typeof f.features === 'object') {
              _hubFeatures = f.features;
            }
          } else if (f.type === 'spawn') {
            // Two payload shapes:
            //   Legacy:   { args: [...], env, cwd } — args are pre-built by the
            //             client (current UI buildSpawnArgs path). Pass through.
            //   Backend:  { agent: 'claude'|'opencode'|..., prompt, model,
            //             system_prompt, allowed_tools, resume_session_id,
            //             dangerous, args?, env, cwd } — daemon picks backend
            //             and asks it to build argv. Falls back to default
            //             backend if `agent` is unknown.
            try {
              // vt-0317: feature-mask gate. If hub disabled `fleet` (rare —
              // would normally kill the daemon), refuse spawn here too —
              // defence in depth against the hub being inconsistent
              // with what the operator toggled.
              if (_hubFeatures && _hubFeatures.fleet === false) {
                throw new Error('hub feature mask: fleet disabled');
              }
              applySpawnFrame(f, { ptyMgr, backends, defaultBackend, baseBin: opts.claudeBin });
            } catch (e) {
              safeSend(ws, { type: 'spawn_err', session_id: f.session_id, error: e.message });
            }
          } else if (f.type === 'input') {
            // vt-0201: cap input frame size. A viewer with a WS ticket can
            // stream into a PTY they're attached to; without a cap they can
            // pump arbitrary bytes (megabytes/s) and OOM the daemon or
            // wedge the spawned process. 64 KiB matches the upstream
            // PTY pipe buffer; legitimate paste/typing fits easily.
            if (typeof f.data !== 'string') {
              console.warn(`[daemon] input frame for ${f.session_id}: data must be string, got ${typeof f.data}`);
            } else if (f.data.length > 65536) {
              console.warn(`[daemon] input frame for ${f.session_id} dropped: ${f.data.length} bytes > 65536`);
            } else {
              ptyMgr.writeInput(f.session_id, f.data);
            }
          } else if (f.type === 'kill') {
            ptyMgr.kill(f.session_id, f.signal || 'SIGTERM');
          } else if (f.type === 'replay') {
            // vt-0304: hub asks to replay pty_data since the given seq.
            // We send the buffered frames in order; anything that fell
            // out of the ring was already accounted via _droppedBySession
            // and surfaced as a pty_gap on reconnect.
            const sid = f.session_id;
            const sinceSeq = Number.isFinite(f.since_seq) ? f.since_seq : -1;
            const frames = _ringReplayFrom(sid, sinceSeq);
            for (const r of frames) {
              ws.send(JSON.stringify({ type: 'pty_data', session_id: sid, seq: r.seq, data: r.data, replayed: true }));
            }
            ws.send(JSON.stringify({ type: 'replay_end', session_id: sid, since_seq: sinceSeq, count: frames.length }));
          } else if (f.type === 'resize') {
            ptyMgr.resize(f.session_id, f.cols, f.rows);
          } else if (f.type === 'read_file') {
            const abs = resolveAllowedPath(f.path);
            if (!abs) {
              safeSend(ws, { type: 'file_err', req_id: f.req_id, error: 'path not allowed' });
            } else {
              try {
                const data = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
                safeSend(ws, { type: 'file_data', req_id: f.req_id, path: f.path, exists: fs.existsSync(abs), content: data });
              } catch (e) {
                safeSend(ws, { type: 'file_err', req_id: f.req_id, error: e.message });
              }
            }
          } else if (f.type === 'write_file') {
            const abs = resolveAllowedPath(f.path);
            if (!abs) {
              safeSend(ws, { type: 'file_err', req_id: f.req_id, error: 'path not allowed' });
            } else {
              try {
                fs.mkdirSync(path.dirname(abs), { recursive: true });
                const tmp = abs + '.tmp.' + process.pid;
                fs.writeFileSync(tmp, f.content || '');
                fs.renameSync(tmp, abs);
                safeSend(ws, { type: 'file_ok', req_id: f.req_id, path: f.path, bytes: (f.content || '').length });
              } catch (e) {
                safeSend(ws, { type: 'file_err', req_id: f.req_id, error: e.message });
              }
            }
          }
          opts.onFrame?.(f, ws);
        });
        const clearTimers = () => {
          clearInterval(heartbeat);
          clearInterval(metricsTimer);
          clearInterval(invMtimeTimer);
          clearInterval(invHeartbeatTimer);
        };
        ws.on('close', () => { clearTimers(); resolve(); });
        ws.on('error', (e) => {
          console.error('[daemon] ws error:', e?.message || e);
          clearTimers(); resolve();
        });
        opts.abortSignal?.addEventListener('abort', () => {
          clearTimers();
          try { ws.close(); } catch {}
          resolve();
        });
      });
    } catch (_) { /* fallthrough to backoff */ }
    if (opts.abortSignal?.aborted) break;
    await new Promise(r => setTimeout(r, backoff(attempt++)));
  }
}

module.exports = { runDaemon, computeBackoff, applySpawnFrame };
