'use strict';
// OpenClaw backend — https://openclaw.ai / https://github.com/openclaw/openclaw
// OpenClaw is itself an orchestrator with its own skills runtime. We treat
// it as a process that consumes a prompt and emits output via a wrapper
// script — the wrapper picks the right `openclaw <skill>` invocation based
// on $OPENCLAW_SKILL env (default: chat).

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const DEFAULT_WRAPPER = path.join(__dirname, 'openclaw-run.sh');

module.exports = {
  name: 'openclaw',
  bin_env: 'AGENT_FLEET_OPENCLAW_BIN',
  bin_default: DEFAULT_WRAPPER,

  async detectVersion(bin) {
    try {
      // Wrapper script: --version returns underlying openclaw version.
      // Plain openclaw bin: also supports --version.
      const out = execFileSync(bin, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
      });
      return String(out).trim().split('\n')[0] || null;
    } catch { return null; }
  },

  buildSpawnArgs(req) {
    // Wrapper expects: $OPENCLAW_SKILL env + prompt via stdin.
    // Model/system_prompt forwarded so the wrapper can pass them through if
    // the underlying skill supports them.
    const env = { ...(req.env || {}) };
    if (req.model)              env.OPENCLAW_MODEL         = String(req.model);
    if (req.system_prompt)      env.OPENCLAW_SYSTEM_PROMPT = String(req.system_prompt);
    if (req.allowed_tools)      env.OPENCLAW_ALLOWED_TOOLS = String(req.allowed_tools);
    // First positional arg of `args` is treated as the skill name; default 'chat'.
    const args = (req.args || []).slice();
    const skill = args.shift() || 'chat';
    env.OPENCLAW_SKILL = String(skill);
    return { argv: args.map(String), env, stdin: req.prompt || null };
  },

  parseCostFrame() { return null; },
};
