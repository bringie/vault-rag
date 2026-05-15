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

// Sum cost for one session: rows where host_id == host.name AND ts ∈ [started_at, ended_at|now].
async function sessionCost(tokmonPg, hostName, startedAt, endedAt) {
  const end = endedAt || new Date();
  const { rows } = await tokmonPg.query(
    `SELECT model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_5m) AS cache_creation_5m, SUM(cache_read) AS cache_read,
            COUNT(*) AS msgs
     FROM events
     WHERE host_id = $1 AND ts >= $2 AND ts < $3
     GROUP BY model`,
    [hostName, startedAt, end],
  );
  let usd = 0;
  let msgs = 0;
  const byModel = {};
  for (const r of rows) {
    const c = rowCost(r);
    usd += c;
    msgs += Number(r.msgs);
    byModel[r.model] = {
      usd: c,
      msgs: Number(r.msgs),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cache_creation_5m: Number(r.cache_creation_5m),
      cache_read: Number(r.cache_read),
    };
  }
  return { usd, msgs, by_model: byModel };
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

module.exports = { sessionCost, hostSummary, rowCost, priceFor };
