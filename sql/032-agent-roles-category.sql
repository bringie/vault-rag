-- vt-0432 / vt-0431 epic: category column for agent roles.
-- Enables folder-tree UI grouping and per-domain seeding from
-- external catalogs (msitarzewski/agency-agents → engineering /
-- marketing / specialized / etc).
--
-- Idempotent: re-applies cleanly on existing prod DB.

ALTER TABLE fleet_agent_roles
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'general';

CREATE INDEX IF NOT EXISTS idx_fleet_agent_roles_category
  ON fleet_agent_roles (category)
  WHERE deleted_at IS NULL;
