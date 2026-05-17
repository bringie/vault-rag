#!/usr/bin/env node
'use strict';

// Reads local 04-tasks/*.md and POSTs each to /api/task/import.
// Requires VAULT_RAG_URL, VAULT_RAG_API_TOKEN, and source dir as argv[2].
const fs = require('node:fs');
const path = require('node:path');

const url = process.env.VAULT_RAG_URL;
const token = process.env.VAULT_RAG_API_TOKEN;
const src = process.argv[2];
if (!url || !token || !src) {
  console.error('usage: VAULT_RAG_URL=.. VAULT_RAG_API_TOKEN=.. node vt-migrate.js <local-vault-dir>');
  process.exit(1);
}
const tasksDir = path.join(src, '04-tasks');
if (!fs.existsSync(tasksDir)) { console.error(`no 04-tasks at ${tasksDir}`); process.exit(1); }

(async () => {
  const files = fs.readdirSync(tasksDir).filter(f => /^vt-\d+.*\.md$/.test(f));
  console.error(`migrating ${files.length} tasks from ${tasksDir}`);
  for (const f of files) {
    const content = fs.readFileSync(path.join(tasksDir, f), 'utf8');
    const res = await fetch(`${url}/api/task/import`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: `04-tasks/${f}`, content }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`FAIL ${f}: ${res.status} ${text}`);
      process.exit(2);
    }
    console.error(`ok ${f}`);
  }
  console.error('done');
})();
