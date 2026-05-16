'use strict';
// Anthropic Claude CLI backend.
// Contract: see backends/index.js header.

const { execFileSync } = require('node:child_process');

module.exports = {
  name: 'claude',
  bin_env: 'AGENT_FLEET_CLAUDE_BIN',
  bin_default: 'claude',

  async detectVersion(bin) {
    try {
      const out = execFileSync(bin, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
      });
      return String(out).trim().split('\n')[0] || null;
    } catch { return null; }
  },

  // Build claude argv from a generic spawn request. Returns argv (no bin
  // prepended — caller spawns bin + argv). Structured flags first; req.args
  // (raw passthrough) appended last so an author can override.
  buildSpawnArgs(req) {
    const argv = [];
    if (req.model)              argv.push('--model', String(req.model));
    if (req.system_prompt)      argv.push('--append-system-prompt', String(req.system_prompt));
    if (req.allowed_tools)      argv.push('--allowed-tools', String(req.allowed_tools));
    if (req.resume_session_id)  argv.push('--resume', String(req.resume_session_id));
    if (req.dangerous)          argv.push('--dangerously-skip-permissions');
    for (const a of req.args || []) argv.push(String(a));
    return {
      argv,
      env: req.env || {},
      // Prompt goes through PTY stdin AFTER spawn (current behaviour the hub
      // already implements via POST /sessions/:id/input). Return null here so
      // the daemon spawn path knows not to inject prompt into argv.
      stdin: req.prompt || null,
    };
  },

  // Optional. Returns { input_tokens, output_tokens, model } or null when
  // the frame is not a cost-bearing line. Claude does not emit structured
  // cost frames over PTY; the hub computes cost via tokmon. Always null here.
  parseCostFrame(/* frame */) { return null; },
};
