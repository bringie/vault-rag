'use strict';

// git-sync: fire-and-forget trigger of vault-sync.sh push after writes.
// No-op if .sync/vault-sync.sh missing (tests, fresh vaults).
// Debounces bursts into a single push; lockdir in vault-sync.sh handles concurrency.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const log = require('./log').for('git-sync');
const metrics = require('./metrics');

const DEBOUNCE_MS = parseInt(process.env.VAULT_GIT_SYNC_DEBOUNCE_MS || '1500', 10);

// vt-0289: observability for git push failures. Previously the spawn was
// fire-and-forget with stdio:'ignore' — a deploy key expired, branch
// diverged, or DNS blip would silently drop the push and the operator
// would only find out by comparing replicas days later.
const _syncResults = metrics.counter('vault_git_sync_total',
  'vault-sync.sh push attempts by outcome', ['outcome']);
const _syncLastOk = metrics.gauge('vault_git_sync_last_ok_seconds',
  'epoch seconds of the most recent successful vault-sync push (0 = never)');
const _syncLastFail = metrics.gauge('vault_git_sync_last_fail_seconds',
  'epoch seconds of the most recent failed vault-sync push (0 = never)');
// Module-local view for status() — avoids reaching into metrics-lib privates.
let _lastOkEpoch = 0;
let _lastFailEpoch = 0;
_syncLastOk.set({}, 0);
_syncLastFail.set({}, 0);

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
      // vt-0289: capture stdout/stderr (last 4 KiB each) + exit code so
      // we can record outcomes. Still non-blocking — the caller's
      // /api/put response already returned. Don't `unref` immediately:
      // we need the `exit` event.
      const ch = spawn('bash', [script, 'push'], {
        cwd: vault,
        env: minimalEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const cap = (buf, chunk) => Buffer.concat([buf, chunk]).slice(-4096);
      let stdoutTail = Buffer.alloc(0);
      let stderrTail = Buffer.alloc(0);
      ch.stdout.on('data', (c) => { stdoutTail = cap(stdoutTail, c); });
      ch.stderr.on('data', (c) => { stderrTail = cap(stderrTail, c); });
      ch.on('error', (e) => {
        _syncResults.inc({ outcome: 'spawn_error' });
        _lastFailEpoch = Math.floor(Date.now() / 1000); _syncLastFail.set({}, _lastFailEpoch);
        log.error('spawn_error', { msg: e.message });
      });
      ch.on('close', (code) => {
        if (code === 0) {
          _syncResults.inc({ outcome: 'ok' });
          _lastOkEpoch = Math.floor(Date.now() / 1000);
          _syncLastOk.set({}, _lastOkEpoch);
        } else {
          _syncResults.inc({ outcome: 'failed' });
          _lastFailEpoch = Math.floor(Date.now() / 1000); _syncLastFail.set({}, _lastFailEpoch);
          log.error('push_failed', {
            exit_code: code,
            vault,
            stdout: stdoutTail.toString('utf8'),
            stderr: stderrTail.toString('utf8'),
          });
        }
      });
    } catch (e) {
      _syncResults.inc({ outcome: 'spawn_error' });
      _lastFailEpoch = Math.floor(Date.now() / 1000); _syncLastFail.set({}, _lastFailEpoch);
      log.error('run_error', { msg: e.message });
    }
  }, DEBOUNCE_MS);
  if (s.timer.unref) s.timer.unref();
}

// vt-0289: expose status for /healthz/detail to surface "git push hasn't
// succeeded in 2 hours" without forcing the operator to grep logs.
function status() {
  return {
    last_ok_epoch:   _lastOkEpoch,
    last_fail_epoch: _lastFailEpoch,
  };
}

module.exports = { trigger, status };
