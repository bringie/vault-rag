'use strict';
// vt-0287: shared helpers used by sub-domain route modules. Extracted
// from the fleet-routes.js monolith. Each sub-module receives a `deps`
// bundle on register() — that's the only way they reach the parent
// helpers (no global state, no cross-module require cycles).

// vt-0354: lazy logger require — keeps _shared.js test-friendly when the
// log module isn't on the path. log.for() is cheap so a single instance
// shared across all sub-routes is fine.
const log = require('../log').for('fleet/sub');

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

// HTTP response helper. vt-0354: also auto-logs http_handler_error on 5xx —
// without this, every sub-module catch block that ends in `send(res, 500,
// {error: e.message})` was a silent failure (operator only saw the
// response). The original inline handlers relied on dispatchHttp's outer
// tryDispatch catch for logging; sub-module catches resolved the promise
// before it could fire, so observability was lost during the split.
function send(res, status, body) {
  if (status >= 500) {
    const url = res.req && res.req.url;
    const msg = body && body.error;
    log.error('http_handler_error', { url, status, msg });
  }
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

// vt-0354: single source for "filter online hosts by host_id/host_name/tag/
// capability/group" — was duplicated across dispatch / exec / broadcast /
// spawnClaudeForWorkflow with subtle differences (capability missing in
// broadcast, group object retained only in dispatch). Returns
// `{ candidates, resolvedGroup }`. Throws a typed Error (`.notFound='group'`)
// when a named group does not exist — HTTP callers map that to 404, the
// workflow runner lets it propagate to the run's exception sink.
async function resolveCandidates(fleetDb, ctx, target = {}) {
  const { host_id, host_name, tag, capability, group } = target;
  const all = await fleetDb.listHosts(ctx.db);
  let candidates = all.filter(h => h.status === 'online');
  if (host_id)   candidates = candidates.filter(h => h.id === host_id);
  if (host_name) candidates = candidates.filter(h => h.name === host_name || h.display_name === host_name);
  if (tag) {
    // Effective tag: direct h.capabilities ∪ group labels (vt-0079).
    const tagged = await fleetDb.listHostsByEffectiveTag(ctx.db, tag);
    const ids = new Set(tagged.map(h => h.id));
    candidates = candidates.filter(h => ids.has(h.id));
  }
  if (capability) {
    const tagged = await fleetDb.listHostsByEffectiveTag(ctx.db, capability);
    const ids = new Set(tagged.map(h => h.id));
    candidates = candidates.filter(h => ids.has(h.id));
  }
  let resolvedGroup = null;
  if (group) {
    resolvedGroup = await fleetDb.getGroupByName(ctx.db, group);
    if (!resolvedGroup) {
      const err = new Error(`group not found: ${group}`);
      err.notFound = 'group';
      throw err;
    }
    const members = await fleetDb.listHostsInGroup(ctx.db, resolvedGroup.id);
    const ids = new Set(members.map(h => h.id));
    candidates = candidates.filter(h => ids.has(h.id));
  }
  return { candidates, resolvedGroup };
}

module.exports = { SID_RE, send, readBody, STRUCTURED_SPAWN_FIELDS, stripAnsi, resolveCandidates };
