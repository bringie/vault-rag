'use strict';
// fleet-workflow-db: CRUD for fleet_workflows + fleet_workflow_runs.
// Callers pass an active pg Client/Pool.

async function listWorkflows(c) {
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
    ORDER BY w.updated_at DESC`);
  return rows;
}

async function getWorkflow(c, id) {
  const { rows } = await c.query('SELECT * FROM fleet_workflows WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createWorkflow(c, { name, description, definition }) {
  const { rows } = await c.query(
    `INSERT INTO fleet_workflows (name, description, definition)
     VALUES ($1, $2, $3::jsonb) RETURNING *`,
    [name, description || null, JSON.stringify(definition)]);
  return rows[0];
}

async function updateWorkflow(c, id, patch) {
  const updates = []; const args = [];
  if ('name' in patch)        { args.push(patch.name);        updates.push(`name = $${args.length}`); }
  if ('description' in patch) { args.push(patch.description); updates.push(`description = $${args.length}`); }
  if ('definition' in patch)  { args.push(JSON.stringify(patch.definition)); updates.push(`definition = $${args.length}::jsonb`); }
  if (!updates.length) return await getWorkflow(c, id);
  updates.push('updated_at = now()');
  args.push(id);
  const { rows } = await c.query(
    `UPDATE fleet_workflows SET ${updates.join(', ')} WHERE id = $${args.length} RETURNING *`, args);
  return rows[0] || null;
}

async function deleteWorkflow(c, id) {
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

module.exports = {
  listWorkflows, getWorkflow, createWorkflow, updateWorkflow, deleteWorkflow,
  listRuns, getRun, createRun, updateRunStatus, updateRunState, orphanRunningRuns,
};
