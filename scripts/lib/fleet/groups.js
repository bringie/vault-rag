'use strict';
// vt-0287 slice 4: group CRUD + host membership. Pure DB CRUD with no
// closure state — mirrors the prices slice as a clean template.
//
// Routes:
//   GET    /fleet/groups
//   POST   /fleet/groups
//   GET    /fleet/groups/:id              (with host roster)
//   PATCH  /fleet/groups/:id              (with vt-0170 brain_prompt cap)
//   DELETE /fleet/groups/:id
//   POST   /fleet/groups/:id/hosts        (add host)
//   DELETE /fleet/groups/:id/hosts/:hostId (remove host)
//
// vt-0287 slice 1 already lives at fleet/agent-roles.js for
// /fleet/groups/:id/roles — those stay there.

const { SID_RE, send, readBody } = require('./_shared');

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
function validColor(c) {
  return c == null || c === '' || HEX_COLOR_RE.test(c);
}
const BRAIN_PROMPT_MAX = 32768; // vt-0170

function register({ fleetDb }) {
  return [
    {
      method: 'GET',
      pattern: /^\/fleet\/groups$/,
      handler(req, res, ctx) {
        return fleetDb.listGroups(ctx.db)
          .then(rs => send(res, 200, rs))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      method: 'POST',
      pattern: /^\/fleet\/groups$/,
      handler(req, res, ctx) {
        return readBody(req).then(async (body) => {
          if (!body || !body.name) return send(res, 422, { error: 'name required' });
          if (!validColor(body.color)) return send(res, 422, { error: 'color must be #rrggbb hex or null' });
          if (typeof body.brain_prompt === 'string' && body.brain_prompt.length > BRAIN_PROMPT_MAX) {
            return send(res, 422, { error: `brain_prompt too long (max ${BRAIN_PROMPT_MAX} chars)` });
          }
          try {
            const g = await fleetDb.createGroup(ctx.db, {
              name: body.name,
              description: body.description,
              color: body.color || null,
              labels: Array.isArray(body.labels) ? body.labels : [],
              brain_prompt: typeof body.brain_prompt === 'string' ? body.brain_prompt : null,
            });
            send(res, 201, g);
          } catch (e) {
            if (e.code === '23505') return send(res, 409, { error: 'name already exists' });
            send(res, 500, { error: e.message });
          }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/groups/(${SID_RE})$`, 'i'),
      async handler(req, res, ctx, m) {
        try {
          const g = await fleetDb.getGroup(ctx.db, m[1]);
          if (!g) return send(res, 404, { error: 'not found' });
          g.hosts = await fleetDb.listHostsInGroup(ctx.db, m[1]);
          send(res, 200, g);
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
    {
      method: 'PATCH',
      pattern: new RegExp(`^/fleet/groups/(${SID_RE})$`, 'i'),
      handler(req, res, ctx, m) {
        return readBody(req).then(async (body) => {
          if (!body) return send(res, 422, { error: 'body required' });
          const patch = {};
          if ('name' in body)        patch.name = body.name;
          if ('description' in body) patch.description = body.description;
          if ('color' in body) {
            if (!validColor(body.color)) return send(res, 422, { error: 'color must be #rrggbb hex or null' });
            patch.color = body.color || null;
          }
          if ('labels' in body) {
            if (!Array.isArray(body.labels)) return send(res, 422, { error: 'labels must be array of strings' });
            patch.labels = body.labels;
          }
          if ('brain_prompt' in body) {
            if (body.brain_prompt !== null && typeof body.brain_prompt !== 'string') {
              return send(res, 422, { error: 'brain_prompt must be string or null' });
            }
            if (body.brain_prompt && body.brain_prompt.length > BRAIN_PROMPT_MAX) {
              return send(res, 422, { error: `brain_prompt too long (max ${BRAIN_PROMPT_MAX} chars)` });
            }
            patch.brain_prompt = body.brain_prompt;
          }
          const expectedVersion = Number.isFinite(body.expected_version) ? body.expected_version : undefined;
          try {
            const g = await fleetDb.updateGroup(ctx.db, m[1], patch, expectedVersion);
            if (!g) return send(res, 404, { error: 'not found' });
            if (g.__conflict) return send(res, 409, { error: 'version conflict', current: g.current });
            send(res, 200, g);
          } catch (e) {
            if (e.code === '23505') return send(res, 409, { error: 'name already exists' });
            send(res, 400, { error: e.message });
          }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'DELETE',
      pattern: new RegExp(`^/fleet/groups/(${SID_RE})$`, 'i'),
      async handler(req, res, ctx, m) {
        try {
          await fleetDb.deleteGroup(ctx.db, m[1]);
          res.writeHead(204); res.end();
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/fleet/groups/(${SID_RE})/hosts$`, 'i'),
      handler(req, res, ctx, m) {
        return readBody(req).then(async (body) => {
          if (!body || !body.host_id) return send(res, 422, { error: 'host_id required' });
          try {
            await fleetDb.addHostToGroup(ctx.db, body.host_id, m[1]);
            res.writeHead(204); res.end();
          } catch (e) { send(res, 500, { error: e.message }); }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'DELETE',
      pattern: new RegExp(`^/fleet/groups/(${SID_RE})/hosts/(${SID_RE})$`, 'i'),
      async handler(req, res, ctx, m) {
        try {
          await fleetDb.removeHostFromGroup(ctx.db, m[2], m[1]);
          res.writeHead(204); res.end();
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
  ];
}

module.exports = { register };
