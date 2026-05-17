'use strict';
// vt-0287: extracted from fleet-routes.js — recycle bin endpoints.
// (vt-0225 listing + restore + vt-0269 pagination.)
//
// Each domain module exports `register(deps)` which returns an array of
// route descriptors:
//   { method, pattern: RegExp | string, handler: (req, res, ctx) => any }
// The pattern matches against `req.url.split('?')[0]` so handlers can
// stop worrying about query-string anchors (vt-0288 class).

const { SID_RE, send } = require('./_shared');

function register({ fleetDb, fleetWorkflowDb }) {
  return [
    {
      method: 'GET',
      pattern: /^\/fleet\/recycle-bin$/,
      handler(req, res, ctx) {
        const u = new URL('http://x' + req.url);
        const limit  = parseInt(u.searchParams.get('limit')  || '100', 10);
        const offset = parseInt(u.searchParams.get('offset') || '0',  10);
        return Promise.all([
          fleetDb.listDeletedGroups(ctx.db, { limit, offset }),
          fleetWorkflowDb.listDeletedWorkflows(ctx.db, { limit, offset }),
        ]).then(([groups, workflows]) => send(res, 200, { groups, workflows }))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/fleet/groups/(${SID_RE})/restore$`, 'i'),
      handler(req, res, ctx, match) {
        const id = match[1];
        return fleetDb.restoreGroup(ctx.db, id).then(g =>
          g ? send(res, 200, g) : send(res, 404, { error: 'not found in trash' })
        ).catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/fleet/workflows/(${SID_RE})/restore$`, 'i'),
      handler(req, res, ctx, match) {
        const id = match[1];
        return fleetWorkflowDb.restoreWorkflow(ctx.db, id).then(w =>
          w ? send(res, 200, w) : send(res, 404, { error: 'not found in trash' })
        ).catch(e => send(res, 500, { error: e.message }));
      },
    },
  ];
}

module.exports = { register };
