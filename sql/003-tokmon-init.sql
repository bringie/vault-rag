-- ============================================================================
-- tokmon DB schema for vault-rag-postgres (idempotent).
-- Adapted from /root/token-monitor/postgres/{00-roles.sh,01-schema.sql,02-mv.sql,02-grants.sql}
-- Differences:
--   - Roles renamed: parser -> tokmon_parser, grafana_ro -> tokmon_grafana
--   - DB renamed: tokens -> tokmon (created externally before \i this file)
--   - events.host_id TEXT NOT NULL DEFAULT 'localhost' added (multi-host federation)
--   - UNIQUE(source_file, source_offset) -> UNIQUE(host_id, source_file, source_offset)
--   - parser_offsets PK (host_id, file_path)
-- Apply: docker exec -i vault-rag-postgres psql -U postgres -d tokmon < this.sql
-- ============================================================================

-- Roles - psql vars :'parser_pass' / :'grafana_pass' substituted before parse
-- (DO blocks dollar-quote everything inside, so we use \gexec for substitution)
SELECT 'CREATE ROLE tokmon_parser LOGIN PASSWORD ' || quote_literal(:'parser_pass')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tokmon_parser')
\gexec
SELECT 'ALTER ROLE tokmon_parser PASSWORD ' || quote_literal(:'parser_pass')
 WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tokmon_parser')
\gexec
SELECT 'CREATE ROLE tokmon_grafana LOGIN PASSWORD ' || quote_literal(:'grafana_pass')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tokmon_grafana')
\gexec
SELECT 'ALTER ROLE tokmon_grafana PASSWORD ' || quote_literal(:'grafana_pass')
 WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tokmon_grafana')
\gexec

-- ====== events ==============================================================
CREATE TABLE IF NOT EXISTS events (
    id                BIGSERIAL PRIMARY KEY,
    host_id           TEXT NOT NULL DEFAULT 'localhost',
    message_uuid      TEXT UNIQUE NOT NULL,
    ts                TIMESTAMPTZ NOT NULL,
    session_id        TEXT NOT NULL,
    project_path      TEXT,
    model             TEXT NOT NULL,
    input_tokens      INT NOT NULL DEFAULT 0,
    output_tokens     INT NOT NULL DEFAULT 0,
    cache_creation_5m INT NOT NULL DEFAULT 0,
    cache_creation_1h INT NOT NULL DEFAULT 0,
    cache_read        INT NOT NULL DEFAULT 0,
    service_tier      TEXT,
    active_skill      TEXT,
    source_file       TEXT NOT NULL,
    source_offset     BIGINT NOT NULL,
    raw_hash          TEXT NOT NULL,
    raw               JSONB NOT NULL,
    UNIQUE (host_id, source_file, source_offset)
);
CREATE INDEX IF NOT EXISTS events_ts_idx           ON events (ts DESC);
CREATE INDEX IF NOT EXISTS events_session_idx      ON events (session_id);
CREATE INDEX IF NOT EXISTS events_active_skill_idx ON events (active_skill) WHERE active_skill IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_project_idx      ON events (project_path);
CREATE INDEX IF NOT EXISTS events_model_idx        ON events (model);
CREATE INDEX IF NOT EXISTS events_host_idx         ON events (host_id);

-- ====== tool_calls ==========================================================
CREATE TABLE IF NOT EXISTS tool_calls (
    id           BIGSERIAL PRIMARY KEY,
    event_id     BIGINT REFERENCES events(id) ON DELETE CASCADE,
    tool_use_id  TEXT UNIQUE,
    ts           TIMESTAMPTZ NOT NULL,
    session_id   TEXT NOT NULL,
    tool_name    TEXT NOT NULL,
    skill_arg    TEXT
);
CREATE INDEX IF NOT EXISTS tool_calls_tool_idx       ON tool_calls (tool_name);
CREATE INDEX IF NOT EXISTS tool_calls_ts_idx         ON tool_calls (ts DESC);
CREATE INDEX IF NOT EXISTS tool_calls_session_ts_idx ON tool_calls (session_id, ts DESC);
CREATE INDEX IF NOT EXISTS tool_calls_event_idx      ON tool_calls (event_id);

-- ====== parser_offsets (legacy local fallback; HTTP shipper uses local JSON) =
CREATE TABLE IF NOT EXISTS parser_offsets (
    host_id   TEXT NOT NULL DEFAULT 'localhost',
    file_path TEXT NOT NULL,
    last_byte BIGINT NOT NULL DEFAULT 0,
    last_run  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (host_id, file_path)
);

-- ====== parser_runs =========================================================
CREATE TABLE IF NOT EXISTS parser_runs (
    id                  BIGSERIAL PRIMARY KEY,
    host_id             TEXT NOT NULL DEFAULT 'localhost',
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at         TIMESTAMPTZ,
    status              TEXT NOT NULL,
    files_seen          INT NOT NULL DEFAULT 0,
    lines_read          BIGINT NOT NULL DEFAULT 0,
    events_inserted     BIGINT NOT NULL DEFAULT 0,
    tool_calls_inserted BIGINT NOT NULL DEFAULT 0,
    errors              JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS parser_runs_started_idx ON parser_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS parser_runs_host_idx    ON parser_runs (host_id);

-- ====== model_rates =========================================================
CREATE TABLE IF NOT EXISTS model_rates (
    model                   TEXT PRIMARY KEY,
    input_per_mtok          NUMERIC(10,4) NOT NULL,
    output_per_mtok         NUMERIC(10,4) NOT NULL,
    cache_read_per_mtok     NUMERIC(10,4) NOT NULL,
    cache_write_5m_per_mtok NUMERIC(10,4) NOT NULL,
    cache_write_1h_per_mtok NUMERIC(10,4) NOT NULL,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO model_rates (model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_5m_per_mtok, cache_write_1h_per_mtok)
VALUES
    ('claude-opus-4-7',              5.00, 25.00, 0.50, 6.25, 10.00),
    ('claude-sonnet-4-6',            3.00, 15.00, 0.30, 3.75,  6.00),
    ('claude-haiku-4-5-20251001',    1.00,  5.00, 0.10, 1.25,  2.00),
    ('<synthetic>',                  0.00,  0.00, 0.00, 0.00,  0.00)
ON CONFLICT (model) DO NOTHING;

-- ====== events_with_cost view ===============================================
CREATE OR REPLACE VIEW events_with_cost AS
SELECT
    e.*,
    (r.model IS NULL) AS missing_rate,
    (e.input_tokens      * COALESCE(r.input_per_mtok, 0)          / 1e6) +
    (e.output_tokens     * COALESCE(r.output_per_mtok, 0)         / 1e6) +
    (e.cache_read        * COALESCE(r.cache_read_per_mtok, 0)     / 1e6) +
    (e.cache_creation_5m * COALESCE(r.cache_write_5m_per_mtok, 0) / 1e6) +
    (e.cache_creation_1h * COALESCE(r.cache_write_1h_per_mtok, 0) / 1e6) AS cost_usd
FROM events e
LEFT JOIN model_rates r ON r.model = e.model;

-- ====== daily_costs MV ======================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_costs AS
SELECT
    date_trunc('day', ts AT TIME ZONE 'UTC')::date AS day,
    host_id,
    project_path,
    model,
    active_skill,
    COUNT(*)                  AS msgs,
    SUM(input_tokens)         AS input_tokens,
    SUM(output_tokens)        AS output_tokens,
    SUM(cache_read)           AS cache_read,
    SUM(cache_creation_5m)    AS cache_creation_5m,
    SUM(cache_creation_1h)    AS cache_creation_1h,
    SUM(cost_usd)             AS cost_usd
FROM events_with_cost
GROUP BY 1, 2, 3, 4, 5
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS daily_costs_uniq
    ON daily_costs (day, host_id, project_path, model, active_skill) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS daily_costs_day_idx     ON daily_costs (day DESC);
CREATE INDEX IF NOT EXISTS daily_costs_project_idx ON daily_costs (project_path);
CREATE INDEX IF NOT EXISTS daily_costs_model_idx   ON daily_costs (model);
CREATE INDEX IF NOT EXISTS daily_costs_host_idx    ON daily_costs (host_id);

-- ====== grants ==============================================================
GRANT CONNECT ON DATABASE tokmon TO tokmon_parser, tokmon_grafana;
GRANT USAGE ON SCHEMA public TO tokmon_parser, tokmon_grafana;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO tokmon_parser;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tokmon_parser;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO tokmon_grafana;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO tokmon_grafana;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO tokmon_parser;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO tokmon_parser;
