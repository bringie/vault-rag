// git-sync: fire-and-forget trigger of vault-sync.sh push after writes.
// No-op if .sync/vault-sync.sh missing (tests, fresh vaults).
// Debounces bursts into a single push; lockdir in vault-sync.sh handles concurrency.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const DEBOUNCE_MS = 1500;

const state = new Map();

function trigger(vault) {
  if (!vault) return;
  const script = path.join(vault, '.sync', 'vault-sync.sh');
  if (!fs.existsSync(script)) return;

  let s = state.get(vault);
  if (!s) {
    s = { timer: null, pending: false };
    state.set(vault, s);
  }
  s.pending = true;
  if (s.timer) return;

  s.timer = setTimeout(() => {
    s.timer = null;
    if (!s.pending) return;
    s.pending = false;
    try {
      const ch = spawn('bash', [script, 'push'], {
        cwd: vault,
        env: { ...process.env, HOME: process.env.HOME || '/root' },
        stdio: 'ignore',
        detached: true,
      });
      ch.on('error', (e) => console.error(`[git-sync] spawn: ${e.message}`));
      ch.unref();
    } catch (e) {
      console.error(`[git-sync] ${e.message}`);
    }
  }, DEBOUNCE_MS);
  if (s.timer.unref) s.timer.unref();
}

module.exports = { trigger };
