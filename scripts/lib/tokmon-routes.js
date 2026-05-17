'use strict';
// vt-0140: tokmon ingest logic, lifted out of the standalone server
// (scripts/tokmon-ingest.js). rag-api wires the HTTP route + auth; this
// lib only does the SQL on a passed-in pg client.

// I9 (audit pass 2): reject backdated / future-dated event timestamps so
// a buggy or malicious shipper can't corrupt cost rollup queries.
const TS_MAX_SKEW_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days either side
function isPlausibleTs(ts) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return false;
  return Math.abs(t - Date.now()) < TS_MAX_SKEW_MS;
}

async function ingestBulk(tokmonPg, events) {
  if (!events.length) return { inserted: 0, dup: 0, tools: 0 };

  // vt-0226: ingestBulk was written assuming a singular Client. After
  // vt-0186 migrated the hub to pg.Pool, BEGIN/COMMIT on the Pool would
  // dispatch each statement to a different connection — transaction
  // silently broken. Detect Pool (has .connect()) and acquire a
  // dedicated client for the tx; release in finally.
  const isPool = typeof tokmonPg.connect === 'function' && typeof tokmonPg.release !== 'function';
  const client = isPool ? await tokmonPg.connect() : tokmonPg;
  try {
    return await _ingestBulkOnClient(client, events);
  } finally {
    if (isPool) { try { client.release(); } catch {} }
  }
}

async function _ingestBulkOnClient(tokmonPg, events) {

  const host_id     = events.map(e => String(e.host_id || 'localhost'));
  const message_uuid= events.map(e => String(e.message_uuid));
  const ts          = events.map(e => e.ts);
  const session_id  = events.map(e => String(e.session_id));
  const project_path= events.map(e => e.project_path ?? null);
  const model       = events.map(e => String(e.model));
  const input_t     = events.map(e => e.input_tokens | 0);
  const output_t    = events.map(e => e.output_tokens | 0);
  const ccr_5m      = events.map(e => e.cache_creation_5m | 0);
  const ccr_1h      = events.map(e => e.cache_creation_1h | 0);
  const cread       = events.map(e => e.cache_read | 0);
  const tier        = events.map(e => e.service_tier ?? null);
  const askill      = events.map(e => e.active_skill ?? null);
  const sfile       = events.map(e => String(e.source_file));
  const soff        = events.map(e => Number(e.source_offset));
  const rhash       = events.map(e => String(e.raw_hash));
  const raw         = events.map(e => JSON.stringify(e.raw ?? {}));

  let inserted = 0, dup = 0, tools = 0;

  await tokmonPg.query('BEGIN');
  try {
    const insRes = await tokmonPg.query(
      `INSERT INTO events (
         host_id, message_uuid, ts, session_id, project_path, model,
         input_tokens, output_tokens, cache_creation_5m, cache_creation_1h,
         cache_read, service_tier, active_skill, source_file, source_offset,
         raw_hash, raw
       )
       SELECT * FROM UNNEST(
         $1::text[],  $2::text[],  $3::timestamptz[], $4::text[], $5::text[], $6::text[],
         $7::int[],   $8::int[],   $9::int[],         $10::int[], $11::int[],
         $12::text[], $13::text[], $14::text[],       $15::bigint[],
         $16::text[], $17::jsonb[]
       )
       ON CONFLICT (message_uuid) DO NOTHING
       RETURNING id, message_uuid`,
      [host_id, message_uuid, ts, session_id, project_path, model,
       input_t, output_t, ccr_5m, ccr_1h, cread,
       tier, askill, sfile, soff, rhash, raw],
    );

    inserted = insRes.rowCount;
    dup = events.length - inserted;

    const newIdByUuid = new Map(insRes.rows.map(r => [r.message_uuid, r.id]));

    const dupUuids = events
      .map(e => e.message_uuid)
      .filter(u => !newIdByUuid.has(u));
    if (dupUuids.length) {
      const r2 = await tokmonPg.query(
        'SELECT id, message_uuid FROM events WHERE message_uuid = ANY($1::text[])',
        [dupUuids],
      );
      for (const row of r2.rows) newIdByUuid.set(row.message_uuid, row.id);
    }

    const tcEventIds = [];
    const tcUseIds   = [];
    const tcTs       = [];
    const tcSids     = [];
    const tcNames    = [];
    const tcSkills   = [];

    for (const ev of events) {
      const eventId = newIdByUuid.get(ev.message_uuid);
      if (!eventId) continue;
      for (const tc of ev.tool_calls || []) {
        if (!tc.tool_use_id) continue;
        tcEventIds.push(eventId);
        tcUseIds.push(String(tc.tool_use_id));
        tcTs.push(tc.ts);
        tcSids.push(String(tc.session_id ?? ev.session_id));
        tcNames.push(String(tc.tool_name || 'unknown'));
        tcSkills.push(tc.skill_arg ?? null);
      }
    }

    if (tcEventIds.length) {
      const tr = await tokmonPg.query(
        `INSERT INTO tool_calls (event_id, tool_use_id, ts, session_id, tool_name, skill_arg)
         SELECT * FROM UNNEST(
           $1::bigint[], $2::text[], $3::timestamptz[], $4::text[], $5::text[], $6::text[]
         )
         ON CONFLICT (tool_use_id) DO NOTHING
         RETURNING id`,
        [tcEventIds, tcUseIds, tcTs, tcSids, tcNames, tcSkills],
      );
      tools = tr.rowCount;
    }

    await tokmonPg.query('COMMIT');
  } catch (e) {
    try { await tokmonPg.query('ROLLBACK'); } catch {}
    throw e;
  }

  return { inserted, dup, tools };
}

module.exports = { ingestBulk, isPlausibleTs };
