'use strict';
// vt-0287 slice 6: cost + timeline endpoints. Pure read paths backed
// by fleet-cost helpers + ctx.tokmonDb (separate pg pool for token
// usage data). 503 when tokmonDb isn't configured.
//
// Routes:
//   GET  /fleet/cost/summary           — per-host $ + msgs (days∈{1,7,14,30,90})
//   GET  /fleet/cost/timeline          — group_by={model|host|label|group}
//   GET  /fleet/cost/rollup-timeline   — long-term from fleet_cost_daily_rollup
//   GET  /fleet/sessions/:id/cost      — one session
//   POST /fleet/sessions/cost-batch    — batch lookup (≤200 ids)
//   GET  /fleet/sessions/:id/timeline  — lifecycle event timeline
//   GET  /fleet/sessions/by-bucket     — cost-chart drill-down

const { SID_RE, send, readBody } = require('./_shared');
const SID_RE_BARE = /^[0-9a-f-]{36}$/i;
const COST_VALID_DAYS = new Set([1, 7, 14, 30, 90]);

function register({ fleetDb, fleetCost }) {
  return [
    {
      method: 'GET',
      pattern: /^\/fleet\/cost\/summary$/,
      async handler(req, res, ctx) {
        if (!ctx.tokmonDb) return send(res, 503, { error: 'cost data unavailable (tokmon db not configured)' });
        const u = new URL(req.url, 'http://x');
        const days = parseInt(u.searchParams.get('days') || '7', 10);
        if (!COST_VALID_DAYS.has(days)) return send(res, 422, { error: 'invalid days', allowed: [...COST_VALID_DAYS] });
        try {
          const hosts = await fleetDb.listHosts(ctx.db);
          const r = await fleetCost.hostSummary(ctx.tokmonDb, ctx.db, hosts.map(h => h.name), days);
          const result = hosts.map(h => ({
            host_id: h.id, host: h.name, status: h.status,
            usd: r[h.name]?.usd || 0,
            msgs: r[h.name]?.msgs || 0,
            by_model: r[h.name]?.by_model || {},
          }));
          send(res, 200, { days, hosts: result });
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
    {
      method: 'GET',
      pattern: /^\/fleet\/cost\/timeline$/,
      async handler(req, res, ctx) {
        if (!ctx.tokmonDb) return send(res, 503, { error: 'cost data unavailable' });
        const u = new URL(req.url, 'http://x');
        const days = parseInt(u.searchParams.get('days') || '7', 10);
        if (!COST_VALID_DAYS.has(days)) return send(res, 422, { error: 'invalid days', allowed: [...COST_VALID_DAYS] });
        const groupBy = u.searchParams.get('group_by') || 'model';
        try {
          const hosts = await fleetDb.listHosts(ctx.db);
          const rows = await fleetCost.timeline(ctx.tokmonDb, ctx.db, hosts.map(h => h.name), days, groupBy);
          send(res, 200, { days, group_by: groupBy, points: rows });
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
    {
      // vt-0114: long-term timeline from fleet_cost_daily_rollup —
      // visible past tokmon's 90d retention window.
      method: 'GET',
      pattern: /^\/fleet\/cost\/rollup-timeline$/,
      async handler(req, res, ctx) {
        const u = new URL(req.url, 'http://x');
        const days = Math.min(Math.max(parseInt(u.searchParams.get('days') || '90', 10), 1), 730);
        const dim = u.searchParams.get('dim') || 'model';
        if (!['model', 'host'].includes(dim)) return send(res, 422, { error: 'dim must be model|host' });
        try {
          const rows = await fleetCost.timelineFromRollup(ctx.db, days, dim);
          send(res, 200, { days, dim, points: rows });
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/sessions/(${SID_RE})/cost$`, 'i'),
      async handler(req, res, ctx, m) {
        if (!ctx.tokmonDb) return send(res, 503, { error: 'cost data unavailable (tokmon db not configured)' });
        try {
          const s = await fleetDb.getSession(ctx.db, m[1]);
          if (!s) return send(res, 404, { error: 'session not found' });
          const host = await fleetDb.getHost(ctx.db, s.host_id);
          if (!host) return send(res, 404, { error: 'host not found' });
          const cost = await fleetCost.sessionCost(ctx.tokmonDb, ctx.db, host.name, s.started_at, s.ended_at, s.id);
          send(res, 200, { session_id: s.id, host: host.name, ...cost });
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
    {
      method: 'POST',
      pattern: /^\/fleet\/sessions\/cost-batch$/,
      // vt-0363: viewer-readable despite POST (body carries up to 200 ids).
      admin: false,
      handler(req, res, ctx) {
        return readBody(req).then(async (body) => {
          if (!body || !Array.isArray(body.ids)) return send(res, 422, { error: 'ids[] required' });
          if (body.ids.length > 200) return send(res, 422, { error: 'max 200 ids per request' });
          if (!ctx.tokmonDb) return send(res, 503, { error: 'cost data unavailable' });
          // N9: dedupe + validate before pg ANY($1).
          const ids = [...new Set(body.ids.filter(x => typeof x === 'string' && SID_RE_BARE.test(x)))];
          try {
            const costs = await fleetCost.sessionCostBatch(ctx.tokmonDb, ctx.db, ids);
            send(res, 200, costs);
          } catch (e) { send(res, 500, { error: e.message }); }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/sessions/(${SID_RE})/timeline$`, 'i'),
      async handler(req, res, ctx, m) {
        try {
          const sid = m[1];
          const s = await fleetDb.getSession(ctx.db, sid);
          if (!s) return send(res, 404, { error: 'session not found' });
          // Build lifecycle timeline from session row + fleet_events lifecycle entries.
          const { rows: lc } = await ctx.db.query(
            `SELECT ts, payload FROM fleet_events
             WHERE session_id = $1 AND kind = 'lifecycle'
             ORDER BY ts`, [sid]);
          const events = [
            { ts: s.started_at, kind: 'created', detail: { cwd: s.cwd, args: s.args, created_by: s.created_by } },
          ];
          if (s.pid != null) events.push({ ts: s.started_at, kind: 'spawned', detail: { pid: s.pid } });
          for (const r of lc) {
            let detail = null;
            try { detail = JSON.parse((r.payload || Buffer.alloc(0)).toString('utf8')); } catch {}
            events.push({ ts: r.ts, kind: 'lifecycle', detail });
          }
          if (s.ended_at) events.push({ ts: s.ended_at, kind: 'ended', detail: { exit_code: s.exit_code, status: s.status } });
          send(res, 200, { session_id: sid, events });
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
    {
      // vt-0113 cost-chart drill-down — sessions whose started_at falls
      // on a given day, optionally narrowed by host/label/group/model.
      method: 'GET',
      pattern: /^\/fleet\/sessions\/by-bucket$/,
      async handler(req, res, ctx) {
        const u = new URL(req.url, 'http://x');
        const day = u.searchParams.get('day');
        if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          return send(res, 422, { error: 'day=YYYY-MM-DD required' });
        }
        const dim = u.searchParams.get('dim') || '';
        const value = u.searchParams.get('value') || '';
        const limit = Math.min(parseInt(u.searchParams.get('limit') || '200', 10), 500);
        const args = [day, limit];
        let where = `date_trunc('day', s.started_at) = $1::date`;

        if (dim === 'host') {
          if (!/^[0-9a-f-]{36}$/i.test(value)) {
            return send(res, 422, { error: 'dim=host requires value=<host-uuid>' });
          }
          args.push(value);
          where += ` AND s.host_id = $${args.length}`;
        } else if (dim === 'label') {
          if (value === '(unlabeled)' || value === '(external/unlabeled)') {
            where += ` AND s.label IS NULL`;
          } else {
            args.push(value);
            where += ` AND s.label = $${args.length}`;
          }
        } else if (dim === 'group') {
          if (value === '(ungrouped)') {
            where += ` AND NOT EXISTS (SELECT 1 FROM fleet_host_groups hg WHERE hg.host_id = s.host_id)`;
          } else {
            args.push(value);
            where += ` AND EXISTS (
              SELECT 1 FROM fleet_host_groups hg JOIN fleet_groups g ON g.id = hg.group_id
              WHERE hg.host_id = s.host_id AND g.name = $${args.length}
            )`;
          }
        } else if (dim === 'model') {
          if (!ctx.tokmonDb) return send(res, 503, { error: 'dim=model requires tokmon db' });
          const { rows: matchingIds } = await ctx.tokmonDb.query(
            `SELECT DISTINCT session_id
             FROM events
             WHERE date_trunc('day', ts) = $1::date AND model = $2
               AND session_id ~ '^[0-9a-f-]{36}$'`,
            [day, value]);
          const ids = matchingIds.map(r => r.session_id);
          if (!ids.length) {
            return send(res, 200, { day, dim, value, dim_unfiltered: false, sessions: [] });
          }
          args.push(ids);
          where += ` AND s.id::text = ANY($${args.length})`;
        } else if (dim) {
          return send(res, 422, { error: `unsupported dim: ${dim} (expected host|label|group|model)` });
        }

        try {
          const { rows } = await ctx.db.query(
            `SELECT s.id, s.label, s.started_at, s.ended_at, s.status, s.exit_code,
                    s.host_id, h.name AS host_name, h.display_name AS host_display
             FROM fleet_sessions s
             LEFT JOIN fleet_hosts h ON h.id = s.host_id
             WHERE ${where}
             ORDER BY s.started_at DESC
             LIMIT $2`, args);
          send(res, 200, { day, dim, value, dim_unfiltered: false, sessions: rows });
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
  ];
}

module.exports = { register };
