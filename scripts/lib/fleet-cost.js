'use strict';
// fleet-cost: attribute token-monitor events to fleet sessions/hosts.
// Heuristic match: tokmon.events.host_id ≈ fleet_hosts.name + ts in [started_at, ended_at).
// Caller supplies tokmonPg (separate client to the `tokmon` database).

// Approximate $/Mtok by model family (input + output + cache_creation_5m as input-equivalent).
// Numbers conservative; refine per Anthropic pricing.
const PRICES = {
  // [input/Mtok, output/Mtok, cache_create_5m/Mtok, cache_read/Mtok]
  opus:    [15, 75, 18.75, 1.50],
  sonnet:  [3, 15, 3.75, 0.30],
  haiku:   [1, 5, 1.25, 0.10],
};
function priceFor(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return PRICES.opus;
  if (m.includes('sonnet')) return PRICES.sonnet;
  if (m.includes('haiku')) return PRICES.haiku;
  return PRICES.sonnet;
}
function rowCost(r) {
  const [pi, po, pcc, pcr] = priceFor(r.model);
  return (
    Number(r.input_tokens)      / 1e6 * pi +
    Number(r.output_tokens)     / 1e6 * po +
    Number(r.cache_creation_5m) / 1e6 * pcc +
    Number(r.cache_read)        / 1e6 * pcr
  );
}

async function aggregateRows(tokmonPg, where, args) {
  const { rows } = await tokmonPg.query(
    `SELECT model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_5m) AS cache_creation_5m, SUM(cache_read) AS cache_read,
            COUNT(*) AS msgs
     FROM events
     WHERE ${where}
     GROUP BY model`, args);
  let usd = 0, msgs = 0;
  const byModel = {};
  for (const r of rows) {
    const c = rowCost(r);
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

// Cost for one fleet session.
// 1. Exact match: tokmon.events.session_id == fleet_session.id (since daemon now
//    spawns claude with --session-id <fleet sid>). Trust this when rows exist.
// 2. Fallback heuristic for legacy sessions (no session-id injection): rows where
//    host_id == host.name AND ts ∈ [started_at, ended_at|now]. Marked approximate.
async function sessionCost(tokmonPg, hostName, startedAt, endedAt, fleetSessionId) {
  // Exact attribution
  if (fleetSessionId) {
    const exact = await aggregateRows(tokmonPg, 'session_id = $1', [fleetSessionId]);
    if (exact.msgs > 0) return { ...exact, attribution: 'exact' };
  }
  // Heuristic fallback: host + time window (over-attributes if other claude sessions
  // ran on the same host in this window).
  const end = endedAt || new Date();
  const heur = await aggregateRows(tokmonPg, 'host_id = $1 AND ts >= $2 AND ts < $3',
    [hostName, startedAt, end]);
  return { ...heur, attribution: 'approximate' };
}

// Summary: cost per host over last N days.
async function hostSummary(tokmonPg, hostNames, days = 7) {
  if (!hostNames.length) return {};
  const { rows } = await tokmonPg.query(
    `SELECT host_id, model,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_5m) AS cache_creation_5m, SUM(cache_read) AS cache_read,
            COUNT(*) AS msgs
     FROM events
     WHERE host_id = ANY($1) AND ts > now() - ($2 || ' days')::interval
     GROUP BY host_id, model`,
    [hostNames, String(days)],
  );
  const out = {};
  for (const r of rows) {
    if (!out[r.host_id]) out[r.host_id] = { usd: 0, msgs: 0, by_model: {} };
    const c = rowCost(r);
    out[r.host_id].usd += c;
    out[r.host_id].msgs += Number(r.msgs);
    out[r.host_id].by_model[r.model] = {
      usd: c,
      msgs: Number(r.msgs),
    };
  }
  return out;
}

// Daily aggregate over the last N days. `groupBy` selects the second
// dimension: 'model' (default), 'host' (=tokmon host_id), or 'label'
// (requires session_id join to fleet_sessions for label column).
async function timeline(tokmonPg, hostNames, days = 7, groupBy = 'model', vaultPg = null) {
  if (groupBy === 'label' && vaultPg) return timelineByLabel(tokmonPg, vaultPg, days);
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
  return rows.map(r => ({
    day: r.day,
    dim: r.dim,
    model: r.model,
    msgs: Number(r.msgs),
    usd: rowCost(r),
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    cache_creation_5m: Number(r.cache_creation_5m),
    cache_read: Number(r.cache_read),
  }));
}

// label is a fleet_sessions column. tokmon stores session_id matching fleet
// session id (since we inject --session-id). Two pools, so we do it in two
// steps: pull events grouped by session_id from tokmon, then resolve labels
// from vault_rag.
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
  // Now coalesce by (day, label, model)
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
  return Array.from(grouped.values()).map(g => ({ ...g, usd: rowCost(g) }))
    .sort((a, b) => a.day - b.day);
}

module.exports = { sessionCost, hostSummary, timeline, rowCost, priceFor };
