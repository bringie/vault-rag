'use strict';
// vt-0140: shared constant-time bearer compare. Was duplicated in
// rag-api.js, fleet-routes.js, mcp-shim.js, secrets-server.js, and
// tokmon-ingest.js — collapsed to a single source of truth here.
function tokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

module.exports = { tokenEqual };
