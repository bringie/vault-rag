'use strict';
// fleet-workflow-db: CRUD for fleet_workflows + fleet_workflow_runs.
// Callers pass an active pg Client/Pool.

async function listWorkflows(c, { includeDeleted = false } = {}) {
  // LATERAL JOIN pulls the most-recent run per workflow (or NULL columns
  // if the workflow has never been run). Powers the "last run / status /
  // failed at" columns in the workflows list UI.
  const { rows } = await c.query(`
    SELECT w.id, w.name, w.description,
           jsonb_array_length(w.definition->'nodes') AS n_nodes,
           w.updated_at, w.created_at,
           lr.status         AS last_status,
           lr.finished_at    AS last_finished,
           lr.failed_node_id AS last_failed_node
    FROM fleet_workflows w
    LEFT JOIN LATERAL (
      SELECT status, finished_at, failed_node_id
      FROM fleet_workflow_runs
      WHERE workflow_id = w.id
      ORDER BY created_at DESC LIMIT 1
    ) lr ON true
    ${includeDeleted ? '' : 'WHERE w.deleted_at IS NULL'}
    ORDER BY w.updated_at DESC`);
  return rows;
}
// vt-0225: trash bin helpers.
async function listDeletedWorkflows(c) {
  const { rows } = await c.query(
    `SELECT id, name, description, deleted_at FROM fleet_workflows
      WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`);
  return rows;
}
async function restoreWorkflow(c, id) {
  const { rows } = await c.query(
    `UPDATE fleet_workflows SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *`, [id]);
  return rows[0] || null;
}

// vt-0230: default filter excludes soft-deleted workflows so the runner
// can't start a "deleted" workflow via trigger / cron / stale UI tab.
// Use getWorkflowIncludingDeleted for trash UI / restore paths.
async function getWorkflow(c, id, { includeDeleted = false } = {}) {
  const sql = includeDeleted
    ? 'SELECT * FROM fleet_workflows WHERE id = $1'
    : 'SELECT * FROM fleet_workflows WHERE id = $1 AND deleted_at IS NULL';
  const { rows } = await c.query(sql, [id]);
  return rows[0] || null;
}
async function getWorkflowIncludingDeleted(c, id) {
  return getWorkflow(c, id, { includeDeleted: true });
}

async function createWorkflow(c, { name, description, definition }) {
  const { rows } = await c.query(
    `INSERT INTO fleet_workflows (name, description, definition)
     VALUES ($1, $2, $3::jsonb) RETURNING *`,
    [name, description || null, JSON.stringify(definition)]);
  return rows[0];
}

// vt-0205: optimistic concurrency. expectedVersion (optional, finite int)
// enables cross-tab safety: UPDATE only fires if current version still
// matches; bumps version on success. Returns {__conflict: true, current}
// to let the caller surface 409. Same shape as updateGroup (vt-0081).
async function updateWorkflow(c, id, patch, expectedVersion) {
  const updates = []; const args = [];
  if ('name' in patch)        { args.push(patch.name);        updates.push(`name = $${args.length}`); }
  if ('description' in patch) { args.push(patch.description); updates.push(`description = $${args.length}`); }
  if ('definition' in patch)  { args.push(JSON.stringify(patch.definition)); updates.push(`definition = $${args.length}::jsonb`); }
  if (!updates.length) return await getWorkflow(c, id);
  updates.push('version = version + 1');
  updates.push('updated_at = now()');
  args.push(id);
  let sql = `UPDATE fleet_workflows SET ${updates.join(', ')} WHERE id = $${args.length}`;
  if (Number.isFinite(expectedVersion)) {
    args.push(expectedVersion);
    sql += ` AND version = $${args.length}`;
  }
  sql += ' RETURNING *';
  const { rows } = await c.query(sql, args);
  if (!rows.length) {
    if (Number.isFinite(expectedVersion)) {
      const cur = await getWorkflow(c, id);
      if (!cur) return null;
      return { __conflict: true, current: cur };
    }
    return null;
  }
  return rows[0];
}

// vt-0225: soft-delete; purgeWorkflow() for the eventual 30-day reaper.
// vt-0230: refuse soft-delete while pending/running runs exist — runner
// would keep executing a "deleted" workflow until completion otherwise.
// Returns { deleted: bool, reason?: string } so the route can surface 409.
async function deleteWorkflow(c, id) {
  const active = await c.query(
    `SELECT COUNT(*)::int AS n FROM fleet_workflow_runs WHERE workflow_id = $1 AND status IN ('pending','running')`,
    [id]
  );
  if (active.rows[0].n > 0) {
    return { deleted: false, reason: `${active.rows[0].n} pending/running run(s) — cancel first` };
  }
  const r = await c.query(
    'UPDATE fleet_workflows SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id]);
  return { deleted: r.rowCount > 0 };
}
async function purgeWorkflow(c, id) {
  await c.query('DELETE FROM fleet_workflows WHERE id = $1', [id]);
}

async function listRuns(c, { workflowId, status, limit = 100 } = {}) {
  const where = []; const args = [];
  if (workflowId) { args.push(workflowId); where.push(`workflow_id = $${args.length}`); }
  if (status)     { args.push(status);     where.push(`status = $${args.length}`); }
  const wh = where.length ? `WHERE ${where.join(' AND ')}` : '';
  args.push(limit);
  const { rows } = await c.query(
    `SELECT * FROM fleet_workflow_runs ${wh}
     ORDER BY created_at DESC LIMIT $${args.length}`, args);
  return rows;
}

async function getRun(c, id) {
  const { rows } = await c.query('SELECT * FROM fleet_workflow_runs WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createRun(c, { workflowId, snapshot, state = {} }) {
  const { rows } = await c.query(
    `INSERT INTO fleet_workflow_runs (workflow_id, snapshot, state)
     VALUES ($1, $2::jsonb, $3::jsonb) RETURNING *`,
    [workflowId, JSON.stringify(snapshot), JSON.stringify(state)]);
  return rows[0];
}

async function updateRunStatus(c, id, status, errorMsg = null, failedNodeId = null) {
  const ts = status === 'running' ? 'started_at = now()' :
             (status === 'done' || status === 'failed' || status === 'cancelled') ? 'finished_at = now()' :
             '';
  const tsClause = ts ? `, ${ts}` : '';
  const args = [id, status];
  let errClause = '';
  if (errorMsg) { args.push(errorMsg); errClause = `, state = jsonb_set(state, '{error}', to_jsonb($${args.length}::text), true)`; }
  let failClause = '';
  if (failedNodeId) { args.push(failedNodeId); failClause = `, failed_node_id = $${args.length}`; }
  await c.query(
    `UPDATE fleet_workflow_runs SET status = $2 ${tsClause} ${errClause} ${failClause} WHERE id = $1`, args);
}

async function updateRunState(c, id, patch) {
  await c.query(
    `UPDATE fleet_workflow_runs SET state = state || $2::jsonb WHERE id = $1`,
    [id, JSON.stringify(patch)]);
}

async function orphanRunningRuns(c) {
  const { rowCount } = await c.query(
    `UPDATE fleet_workflow_runs
     SET status = 'failed',
         finished_at = now(),
         state = state || '{"error":"hub restart"}'::jsonb
     WHERE status IN ('pending','running')`);
  return rowCount;
}

// vt-0206: heartbeat reaper for stuck workflow_runs. Same intent as
// reapStuckSessions but at the workflow_run level — a runner that
// crashed silently leaves rows in 'running' forever. Default 24h.
async function reapStuckRuns(c, { maxAgeHours = 24 } = {}) {
  const r = await c.query(
    `UPDATE fleet_workflow_runs
        SET status = 'failed',
            finished_at = now(),
            state = state || '{"error":"reaped: stuck > ' || $1 || 'h"}'::jsonb
      WHERE status IN ('pending','running')
        AND started_at < now() - ($1::text || ' hours')::interval
   RETURNING id`, [String(maxAgeHours)]);
  return r.rowCount;
}

// --- vt-0110: triggers + suspension primitives ---

async function listTriggeredWorkflows(c) {
  const { rows } = await c.query(
    `SELECT id, name, definition, trigger,
            (SELECT MAX(created_at) FROM fleet_workflow_runs WHERE workflow_id = w.id) AS last_run_at
     FROM fleet_workflows w
     WHERE trigger IS NOT NULL`);
  return rows;
}

async function setWorkflowTrigger(c, id, trigger) {
  await c.query('UPDATE fleet_workflows SET trigger = $2::jsonb, updated_at = now() WHERE id = $1',
    [id, trigger == null ? null : JSON.stringify(trigger)]);
}

async function createPendingApproval(c, { runId, nodeId, reason }) {
  // vt-0128: ON CONFLICT used to only refresh `reason`, leaving any prior
  // `decision`/`decided_at`/`decided_by`/`note` in place. If a wait_for_approval
  // node re-enters (replay, retry, sub-workflow re-dispatch) the next poll
  // tick would see the stale decision and auto-approve without operator
  // action. Reset the decision fields whenever a new pending row is created.
  const { rows } = await c.query(
    `INSERT INTO fleet_workflow_pending_approvals (run_id, node_id, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (run_id, node_id) DO UPDATE SET
       reason     = EXCLUDED.reason,
       decision   = NULL,
       decided_at = NULL,
       decided_by = NULL,
       note       = NULL,
       requested_at = now()
     RETURNING *`,
    [runId, nodeId, reason || null]);
  return rows[0];
}

async function getPendingApproval(c, runId, nodeId) {
  const { rows } = await c.query(
    `SELECT * FROM fleet_workflow_pending_approvals WHERE run_id = $1 AND node_id = $2`,
    [runId, nodeId]);
  return rows[0] || null;
}

async function listPendingApprovals(c) {
  const { rows } = await c.query(
    `SELECT a.*, r.workflow_id, w.name AS workflow_name
     FROM fleet_workflow_pending_approvals a
     LEFT JOIN fleet_workflow_runs r ON r.id = a.run_id
     LEFT JOIN fleet_workflows w ON w.id = r.workflow_id
     WHERE a.decided_at IS NULL
     ORDER BY a.requested_at DESC`);
  return rows;
}

async function recordApprovalDecision(c, runId, nodeId, { decision, decided_by, note }) {
  if (!['approve', 'reject'].includes(decision)) {
    throw new Error('decision must be approve or reject');
  }
  const { rows } = await c.query(
    `UPDATE fleet_workflow_pending_approvals
     SET decision = $3, decided_at = now(), decided_by = $4, note = $5
     WHERE run_id = $1 AND node_id = $2 AND decided_at IS NULL
     RETURNING *`,
    [runId, nodeId, decision, decided_by || null, note || null]);
  return rows[0] || null;
}

async function createPendingEvent(c, { runId, nodeId, eventName }) {
  // vt-0128: same stale-decision race as createPendingApproval. Reset
  // fired_at + payload when a wait_for_event node re-enters; otherwise
  // a prior `fired_at` would auto-satisfy the new wait.
  const { rows } = await c.query(
    `INSERT INTO fleet_workflow_pending_events (run_id, node_id, event_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (run_id, node_id) DO UPDATE SET
       event_name   = EXCLUDED.event_name,
       fired_at     = NULL,
       payload      = NULL,
       requested_at = now()
     RETURNING *`,
    [runId, nodeId, eventName]);
  return rows[0];
}

async function getPendingEvent(c, runId, nodeId) {
  const { rows } = await c.query(
    `SELECT * FROM fleet_workflow_pending_events WHERE run_id = $1 AND node_id = $2`,
    [runId, nodeId]);
  return rows[0] || null;
}

async function fireEvent(c, eventName, payload) {
  const { rowCount } = await c.query(
    `UPDATE fleet_workflow_pending_events
     SET fired_at = now(), payload = $2::jsonb
     WHERE event_name = $1 AND fired_at IS NULL`,
    [eventName, JSON.stringify(payload || null)]);
  return rowCount;
}

module.exports = {
  listWorkflows, getWorkflow, getWorkflowIncludingDeleted, createWorkflow, updateWorkflow, deleteWorkflow, purgeWorkflow,
  listDeletedWorkflows, restoreWorkflow,
  listRuns, getRun, createRun, updateRunStatus, updateRunState, orphanRunningRuns, reapStuckRuns,
  // vt-0110
  listTriggeredWorkflows, setWorkflowTrigger,
  createPendingApproval, getPendingApproval, listPendingApprovals, recordApprovalDecision,
  createPendingEvent, getPendingEvent, fireEvent,
};
