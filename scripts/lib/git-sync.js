// git-sync: fire-and-forget trigger of vault-sync.sh push after writes.
// No-op if .sync/vault-sync.sh missing (tests, fresh vaults).
// Debounces bursts into a single push; lockdir in vault-sync.sh handles concurrency.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const log = require('./log').for('git-sync');

const DEBOUNCE_MS = 1500;

const state = new Map();

// I5 (audit pass 2): refuse to launch if the script is world-writable. Vault
// is a git repo; an attacker who lands a `.sync/vault-sync.sh` (via a
// compromised /api/put path, or a separate ingress) would otherwise get host
// RCE on next debounce tick. Also restrict env passthrough to a minimal set —
// the script only needs PATH/HOME/git-related vars.
const ALLOWED_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL',
  'GIT_SSH_COMMAND', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'SSH_AUTH_SOCK',
]);
function minimalEnv() {
  const out = {};
  for (const k of ALLOWED_ENV_KEYS) if (process.env[k] != null) out[k] = process.env[k];
  out.HOME = out.HOME || '/root';
  return out;
}

function trigger(vault) {
  if (!vault) return;
  const script = path.join(vault, '.sync', 'vault-sync.sh');
  if (!fs.existsSync(script)) return;
  // I5: defence-in-depth — bail if the script has gone world/group-writable.
  try {
    const st = fs.statSync(script);
    if ((st.mode & 0o022) !== 0) {
      log.error('script_unsafe_perms', { script, mode: (st.mode & 0o777).toString(8) });
      return;
    }
  } catch (e) {
    log.error('script_stat_failed', { script, msg: e.message });
    return;
  }

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
        env: minimalEnv(),
        stdio: 'ignore',
        detached: true,
      });
      ch.on('error', (e) => log.error('spawn_error', { msg: e.message }));
      ch.unref();
    } catch (e) {
      log.error('run_error', { msg: e.message });
    }
  }, DEBOUNCE_MS);
  if (s.timer.unref) s.timer.unref();
}

module.exports = { trigger };
