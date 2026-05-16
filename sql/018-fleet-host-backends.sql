-- sql/018-fleet-host-backends.sql
-- vt-0150: persist per-host installed-backend map so the UI can render
-- one edit button per backend that actually exists on the host.
--
-- Shape: {"claude": "1.x.y", "codex": "0.4", "opencode": "0.1", ...}
-- Value null/undefined → backend not installed.

ALTER TABLE fleet_hosts
  ADD COLUMN IF NOT EXISTS installed_backends jsonb DEFAULT '{}'::jsonb;
