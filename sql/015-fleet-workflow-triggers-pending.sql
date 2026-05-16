-- vt-0110: workflow triggers (cron/every_ms) + suspension primitives.

-- workflow-level trigger config. Examples:
--   { "every_ms": 3600000 }  → runs hourly
--   { "every_ms": 86400000 } → runs daily
-- (cron syntax may be added later; every_ms covers the common cases.)
ALTER TABLE fleet_workflows
  ADD COLUMN IF NOT EXISTS trigger jsonb;

-- wait_for_approval pending rows. Runner polls these every ~2s; route
-- handler updates them when the operator decides. fired_at populated when
-- decision is recorded — runner sees it on next poll, resumes the run.
CREATE TABLE IF NOT EXISTS fleet_workflow_pending_approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES fleet_workflow_runs(id) ON DELETE CASCADE,
  node_id      text NOT NULL,
  reason       text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decision     text,                     -- 'approve' | 'reject' | null while pending
  decided_by   text,
  note         text,
  UNIQUE (run_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_fleet_wf_pending_approvals_open
  ON fleet_workflow_pending_approvals (requested_at)
  WHERE decided_at IS NULL;

-- wait_for_event pending rows. POST /fleet/workflow-events {name, payload}
-- updates all rows where event_name matches and fired_at is null.
CREATE TABLE IF NOT EXISTS fleet_workflow_pending_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES fleet_workflow_runs(id) ON DELETE CASCADE,
  node_id     text NOT NULL,
  event_name  text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  fired_at    timestamptz,
  payload     jsonb,
  UNIQUE (run_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_fleet_wf_pending_events_open
  ON fleet_workflow_pending_events (event_name)
  WHERE fired_at IS NULL;
