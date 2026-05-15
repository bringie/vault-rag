CREATE TABLE IF NOT EXISTS fleet_workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text UNIQUE NOT NULL,
  description text,
  definition  jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fleet_workflow_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  uuid REFERENCES fleet_workflows(id) ON DELETE SET NULL,
  snapshot     jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  state        jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fleet_workflow_runs_wid
  ON fleet_workflow_runs(workflow_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_fleet_workflow_runs_status
  ON fleet_workflow_runs(status) WHERE status IN ('pending','running');
