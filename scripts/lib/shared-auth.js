'use strict';
// vt-0140: shared constant-time bearer compare. Was duplicated in
// rag-api.js, fleet-routes.js, mcp-shim.js, secrets-server.js, and
// tokmon-ingest.js — collapsed to a single source of truth here.
// vt-0364: also hosts callerFingerprint (was duplicated in rag-api +
// fleet-routes as _workflowCallerFp) and realClientIp (X-Forwarded-For
// aware — was inline in alert-sink and missing in mux/ws-ticket audit).
const crypto = require('node:crypto');

function tokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// SHA-256 fingerprint (first 12 hex chars) of the bearer token. Used as
// `caller_id` in auth_audit so a DB dump never yields the raw bearer.
function callerFingerprint(req) {
  if (!req) return null;
  const auth = (req.headers && req.headers.authorization) || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}

// X-Forwarded-For-aware client IP. Vault-rag runs behind Caddy, so
// req.socket.remoteAddress is the docker bridge address (`172.x.x.x`).
// Use the rightmost trustworthy XFF entry — Caddy appends the real client
// IP to whatever upstream sent, so the last entry is always the proxy's
// own observation.
function realClientIp(req) {
  if (!req) return null;
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || null;
}

module.exports = { tokenEqual, callerFingerprint, realClientIp };
