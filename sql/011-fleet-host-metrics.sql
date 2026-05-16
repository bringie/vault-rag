CREATE TABLE IF NOT EXISTS fleet_host_metrics (
  host_id        uuid NOT NULL REFERENCES fleet_hosts(id) ON DELETE CASCADE,
  ts             timestamptz NOT NULL DEFAULT now(),
  cpu_pct        real,
  ram_used_bytes bigint,
  ram_total_bytes bigint,
  disk           jsonb,
  net            jsonb,
  error          text
);

CREATE INDEX IF NOT EXISTS idx_fleet_host_metrics_host_ts
  ON fleet_host_metrics (host_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_fleet_host_metrics_ts_brin
  ON fleet_host_metrics USING brin (ts);

CREATE TABLE IF NOT EXISTS fleet_host_metrics_5m (
  host_id        uuid NOT NULL REFERENCES fleet_hosts(id) ON DELETE CASCADE,
  bucket         timestamptz NOT NULL,
  cpu_pct_avg    real,
  cpu_pct_max    real,
  ram_used_bytes bigint,
  PRIMARY KEY (host_id, bucket)
);

CREATE INDEX IF NOT EXISTS idx_fleet_host_metrics_5m_bucket
  ON fleet_host_metrics_5m (bucket DESC);
