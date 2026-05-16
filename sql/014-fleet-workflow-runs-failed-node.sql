-- Track the node id that failed a workflow run, so the workflows list can
-- show "failed at n2" without scanning state.outputs JSON.

ALTER TABLE fleet_workflow_runs
  ADD COLUMN IF NOT EXISTS failed_node_id text;
