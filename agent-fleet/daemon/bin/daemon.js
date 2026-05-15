#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { runDaemon } = require('../src/ws-client');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--hub') out.hub = args[++i];
    else if (a === '--token') out.token = args[++i];
    else if (a === '--host-name') out.hostName = args[++i];
    else if (a === '--caps') out.capabilities = args[++i].split(',').filter(Boolean);
    else if (a === '--state-dir') out.stateDir = args[++i];
    else if (a === '--claude-bin') out.claudeBin = args[++i];
  }
  out.hub = out.hub || process.env.AGENT_FLEET_HUB;
  out.token = out.token || process.env.AGENT_FLEET_TOKEN || process.env.VAULT_RAG_API_TOKEN;
  out.hostName = out.hostName || process.env.AGENT_FLEET_HOST_NAME || require('node:os').hostname();
  out.stateDir = out.stateDir || path.join(require('node:os').homedir(), '.agent-fleet');
  out.claudeBin = out.claudeBin || process.env.AGENT_FLEET_CLAUDE_BIN || 'claude';
  return out;
}

const opts = parseArgs();
if (!opts.hub) { console.error('--hub required'); process.exit(2); }
if (!opts.token) { console.error('--token (or env AGENT_FLEET_TOKEN) required'); process.exit(2); }
console.error(`[daemon] starting host=${opts.hostName} hub=${opts.hub} claude=${opts.claudeBin}`);

const ctrl = new AbortController();
process.on('SIGTERM', () => ctrl.abort());
process.on('SIGINT',  () => ctrl.abort());

runDaemon({ ...opts, abortSignal: ctrl.signal }).catch((e) => { console.error(e); process.exit(1); });
