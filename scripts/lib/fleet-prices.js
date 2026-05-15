'use strict';
// fleet-prices: cache-backed price resolver. Source of truth: fleet_model_prices table.
// Resolution: sort rows by (priority DESC, valid_from DESC), pick first where
// valid_from <= ts AND pattern LIKE model. Fallback: ZERO_PRICE flagged=true.

const TTL_MS = 60_000;
const ZERO_PRICE = Object.freeze({
  input: 0, output: 0, cache_create: 0, cache_read: 0, flagged: true, id: null,
});

let cache = { rows: [], loadedAt: 0 };
let inFlightLoad = null;  // concurrency guard: dedupe parallel cold-cache loads

function likeMatch(pattern, s) {
  // Postgres LIKE: % = any chars, _ = single char. Case-insensitive.
  const re = new RegExp(
    '^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex specials
      .replace(/%/g, '.*')
      .replace(/_/g, '.')
    + '$',
    'i',
  );
  return re.test(s);
}

async function load(db) {
  if (inFlightLoad) return inFlightLoad;
  inFlightLoad = (async () => {
    try {
      const { rows } = await db.query(`
        SELECT id, match_pattern, priority, valid_from,
               input_per_mtok, output_per_mtok,
               cache_create_per_mtok, cache_read_per_mtok, flagged
        FROM fleet_model_prices
        WHERE deleted_at IS NULL
        ORDER BY priority DESC, valid_from DESC`);
      cache = { rows, loadedAt: Date.now() };
    } finally {
      inFlightLoad = null;
    }
  })();
  return inFlightLoad;
}

async function ensure(db) {
  if (Date.now() - cache.loadedAt >= TTL_MS) {
    await load(db);
  }
}

function invalidate() {
  cache = { rows: [], loadedAt: 0 };
  inFlightLoad = null;
}

async function priceFor(db, model, ts) {
  await ensure(db);
  if (!cache.rows.length) return ZERO_PRICE;
  const m = (model || '').toLowerCase();
  const at = ts instanceof Date ? ts : new Date(ts || Date.now());
  for (const r of cache.rows) {
    if (new Date(r.valid_from) > at) continue;
    if (!likeMatch(r.match_pattern.toLowerCase(), m)) continue;
    return {
      input: Number(r.input_per_mtok),
      output: Number(r.output_per_mtok),
      cache_create: Number(r.cache_create_per_mtok),
      cache_read: Number(r.cache_read_per_mtok),
      flagged: Boolean(r.flagged),
      id: r.id,
    };
  }
  return ZERO_PRICE;
}

module.exports = { priceFor, invalidate, load, likeMatch, ZERO_PRICE };
