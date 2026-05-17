-- vt-0207: perf indices for hot paths surfaced by the DB review.

-- GIN on fleet_hosts.capabilities — listHostsByEffectiveTag does
-- $1 = ANY(capabilities) + LEFT JOIN with group labels (already GIN'd by
-- sql/009). Without GIN on the host side, the join falls back to seq-scan
-- on every dispatch + broadcast.
CREATE INDEX IF NOT EXISTS idx_fleet_hosts_capabilities_gin
  ON fleet_hosts USING gin (capabilities);

-- Partial index on fleet_sessions: the common UI query is "running" +
-- "pending" sessions ordered by started_at DESC. The existing
-- (host_id, status) index doesn't help "show me everything currently live".
CREATE INDEX IF NOT EXISTS idx_fleet_sessions_active
  ON fleet_sessions (status, started_at DESC)
  WHERE status IN ('pending', 'running');

-- fleet_host_metrics had no PK. A flapping daemon (reconnecting every 5s
-- and replaying its metrics buffer) could insert dupes. PK on (host_id, ts)
-- enforces idempotency. Use ALTER TABLE ... ADD PRIMARY KEY (idempotent
-- via DO block — Postgres lacks IF NOT EXISTS on ADD CONSTRAINT).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'fleet_host_metrics'
      AND indexname = 'fleet_host_metrics_pkey'
  ) THEN
    -- Drop any duplicate rows (host_id, ts) before adding the constraint.
    -- Keep one row per (host_id, ts) by ctid (arbitrary but deterministic).
    DELETE FROM fleet_host_metrics a
     USING fleet_host_metrics b
     WHERE a.ctid < b.ctid
       AND a.host_id = b.host_id
       AND a.ts = b.ts;
    ALTER TABLE fleet_host_metrics ADD PRIMARY KEY (host_id, ts);
  END IF;
END$$;
