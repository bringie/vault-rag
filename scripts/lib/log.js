'use strict';
// vt-0210: tiny structured-logger. Outputs one JSON line per event when
// VAULT_RAG_LOG_FORMAT=json (Loki/Splunk-friendly); otherwise a compact
// `level | service | event | k=v k=v` line for human reading via
// `docker logs`. No dependencies — just JSON.stringify.
//
// API:
//   const log = require('./log').for('rag-api');
//   log.info('http_request', { method, path, status, ms, req_id });
//   log.error('pg_error', { msg: e.message });
//
// Backwards-compat: existing console.log('[rag-api] freeform') calls keep
// working. Adopt log.* progressively.

const crypto = require('crypto');

const FORMAT = (process.env.VAULT_RAG_LOG_FORMAT || 'text').toLowerCase();
const LEVEL_NUM = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const MIN = LEVEL_NUM[(process.env.VAULT_RAG_LOG_LEVEL || 'info').toLowerCase()] || 30;

function emit(service, level, event, fields) {
  if ((LEVEL_NUM[level] || 0) < MIN) return;
  const ts = new Date().toISOString();
  if (FORMAT === 'json') {
    const obj = { ts, level, service, event, ...fields };
    // stdout for info/debug, stderr for warn/error/fatal.
    const stream = LEVEL_NUM[level] >= 40 ? process.stderr : process.stdout;
    try { stream.write(JSON.stringify(obj) + '\n'); }
    catch (e) { /* swallow — never crash on log */ }
  } else {
    const kv = fields ? Object.entries(fields).map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${s}`;
    }).join(' ') : '';
    const line = `${ts} ${level.padEnd(5)} [${service}] ${event}${kv ? ' ' + kv : ''}`;
    if (LEVEL_NUM[level] >= 40) process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }
}

function loggerFor(service) {
  return {
    trace: (event, fields) => emit(service, 'trace', event, fields),
    debug: (event, fields) => emit(service, 'debug', event, fields),
    info:  (event, fields) => emit(service, 'info',  event, fields),
    warn:  (event, fields) => emit(service, 'warn',  event, fields),
    error: (event, fields) => emit(service, 'error', event, fields),
    fatal: (event, fields) => emit(service, 'fatal', event, fields),
  };
}

// Request-id helper — short hex (8 bytes) for correlation. Caller can
// pre-fill from X-Request-Id header if present.
function requestId(headers) {
  const incoming = headers && (headers['x-request-id'] || headers['X-Request-Id']);
  if (incoming && /^[\w.-]{1,128}$/.test(incoming)) return incoming;
  return crypto.randomBytes(8).toString('hex');
}

module.exports = { for: loggerFor, requestId };
