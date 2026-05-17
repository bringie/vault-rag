'use strict';
// vt-0287: shared helpers used by sub-domain route modules. Extracted
// from the fleet-routes.js monolith. Each sub-module receives a `deps`
// bundle on register() — that's the only way they reach the parent
// helpers (no global state, no cross-module require cycles).

// SID_RE: UUID-shape regex used for route patterns.
const SID_RE = '[0-9a-f-]{36}';

// Spawn schema (vt-0102). Two shapes accepted:
//   Legacy:  { host_id, cwd, args:[...], env? }
//   Generic: { host_id, cwd, agent?, prompt?, model?, system_prompt?,
//              allowed_tools?, resume_session_id?, dangerous?, args?, env? }
// Lives here (vt-0353) because both sessions.js and dispatch.js consume
// the list — keeping it in either module forces a sibling-to-sibling
// require which violates the "sub-modules talk only through deps" rule.
const STRUCTURED_SPAWN_FIELDS = [
  'agent', 'prompt', 'model', 'system_prompt',
  'allowed_tools', 'resume_session_id', 'dangerous',
];

// Strip CSI + 2-byte ESC sequences and OSC strings, plus the TUI
// cursor-control noise (\r, \b, BEL) that survives ANSI removal.
// Used by transcript .txt (human-readable view) and the /fleet/exec
// roundtrip handler. Co-located with the spawn schema for the same
// reason — eliminates sibling cross-imports.
function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC ...BEL or ...ST
    .replace(/\x1b\[[\d;?<>]*[A-Za-z]/g, '')              // CSI ...final
    .replace(/\x1b[()][\x20-\x7e]/g, '')                  // charset designate
    .replace(/\x1b[78=>cDEHMNOPVZ\\]/g, '')               // simple 2-byte ESC
    .replace(/\r\n/g, '\n')                               // CRLF → LF
    .replace(/\r/g, '')                                   // lone CR drop
    .replace(/[\x07\x08]/g, '');                          // BEL + BS drop
}

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

module.exports = { SID_RE, send, readBody, STRUCTURED_SPAWN_FIELDS, stripAnsi };
