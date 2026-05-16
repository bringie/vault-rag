'use strict';
// vt-0134: HTTP client for the standalone secrets-server. rag-api uses this
// instead of holding age.key + git push creds in its own process.
//
// Backwards compat: if VAULT_RAG_SECRETS_URL is unset (dev, tests, legacy
// deployments), callers fall back to the in-process SecretsHandler. The
// constructor here is harmless to instantiate; the .enabled flag tells the
// caller whether to use it.

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

class SecretsClient {
  constructor({ url, token, timeoutMs = 10_000 } = {}) {
    this.url = url || process.env.VAULT_RAG_SECRETS_URL || null;
    this.token = token || process.env.VAULT_RAG_SECRETS_TOKEN || null;
    this.timeoutMs = timeoutMs;
    this.enabled = !!(this.url && this.token);
  }

  async _call(path, body) {
    const u = new URL(path, this.url);
    const data = Buffer.from(JSON.stringify(body || {}));
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      headers: {
        'authorization': `Bearer ${this.token}`,
        'content-type': 'application/json',
        'content-length': data.length,
      },
      timeout: this.timeoutMs,
    };
    return new Promise((resolve, reject) => {
      const req = lib.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = { error: raw.slice(0, 200) }; } }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
          const err = new Error(parsed?.error || `secrets-server ${res.statusCode}`);
          err.statusCode = res.statusCode;
          err.code = res.statusCode === 404 ? 404 : err.code;
          reject(err);
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('secrets-server timeout')); });
      req.write(data);
      req.end();
    });
  }

  async get(name)    { return (await this._call('/secrets/get',    { name })).value; }
  async list()       { return (await this._call('/secrets/list',   {})).names; }
  async set(name, value)  { return (await this._call('/secrets/set',    { name, value })).committed_sha; }
  async delete(name)      { return (await this._call('/secrets/delete', { name })).committed_sha; }
  async rotate(name, value=null) { return (await this._call('/secrets/rotate', { name, value })).committed_sha; }
  async verify()     { return await this._call('/secrets/verify', {}); }
}

module.exports = { SecretsClient };
