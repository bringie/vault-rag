'use strict';
// NanoClaw backend — https://nanoclaw.dev / github.com/nanocoai/nanoclaw
// NanoClaw runs as a long-lived service that listens on messaging channels
// (WhatsApp, Telegram, Slack, etc.) and orchestrates Claude/Codex/local-LLM
// via Claude Agent SDK + skills. It is NOT a one-shot CLI — the fleet
// daemon manages its lifecycle (start/stop) rather than spawning per-prompt
// processes. See spec §5.6 for the side-car decision.
//
// On a spawn request we return a non-zero exit immediately so the workflow
// engine surfaces the mode mismatch clearly. To actually drive NanoClaw
// from the fleet, build the (b) RPC bridge as a follow-up.

// N5 (audit): cache the probe result for the lifetime of the daemon process.
// If the loopback admin endpoint is blocked (firewalled, port not bound),
// every reconnect would otherwise burn the full 2s timeout before the hello
// frame is sent. The probe is best-effort metadata; a cached "unreachable"
// result is no worse than re-running it on every reconnect.
let _versionCache = undefined;

module.exports = {
  name: 'nanoclaw',
  bin_env: 'AGENT_FLEET_NANOCLAW_BIN',
  bin_default: 'nanoclaw.sh',
  mode: 'sidecar',

  async detectVersion(/* bin */) {
    if (_versionCache !== undefined) return _versionCache;
    // Lifecycle-only — version probe checks whether the service is reachable
    // via its loopback admin endpoint. Default endpoint per docs.
    try {
      const res = await fetch('http://127.0.0.1:8765/version', { signal: AbortSignal.timeout(2000) });
      if (!res.ok) { _versionCache = null; return null; }
      const txt = await res.text();
      _versionCache = (txt || '').trim().slice(0, 64) || 'reachable';
      return _versionCache;
    } catch {
      _versionCache = null;
      return null;
    }
  },

  // Test/dev hook to force a fresh probe.
  _resetVersionCache() { _versionCache = undefined; },

  buildSpawnArgs(/* req */) {
    // Spawn requests are not supported on a side-car backend. Return an argv
    // that immediately fails with a clear message — the daemon's spawn_err
    // path will surface this to the operator in the UI without crashing.
    return {
      argv: ['-c', 'echo "[nanoclaw] sidecar backend: per-prompt spawn not supported; see docs" >&2; exit 22'],
      env: {},
      stdin: null,
      // Force the daemon to use /bin/sh as the bin, ignoring nanoclaw.sh.
      _shimBin: '/bin/sh',
    };
  },

  parseCostFrame() { return null; },
};
