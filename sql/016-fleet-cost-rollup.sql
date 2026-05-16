-- vt-0114: per-day aggregated cost view, kept beyond tokmon.events retention.
-- Events get pruned at VAULT_RAG_TOKMON_RETAIN_DAYS (default 90); this rollup
-- keeps the daily roll-up indefinitely so /fleet/cost can still render
-- 365-day windows. Drill-down to per-session detail remains tied to the
-- 90-day events retention.

CREATE TABLE IF NOT EXISTS fleet_cost_daily_rollup (
  day               date NOT NULL,
  dim               text NOT NULL,                 -- 'model' | 'host'
  value             text NOT NULL,
  usd               numeric(14, 6) NOT NULL DEFAULT 0,
  msgs              integer NOT NULL DEFAULT 0,
  input_tokens      bigint  NOT NULL DEFAULT 0,
  output_tokens     bigint  NOT NULL DEFAULT 0,
  cache_creation_5m bigint  NOT NULL DEFAULT 0,
  cache_read        bigint  NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, dim, value)
);

CREATE INDEX IF NOT EXISTS idx_fleet_cost_daily_rollup_day_dim
  ON fleet_cost_daily_rollup(day, dim);
