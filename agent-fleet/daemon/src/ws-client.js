'use strict';
const WebSocket = require('ws');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { collectMetrics } = require('./metrics-collector');
const { collectInventory, inventoryChanged, resetInventoryCache } = require('./inventory-collector');
const { PtyManager } = require('./pty-manager');
const { SessionStore } = require('./session-store');
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
function applySpawnFrame(f, { ptyMgr, backends, defaultBackend, baseBin }) {
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
function resolveAllowedPath(reqPath) {
  // Map symbolic names → real path. Reject anything else.
  const home = process.env.HOME || os.homedir() || '/root';
  const map = {
    'CLAUDE.md':       path.join(home, '.claude', 'CLAUDE.md'),
    'settings.json':   path.join(home, '.claude', 'settings.json'),
  };
  return map[reqPath] || null;
}

const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 30_000;

function computeBackoff(attempt) {
  const exp = Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** attempt);
  const jitter = (Math.random() * 0.5 - 0.25) * exp;
  return Math.max(0, Math.round(exp + jitter));
}

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch {}
}

async function runDaemon(opts) {
  fs.mkdirSync(opts.stateDir, { recursive: true });
  const backoff = opts.backoffOverride || computeBackoff;
  const store = new SessionStore(opts.stateDir);
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
  reloadBackends();
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
  let ws = null;
  let attempt = 0;
  let hostId = null;
  const cfgPath = path.join(opts.stateDir, 'config.json');
  try { hostId = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).host_id; } catch {}

  // PTY → WS bridge
  ptyMgr.on('spawn', ({ sessionId, pid }) => {
    store.put(sessionId, { pid, last_seq: 0 });
    safeSend(ws, { type: 'spawn_ok', session_id: sessionId, pid });
  });
  ptyMgr.on('data', ({ sessionId, seq, data }) => {
    const cur = store.get(sessionId);
    if (cur) store.put(sessionId, { ...cur, last_seq: seq });
    safeSend(ws, { type: 'pty_data', session_id: sessionId, seq, data: data.toString('base64') });
  });
  ptyMgr.on('exit', ({ sessionId, exitCode, signal }) => {
    safeSend(ws, { type: 'session_exit', session_id: sessionId, exit_code: exitCode, signal: signal || undefined });
    store.delete(sessionId);
  });

  // vt-0140: jsonl watcher starts ONCE per daemon process (survives WS
  // reconnects, which can happen many times per day). Opt-in: only when
  // AGENT_FLEET_TOKMON_ENABLED=1 + token is set + the hub URL parses cleanly.
  let tokmonWatcher = null;
  if (process.env.AGENT_FLEET_TOKMON_ENABLED === '1') {
    try {
      const { TokmonWatcher } = require('./tokmon-watcher');
      // Hub URL is the WS endpoint (wss://.../api/fleet/ws). Strip the path
      // + flip scheme back to http(s) for the REST POST target.
      const hubUrl = new URL(opts.hub);
      hubUrl.protocol = hubUrl.protocol === 'wss:' ? 'https:' : 'http:';
      hubUrl.pathname = '';
      hubUrl.search = '';
      const tokmonToken = process.env.AGENT_FLEET_TOKMON_TOKEN || opts.token;
      tokmonWatcher = new TokmonWatcher({ hubUrl: hubUrl.toString().replace(/\/$/, ''), token: tokmonToken });
      tokmonWatcher.start().catch(e => console.error('[daemon] tokmon-watcher start:', e.message));
      console.log(`[daemon] tokmon-watcher armed → ${hubUrl.toString().replace(/\/$/, '')}/api/tokmon/ingest`);
    } catch (e) {
      console.error('[daemon] tokmon-watcher init failed:', e.message);
    }
  }
  opts.abortSignal?.addEventListener('abort', () => { try { tokmonWatcher?.stop(); } catch {} });

  while (!opts.abortSignal?.aborted) {
    try {
      const url = new URL(opts.hub);
      url.searchParams.set('role', 'daemon');
      url.searchParams.set('host_name', opts.hostName);
      url.searchParams.set('daemon_version', '0.1.0');
      ws = new WebSocket(url.toString(), { headers: { authorization: `Bearer ${opts.token}` } });
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
              applySpawnFrame(f, { ptyMgr, backends, defaultBackend, baseBin: opts.claudeBin });
            } catch (e) {
              safeSend(ws, { type: 'spawn_err', session_id: f.session_id, error: e.message });
            }
          } else if (f.type === 'input') {
            ptyMgr.writeInput(f.session_id, f.data);
          } else if (f.type === 'kill') {
            ptyMgr.kill(f.session_id, f.signal || 'SIGTERM');
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
