-- 006-fleet-session-notes.sql: editable per-session notes + indices for archive filtering.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE fleet_sessions ADD COLUMN IF NOT EXISTS notes text;

-- Speed up the archive view: range scan by start time within a host, filter by label.
CREATE INDEX IF NOT EXISTS fleet_sessions_started_desc ON fleet_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS fleet_sessions_label_trgm ON fleet_sessions USING gin (label gin_trgm_ops);
