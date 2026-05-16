-- Optimistic-concurrency: version column bumped on every UPDATE.
-- PATCH /fleet/groups/:id requires expected_version; mismatch → 409.

ALTER TABLE fleet_groups
  ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
