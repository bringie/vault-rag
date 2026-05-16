'use strict';
// Hermes (Nous Research) backend.
// Hermes models are not a CLI — they run inside ollama (or vllm with an
// OpenAI-compatible shim). We ship a tiny wrapper script that reads stdin,
// calls `ollama run $MODEL`, and writes to stdout. The daemon spawns the
// wrapper just like any other agent.
//
// Default wrapper path: <daemon>/src/backends/hermes-wrapper.sh.
// Override per-host with AGENT_FLEET_HERMES_BIN or backends.json bin field.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const DEFAULT_WRAPPER = path.join(__dirname, 'hermes-wrapper.sh');

module.exports = {
  name: 'hermes',
  bin_env: 'AGENT_FLEET_HERMES_BIN',
  bin_default: DEFAULT_WRAPPER,

  async detectVersion(bin) {
    // Probe by running ollama list — if ollama exists, hermes is at least
    // theoretically available. Don't try to enumerate models on each probe.
    try {
      execFileSync('ollama', ['list'], {
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
      });
      return 'wrapper@' + bin;
    } catch {
      return null;
    }
  },

  buildSpawnArgs(req) {
    // The wrapper reads model from MODEL env, prompt from stdin.
    const env = { ...(req.env || {}) };
    if (req.model) env.MODEL = String(req.model);
    // For Hermes the system_prompt is prepended to the user prompt with a
    // separator that the wrapper understands.
    let stdin = req.prompt || '';
    if (req.system_prompt) {
      stdin = `<<SYSTEM>>\n${req.system_prompt}\n<<USER>>\n${stdin}`;
    }
    // Unsupported fields → warn-once.
    for (const k of ['allowed_tools', 'resume_session_id', 'dangerous']) {
      if (req[k] != null && !this[`_warned_${k}`]) {
        this[`_warned_${k}`] = true;
        console.warn(`[backend:hermes] ${k} is not supported via the ollama wrapper; ignoring`);
      }
    }
    const argv = [];
    for (const a of req.args || []) argv.push(String(a));
    return { argv, env, stdin };
  },

  parseCostFrame() { return null; },
};
