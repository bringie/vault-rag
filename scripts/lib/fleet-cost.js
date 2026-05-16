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
  if (groupBy === 'label' && vaultPg) return timelineByLabel(tokmonPg, vaultPg, days);
  if (groupBy === 'group' && vaultPg) return timelineByGroup(tokmonPg, vaultPg, days);
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

module.exports = { sessionCost, hostSummary, timeline, rowCost };
