'use strict';
// vt-0287 slice 2: model-pricing endpoints. Pure DB CRUD with no
// closure state — perfect template for the next slice. Cache
// invalidation goes through fleetPrices.invalidate() passed in
// via deps.

const { send, readBody } = require('./_shared');

function register({ fleetDb, fleetPrices }) {
  return [
    {
      method: 'GET',
      pattern: /^\/fleet\/prices$/,
      async handler(req, res, ctx) {
        const u = new URL(req.url, 'http://x');
        const withHistory = u.searchParams.get('history') === '1';
        const where = withHistory ? '' : 'WHERE deleted_at IS NULL';
        try {
          const { rows } = await ctx.db.query(`
            SELECT id, match_pattern, priority, valid_from,
                   input_per_mtok, output_per_mtok,
                   cache_create_per_mtok, cache_read_per_mtok,
                   flagged, note, deleted_at, created_at
            FROM fleet_model_prices ${where}
            ORDER BY priority DESC, valid_from DESC`);
          send(res, 200, rows);
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
    {
      method: 'POST',
      pattern: /^\/fleet\/prices$/,
      handler(req, res, ctx) {
        return readBody(req).then(async (b) => {
          if (!b || !b.match_pattern || typeof b.input_per_mtok !== 'number' || typeof b.output_per_mtok !== 'number') {
            return send(res, 422, { error: 'match_pattern + numeric input_per_mtok + output_per_mtok required' });
          }
          const { rows } = await ctx.db.query(
            `INSERT INTO fleet_model_prices
               (match_pattern, priority, valid_from,
                input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok,
                flagged, note)
             VALUES ($1, $2, COALESCE($3, now()), $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
              b.match_pattern,
              Number.isFinite(b.priority) ? b.priority : 100,
              b.valid_from || null,
              b.input_per_mtok,
              b.output_per_mtok,
              Number.isFinite(b.cache_create_per_mtok) ? b.cache_create_per_mtok : 0,
              Number.isFinite(b.cache_read_per_mtok) ? b.cache_read_per_mtok : 0,
              Boolean(b.flagged),
              b.note || null,
            ]);
          fleetPrices.invalidate();
          send(res, 201, rows[0]);
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'POST',
      pattern: /^\/fleet\/prices\/resolve$/,
      handler(req, res, ctx) {
        return readBody(req).then(async (b) => {
          if (!b || !b.model) return send(res, 422, { error: 'model required' });
          const ts = b.at ? new Date(b.at) : new Date();
          const matched = await fleetPrices.priceFor(ctx.db, b.model, ts);
          send(res, 200, { matched, at: ts.toISOString() });
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/fleet\/prices\/(\d+)$/,
      async handler(req, res, ctx, match) {
        const id = match[1];
        try {
          await ctx.db.query(`UPDATE fleet_model_prices SET deleted_at = now() WHERE id = $1`, [id]);
          fleetPrices.invalidate();
          res.writeHead(204); res.end();
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
  ];
}

module.exports = { register };
