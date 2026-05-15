CREATE TABLE IF NOT EXISTS fleet_model_prices (
  id                    bigserial PRIMARY KEY,
  match_pattern         text NOT NULL,
  priority              int NOT NULL DEFAULT 100,
  valid_from            timestamptz NOT NULL DEFAULT now(),
  input_per_mtok        numeric(10,4) NOT NULL,
  output_per_mtok       numeric(10,4) NOT NULL,
  cache_create_per_mtok numeric(10,4) NOT NULL DEFAULT 0,
  cache_read_per_mtok   numeric(10,4) NOT NULL DEFAULT 0,
  flagged               boolean NOT NULL DEFAULT false,
  note                  text,
  deleted_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fleet_model_prices_priority
  ON fleet_model_prices (priority DESC, valid_from DESC)
  WHERE deleted_at IS NULL;

-- Idempotent seed: skip if any seed row already exists (re-runs are safe).
INSERT INTO fleet_model_prices
  (match_pattern, priority, valid_from, input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok, note)
SELECT * FROM (VALUES
  ('claude-opus-%',   200, '1970-01-01'::timestamptz, 15.0000, 75.0000, 18.7500, 1.5000, 'seed: opus family'),
  ('claude-sonnet-%', 200, '1970-01-01'::timestamptz,  3.0000, 15.0000,  3.7500, 0.3000, 'seed: sonnet family'),
  ('claude-haiku-%',  200, '1970-01-01'::timestamptz,  1.0000,  5.0000,  1.2500, 0.1000, 'seed: haiku family'),
  ('%',                 0, '1970-01-01'::timestamptz,  0.0000,  0.0000,  0.0000, 0.0000, 'fallback (unpriced)')
) AS v(match_pattern, priority, valid_from, input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok, note)
WHERE NOT EXISTS (
  SELECT 1 FROM fleet_model_prices
  WHERE match_pattern = v.match_pattern
    AND priority = v.priority
    AND valid_from = v.valid_from
    AND deleted_at IS NULL
);

-- Mark the fallback row as flagged so UI can highlight unpriced events.
UPDATE fleet_model_prices SET flagged = true WHERE match_pattern = '%' AND priority = 0 AND flagged = false;
