'use strict';
// vt-0223: outbound webhook dispatcher.
//
// API (single function for emit-from-anywhere):
//   const webhooks = require('./webhooks');
//   await webhooks.emit(pg, 'workflow.failed', { run_id, workflow_name, error });
//
// Lookup subscriptions matching the event; format payload per backend
// (slack/discord/telegram/generic); POST via http(s) with retries; record
// every attempt in webhook_deliveries. Best-effort — never throws.

const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const log = require('./log').for('webhooks');

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 5000;

function formatPayload(format, event, data) {
  // Common compact text rendering used by chat-style integrations.
  const summary = (() => {
    if (event === 'workflow.failed') return `❌ Workflow *${data.workflow_name || '?'}* failed (run ${data.run_id || '?'}). ${data.error || ''}`;
    if (event === 'workflow.completed') return `✅ Workflow *${data.workflow_name || '?'}* completed (run ${data.run_id || '?'}).`;
    if (event === 'host.offline') return `⚠️ Host *${data.host_name || '?'}* went offline.`;
    if (event === 'host.online')  return `🟢 Host *${data.host_name || '?'}* came online.`;
    if (event === 'secret.new_caller') return `🔑 New caller (fp ${data.caller_id || '?'}) accessed secret *${data.name || '?'}*.`;
    return `[vault-rag] ${event}: ${JSON.stringify(data)}`;
  })();
  switch (format) {
    case 'slack':   return JSON.stringify({ text: summary });
    case 'discord': return JSON.stringify({ content: summary });
    case 'telegram':
      // Caller must include chat_id in URL (telegram bot API quirk); body
      // is JSON {text}.
      return JSON.stringify({ text: summary, parse_mode: 'Markdown' });
    case 'generic':
    default:
      return JSON.stringify({ event, ts: new Date().toISOString(), data, summary });
  }
}

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// vt-0229: SSRF guard. Reject RFC1918 / loopback / link-local / multicast
// hostnames. Admin-only attack surface, but the threat model includes
// "limit blast radius of admin compromise". Operators who legitimately
// need to webhook to an internal host can set
// VAULT_RAG_WEBHOOK_ALLOW_PRIVATE=1.
function _isPrivateHost(host) {
  if (process.env.VAULT_RAG_WEBHOOK_ALLOW_PRIVATE === '1') return false;
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  // IPv4 literal
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;  // multicast + reserved
  }
  // Hostnames matching docker-compose service names are private by convention.
  if (/^vault-rag-/.test(h)) return true;
  return false;
}

function post(url, body, secret) {
  return new Promise((resolve) => {
    let urlObj;
    try { urlObj = new URL(url); }
    catch (e) { return resolve({ status: null, error: 'bad url: ' + e.message }); }
    if (_isPrivateHost(urlObj.hostname)) {
      return resolve({ status: null, error: 'private host blocked (SSRF guard) — set VAULT_RAG_WEBHOOK_ALLOW_PRIVATE=1 to override' });
    }
    const opts = {
      method: 'POST',
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'user-agent': 'vault-rag-webhook/1',
      },
      timeout: TIMEOUT_MS,
    };
    // vt-0249: always emit x-vault-signature so the receiver can enforce
    // a policy of "reject unsigned"; explicit 'none' beats silently
    // omitting the header (receiver can't tell signed-but-unverified
    // from never-signed).
    opts.headers['x-vault-signature'] = secret ? sign(secret, body) : 'none';
    const lib = urlObj.protocol === 'https:' ? https : http;
    const req = lib.request(opts, (res) => {
      // Drain body to free socket
      res.on('data', () => {}); res.on('end', () => {});
      resolve({ status: res.statusCode, error: null });
    });
    req.on('error',   (e) => resolve({ status: null, error: e.message }));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(body); req.end();
  });
}

async function emit(pg, event, data) {
  if (!pg) return;
  let subs;
  try {
    subs = (await pg.query(
      `SELECT id, url, secret, format FROM webhook_subscriptions
        WHERE enabled = true AND $1 = ANY(events)`, [event]
    )).rows;
  } catch (e) {
    // Likely table missing — silent in dev/test where migrations not yet run.
    if (!/relation .* does not exist/.test(e.message)) {
      log.error('lookup_failed', { msg: e.message });
    }
    return;
  }
  for (const sub of subs) {
    const body = formatPayload(sub.format, event, data);
    let lastResult = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      lastResult = await post(sub.url, body, sub.secret);
      try {
        await pg.query(
          `INSERT INTO webhook_deliveries (subscription, event, attempt, status, error)
           VALUES ($1, $2, $3, $4, $5)`,
          [sub.id, event, attempt, lastResult.status, lastResult.error]
        );
      } catch {}
      if (lastResult.status && lastResult.status < 500) break;  // success or client error → don't retry
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
}

module.exports = { emit, isPrivateHost: _isPrivateHost };
