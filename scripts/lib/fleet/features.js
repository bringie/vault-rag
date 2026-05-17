'use strict';
// vt-0287: extracted from fleet-routes.js — feature-flag endpoints
// (vt-0311). GET is viewer-readable, PATCH is admin (gated by the
// outer isAdminPath check in the parent router).

const { send, readBody } = require('./_shared');

function register({ fleetDb, callerFp }) {
  return [
    {
      method: 'GET',
      pattern: /^\/fleet\/features$/,
      handler(req, res, ctx) {
        return fleetDb.listFeatures(ctx.db).then(rs => send(res, 200, rs))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/fleet\/features\/([\w-]{1,64})$/i,
      handler(req, res, ctx, match) {
        const name = match[1];
        return readBody(req).then(async (b) => {
          if (!b) return send(res, 422, { error: 'body required' });
          if (typeof b.enabled !== 'boolean') return send(res, 422, { error: 'enabled (boolean) required' });
          await fleetDb.setFeature(ctx.db, name, b.enabled, callerFp(req));
          send(res, 200, { name, enabled: b.enabled });
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
  ];
}

module.exports = { register };
