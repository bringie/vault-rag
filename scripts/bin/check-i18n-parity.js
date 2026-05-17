#!/usr/bin/env node
// vt-0282: i18n parity linter. Walks agent-fleet/web/i18n/*.json, treats
// en.json as the canonical source, reports any key present in en but
// missing in ru or es (or extra keys in ru/es not in en).
//
// Exits non-zero if any drift is found — wire into CI to catch regressions.
//
// Usage:
//   node scripts/bin/check-i18n-parity.js [--quiet]
//
// Quiet mode: only print the summary, suppress per-key diff (used by hooks).

'use strict';
const fs = require('node:fs');
const path = require('node:path');

const I18N_DIR = path.resolve(__dirname, '..', '..', 'agent-fleet', 'web', 'i18n');
const CANONICAL = 'en.json';
const QUIET = process.argv.includes('--quiet');

function load(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) {
    console.error(`[i18n-lint] cannot load ${p}: ${e.message}`);
    process.exit(2);
  }
}

const canonicalPath = path.join(I18N_DIR, CANONICAL);
const canonical = load(canonicalPath);
const canonicalKeys = new Set(Object.keys(canonical));

const others = fs.readdirSync(I18N_DIR)
  .filter(f => f.endsWith('.json') && f !== CANONICAL);

let bad = 0;
for (const f of others) {
  const obj = load(path.join(I18N_DIR, f));
  const keys = new Set(Object.keys(obj));
  const missing = [...canonicalKeys].filter(k => !keys.has(k));
  const extra   = [...keys].filter(k => !canonicalKeys.has(k));
  if (missing.length || extra.length) {
    bad += 1;
    console.error(`[i18n-lint] ${f}: ${missing.length} missing, ${extra.length} extra (vs ${CANONICAL})`);
    if (!QUIET) {
      for (const k of missing) console.error(`  MISSING  ${k}`);
      for (const k of extra)   console.error(`  EXTRA    ${k}`);
    }
  } else {
    console.log(`[i18n-lint] ${f}: ok (${keys.size} keys)`);
  }
}

if (bad) {
  console.error(`[i18n-lint] FAIL: ${bad} locale(s) out of sync with ${CANONICAL}`);
  process.exit(1);
}
console.log('[i18n-lint] ok — all locales in sync');
