'use strict';
// vt-0287 slice 5: host CRUD + inventory/metrics/file ops. Pure DB
// CRUD with optional ctx.bus.fileOp() for live file proxying (which
// is already injected on ctx, no new deps needed).
//
// Routes:
//   GET    /fleet/hosts                — list
//   GET    /fleet/hosts/:id            — get one (+ groups + effective caps)
//   PATCH  /fleet/hosts/:id            — display_name + capabilities
//   DELETE /fleet/hosts/:id?confirm=1  — cascade delete (vt-0183 guard)
//   GET    /fleet/hosts/:id/metrics    — rollup or raw (since=15m|1h|6h|24h|7d)
//   GET    /fleet/hosts/:id/inventory  — metadata.inventory snapshot
//   GET    /fleet/hosts/:id/file       — read remote file via WS roundtrip
//   PUT    /fleet/hosts/:id/file       — write remote file (cap 128 KiB)

const { SID_RE, send, readBody } = require('./_shared');

const FILE_MAX_BYTES = 128 * 1024;
const METRIC_INTERVALS = {
  '15m': '15 minutes',
  '1h':  '1 hour',
  '6h':  '6 hours',
  '24h': '24 hours',
  '7d':  '7 days',
};

function register({ fleetDb }) {
  return [
    {
      method: 'GET',
      pattern: /^\/fleet\/hosts$/,
      handler(req, res, ctx) {
        return fleetDb.listHosts(ctx.db)
          .then(rs => send(res, 200, rs))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/hosts/(${SID_RE})$`, 'i'),
      async handler(req, res, ctx, m) {
        try {
          const h = await fleetDb.getHost(ctx.db, m[1]);
          if (!h) return send(res, 404, { error: 'host not found' });
          h.groups = await fleetDb.listGroupsForHost(ctx.db, m[1]);
          const eff = await fleetDb.getEffectiveCapabilities(ctx.db, m[1]);
          if (eff) {
            h.effective_capabilities = eff.effective;
            h.inherited_labels = eff.inherited;
          }
          send(res, 200, h);
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
    {
      method: 'PATCH',
      pattern: new RegExp(`^/fleet/hosts/(${SID_RE})$`, 'i'),
      handler(req, res, ctx, m) {
        return readBody(req).then(async (body) => {
          if (!body) return send(res, 422, { error: 'body required' });
          const patch = {};
          if ('display_name' in body) patch.display_name = body.display_name;
          if ('capabilities' in body) {
            if (!Array.isArray(body.capabilities)) {
              return send(res, 422, { error: 'capabilities must be array of strings' });
            }
            patch.capabilities = body.capabilities.map(String).filter(Boolean);
          }
          try {
            const updated = await fleetDb.updateHost(ctx.db, m[1], patch);
            if (!updated) return send(res, 404, { error: 'host not found' });
            send(res, 200, updated);
          } catch (e) { send(res, 500, { error: e.message }); }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'DELETE',
      pattern: new RegExp(`^/fleet/hosts/(${SID_RE})$`, 'i'),
      async handler(req, res, ctx, m) {
        // vt-0183: require ?confirm=1 because DELETE cascades to
        // sessions + events + metrics + group memberships. A typo'd
        // UUID would wipe an entire host's history.
        const u = new URL(req.url, 'http://x');
        if (u.searchParams.get('confirm') !== '1') {
          return send(res, 400, { error: 'add ?confirm=1 to delete (cascades to sessions+events+metrics)' });
        }
        try {
          await fleetDb.deleteHost(ctx.db, m[1]);
          res.writeHead(204); res.end();
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/hosts/(${SID_RE})/metrics$`, 'i'),
      async handler(req, res, ctx, m) {
        const u = new URL(req.url, 'http://x');
        const since = u.searchParams.get('since') || '1h';
        const interval = METRIC_INTERVALS[since];
        if (!interval) {
          return send(res, 422, { error: `invalid since (allowed: ${Object.keys(METRIC_INTERVALS).join(',')})` });
        }
        const downsampled = u.searchParams.get('downsampled') === '1';
        try {
          const rows = downsampled
            ? await fleetDb.readMetricsRollupSince(ctx.db, m[1], interval)
            : await fleetDb.readMetricsSince(ctx.db, m[1], interval);
          send(res, 200, rows);
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/hosts/(${SID_RE})/inventory$`, 'i'),
      async handler(req, res, ctx, m) {
        try {
          const h = await fleetDb.getHost(ctx.db, m[1]);
          if (!h) return send(res, 404, { error: 'host not found' });
          send(res, 200, (h.metadata && h.metadata.inventory) || {});
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/hosts/(${SID_RE})/file$`, 'i'),
      async handler(req, res, ctx, m) {
        const u = new URL(req.url, 'http://x');
        const pathName = u.searchParams.get('path');
        if (!pathName) return send(res, 422, { error: 'path query required' });
        try {
          const host = await fleetDb.getHost(ctx.db, m[1]);
          if (!host) return send(res, 404, { error: 'host not found' });
          if (host.status !== 'online') return send(res, 410, { error: 'host offline' });
          const r = await ctx.bus.fileOp(host.id, 'read_file', pathName);
          send(res, 200, { path: r.path, exists: r.exists, content: r.content });
        } catch (e) { send(res, 502, { error: e.message }); }
      },
    },
    {
      method: 'PUT',
      pattern: new RegExp(`^/fleet/hosts/(${SID_RE})/file$`, 'i'),
      handler(req, res, ctx, m) {
        // vt-0126: 256 KiB cap at the wire — handler also enforces
        // FILE_MAX_BYTES (128 KiB) on content explicitly so partial
        // reads produce a clean 413.
        return readBody(req, { maxBytes: 256 * 1024 }).then(async (body) => {
          if (!body || !body.path || typeof body.content !== 'string') {
            return send(res, 422, { error: 'path and content required' });
          }
          if (Buffer.byteLength(body.content, 'utf8') > FILE_MAX_BYTES) {
            return send(res, 413, { error: `file content exceeds ${FILE_MAX_BYTES} bytes` });
          }
          try {
            const host = await fleetDb.getHost(ctx.db, m[1]);
            if (!host) return send(res, 404, { error: 'host not found' });
            if (host.status !== 'online') return send(res, 410, { error: 'host offline' });
            const r = await ctx.bus.fileOp(host.id, 'write_file', body.path, body.content);
            send(res, 200, { path: r.path, bytes: r.bytes });
          } catch (e) { send(res, 502, { error: e.message }); }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
  ];
}

module.exports = { register };
