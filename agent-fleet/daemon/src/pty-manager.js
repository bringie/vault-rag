'use strict';
const { EventEmitter } = require('node:events');
const pty = require('node-pty');

function signalName(n) {
  const map = { 1:'HUP', 2:'INT', 9:'KILL', 15:'TERM' };
  return map[n] || String(n);
}

class PtyManager extends EventEmitter {
  constructor({ claudeBin = 'claude', killGraceMs = 5000 } = {}) {
    super();
    this.claudeBin = claudeBin;
    this.killGraceMs = killGraceMs;
    this.sessions = new Map();
  }
  spawn({ sessionId, cwd, args = [], env = {}, binOverride = null }) {
    // Resolve '~', '~/', or empty cwd to the daemon's $HOME.
    const home = process.env.HOME || '/root';
    let resolvedCwd = cwd;
    if (!resolvedCwd || resolvedCwd === '~') resolvedCwd = home;
    else if (resolvedCwd.startsWith('~/')) resolvedCwd = home + resolvedCwd.slice(1);

    // Per-spawn bin override (chosen by backend registry, vt-0096). Falls back
    // to claudeBin so legacy callers keep working.
    let bin = binOverride || this.claudeBin;
    // Inject --session-id <fleet sid> for exact tokmon cost attribution.
    // Only when running claude AND caller didn't already pass --session-id.
    let finalArgs = args.slice();
    const looksLikeClaude = /claude(\.|$)/i.test(bin);
    const hasSessionFlag = finalArgs.some(a => a === '--session-id' || a.startsWith('--session-id='));
    if (looksLikeClaude && !hasSessionFlag && /^[0-9a-f-]{36}$/i.test(sessionId)) {
      finalArgs.unshift('--session-id', sessionId);
    }

    // vt-0305: opt-in sandbox. When AGENT_FLEET_SANDBOX is set to
    // "firejail" / "bwrap" the spawn is wrapped in a profile that
    // restricts what the agent process can read/write/network.
    // Operator gets defence-in-depth against Claude going rogue
    // (intentional or via prompt injection):
    //   - firejail: needs `firejail` binary on PATH; --quiet --net=none
    //     --private-tmp by default. Override with AGENT_FLEET_SANDBOX_ARGS.
    //   - bwrap:    minimal user-namespace; --ro-bind / etc by default.
    //   - none (default): legacy behaviour, no wrap.
    const sandboxMode = process.env.AGENT_FLEET_SANDBOX || 'none';
    if (sandboxMode === 'bwrap') {
      // vt-0317: hardened defaults. Earlier set bound the daemon user's
      // full $HOME read-write — claude-in-sandbox could read .ssh/id_rsa,
      // .gh-token, .git-credentials and exfil through stdout. NEW model:
      // give the sandbox an empty tmpfs HOME at /sandbox-home so the
      // host's $HOME is invisible. Network is also unshared by default
      // (claude-in-sandbox can't curl out). cwd remains writable for
      // the legitimate work loop.
      // To restore the previous behaviour (host HOME visible, network
      // available) set AGENT_FLEET_SANDBOX_ARGS to your own bwrap args.
      const defaultBwrap = [
        '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net',
        '--die-with-parent',
        '--ro-bind', '/usr', '/usr',
        '--ro-bind', '/bin', '/bin',
        '--ro-bind', '/lib', '/lib',
        '--ro-bind', '/lib64', '/lib64',
        '--ro-bind', '/etc/ssl', '/etc/ssl',
        '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf',
        '--bind', resolvedCwd, resolvedCwd,
        '--tmpfs', '/sandbox-home',
        '--setenv', 'HOME', '/sandbox-home',
        '--proc', '/proc',
        '--dev', '/dev',
        '--tmpfs', '/tmp',
      ];
      const extra = process.env.AGENT_FLEET_SANDBOX_ARGS
        ? process.env.AGENT_FLEET_SANDBOX_ARGS.split(/\s+/).filter(Boolean)
        : defaultBwrap;
      finalArgs = [...extra, '--', bin, ...finalArgs];
      bin = 'bwrap';
    } else if (sandboxMode === 'firejail') {
      // vt-0317: firejail also unshares net by default + private-tmp +
      // private-home (overlay). Operator who needs network grants it
      // via AGENT_FLEET_SANDBOX_ARGS="--net=none" override OR keeps
      // the default below which already disables it.
      const extra = (process.env.AGENT_FLEET_SANDBOX_ARGS
        || '--quiet --private-tmp --private --net=none').split(/\s+/).filter(Boolean);
      finalArgs = [...extra, '--', bin, ...finalArgs];
      bin = 'firejail';
    }
    // sandboxMode other than known values is treated as 'none' (don't
    // crash on typos — daemon would refuse to spawn anything).

    const proc = pty.spawn(bin, finalArgs, {
      name: 'xterm-color', cols: 120, rows: 30, cwd: resolvedCwd,
      env: { ...process.env, ...env },
    });
    this.sessions.set(sessionId, { proc, seq: 0 });
    this.emit('spawn', { sessionId, pid: proc.pid });
    // Kick TUIs (Ink-based claude in particular) that wait for SIGWINCH before
    // first render. Two resize ticks shortly after spawn force the redraw.
    setTimeout(() => { try { proc.resize(121, 30); } catch {} }, 100);
    setTimeout(() => { try { proc.resize(120, 30); } catch {} }, 250);
    proc.onData((d) => {
      const entry = this.sessions.get(sessionId);
      if (!entry) return;
      const seq = entry.seq++;
      this.emit('data', { sessionId, seq, data: Buffer.from(d, 'utf8') });
    });
    proc.onExit(({ exitCode, signal }) => {
      this.sessions.delete(sessionId);
      this.emit('exit', { sessionId, exitCode, signal: signal ? `SIG${signalName(signal)}` : null });
    });
    return { pid: proc.pid };
  }
  writeInput(sessionId, data) {
    const e = this.sessions.get(sessionId);
    if (!e) return;
    e.proc.write(data);
  }
  resize(sessionId, cols, rows) {
    const e = this.sessions.get(sessionId);
    if (!e) return;
    e.proc.resize(cols, rows);
  }
  kill(sessionId, signal = 'SIGTERM') {
    const e = this.sessions.get(sessionId);
    if (!e) return;
    try { e.proc.kill(signal); } catch {}
    setTimeout(() => {
      const still = this.sessions.get(sessionId);
      if (still) try { still.proc.kill('SIGKILL'); } catch {}
    }, this.killGraceMs).unref?.();
  }
  list() {
    return Array.from(this.sessions.entries()).map(([id, e]) => ({
      session_id: id, pid: e.proc.pid, last_seq: e.seq,
    }));
  }
}

module.exports = { PtyManager };
