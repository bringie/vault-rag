-- vt-0337: fleet_tmux_sessions tracks user-launched tmux sessions
-- on hosts (discovered via the daemon mux-poller every 30s). Hub
-- exposes /api/fleet/hosts/:id/tmux-sessions for the SPA, and
-- POST .../attach mints a synthetic fleet_sessions row that runs
-- `tmux attach-session -t <name>` (vt-0338, phase 4).
CREATE TABLE IF NOT EXISTS fleet_tmux_sessions (
  host_id           uuid NOT NULL REFERENCES fleet_hosts(id) ON DELETE CASCADE,
  name              text NOT NULL,
  agent             text NULL,
  cwd               text NULL,
  created_at        timestamptz NULL,
  last_activity     timestamptz NULL,
  attached_clients  smallint NOT NULL DEFAULT 0,
  windows           smallint NOT NULL DEFAULT 1,
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, name)
);
CREATE INDEX IF NOT EXISTS idx_fleet_tmux_sessions_host_activity
  ON fleet_tmux_sessions (host_id, last_activity DESC);

-- Support index for the per-host top-10 retention sweeper (phase 6).
-- Partial index so the planner sticks to it for the common 'closed'
-- predicate without bloating writes on active rows.
CREATE INDEX IF NOT EXISTS idx_fleet_sessions_host_endtime
  ON fleet_sessions (host_id, COALESCE(ended_at, started_at) DESC)
  WHERE status IN ('done','failed','cancelled');
