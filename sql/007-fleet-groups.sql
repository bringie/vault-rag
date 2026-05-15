-- 007-fleet-groups.sql: named first-class groups (vs free-form capabilities[]).
-- Capabilities stay as ad-hoc labels; groups are explicit named collections
-- with descriptions, used for dispatch/broadcast routing and UI organization.

CREATE TABLE IF NOT EXISTS fleet_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text UNIQUE NOT NULL,
  description text,
  color       text,                      -- '#hex' UI accent
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fleet_host_groups (
  host_id  uuid REFERENCES fleet_hosts(id)  ON DELETE CASCADE,
  group_id uuid REFERENCES fleet_groups(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, group_id)
);
CREATE INDEX IF NOT EXISTS fleet_host_groups_by_group ON fleet_host_groups(group_id);
