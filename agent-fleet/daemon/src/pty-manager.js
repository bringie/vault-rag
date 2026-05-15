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
  spawn({ sessionId, cwd, args = [], env = {} }) {
    // Resolve '~', '~/', or empty cwd to the daemon's $HOME.
    const home = process.env.HOME || '/root';
    let resolvedCwd = cwd;
    if (!resolvedCwd || resolvedCwd === '~') resolvedCwd = home;
    else if (resolvedCwd.startsWith('~/')) resolvedCwd = home + resolvedCwd.slice(1);
    const proc = pty.spawn(this.claudeBin, args, {
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
