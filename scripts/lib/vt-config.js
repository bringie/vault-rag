'use strict';

// vt: configuration & path resolution.
// Resolves vault directory, API base, and token from env/.env.

const fs = require('fs');
const path = require('path');

function findRepoRoot(start) {
  let cur = path.resolve(start || process.cwd());
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function loadDotenv(repoRoot) {
  const envPath = path.join(repoRoot || '', '.env');
  if (!repoRoot || !fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function resolveConfig() {
  const repoRoot = findRepoRoot();
  const envFile = loadDotenv(repoRoot);
  const get = (k) => process.env[k] || envFile[k];

  const vaultDir = process.env.VT_VAULT_DIR
    || (repoRoot ? path.join(repoRoot, 'obsidian-vault') : null);

  if (!vaultDir || !fs.existsSync(vaultDir)) {
    throw new Error(
      `vt: vault directory not found (tried ${vaultDir}). ` +
      `Set VT_VAULT_DIR or run from inside a repo with obsidian-vault/.`
    );
  }

  const tasksDir = path.join(vaultDir, '04-tasks');
  const seqDir   = path.join(vaultDir, '.vt');
  const seqFile  = path.join(seqDir, 'seq');
  const notesDir = path.join(vaultDir, '06-resources', 'notes');

  const apiBase = process.env.VT_API_BASE
    || get('VAULT_RAG_API_URL')
    || (get('VAULT_RAG_DOMAIN') ? `https://${get('VAULT_RAG_DOMAIN')}` : null);
  const apiToken = process.env.VT_API_TOKEN || get('VAULT_RAG_API_TOKEN');

  return {
    repoRoot,
    vaultDir,
    tasksDir,
    seqDir,
    seqFile,
    notesDir,
    apiBase,
    apiToken,
    agentId: process.env.VT_AGENT || process.env.USER || 'unknown',
  };
}

module.exports = { resolveConfig, findRepoRoot, loadDotenv };
