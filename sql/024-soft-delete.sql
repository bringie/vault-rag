-- vt-0225: soft-delete for groups + workflows. Recycle bin window: 30
-- days, then a periodic job hard-deletes (out of scope for this MVP —
-- operator runs DELETE WHERE deleted_at < now() - interval '30 days').
--
-- Secrets are NOT soft-deleted here: they live in age-encrypted blob,
-- not pg. A separate trash mechanism on the secrets backend is needed
-- if/when that's wanted (e.g. rotate moves old value to a .deleted_at
-- entry instead of overwriting).

ALTER TABLE fleet_groups
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE fleet_workflows
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Filter all listings to non-deleted by default. Existing queries use
-- SELECT * which now includes the column but filter via WHERE deleted_at
-- IS NULL — handled in the JS layer.

CREATE INDEX IF NOT EXISTS idx_fleet_groups_deleted_at
  ON fleet_groups (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fleet_workflows_deleted_at
  ON fleet_workflows (deleted_at) WHERE deleted_at IS NOT NULL;
