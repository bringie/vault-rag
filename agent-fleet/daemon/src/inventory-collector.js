'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

let lastMtimes = {};

function inventoryChanged() {
  const home = os.homedir();
  const targets = [
    path.join(home, '.claude', 'mcp.json'),
    path.join(home, '.claude', 'settings.json'),
  ];
  let changed = false;
  for (const p of targets) {
    try {
      const stat = fs.statSync(p);
      const m = stat.mtimeMs;
      if (lastMtimes[p] !== m) { lastMtimes[p] = m; changed = true; }
    } catch {
      if (lastMtimes[p] !== undefined) { lastMtimes[p] = undefined; changed = true; }
    }
  }
  return changed;
}

function resetInventoryCache() { lastMtimes = {}; }

function safeReaddir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
}

function scanSkills(home) {
  const root = path.join(home, '.claude', 'plugins', 'cache');
  if (!fs.existsSync(root)) return [];
  const skills = [];
  for (const mp of safeReaddir(root)) {
    const mpDir = path.join(root, mp);
    for (const plugin of safeReaddir(mpDir)) {
      const pluginDir = path.join(mpDir, plugin);
      for (const version of safeReaddir(pluginDir)) {
        const skillsDir = path.join(pluginDir, version, 'skills');
        for (const name of safeReaddir(skillsDir)) {
          skills.push({ plugin, version, name });
        }
      }
    }
  }
  return skills;
}

function parseMcpServers(home) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'mcp.json'), 'utf8'));
    const out = [];
    for (const [name, def] of Object.entries(cfg.mcpServers || {})) {
      out.push({
        name,
        enabled: def.disabled !== true,
        command: def.command || null,
        args: Array.isArray(def.args) ? def.args.slice(0, 5) : [],
      });
    }
    return out;
  } catch { return []; }
}

function detectClaudeVersion() {
  try {
    // vt-0342: claude CLI ≥ 2.1.x writes "open terminal failed: not a
    // terminal" to stderr when invoked without a TTY (even for
    // --version). Without TERM in the env, even the exit code can
    // flip non-zero. Two-belt-suspenders fix:
    //   1. set TERM=xterm-256color so claude treats us as terminal-aware
    //   2. drop stderr (stdio[2]='ignore') so daemon logs stay clean
    return execFileSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 1500,
      env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

// SECURITY POLICY: strict allowlist. Each value's shape validated.
// EXCLUDED keys (would leak secrets): env, hooks, permissions, credentials.
function parseSettings(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    const out = {};
    if (typeof raw.model === 'string')          out.model = raw.model;
    if (typeof raw.permissionMode === 'string') out.permissionMode = raw.permissionMode;
    if (raw.autoUpdater && typeof raw.autoUpdater === 'object' && typeof raw.autoUpdater.enabled === 'boolean') {
      out.autoUpdater = { enabled: raw.autoUpdater.enabled };
    }
    if (raw.enabledPlugins && typeof raw.enabledPlugins === 'object'
        && Object.values(raw.enabledPlugins).every(v => typeof v === 'boolean')) {
      out.enabledPlugins = raw.enabledPlugins;
    }
    return out;
  } catch { return null; }
}

function collectInventory() {
  const home = os.homedir();
  return {
    collected_at: new Date().toISOString(),
    skills: scanSkills(home),
    mcp_servers: parseMcpServers(home),
    claude_version: detectClaudeVersion(),
    settings: parseSettings(home),
  };
}

module.exports = {
  collectInventory, inventoryChanged, resetInventoryCache,
  _internals: { scanSkills, parseMcpServers, detectClaudeVersion, parseSettings },
};
