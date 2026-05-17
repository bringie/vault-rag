'use strict';
// fleet-db: thin pg query layer for agent-fleet hosts/sessions/events.
// Callers pass an active pg.Client/pg.Pool — no connection management here.

async function upsertHost(c, h) {
  // capabilities: only overwrite if explicitly provided AND non-empty
  // (daemon hello has empty array by default; we don't want it to clobber
  // user-set tags via PATCH).
  // vt-0150: persist installed_backends if provided (empty object = no probe).
  // Pre-vt-0150 daemons don't send `backends`, so absence is a no-op.
  const sql = `
    INSERT INTO fleet_hosts (name, os, arch, capabilities, daemon_version, claude_version, installed_backends, status, last_seen)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'online', now())
    ON CONFLICT (name) DO UPDATE SET
      os = COALESCE(EXCLUDED.os, fleet_hosts.os),
      arch = COALESCE(EXCLUDED.arch, fleet_hosts.arch),
      capabilities = CASE
        WHEN EXCLUDED.capabilities IS NOT NULL AND array_length(EXCLUDED.capabilities, 1) > 0
        THEN EXCLUDED.capabilities
        ELSE fleet_hosts.capabilities
      END,
      daemon_version = COALESCE(EXCLUDED.daemon_version, fleet_hosts.daemon_version),
      claude_version = COALESCE(EXCLUDED.claude_version, fleet_hosts.claude_version),
      -- Merge instead of replace: a partial probe (e.g. claude detected but
      -- codex offline this tick) should not erase previously-known backends.
      -- Drop entries with null values from the incoming side so a clean
      -- probe of "this backend is not installed" doesn't overwrite a prior
      -- positive detection. The full-replace happens implicitly when the
      -- incoming side has all the same keys.
      installed_backends = COALESCE(fleet_hosts.installed_backends, '{}'::jsonb) || (
        SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
        FROM jsonb_each(EXCLUDED.installed_backends) AS x(k, v)
        WHERE v IS NOT NULL AND v <> 'null'::jsonb
      ),
      status = 'online',
      last_seen = now()
    RETURNING *`;
  const { rows } = await c.query(sql, [
    h.name, h.os || null, h.arch || null, h.capabilities || [],
    h.daemonVersion || null, h.claudeVersion || null,
    h.backends ? JSON.stringify(h.backends) : '{}',
  ]);
  return rows[0];
}

// ============ Groups ============

async function listGroups(c, { includeDeleted = false } = {}) {
  const { rows } = await c.query(`
    SELECT g.*,
      COALESCE((SELECT array_agg(hg.host_id) FROM fleet_host_groups hg WHERE hg.group_id = g.id), '{}') AS host_ids
    FROM fleet_groups g
    ${includeDeleted ? '' : 'WHERE g.deleted_at IS NULL'}
    ORDER BY g.name
  `);
  return rows;
}
// vt-0225: soft-delete instead of hard. listDeletedGroups + restoreGroup.
async function listDeletedGroups(c) {
  const { rows } = await c.query(
    `SELECT id, name, description, color, deleted_at
       FROM fleet_groups
      WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at DESC`);
  return rows;
}
async function restoreGroup(c, id) {
  const { rows } = await c.query(
    `UPDATE fleet_groups SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *`, [id]);
  return rows[0] || null;
}

async function getGroup(c, id) {
  const { rows } = await c.query('SELECT * FROM fleet_groups WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getGroupByName(c, name) {
  const { rows } = await c.query('SELECT * FROM fleet_groups WHERE name = $1', [name]);
  return rows[0] || null;
}

async function createGroup(c, { name, description, color, labels, brain_prompt }) {
  const { rows } = await c.query(
    `INSERT INTO fleet_groups (name, description, color, labels, brain_prompt) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, description || null, color || null, labels || [], brain_prompt || null]);
  return rows[0];
}

// expectedVersion (optional) enables optimistic-concurrency for cross-tab edits.
// If provided and current version differs, returns 'conflict' (no UPDATE applied);
// caller surfaces 409. Otherwise updates and bumps version atomically.
async function updateGroup(c, id, patch, expectedVersion) {
  const updates = []; const args = [];
  if ('name' in patch)        { args.push(patch.name);        updates.push(`name = $${args.length}`); }
  if ('description' in patch) { args.push(patch.description); updates.push(`description = $${args.length}`); }
  if ('color' in patch)       { args.push(patch.color);       updates.push(`color = $${args.length}`); }
  if ('labels' in patch)      {
    if (!Array.isArray(patch.labels)) throw new Error('labels must be array');
    args.push(patch.labels.map(String).filter(Boolean));
    updates.push(`labels = $${args.length}`);
  }
  if ('brain_prompt' in patch) {
    args.push(patch.brain_prompt || null);
    updates.push(`brain_prompt = $${args.length}`);
  }
  if (!updates.length) return await getGroup(c, id);
  updates.push(`version = version + 1`);
  args.push(id);
  let sql = `UPDATE fleet_groups SET ${updates.join(', ')} WHERE id = $${args.length}`;
  if (Number.isFinite(expectedVersion)) {
    args.push(expectedVersion);
    sql += ` AND version = $${args.length}`;
  }
  sql += ' RETURNING *';
  const { rows } = await c.query(sql, args);
  if (!rows.length) {
    if (Number.isFinite(expectedVersion)) {
      // Distinguish 404 (not found) vs 409 (version mismatch)
      const cur = await getGroup(c, id);
      if (!cur) return null;
      return { __conflict: true, current: cur };
    }
    return null;
  }
  return rows[0];
}

// Effective capabilities = host.capabilities ∪ ⋃ group.labels for each group host is in.
// Returns { capabilities: [direct...], inherited: { groupName: [labels...] }, effective: [union] }.
async function getEffectiveCapabilities(c, hostId) {
  const host = await getHost(c, hostId);
  if (!host) return null;
  const { rows } = await c.query(`
    SELECT g.name, g.labels FROM fleet_groups g
    JOIN fleet_host_groups hg ON hg.group_id = g.id
    WHERE hg.host_id = $1`, [hostId]);
  const direct = host.capabilities || [];
  const inherited = {};
  const set = new Set(direct);
  for (const r of rows) {
    inherited[r.name] = r.labels || [];
    for (const l of r.labels || []) set.add(l);
  }
  return { capabilities: direct, inherited, effective: Array.from(set).sort() };
}

// For dispatch: list hosts whose effective tags contain `tag`.
async function listHostsByEffectiveTag(c, tag) {
  const { rows } = await c.query(`
    SELECT DISTINCT h.* FROM fleet_hosts h
    LEFT JOIN fleet_host_groups hg ON hg.host_id = h.id
    LEFT JOIN fleet_groups g ON g.id = hg.group_id
    WHERE $1 = ANY(h.capabilities) OR $1 = ANY(g.labels)`, [tag]);
  return rows;
}

// vt-0225: soft-delete now. Use purgeGroup() for hard delete (the 30-day
// reaper or operator-driven).
async function deleteGroup(c, id) {
  await c.query('UPDATE fleet_groups SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
}
async function purgeGroup(c, id) {
  await c.query('DELETE FROM fleet_groups WHERE id = $1', [id]);
}

async function addHostToGroup(c, hostId, groupId) {
  await c.query(
    `INSERT INTO fleet_host_groups (host_id, group_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`, [hostId, groupId]);
}

async function removeHostFromGroup(c, hostId, groupId) {
  await c.query('DELETE FROM fleet_host_groups WHERE host_id = $1 AND group_id = $2', [hostId, groupId]);
}

async function listGroupsForHost(c, hostId) {
  const { rows } = await c.query(`
    SELECT g.* FROM fleet_groups g
    JOIN fleet_host_groups hg ON hg.group_id = g.id
    WHERE hg.host_id = $1
    ORDER BY g.name`, [hostId]);
  return rows;
}

async function listHostsInGroup(c, groupId) {
  const { rows } = await c.query(`
    SELECT h.* FROM fleet_hosts h
    JOIN fleet_host_groups hg ON hg.host_id = h.id
    WHERE hg.group_id = $1`, [groupId]);
  return rows;
}

async function setHostMetadata(c, id, info) {
  await c.query(
    `UPDATE fleet_hosts SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [id, JSON.stringify(info)]);
}

async function updateHost(c, id, patch) {
  // Patchable: display_name (string|null), capabilities (string[])
  const updates = [];
  const args = [];
  if (Object.prototype.hasOwnProperty.call(patch, 'display_name')) {
    args.push(patch.display_name);
    updates.push(`display_name = $${args.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'capabilities')) {
    args.push(patch.capabilities || []);
    updates.push(`capabilities = $${args.length}`);
  }
  if (!updates.length) return await getHost(c, id);
  args.push(id);
  const { rows } = await c.query(
    `UPDATE fleet_hosts SET ${updates.join(', ')} WHERE id = $${args.length} RETURNING *`,
    args);
  return rows[0] || null;
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

async function listSessions(c, { hostId, status, limit = 100, offset = 0, since, until, query } = {}) {
  const where = [];
  const args = [];
  if (hostId) { args.push(hostId); where.push(`host_id = $${args.length}`); }
  if (status) { args.push(status); where.push(`status = $${args.length}`); }
  if (since)  { args.push(since);  where.push(`started_at >= $${args.length}`); }
  if (until)  { args.push(until);  where.push(`started_at <= $${args.length}`); }
  if (query) {
    args.push('%' + query + '%');
    where.push(`(label ILIKE $${args.length} OR notes ILIKE $${args.length} OR cwd ILIKE $${args.length})`);
  }
  const wh = where.length ? `WHERE ${where.join(' AND ')}` : '';
  args.push(limit); args.push(offset);
  const sql = `SELECT * FROM fleet_sessions ${wh}
               ORDER BY started_at DESC
               LIMIT $${args.length - 1} OFFSET $${args.length}`;
  const { rows } = await c.query(sql, args);
  return rows;
}

async function countSessions(c, { hostId, status, since, until, query } = {}) {
  const where = [];
  const args = [];
  if (hostId) { args.push(hostId); where.push(`host_id = $${args.length}`); }
  if (status) { args.push(status); where.push(`status = $${args.length}`); }
  if (since)  { args.push(since);  where.push(`started_at >= $${args.length}`); }
  if (until)  { args.push(until);  where.push(`started_at <= $${args.length}`); }
  if (query) {
    args.push('%' + query + '%');
    where.push(`(label ILIKE $${args.length} OR notes ILIKE $${args.length} OR cwd ILIKE $${args.length})`);
  }
  const wh = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await c.query(`SELECT COUNT(*)::int AS n FROM fleet_sessions ${wh}`, args);
  return rows[0].n;
}

async function updateSession(c, id, patch) {
  const updates = [];
  const args = [];
  if ('notes' in patch) { args.push(patch.notes);  updates.push(`notes = $${args.length}`); }
  if ('label' in patch) { args.push(patch.label);  updates.push(`label = $${args.length}`); }
  if (!updates.length) return await getSession(c, id);
  args.push(id);
  const { rows } = await c.query(
    `UPDATE fleet_sessions SET ${updates.join(', ')} WHERE id = $${args.length} RETURNING *`,
    args);
  return rows[0] || null;
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

// vt-0206: periodic heartbeat reaper for sessions/workflow_runs stuck
// in 'running'. The startup-only orphanRunningSessions catches restart
// crashes, but a daemon that dies WITHOUT a hub restart leaves rows
// stuck forever. Two signals:
//   1. host went offline (last_seen old) → all its running sessions
//      are orphaned with status='orphaned' + ended_at=now()
//   2. session has been 'running' for > maxAgeHours and its host is
//      offline → orphaned regardless (defensive backstop).
// Defaults: hostStaleSec=180 (3× heartbeat), maxAgeHours=24.
async function reapStuckSessions(c, { hostStaleSec = 180, maxAgeHours = 24 } = {}) {
  const r = await c.query(`
    UPDATE fleet_sessions s
       SET status = 'orphaned', ended_at = COALESCE(s.ended_at, now())
      FROM fleet_hosts h
     WHERE s.host_id = h.id
       AND s.status = 'running'
       AND (
         h.last_seen < now() - ($1::text || ' seconds')::interval
         OR s.started_at < now() - ($2::text || ' hours')::interval
       )
   RETURNING s.id`, [String(hostStaleSec), String(maxAgeHours)]);
  return r.rowCount;
}

// Delete sessions that have been in a terminal state for at least `olderThan`
// (e.g. '1 hour'). CASCADE removes their fleet_events.
// LIMIT 1000 caps the AccessExclusiveLock duration on busy installs.
// Caller can loop while limited === true to drain.
async function deleteClosedSessions(c, olderThan = '1 hour', limit = 1000) {
  const { rowCount } = await c.query(
    `DELETE FROM fleet_sessions
     WHERE id IN (
       SELECT id FROM fleet_sessions
       WHERE status IN ('exited','killed')
         AND ended_at IS NOT NULL
         AND ended_at < now() - $1::interval
       LIMIT $2
     )`,
    [olderThan, limit]);
  return { deleted: rowCount, limited: rowCount >= limit };
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

// LIMIT 10000 + caller-loop to avoid one giant delete on million-row tables.
async function purgeOldEvents(c, intervalStr, limit = 10000) {
  const { rowCount } = await c.query(
    `DELETE FROM fleet_events WHERE id IN (
       SELECT id FROM fleet_events
       WHERE ts < now() - $1::interval
         AND kind IN ('pty_out','pty_in','meta')
       LIMIT $2
     )`,
    [intervalStr, limit]);
  return { deleted: rowCount, limited: rowCount >= limit };
}

// vt-0203: filter jsonb shapes from daemon-supplied metric frames. Without
// this, a compromised daemon could stuff arbitrary keys/sizes into
// fleet_host_metrics.{disk,net} and the UI may render them unescaped.
const DISK_KEYS = new Set(['mount', 'used_bytes', 'total_bytes', 'used_pct', 'fs', 'device']);
const NET_KEYS  = new Set(['iface', 'rx_bytes', 'tx_bytes', 'rx_packets', 'tx_packets', 'rx_errors', 'tx_errors']);
function _filterMetricArray(arr, keySet) {
  if (!Array.isArray(arr)) return null;
  // Cap entries — a malicious daemon could otherwise emit 10k mounts.
  return arr.slice(0, 64).map(entry => {
    if (!entry || typeof entry !== 'object') return null;
    const out = {};
    for (const k of Object.keys(entry)) if (keySet.has(k)) out[k] = entry[k];
    return out;
  }).filter(Boolean);
}

async function insertHostMetric(c, hostId, m) {
  const disk = _filterMetricArray(m.disk, DISK_KEYS);
  const net  = _filterMetricArray(m.net, NET_KEYS);
  await c.query(
    `INSERT INTO fleet_host_metrics (host_id, ts, cpu_pct, ram_used_bytes, ram_total_bytes, disk, net, error)
     VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [
      hostId,
      m.ts || null,
      m.cpu_pct == null ? null : Number(m.cpu_pct),
      m.ram_used_bytes == null ? null : Number(m.ram_used_bytes),
      m.ram_total_bytes == null ? null : Number(m.ram_total_bytes),
      disk && disk.length ? JSON.stringify(disk) : null,
      net  && net.length  ? JSON.stringify(net)  : null,
      m.error || null,
    ]);
}

async function setHostLatestMetrics(c, hostId, m) {
  await c.query(
    `UPDATE fleet_hosts
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('latest_metrics', $2::jsonb)
     WHERE id = $1`,
    [hostId, JSON.stringify({
      ts: m.ts, cpu_pct: m.cpu_pct, ram_used_bytes: m.ram_used_bytes, ram_total_bytes: m.ram_total_bytes,
    })]);
}

// vt-0203: filter inventory frame to known keys. Anything else gets dropped.
const INVENTORY_KEYS = new Set([
  'skills', 'mcp_servers', 'settings_present', 'claude_md_present',
  'codex_config_present', 'opencode_config_present', 'gemini_md_present',
  'agents_dir', 'home_disk_used_pct', 'snapshot_ts',
]);
async function setHostInventory(c, hostId, inv) {
  const safe = {};
  if (inv && typeof inv === 'object') {
    for (const k of Object.keys(inv)) if (INVENTORY_KEYS.has(k)) safe[k] = inv[k];
  }
  await c.query(
    `UPDATE fleet_hosts
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('inventory', $2::jsonb)
     WHERE id = $1`,
    [hostId, JSON.stringify(safe)]);
}

async function readMetricsSince(c, hostId, interval) {
  const { rows } = await c.query(
    `SELECT ts, cpu_pct, ram_used_bytes, ram_total_bytes, disk, net, error
     FROM fleet_host_metrics
     WHERE host_id = $1 AND ts > now() - $2::interval
     ORDER BY ts ASC`,
    [hostId, interval]);
  return rows;
}

async function readMetricsRollupSince(c, hostId, interval) {
  const { rows } = await c.query(
    `SELECT bucket, cpu_pct_avg, cpu_pct_max, ram_used_bytes
     FROM fleet_host_metrics_5m
     WHERE host_id = $1 AND bucket > now() - $2::interval
     ORDER BY bucket ASC`,
    [hostId, interval]);
  return rows;
}

module.exports = {
  upsertHost, listHosts, getHost, setHostOffline, deleteHost, updateHost, setHostMetadata,
  createSession, getSession, listSessions, countSessions, updateSession,
  markSessionRunning, markSessionExited, orphanRunningSessions, reapStuckSessions, deleteClosedSessions,
  appendEvents, maxSeq, readTranscript, purgeOldEvents,
  listGroups, getGroup, getGroupByName, createGroup, updateGroup, deleteGroup, purgeGroup,
  listDeletedGroups, restoreGroup,
  addHostToGroup, removeHostFromGroup, listGroupsForHost, listHostsInGroup,
  getEffectiveCapabilities, listHostsByEffectiveTag,
  insertHostMetric, setHostLatestMetrics, setHostInventory, readMetricsSince, readMetricsRollupSince,
};
