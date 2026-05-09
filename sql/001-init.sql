-- vault-rag schema. Idempotent.
-- Apply: docker exec -i vault-rag-postgres psql -U postgres -d vault_rag < 001-init.sql
-- Embedding dim = 768 (Ollama nomic-embed-text).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS chunks (
  path  TEXT        NOT NULL,
  idx   INT         NOT NULL,
  text  TEXT        NOT NULL,
  emb   vector(768) NOT NULL,
  tags  TEXT[]      DEFAULT '{}',
  fm    JSONB       DEFAULT '{}'::jsonb,
  mtime TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (path, idx)
);

CREATE INDEX IF NOT EXISTS chunks_emb_hnsw
  ON chunks USING hnsw (emb vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS chunks_tags_gin ON chunks USING gin (tags);
CREATE INDEX IF NOT EXISTS chunks_fm_gin   ON chunks USING gin (fm);
CREATE INDEX IF NOT EXISTS chunks_mtime    ON chunks (mtime DESC);

CREATE TABLE IF NOT EXISTS backlinks (
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  PRIMARY KEY (source, target)
);
CREATE INDEX IF NOT EXISTS backlinks_target ON backlinks (target);

CREATE TABLE IF NOT EXISTS meta (
  k          TEXT        PRIMARY KEY,
  v          TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO meta (k, v) VALUES ('last_indexed_sha', '')
ON CONFLICT (k) DO NOTHING;

CREATE TABLE IF NOT EXISTS ingest_log (
  id     BIGSERIAL   PRIMARY KEY,
  source TEXT        NOT NULL,
  ref    TEXT,
  path   TEXT,
  status TEXT        NOT NULL,
  error  TEXT,
  ts     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingest_log_ts ON ingest_log (ts DESC);

CREATE TABLE IF NOT EXISTS jobs (
  name        TEXT        PRIMARY KEY,
  schedule    TEXT        NOT NULL,
  description TEXT,
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_runs (
  id          BIGSERIAL   PRIMARY KEY,
  job_name    TEXT        NOT NULL,
  status      TEXT        NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms BIGINT,
  exit_code   INT,
  summary     TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS job_runs_started      ON job_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS job_runs_name_started ON job_runs (job_name, started_at DESC);

CREATE TABLE IF NOT EXISTS vault_audit (
  id         BIGSERIAL   PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent_id   TEXT,
  path       TEXT        NOT NULL,
  op         TEXT        NOT NULL,
  sha_before TEXT,
  sha_after  TEXT,
  bytes      INT
);
CREATE INDEX IF NOT EXISTS vault_audit_ts   ON vault_audit (ts DESC);
CREATE INDEX IF NOT EXISTS vault_audit_path ON vault_audit (path);

INSERT INTO jobs (name, schedule, description) VALUES
  ('vault-indexer',       '*/5 * * * *', 'Scan obsidian-vault, embed changed .md files, upsert chunks/backlinks'),
  ('watchdog-stuck-jobs', '*/5 * * * *', 'Mark job_runs.status=err for runs stuck in running >30m'),
  ('cleanup-vault-audit', '0 3 * * 0',   'Prune vault_audit rows older than 90 days')
ON CONFLICT (name) DO UPDATE
  SET schedule = EXCLUDED.schedule,
      description = EXCLUDED.description;
