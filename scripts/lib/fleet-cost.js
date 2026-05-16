'use strict';
// fleet-cost: attribute token-monitor events to fleet sessions/hosts.
// Prices come from fleet_model_prices (via fleet-prices.js). vaultPg = vault_rag pool.

const prices = require('./fleet-prices');

async function rowCost(r, ts, vaultPg) {
  const p = await prices.priceFor(vaultPg, r.model, ts);
  return (
    Number(r.input_tokens)      / 1e6 * p.input +
    Number(r.output_tokens)     / 1e6 * p.output +
    Number(r.cache_creation_5m) / 1e6 * p.cache_create +
    Number(r.cache_read)        / 1e6 * p.cache_read
  );
}

// Aggregate events matching WHERE clause. vaultPg used to resolve prices.
// NOTE: MAX(ts) is bucket-level approximation — price at end-of-bucket applies to
// all events of the bucket. Acceptable for MVP; see plan §Task 3 for caveat.
async function aggregateRows(tokmonPg, vaultPg, where, args) {
  const { rows } = await tokmonPg.query(
    `SELECT model, MAX(ts) AS last_ts,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_5m) AS cache_creation_5m, SUM(cache_read) AS cache_read,
            COUNT(*) AS msgs
     FROM events
     WHERE ${where}
     GROUP BY model`, args);
  let usd = 0, msgs = 0;
  const byModel = {};
  for (const r of rows) {
    const c = await rowCost(r, r.last_ts, vaultPg);
    usd += c; msgs += Number(r.msgs);
    byModel[r.model] = {
      usd: c, msgs: Number(r.msgs),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cache_creation_5m: Number(r.cache_creation_5m),
      cache_read: Number(r.cache_read),
    };
  }
  return { usd, msgs, by_model: byModel };
}

async function sessionCost(tokmonPg, vaultPg, hostName, startedAt, endedAt, fleetSessionId) {
  if (fleetSessionId) {
    const exact = await aggregateRows(tokmonPg, vaultPg, 'session_id = $1', [fleetSessionId]);
    if (exact.msgs > 0) return { ...exact, attribution: 'exact' };
  }
  const end = endedAt || new Date();
  const heur = await aggregateRows(tokmonPg, vaultPg, 'host_id = $1 AND ts >= $2 AND ts < $3',
    [hostName, startedAt, end]);
  return { ...heur, attribution: 'approximate' };
}

async function hostSummary(tokmonPg, vaultPg, hostNames, days = 7) {
  if (!hostNames.length) return {};
  const { rows } = await tokmonPg.query(
    `SELECT host_id, model, MAX(ts) AS last_ts,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_5m) AS cache_creation_5m, SUM(cache_read) AS cache_read,
            COUNT(*) AS msgs
     FROM events
     WHERE host_id = ANY($1) AND ts > now() - ($2 || ' days')::interval
     GROUP BY host_id, model`,
    [hostNames, String(days)]);
  const out = {};
  for (const r of rows) {
    if (!out[r.host_id]) out[r.host_id] = { usd: 0, msgs: 0, by_model: {} };
    const c = await rowCost(r, r.last_ts, vaultPg);
    out[r.host_id].usd += c;
    out[r.host_id].msgs += Number(r.msgs);
    out[r.host_id].by_model[r.model] = { usd: c, msgs: Number(r.msgs) };
  }
  return out;
}

async function timeline(tokmonPg, vaultPg, hostNames, days = 7, groupBy = 'model') {
  // vaultPg is required positional arg post-refactor; && vaultPg guards removed (vt-0082).
  if (groupBy === 'label') return timelineByLabel(tokmonPg, vaultPg, days);
  if (groupBy === 'group') return timelineByGroup(tokmonPg, vaultPg, days);
  const dim = groupBy === 'host' ? 'host_id' : 'model';
  const where = ['ts > now() - ($1 || \' days\')::interval'];
  const args = [String(days)];
  if (hostNames && hostNames.length) {
    args.push(hostNames);
    where.push(`host_id = ANY($${args.length})`);
  }
  const { rows } = await tokmonPg.query(
    `SELECT date_trunc('day', ts) AS day, ${dim} AS dim, model,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_5m) AS cache_creation_5m, SUM(cache_read) AS cache_read,
            COUNT(*) AS msgs
     FROM events
     WHERE ${where.join(' AND ')}
     GROUP BY day, ${dim}, model
     ORDER BY day`, args);
  const out = [];
  for (const r of rows) {
    out.push({
      day: r.day, dim: r.dim, model: r.model, msgs: Number(r.msgs),
      usd: await rowCost(r, r.day, vaultPg),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cache_creation_5m: Number(r.cache_creation_5m),
      cache_read: Number(r.cache_read),
    });
  }
  return out;
}

async function timelineByLabel(tokmonPg, vaultPg, days = 7) {
  const { rows: ev } = await tokmonPg.query(
    `SELECT date_trunc('day', ts) AS day, session_id, model,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_5m) AS cache_creation_5m, SUM(cache_read) AS cache_read,
            COUNT(*) AS msgs
     FROM events
     WHERE ts > now() - ($1 || ' days')::interval
     GROUP BY day, session_id, model`, [String(days)]);
  if (!ev.length) return [];
  const sessionIds = Array.from(new Set(ev.map(r => r.session_id).filter(x => /^[0-9a-f-]{36}$/i.test(x))));
  const labelById = new Map();
  if (sessionIds.length) {
    const { rows: ss } = await vaultPg.query(
      `SELECT id::text AS id, COALESCE(label, '(unlabeled)') AS label FROM fleet_sessions WHERE id::text = ANY($1)`,
      [sessionIds]);
    for (const s of ss) labelById.set(s.id, s.label);
  }
  const grouped = new Map();
  for (const r of ev) {
    const label = labelById.get(r.session_id) || '(external/unlabeled)';
    const key = `${r.day.toISOString()}|${label}|${r.model}`;
    let g = grouped.get(key);
    if (!g) {
      g = { day: r.day, dim: label, model: r.model, msgs: 0, input_tokens: 0, output_tokens: 0, cache_creation_5m: 0, cache_read: 0 };
      grouped.set(key, g);
    }
    g.msgs += Number(r.msgs);
    g.input_tokens += Number(r.input_tokens);
    g.output_tokens += Number(r.output_tokens);
    g.cache_creation_5m += Number(r.cache_creation_5m);
    g.cache_read += Number(r.cache_read);
  }
  const out = [];
  for (const g of grouped.values()) {
    out.push({ ...g, usd: await rowCost(g, g.day, vaultPg) });
  }
  return out.sort((a, b) => a.day - b.day);
}

// Group sessions by host's group memberships. LEFT JOIN → hosts without
// any group land in '(ungrouped)' bucket (explicit, never silent drop).
// Host in N groups → session contributes to all N buckets (double-count).
async function timelineByGroup(tokmonPg, vaultPg, days = 7) {
  const { rows: ev } = await tokmonPg.query(
    `SELECT date_trunc('day', ts) AS day, session_id, model,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_5m) AS cache_creation_5m, SUM(cache_read) AS cache_read,
            COUNT(*) AS msgs
     FROM events
     WHERE ts > now() - ($1 || ' days')::interval
     GROUP BY day, session_id, model`, [String(days)]);
  if (!ev.length) return [];
  const sessionIds = Array.from(new Set(ev.map(r => r.session_id).filter(x => /^[0-9a-f-]{36}$/i.test(x))));
  const groupsBySession = new Map();
  if (sessionIds.length) {
    const { rows: ss } = await vaultPg.query(
      `SELECT s.id::text AS session_id, COALESCE(g.name, '(ungrouped)') AS group_name
       FROM fleet_sessions s
       LEFT JOIN fleet_host_groups hg ON hg.host_id = s.host_id
       LEFT JOIN fleet_groups g ON g.id = hg.group_id
       WHERE s.id::text = ANY($1)`, [sessionIds]);
    for (const r of ss) {
      if (!groupsBySession.has(r.session_id)) groupsBySession.set(r.session_id, []);
      groupsBySession.get(r.session_id).push(r.group_name);
    }
  }
  const grouped = new Map();
  for (const r of ev) {
    const groups = groupsBySession.get(r.session_id) || ['(ungrouped)'];
    for (const gName of groups) {
      const key = `${r.day.toISOString()}|${gName}|${r.model}`;
      let g = grouped.get(key);
      if (!g) {
        g = { day: r.day, dim: gName, model: r.model, msgs: 0, input_tokens: 0, output_tokens: 0, cache_creation_5m: 0, cache_read: 0 };
        grouped.set(key, g);
      }
      g.msgs += Number(r.msgs);
      g.input_tokens += Number(r.input_tokens);
      g.output_tokens += Number(r.output_tokens);
      g.cache_creation_5m += Number(r.cache_creation_5m);
      g.cache_read += Number(r.cache_read);
    }
  }
  const out = [];
  for (const g of grouped.values()) out.push({ ...g, usd: await rowCost(g, g.day, vaultPg) });
  return out.sort((a, b) => a.day - b.day);
}

// Batch-fetch costs for many fleet sessions in a single tokmon query.
// Returns { [sessionId]: {usd, msgs, attribution: 'exact'} } for IDs that
// have any events tagged with session_id. IDs without events are omitted —
// caller can fall back to time-window heuristic per missing ID if needed.
async function sessionCostBatch(tokmonPg, vaultPg, sessionIds) {
  if (!sessionIds.length) return {};
  const { rows } = await tokmonPg.query(
    `SELECT session_id, model, MAX(ts) AS last_ts,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_5m) AS cache_creation_5m, SUM(cache_read) AS cache_read,
            COUNT(*) AS msgs
     FROM events
     WHERE session_id = ANY($1)
     GROUP BY session_id, model`,
    [sessionIds]);
  const out = {};
  for (const r of rows) {
    if (!out[r.session_id]) out[r.session_id] = { usd: 0, msgs: 0, attribution: 'exact', by_model: {} };
    const c = await rowCost(r, r.last_ts, vaultPg);
    out[r.session_id].usd += c;
    out[r.session_id].msgs += Number(r.msgs);
    out[r.session_id].by_model[r.model] = { usd: c, msgs: Number(r.msgs) };
  }
  return out;
}

// vt-0114: aggregate one day of tokmon events into fleet_cost_daily_rollup.
// Idempotent — ON CONFLICT DO UPDATE replaces the row so re-running an
// aggregation pass (e.g. after a backfill) overwrites cleanly.
//
// vt-0127: events are bucketed by hour before pricing. The old MAX(ts)-priced
// rollup used the *end-of-day* price for the whole day, so a mid-day price
// change mispriced morning usage and persisted that error indefinitely (the
// rollup outlives tokmon retention). Hourly bucketing bounds worst-case error
// to one hour. Bucket size is a deliberate trade-off — 24× more rows per day
// for ~rare price changes is fine; per-event pricing would explode result sets.
async function aggregateDayRollup(tokmonPg, vaultPg, day /* 'YYYY-MM-DD' */) {
  const { rows } = await tokmonPg.query(
    `SELECT date_trunc('hour', ts) AS hour,
            model, host_id,
            COUNT(*)::int                    AS msgs,
            SUM(input_tokens)::bigint        AS input_tokens,
            SUM(output_tokens)::bigint       AS output_tokens,
            SUM(cache_creation_5m)::bigint   AS cache_creation_5m,
            SUM(cache_read)::bigint          AS cache_read
     FROM events
     WHERE ts >= $1::date AND ts < ($1::date + interval '1 day')
     GROUP BY hour, model, host_id`,
    [day]);
  if (!rows.length) return { day, rows: 0 };
  // Aggregate by dim ('model' | 'host') so the rollup answers both pivots.
  // Each hour resolves its own price; tally accumulates priced usd + token
  // counts into the (model)/(host) buckets for the whole day.
  const byModel = new Map(), byHost = new Map();
  for (const r of rows) {
    // Use the start of the hour bucket as the price-resolution timestamp.
    // If a price changes mid-hour, that hour is priced at the start-of-hour
    // rate — bounded 1h error, not 24h.
    const usd = await rowCost(r, r.hour, vaultPg);
    const tally = (m, key) => {
      if (!m.has(key)) m.set(key, { usd: 0, msgs: 0, input_tokens: 0n, output_tokens: 0n, cache_creation_5m: 0n, cache_read: 0n });
      const t = m.get(key);
      t.usd += usd;
      t.msgs += Number(r.msgs);
      t.input_tokens      += BigInt(r.input_tokens || 0);
      t.output_tokens     += BigInt(r.output_tokens || 0);
      t.cache_creation_5m += BigInt(r.cache_creation_5m || 0);
      t.cache_read        += BigInt(r.cache_read || 0);
    };
    tally(byModel, r.model);
    tally(byHost,  r.host_id);
  }
  const writes = [];
  for (const [m, t] of byModel) writes.push(['model', m, t]);
  for (const [h, t] of byHost)  writes.push(['host',  h, t]);
  for (const [dim, value, t] of writes) {
    await vaultPg.query(
      `INSERT INTO fleet_cost_daily_rollup
         (day, dim, value, usd, msgs, input_tokens, output_tokens, cache_creation_5m, cache_read, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (day, dim, value) DO UPDATE SET
         usd               = EXCLUDED.usd,
         msgs              = EXCLUDED.msgs,
         input_tokens      = EXCLUDED.input_tokens,
         output_tokens     = EXCLUDED.output_tokens,
         cache_creation_5m = EXCLUDED.cache_creation_5m,
         cache_read        = EXCLUDED.cache_read,
         updated_at        = now()`,
      [day, dim, value, t.usd, t.msgs,
       String(t.input_tokens), String(t.output_tokens),
       String(t.cache_creation_5m), String(t.cache_read)]);
  }
  return { day, rows: writes.length };
}

// vt-0114: rollup-backed timeline for date ranges that exceed tokmon retention.
// dim = 'model' | 'host'. Returns rows {day, dim, value, usd, msgs, ...}.
async function timelineFromRollup(vaultPg, days = 365, dim = 'model') {
  if (!['model', 'host'].includes(dim)) {
    throw new Error(`timelineFromRollup: dim must be model|host (got ${dim})`);
  }
  const { rows } = await vaultPg.query(
    `SELECT day, dim, value, usd, msgs, input_tokens, output_tokens, cache_creation_5m, cache_read
     FROM fleet_cost_daily_rollup
     WHERE dim = $1 AND day >= current_date - ($2::int || ' days')::interval
     ORDER BY day, value`,
    [dim, days]);
  return rows;
}

module.exports = {
  sessionCost, sessionCostBatch, hostSummary, timeline, rowCost,
  aggregateDayRollup, timelineFromRollup,
};
