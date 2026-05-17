-- vt-0271: partial indices on soft-delete columns so the recycle-bin
-- pagination (vt-0269) doesn't degrade to a seqscan once retention
-- grows. count(*) WHERE deleted_at IS NOT NULL is otherwise O(rows).
-- Partial index keeps the live-row hot path untouched.

CREATE INDEX IF NOT EXISTS idx_fleet_groups_deleted_at
  ON fleet_groups (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fleet_workflows_deleted_at
  ON fleet_workflows (deleted_at) WHERE deleted_at IS NOT NULL;

-- vt-0259 follow-up: agent_roles soft-delete column gets the same.
CREATE INDEX IF NOT EXISTS idx_fleet_agent_roles_deleted_at
  ON fleet_agent_roles (deleted_at) WHERE deleted_at IS NOT NULL;
