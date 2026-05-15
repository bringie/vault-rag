ALTER TABLE fleet_groups
  ADD COLUMN IF NOT EXISTS labels text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_fleet_groups_labels
  ON fleet_groups USING gin (labels);
