-- sql/019-fleet-groups-brain-prompt.sql
-- vt-0151: per-group brain prompt. When a task targets a group (rather
-- than a specific host), the dispatch path appends this to the spawn's
-- system_prompt so every member runs with the group's shared context.

ALTER TABLE fleet_groups
  ADD COLUMN IF NOT EXISTS brain_prompt text;
