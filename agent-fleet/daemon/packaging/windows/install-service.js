#!/usr/bin/env node
'use strict';
// Installs/removes the Windows service. Invoked by install.ps1 / uninstall.ps1.
// Why a separate JS: node-windows is a JS lib, easier to call directly than
// wrap in PowerShell. Reads env file → service env vars → Service.install().

const fs = require('node:fs');
const path = require('node:path');

function parseEnvFile(p) {
  const out = [];
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out.push({ name: m[1], value: m[2] });
  }
  return out;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const action      = process.argv[2];                              // install | uninstall
const serviceName = arg('--service-name', 'agent-fleet-daemon');
const installDir  = arg('--install-dir', path.resolve(__dirname, '..', '..'));
const envFile     = arg('--env-file', null);

let Service;
try { Service = require('node-windows').Service; }
catch (e) {
  console.error('[install-service] node-windows not installed. Run: npm install node-windows');
  process.exit(2);
}

const svc = new Service({
  name: serviceName,
  description: 'agent-fleet per-host daemon',
  script: path.join(installDir, 'bin', 'daemon.js'),
  nodeOptions: [],
  env: envFile ? parseEnvFile(envFile) : [],
});

if (action === 'install') {
  svc.on('install', () => { console.log(`[install-service] installed; starting`); svc.start(); });
  svc.on('alreadyinstalled', () => { console.log('[install-service] already installed; restarting'); svc.restart(); });
  svc.on('start', () => console.log('[install-service] started'));
  svc.install();
} else if (action === 'uninstall') {
  svc.on('uninstall', () => console.log('[install-service] uninstalled'));
  svc.uninstall();
} else {
  console.error('usage: install-service.js install|uninstall [--service-name N] [--install-dir D] [--env-file F]');
  process.exit(2);
}
