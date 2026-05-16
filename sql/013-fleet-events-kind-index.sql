-- Compound index for transcript queries that filter by kind (lifecycle vs pty_out)
-- and for purgeOldEvents kind-IN scans. Existing (session_id, seq) covers session
-- lookups but kind is a post-filter — for high-volume sessions, scanning all rows
-- of a session to find rare 'lifecycle' frames is wasteful.

CREATE INDEX IF NOT EXISTS fleet_events_session_kind_seq
  ON fleet_events(session_id, kind, seq);
