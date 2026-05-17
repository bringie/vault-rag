'use strict';
// vt-0287: shared helpers used by sub-domain route modules. Extracted
// from the fleet-routes.js monolith. Each sub-module receives a `deps`
// bundle on register() — that's the only way they reach the parent
// helpers (no global state, no cross-module require cycles).

// SID_RE: UUID-shape regex used for route patterns.
const SID_RE = '[0-9a-f-]{36}';

// HTTP response helper — identical to fleet-routes.send.
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// readBody with size cap. Default 1 MiB.
function readBody(req, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let bytes = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      bytes += c.length;
      if (bytes > maxBytes) {
        aborted = true;
        const err = new Error(`body exceeds ${maxBytes} bytes`);
        err.statusCode = 413;
        return reject(err);
      }
      buf += c;
    });
    // Empty body → null (parent-helper parity at fleet-routes.js:48). Sub-module
    // handlers rely on `if (!body) return 422` guards — returning `{}` here
    // would make every such guard silently unreachable. Architect review of
    // vt-0287 caught the divergence; this restores the original contract.
    req.on('end', () => { if (aborted) return; if (!buf) return resolve(null); try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('bad json: ' + e.message)); } });
    req.on('error', (e) => { if (!aborted) reject(e); });
  });
}

module.exports = { SID_RE, send, readBody };
