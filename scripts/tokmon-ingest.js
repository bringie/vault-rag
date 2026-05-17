#!/usr/bin/env node
'use strict';

// tokmon-ingest: HTTP endpoint for token-monitor parser shippers.
// Bulk INSERT via UNNEST.

const http = require('http');
const { Client } = require('pg');

const TOKEN = process.env.TOKMON_INGEST_TOKEN;
const PORT  = Number(process.env.PORT || 5681);

if (!TOKEN) {
  console.error('[tokmon-ingest] FATAL: TOKMON_INGEST_TOKEN not set');
  process.exit(1);
}

const PG = {
  host:     process.env.TOKMON_PG_HOST || 'vault-rag-postgres',
  database: process.env.TOKMON_PG_DB   || 'tokmon',
  user:     process.env.TOKMON_PG_USER || 'tokmon_parser',
  password: process.env.TOKMON_PG_PASS,
  port:     5432,
};

let pg;

async function pgConnect() {
  pg = new Client(PG);
  pg.on('error', (e) => {
    console.error(`[tokmon-ingest] pg error: ${e.message}`);
    pg = null;
  });
  await pg.connect();
}

async function withPg(fn) {
  if (!pg) await pgConnect();
  try { return await fn(pg); }
  catch (e) {
    if (/connection|terminated/i.test(e.message)) {
      try { await pg.end(); } catch {}
      pg = null;
      await pgConnect();
      return fn(pg);
    }
    throw e;
  }
}

// C2 (audit pass 2): constant-time bearer compare.
function tokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authOK(req) {
  const h = req.headers['x-tokmon-token']
        || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return !!(h && TOKEN && tokenEqual(h, TOKEN));
}

// I9 (audit pass 2): reject backdated / future-dated event timestamps so a
// buggy shipper can't corrupt cost rollup queries with arbitrary ts values.
const TS_MAX_SKEW_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days either side
function isPlausibleTs(ts) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return false;
  return Math.abs(t - Date.now()) < TS_MAX_SKEW_MS;
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function ingestBulk(events) {
  if (!events.length) return { inserted: 0, dup: 0, tools: 0 };

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

  await withPg(async (c) => {
    await c.query('BEGIN');
    try {
      const insRes = await c.query(
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
        const r2 = await c.query(
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
        const tr = await c.query(
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

      await c.query('COMMIT');
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch {}
      throw e;
    }
  });

  return { inserted, dup, tools };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      await withPg((c) => c.query('SELECT 1'));
      return send(res, 200, { ok: true });
    }
    if (!authOK(req)) return send(res, 401, { error: 'unauthorized' });

    if (req.method === 'POST' && req.url === '/ingest') {
      const raw = await readBody(req);
      let payload;
      try { payload = JSON.parse(raw); }
      catch { return send(res, 400, { error: 'bad json' }); }
      const events = Array.isArray(payload?.events) ? payload.events : null;
      if (!events) return send(res, 400, { error: 'events array required' });
      if (events.length > 5000) return send(res, 413, { error: 'batch too large (max 5000)' });
      // I9 (audit pass 2): drop events whose ts is implausible (>30d skew
      // from now). Their tool_calls[].ts is sanitized inside ingestBulk.
      const filtered = events.filter(e => isPlausibleTs(e.ts));
      const dropped = events.length - filtered.length;

      const result = await ingestBulk(filtered);
      if (dropped) result.dropped_implausible_ts = dropped;
      return send(res, 200, { ok: true, ...result });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(`[tokmon-ingest] ${req.method} ${req.url} -> ${e.stack || e.message}`);
    return send(res, 500, { error: 'internal' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[tokmon-ingest] listening on :${PORT} pg=${PG.host}/${PG.database} (bulk)`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
