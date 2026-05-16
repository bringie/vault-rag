'use strict';
// Backend registry — pluggable agent CLIs (claude / opencode / codex / hermes /
// openclaw / nanoclaw / ...). Each backend implements the same contract so the
// daemon's spawn path doesn't have to know about the per-CLI argv shape.
//
// Contract (each backend module):
//   {
//     name: 'claude' | 'opencode' | 'codex' | ...,
//     bin_env: 'AGENT_FLEET_CLAUDE_BIN',          // env var holding bin path
//     bin_default: 'claude',                       // fallback if env unset
//     async detectVersion(bin): string|null,       // version probe; null on fail
//     buildSpawnArgs(req): { argv, env, stdin },   // shape an HTTP spawn req
//     parseCostFrame(frame): {input_tokens,output_tokens,model}|null,  // optional
//   }
//
// Config file (backends.json) example:
//   {
//     "backends": [
//       { "name": "claude",   "module": "./claude.js" },
//       { "name": "opencode", "module": "./opencode.js", "bin": "/usr/local/bin/opencode" }
//     ],
//     "default": "claude"
//   }
//
// If no config exists, only the built-in claude backend is registered.

const fs = require('node:fs');
const path = require('node:path');

function loadBackends({ configPath, baseDir } = {}) {
  const registry = new Map();
  let defaultName = 'claude';

  // Always register the built-in claude backend.
  registry.set('claude', wrap(require('./claude'), null));

  if (configPath && fs.existsSync(configPath)) {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')); }
    catch (e) {
      console.warn(`[backends] failed to parse ${configPath}: ${e.message} — using claude only`);
      return { registry, default: defaultName };
    }
    if (cfg.default) defaultName = cfg.default;
    const dir = baseDir || path.dirname(configPath);
    for (const b of cfg.backends || []) {
      if (!b.name || !b.module) continue;
      const modPath = b.module.startsWith('.') ? path.resolve(dir, b.module) : b.module;
      try {
        const mod = require(modPath);
        registry.set(b.name, wrap(mod, b.bin));
        // Mute the warning when we just re-registered the built-in claude.
      } catch (e) {
        console.error(`[backends] failed to load ${b.name} from ${modPath}: ${e.message}`);
      }
    }
  }
  return { registry, default: defaultName };
}

function wrap(mod, binOverride) {
  // Resolve effective binary path: explicit override → env var → default.
  const bin = binOverride
    || (mod.bin_env && process.env[mod.bin_env])
    || mod.bin_default
    || mod.name;
  return { ...mod, bin };
}

function pick(registry, name, defaultName) {
  if (name && registry.has(name)) return registry.get(name);
  if (registry.has(defaultName)) return registry.get(defaultName);
  // Last resort: any registered backend.
  return registry.values().next().value || null;
}

module.exports = { loadBackends, pick };
