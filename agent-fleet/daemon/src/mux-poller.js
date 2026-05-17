'use strict';
// vt-0336: daemon-side tmux discovery poller. Periodically runs
// `tmux list-sessions` and per-session `tmux show-environment` to
// pick up FLEET_AGENT/FLEET_CWD set by agent-shim (vt-0335).
// Emits `mux_sessions` frames to the hub via the supplied send fn.
//
// Compatibility:
//   - tmux 2.x/3.x: `show-environment -t name` with no var args returns
//     the full env (older versions don't accept multi-var args). We
//     filter FLEET_* in JS — one exec per session, not per-var.
//   - No tmux on host → `caps.mux` advertised empty + poller no-ops.

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const LIST_FMT = '#{session_name}|#{session_created}|#{session_activity}|#{session_attached}|#{session_windows}';

// Parse `tmux list-sessions -F <LIST_FMT>` stdout into normalized rows.
function parseListSessionsOutput(stdout) {
  if (!stdout) return [];
  function isoOrNull(secs) {
    const n = parseInt(secs, 10);
    if (!Number.isFinite(n)) return null;
    const d = new Date(n * 1000);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return stdout.trim().split('\n').filter(Boolean).map(ln => {
    const [name, created, activity, attached, windows] = ln.split('|');
    return {
      name,
      created_at: isoOrNull(created),
      last_activity: isoOrNull(activity),
      attached_clients: parseInt(attached, 10) || 0,
      windows: parseInt(windows, 10) || 0,
    };
  });
}

// Parse `tmux show-environment -t name` stdout, filtering FLEET_* keys.
function parseEnvOutput(stdout) {
  const env = {};
  for (const line of (stdout || '').split('\n')) {
    const m = line.match(/^(FLEET_[A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

// Single poll round: list sessions, enrich each with FLEET_* env vars.
// Returns [] when tmux is missing or no sessions running.
async function pollOnce() {
  let listOut = '';
  try {
    const { stdout } = await execFileAsync(
      'tmux', ['list-sessions', '-F', LIST_FMT],
      { timeout: 2000 });
    listOut = stdout;
  } catch (e) {
    // tmux exit 1 + "no server running on /tmp/tmux-..." is normal when
    // zero sessions exist. Don't log; just return empty.
    // Real errors (tmux missing, permission denied) we want to surface
    // once — but the caller logs the failure path.
    return [];
  }
  const sessions = parseListSessionsOutput(listOut);
  for (const s of sessions) {
    try {
      const { stdout: envOut } = await execFileAsync(
        'tmux', ['show-environment', '-t', s.name],
        { timeout: 1000 });
      const env = parseEnvOutput(envOut);
      s.agent = env.FLEET_AGENT || null;
      s.cwd   = env.FLEET_CWD   || null;
    } catch {
      // Session vanished between list and show-env, or env scoping
      // quirks on older tmux. Mark unknown.
      s.agent = null;
      s.cwd = null;
    }
  }
  return sessions;
}

// Start the poll loop. Returns { stop() } to clear the timer.
// `send(frame)` is invoked per tick with `{ type: 'mux_sessions', items: [...] }`.
function startPoller(send, opts = {}) {
  const intervalMs = opts.intervalMs
    || parseInt(process.env.FLEET_MUX_POLL_MS || '30000', 10);
  let stopped = false;
  let timer = null;
  async function tick() {
    if (stopped) return;
    try {
      const items = await pollOnce();
      send({ type: 'mux_sessions', items });
    } catch (e) {
      // Don't crash the daemon over a tmux quirk; surface once via log frame.
      try { send({ type: 'log', level: 'warn', msg: 'mux_poll_failed', detail: e.message }); }
      catch {}
    }
    if (!stopped) {
      timer = setTimeout(tick, intervalMs);
      timer.unref?.();
    }
  }
  timer = setTimeout(tick, 1000);  // first poll ~1s after start
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

module.exports = { parseListSessionsOutput, parseEnvOutput, pollOnce, startPoller };
