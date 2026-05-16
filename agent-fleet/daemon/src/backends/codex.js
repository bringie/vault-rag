'use strict';
// OpenAI Codex CLI backend — https://github.com/openai/codex
// Argv mapping for the public CLI as of 2026-05.

const { execFileSync } = require('node:child_process');

module.exports = {
  name: 'codex',
  bin_env: 'AGENT_FLEET_CODEX_BIN',
  bin_default: 'codex',

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
    if (req.model)         argv.push('--model', String(req.model));
    if (req.system_prompt) argv.push('--instructions', String(req.system_prompt));
    // codex doesn't expose allowed_tools or session-resume on the CLI in v1.
    for (const k of ['allowed_tools', 'resume_session_id', 'dangerous']) {
      if (req[k] != null && !this[`_warned_${k}`]) {
        this[`_warned_${k}`] = true;
        console.warn(`[backend:codex] ${k} is not supported on the CLI yet; ignoring`);
      }
    }
    for (const a of req.args || []) argv.push(String(a));
    return { argv, env: req.env || {}, stdin: req.prompt || null };
  },

  parseCostFrame() { return null; },
};
