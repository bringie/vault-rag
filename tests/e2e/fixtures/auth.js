'use strict';
// vt-0332: shared auth helpers. Tokens come from the local .env so the
// suite stays runnable from a fresh shell without baking secrets into
// the spec files.

const fs = require('node:fs');
const path = require('node:path');

function loadEnv() {
  const envPath = process.env.VAULT_RAG_ENV_FILE || path.join(__dirname, '..', '..', '..', '.env');
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  const txt = fs.readFileSync(envPath, 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

const env = loadEnv();
const VIEWER_TOKEN = process.env.VAULT_RAG_API_TOKEN || env.VAULT_RAG_API_TOKEN || '';
const ADMIN_TOKEN  = process.env.VAULT_RAG_FLEET_ADMIN_TOKEN || env.VAULT_RAG_FLEET_ADMIN_TOKEN || '';

if (!VIEWER_TOKEN) throw new Error('VAULT_RAG_API_TOKEN missing from env and .env');

// Pre-seed localStorage so the SPA boots straight to the app shell
// without the paste-token dialog. Apply via context init script.
async function loginAs(page, role = 'admin') {
  const token = role === 'admin' ? ADMIN_TOKEN : VIEWER_TOKEN;
  if (!token) throw new Error(`no token configured for role=${role}`);
  // addInitScript runs in the page context BEFORE any other script.
  await page.context().addInitScript((tok) => {
    try { window.localStorage.setItem('fleetToken', tok); } catch {}
  }, token);
}

module.exports = { VIEWER_TOKEN, ADMIN_TOKEN, loginAs };
