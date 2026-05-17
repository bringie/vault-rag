-- vt-0205: optimistic concurrency for fleet_workflows. fleet_groups got
-- this via vt-0081; workflows need it for the same cross-tab edit case
-- (operator opens the same workflow in two browser tabs, saves both —
-- silent last-writer-wins without a version column).
ALTER TABLE fleet_workflows
  ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
