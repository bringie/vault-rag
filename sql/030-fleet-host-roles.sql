-- vt-0370 (epic vt-0369): per-host role assignment.
--
-- Mirrors fleet_group_roles (sql/025-agent-roles.sql) — a host can have
-- 0..N agent-roles attached directly, independent of group membership.
-- Resolution at spawn time (in scripts/lib/fleet/dispatch.js + the
-- workflow runner) is:
--
--   if host belongs to a group with roles → use GROUP roles (host roles ignored)
--   else if host has its own roles        → use HOST roles
--   else                                  → no roles applied (brain_prompt only)
--
-- Rationale for "replace, not merge": predictable mental model. The
-- group is a deliberate aggregation; if an operator put a role on the
-- group, that's the intent — host-level customization on top of a
-- group-roled host would create combinatorial system_prompt bloat and
-- hit the existing MAX_DISPATCH_SYSTEM_PROMPT_BYTES cap.

CREATE TABLE IF NOT EXISTS fleet_host_roles (
  host_id  uuid NOT NULL REFERENCES fleet_hosts(id)       ON DELETE CASCADE,
  role_id  uuid NOT NULL REFERENCES fleet_agent_roles(id) ON DELETE CASCADE,
  position int  NOT NULL DEFAULT 0,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_fleet_host_roles_host ON fleet_host_roles (host_id);
