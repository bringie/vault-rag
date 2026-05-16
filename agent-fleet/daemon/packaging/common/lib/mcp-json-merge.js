#!/usr/bin/env node
'use strict';
// vt-0143: atomic merge helper for ~/.claude.json (and equivalents).
// Reads existing JSON → mutates only mcpServers.<name> → tmp file +
// rename. REFUSES to clobber malformed JSON (preserves user's broken
// state instead of silently nuking it).

const fs = require('node:fs');
const path = require('node:path');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const target = args.target;
const name = args.name;
const url = args.url;
const token = args.token;
const tokenHeader = args['token-header'] || 'X-Vault-Token';
if (!target || !name || !url || !token) {
  console.error('mcp-json-merge: required: --target --name --url --token');
  console.error('optional: --token-header (default: X-Vault-Token)');
  process.exit(2);
}

fs.mkdirSync(path.dirname(target), { recursive: true });

let cur = {};
if (fs.existsSync(target)) {
  let raw;
  try { raw = fs.readFileSync(target, 'utf8'); }
  catch (e) { console.error('mcp-json-merge: read fail:', e.message); process.exit(1); }
  if (raw.trim()) {
    try { cur = JSON.parse(raw); }
    catch (e) {
      console.error(`mcp-json-merge: ${target} is not valid JSON; refusing to clobber.`);
      console.error('Move it aside and re-run to start fresh.');
      process.exit(1);
    }
  }
}
cur.mcpServers = cur.mcpServers || {};
cur.mcpServers[name] = {
  type: 'http',
  url,
  headers: { [tokenHeader]: token },
};

const tmp = target + '.tmp.' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(cur, null, 2));
fs.chmodSync(tmp, 0o600);
fs.renameSync(tmp, target);
console.log(`mcp-json-merge: wrote ${target} (mcpServers.${name})`);
