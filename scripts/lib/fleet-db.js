'use strict';
// fleet-db: thin pg query layer for agent-fleet hosts/sessions/events.
// Callers pass an active pg.Client/pg.Pool — no connection management here.

async function upsertHost(c, h) {
  const sql = `
    INSERT INTO fleet_hosts (name, os, arch, capabilities, daemon_version, claude_version, status, last_seen)
    VALUES ($1, $2, $3, $4, $5, $6, 'online', now())
    ON CONFLICT (name) DO UPDATE SET
      os = COALESCE(EXCLUDED.os, fleet_hosts.os),
      arch = COALESCE(EXCLUDED.arch, fleet_hosts.arch),
      capabilities = COALESCE(EXCLUDED.capabilities, fleet_hosts.capabilities),
      daemon_version = COALESCE(EXCLUDED.daemon_version, fleet_hosts.daemon_version),
      claude_version = COALESCE(EXCLUDED.claude_version, fleet_hosts.claude_version),
      status = 'online',
      last_seen = now()
    RETURNING *`;
  const { rows } = await c.query(sql, [
    h.name, h.os || null, h.arch || null, h.capabilities || [],
    h.daemonVersion || null, h.claudeVersion || null,
  ]);
  return rows[0];
}

async function listHosts(c) {
  const { rows } = await c.query('SELECT * FROM fleet_hosts ORDER BY name');
  return rows;
}

async function getHost(c, id) {
  const { rows } = await c.query('SELECT * FROM fleet_hosts WHERE id = $1', [id]);
  return rows[0] || null;
}

async function setHostOffline(c, id) {
  await c.query("UPDATE fleet_hosts SET status='offline', last_seen=now() WHERE id=$1", [id]);
}

async function deleteHost(c, id) {
  await c.query('DELETE FROM fleet_hosts WHERE id=$1', [id]);
}

async function createSession(c, s) {
  const sql = `
    INSERT INTO fleet_sessions (host_id, cwd, args, env, created_by, label, metadata)
    VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7::jsonb)
    RETURNING *`;
  const { rows } = await c.query(sql, [
    s.hostId, s.cwd,
    JSON.stringify(s.args || []),
    JSON.stringify(s.env || {}),
    s.createdBy || null, s.label || null,
    JSON.stringify(s.metadata || {}),
  ]);
  return rows[0];
}

async function getSession(c, id) {
  const { rows } = await c.query('SELECT * FROM fleet_sessions WHERE id=$1', [id]);
  return rows[0] || null;
}

async function listSessions(c, { hostId, status, limit = 100, offset = 0 } = {}) {
  const where = [];
  const args = [];
  if (hostId) { args.push(hostId); where.push(`host_id = $${args.length}`); }
  if (status) { args.push(status); where.push(`status = $${args.length}`); }
  const wh = where.length ? `WHERE ${where.join(' AND ')}` : '';
  args.push(limit); args.push(offset);
  const sql = `SELECT * FROM fleet_sessions ${wh}
               ORDER BY started_at DESC
               LIMIT $${args.length - 1} OFFSET $${args.length}`;
  const { rows } = await c.query(sql, args);
  return rows;
}

async function markSessionRunning(c, id, pid) {
  await c.query("UPDATE fleet_sessions SET status='running', pid=$2 WHERE id=$1", [id, pid]);
}

async function markSessionExited(c, id, exitCode, status = 'exited') {
  await c.query(
    `UPDATE fleet_sessions SET status=$3, exit_code=$2, ended_at=now() WHERE id=$1`,
    [id, exitCode, status],
  );
}

async function orphanRunningSessions(c) {
  const { rowCount } = await c.query(
    "UPDATE fleet_sessions SET status='orphaned' WHERE status='running'");
  return rowCount;
}

// Delete sessions that have been in a terminal state for at least `olderThan`
// (e.g. '1 hour'). CASCADE removes their fleet_events.
async function deleteClosedSessions(c, olderThan = '1 hour') {
  const { rowCount } = await c.query(
    `DELETE FROM fleet_sessions
     WHERE status IN ('exited','killed')
       AND ended_at IS NOT NULL
       AND ended_at < now() - $1::interval`,
    [olderThan]);
  return rowCount;
}

async function appendEvents(c, events) {
  if (!events.length) return 0;
  const cols = ['session_id', 'kind', 'seq', 'payload'];
  const params = [];
  const placeholders = events.map((ev, i) => {
    const base = i * cols.length;
    params.push(ev.sessionId, ev.kind, ev.seq, ev.payload);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
  });
  const sql = `INSERT INTO fleet_events (${cols.join(',')}) VALUES ${placeholders.join(',')}`;
  await c.query(sql, params);
  return events.length;
}

async function maxSeq(c, sessionId) {
  const { rows } = await c.query(
    'SELECT MAX(seq) AS m FROM fleet_events WHERE session_id=$1', [sessionId]);
  return rows[0].m === null ? null : Number(rows[0].m);
}

async function readTranscript(c, sessionId, { sinceSeq = 0, limit = 10000, kind = null } = {}) {
  const args = [sessionId, sinceSeq, limit];
  let kindClause = '';
  if (kind) { args.push(kind); kindClause = `AND kind = $${args.length}`; }
  const { rows } = await c.query(
    `SELECT id, ts, kind, seq, payload, size FROM fleet_events
     WHERE session_id = $1 AND seq >= $2 ${kindClause}
     ORDER BY seq
     LIMIT $3`, args);
  return rows;
}

async function purgeOldEvents(c, intervalStr) {
  const { rowCount } = await c.query(
    `DELETE FROM fleet_events WHERE ts < now() - $1::interval AND kind IN ('pty_out','pty_in','meta')`,
    [intervalStr]);
  return rowCount;
}

module.exports = {
  upsertHost, listHosts, getHost, setHostOffline, deleteHost,
  createSession, getSession, listSessions,
  markSessionRunning, markSessionExited, orphanRunningSessions, deleteClosedSessions,
  appendEvents, maxSeq, readTranscript, purgeOldEvents,
};
