'use strict';
// vt-0287 slice 8: session CRUD + broadcast + cleanup. All handlers are
// stateless — they reach `ctx.bus` and `ctx.db` through the request ctx,
// not via closures, so the slice is a clean lift.
//
// Routes:
//   GET    /fleet/sessions                 — list/filter + optional with_count
//   POST   /fleet/sessions                 — create (legacy + vt-0102 structured)
//   POST   /fleet/sessions/cleanup         — delete closed older than N
//   POST   /fleet/broadcast                — spawn fan-out across tag/group/all
//   GET    /fleet/sessions/:id
//   PATCH  /fleet/sessions/:id             — notes + label only
//   POST   /fleet/sessions/:id/input
//   POST   /fleet/sessions/:id/kill        — handles orphan/pending degrade

const { SID_RE, send, readBody } = require('./_shared');

// Spawn schema (vt-0102). Two shapes accepted:
//   Legacy:  { host_id, cwd, args:[...], env? }
//   Generic: { host_id, cwd, agent?, prompt?, model?, system_prompt?,
//              allowed_tools?, resume_session_id?, dangerous?, args?, env? }
const STRUCTURED_SPAWN_FIELDS = [
  'agent', 'prompt', 'model', 'system_prompt',
  'allowed_tools', 'resume_session_id', 'dangerous',
];

// Allowlist for older_than: avoids users bypassing intent (e.g. '0 seconds'
// would delete every closed session). Also blocks confusing Postgres errors
// from malformed interval strings leaking out of the 500 handler.
const CLEANUP_OLDER_THAN_ALLOWED = new Set([
  '1 hour', '6 hours', '12 hours', '1 day', '3 days', '7 days', '30 days',
]);

function register({ fleetDb }) {
  return [
    {
      method: 'GET',
      pattern: /^\/fleet\/sessions$/,
      async handler(req, res, ctx) {
        try {
          const u = new URL(req.url, 'http://x');
          const filter = {
            hostId: u.searchParams.get('host_id') || undefined,
            status: u.searchParams.get('status') || undefined,
            since:  u.searchParams.get('since')   || undefined,
            until:  u.searchParams.get('until')   || undefined,
            query:  u.searchParams.get('q')       || undefined,
            limit:  parseInt(u.searchParams.get('limit') || '100', 10),
            offset: parseInt(u.searchParams.get('offset') || '0', 10),
          };
          if (u.searchParams.get('with_count') === '1') {
            const [rows, total] = await Promise.all([
              fleetDb.listSessions(ctx.db, filter),
              fleetDb.countSessions(ctx.db, filter),
            ]);
            send(res, 200, { rows, total, limit: filter.limit, offset: filter.offset });
          } else {
            const rows = await fleetDb.listSessions(ctx.db, filter);
            send(res, 200, rows);
          }
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
    {
      method: 'POST',
      pattern: /^\/fleet\/sessions$/,
      handler(req, res, ctx) {
        return readBody(req).then(async (body) => {
          if (!body || !body.host_id) return send(res, 422, { error: 'host_id required' });
          if (!body.cwd) return send(res, 422, { error: 'cwd required' });
          try {
            const host = await fleetDb.getHost(ctx.db, body.host_id);
            if (!host) return send(res, 422, { error: 'host_id not found' });
            // Carry structured fields into metadata so the row remains the source
            // of truth for a future re-run (POST /sessions with rerun_of: <sid>).
            const metadata = { ...(body.metadata || {}) };
            for (const k of STRUCTURED_SPAWN_FIELDS) {
              if (body[k] != null) metadata[k] = body[k];
            }
            const s = await fleetDb.createSession(ctx.db, {
              hostId: body.host_id, cwd: body.cwd,
              args: body.args, env: body.env,
              createdBy: body.created_by, label: body.label, metadata,
            });
            if (ctx.bus) {
              // Forward both legacy args and structured fields. The daemon picks
              // the path via hasStructuredFields() (see ws-client.js).
              const payload = {
                session_id: s.id, cwd: s.cwd, args: s.args, env: s.env || {},
              };
              for (const k of STRUCTURED_SPAWN_FIELDS) {
                if (body[k] != null) payload[k] = body[k];
              }
              ctx.bus.requestSpawn(host.id, payload);
            }
            send(res, 201, { session_id: s.id });
          } catch (e) { send(res, 500, { error: e.message }); }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'POST',
      pattern: /^\/fleet\/sessions\/cleanup$/,
      handler(req, res, ctx) {
        return readBody(req).then(async (body) => {
          const u = new URL(req.url, 'http://x');
          const olderThan = (body && body.older_than) || u.searchParams.get('older_than') || '1 hour';
          if (!CLEANUP_OLDER_THAN_ALLOWED.has(olderThan)) {
            return send(res, 422, {
              error: 'invalid older_than',
              allowed: [...CLEANUP_OLDER_THAN_ALLOWED],
            });
          }
          try {
            const r = await fleetDb.deleteClosedSessions(ctx.db, olderThan);
            send(res, 200, { deleted: r.deleted, limited: r.limited, older_than: olderThan });
          } catch (e) { send(res, 500, { error: e.message }); }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'POST',
      pattern: /^\/fleet\/broadcast$/,
      handler(req, res, ctx) {
        return readBody(req).then(async (body) => {
          if (!body) return send(res, 422, { error: 'body required' });
          const { tag, group, cwd, args, env, label, metadata } = body;
          if (!tag && !group && !body.all) return send(res, 422, { error: 'tag|group|all required' });
          try {
            const all = await fleetDb.listHosts(ctx.db);
            let candidates = all.filter(h => h.status === 'online');
            if (tag) {
              // Effective tag: direct h.capabilities ∪ group labels (vt-0078).
              const tagged = await fleetDb.listHostsByEffectiveTag(ctx.db, tag);
              const ids = new Set(tagged.map(h => h.id));
              candidates = candidates.filter(h => ids.has(h.id));
            }
            if (group) {
              const g = await fleetDb.getGroupByName(ctx.db, group);
              if (!g) return send(res, 404, { error: `group not found: ${group}` });
              const members = await fleetDb.listHostsInGroup(ctx.db, g.id);
              const ids = new Set(members.map(h => h.id));
              candidates = candidates.filter(h => ids.has(h.id));
            }
            if (!candidates.length) return send(res, 404, { error: 'no matching online hosts' });
            const results = [];
            for (const host of candidates) {
              try {
                const s = await fleetDb.createSession(ctx.db, {
                  hostId: host.id, cwd: cwd || '~',
                  args: args || [], env: env || {},
                  createdBy: 'broadcast',
                  label: label || (tag ? `bcast:${tag}` : 'bcast:all'),
                  metadata: { ...(metadata || {}), broadcast: true, tag: tag || null },
                });
                if (ctx.bus) ctx.bus.requestSpawn(host.id, { session_id: s.id, cwd: s.cwd, args: s.args, env: s.env });
                results.push({ session_id: s.id, host_id: host.id, host_name: host.name, display_name: host.display_name, ok: true });
              } catch (e) {
                results.push({ host_id: host.id, host_name: host.name, ok: false, error: e.message });
              }
            }
            send(res, 201, { count: results.length, results });
          } catch (e) { send(res, 500, { error: e.message }); }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/sessions/(${SID_RE})$`, 'i'),
      async handler(req, res, ctx, m) {
        try {
          const s = await fleetDb.getSession(ctx.db, m[1]);
          if (!s) return send(res, 404, { error: 'session not found' });
          send(res, 200, s);
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
    {
      method: 'PATCH',
      pattern: new RegExp(`^/fleet/sessions/(${SID_RE})$`, 'i'),
      handler(req, res, ctx, m) {
        return readBody(req).then(async (body) => {
          if (!body) return send(res, 422, { error: 'body required' });
          const patch = {};
          if ('notes' in body) patch.notes = body.notes;
          if ('label' in body) patch.label = body.label;
          try {
            const s = await fleetDb.updateSession(ctx.db, m[1], patch);
            if (!s) return send(res, 404, { error: 'session not found' });
            send(res, 200, s);
          } catch (e) { send(res, 500, { error: e.message }); }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/fleet/sessions/(${SID_RE})/input$`, 'i'),
      handler(req, res, ctx, m) {
        return readBody(req).then(async (body) => {
          if (!body || typeof body.data !== 'string') return send(res, 422, { error: 'data required' });
          try {
            const s = await fleetDb.getSession(ctx.db, m[1]);
            if (!s) return send(res, 404, { error: 'session not found' });
            if (ctx.bus) ctx.bus.sendInput(s.id, s.host_id, body.data);
            res.writeHead(204); res.end();
          } catch (e) { send(res, 500, { error: e.message }); }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/fleet/sessions/(${SID_RE})/kill$`, 'i'),
      handler(req, res, ctx, m) {
        return readBody(req).then(async (body) => {
          const signal = (body && body.signal) || 'SIGTERM';
          try {
            const s = await fleetDb.getSession(ctx.db, m[1]);
            if (!s) return send(res, 404, { error: 'session not found' });
            // Orphaned/pending: pty is gone (daemon restart). Mark dead in DB and
            // broadcast session_exit so any attached viewer unblocks.
            if (s.status === 'orphaned' || s.status === 'pending') {
              await fleetDb.markSessionExited(ctx.db, s.id, -1, 'killed');
              if (ctx.bus) ctx.bus.broadcastViewers(s.id, { type: 'session_exit', exit_code: -1 });
              res.writeHead(204); res.end();
              return;
            }
            if (s.status === 'exited' || s.status === 'killed') {
              res.writeHead(204); res.end();
              return;
            }
            // Running session: forward kill to daemon. If host offline, mark killed.
            const sent = ctx.bus && ctx.bus.sendKill(s.id, s.host_id, signal);
            if (!sent) {
              await fleetDb.markSessionExited(ctx.db, s.id, -1, 'killed');
              if (ctx.bus) ctx.bus.broadcastViewers(s.id, { type: 'session_exit', exit_code: -1 });
            }
            res.writeHead(204); res.end();
          } catch (e) { send(res, 500, { error: e.message }); }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
  ];
}

module.exports = { register, STRUCTURED_SPAWN_FIELDS };
