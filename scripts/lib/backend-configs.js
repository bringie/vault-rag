'use strict';
// backend-configs: single source of truth for which config files belong
// to which agent backend. Used by:
//   - daemon ws-client.js  → resolveAllowedPath() write allowlist
//   - hub /api/fleet/backend-configs → web UI per-host edit buttons
//
// Keep symbolic names stable across daemon + UI. Adding a new backend?
// 1. Add an entry here.
// 2. Daemon's resolveAllowedPath uses HOME-relative paths verbatim, so a
//    new path like 'AGENTS.md' is automatically writable once it's listed.
// 3. UI reads the map via /api/fleet/backend-configs; no UI change needed
//    for a single-file backend.

const BACKEND_CONFIGS = Object.freeze({
  claude: Object.freeze([
    { name: 'CLAUDE.md',     rel: '.claude/CLAUDE.md',     label: 'CLAUDE.md' },
    { name: 'settings.json', rel: '.claude/settings.json', label: 'settings.json' },
  ]),
  codex: Object.freeze([
    { name: 'AGENTS.md',     rel: 'AGENTS.md',             label: 'AGENTS.md (codex)' },
  ]),
  opencode: Object.freeze([
    { name: 'AGENTS.md',     rel: 'AGENTS.md',             label: 'AGENTS.md (opencode)' },
  ]),
  gemini: Object.freeze([
    { name: 'GEMINI.md',     rel: '.gemini/GEMINI.md',     label: 'GEMINI.md' },
  ]),
  // hermes wrapper reads MODEL env → no editable config file
  hermes: Object.freeze([]),
  openclaw: Object.freeze([]),  // shares CLAUDE.md/settings.json with claude
  nanoclaw: Object.freeze([]),
});

// Flattened allowlist: { 'CLAUDE.md': '.claude/CLAUDE.md', 'AGENTS.md': 'AGENTS.md', ... }
// AGENTS.md appears in both codex + opencode but maps to the same relative path,
// so the merge is a no-op on conflict.
function flatPaths() {
  const out = {};
  for (const list of Object.values(BACKEND_CONFIGS)) {
    for (const entry of list) {
      if (out[entry.name] && out[entry.name] !== entry.rel) {
        throw new Error(`backend-configs: symbolic name "${entry.name}" maps to two different paths`);
      }
      out[entry.name] = entry.rel;
    }
  }
  return out;
}

module.exports = { BACKEND_CONFIGS, flatPaths };
