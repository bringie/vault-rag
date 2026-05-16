'use strict';
// OpenCode CLI backend — https://github.com/sst/opencode
// Argv mapping derived from the public docs as of 2026-05.

const { execFileSync } = require('node:child_process');

module.exports = {
  name: 'opencode',
  bin_env: 'AGENT_FLEET_OPENCODE_BIN',
  bin_default: 'opencode',

  async detectVersion(bin) {
    try {
      const out = execFileSync(bin, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
      });
      return String(out).trim().split('\n')[0] || null;
    } catch { return null; }
  },

  buildSpawnArgs(req) {
    const argv = [];
    // opencode supports --model and --provider. We don't track provider on
    // our side yet — assume model strings are namespaced (anthropic/…).
    if (req.model)              argv.push('--model', String(req.model));
    if (req.system_prompt)      argv.push('--system', String(req.system_prompt));
    if (req.resume_session_id)  argv.push('--resume', String(req.resume_session_id));
    // opencode auto-approve is roughly equivalent to claude's dangerous flag.
    if (req.dangerous)          argv.push('--auto-approve');
    // allowed_tools: not directly supported via CLI in v1 — warn-once.
    if (req.allowed_tools && !this._warnedTools) {
      this._warnedTools = true;
      console.warn('[backend:opencode] allowed_tools is not supported on the CLI yet; ignoring');
    }
    for (const a of req.args || []) argv.push(String(a));
    return { argv, env: req.env || {}, stdin: req.prompt || null };
  },

  parseCostFrame() { return null; },
  _warnedTools: false,
};
