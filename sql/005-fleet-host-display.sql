-- 005-fleet-host-display.sql: friendly display name for fleet hosts.
-- 'name' stays as the daemon's connection identity; 'display_name' is editable.

ALTER TABLE fleet_hosts ADD COLUMN IF NOT EXISTS display_name text;
