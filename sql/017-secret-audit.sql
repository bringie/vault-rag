-- vt-0142: audit log for every secret operation.
--
-- Pre-existing vault_audit logs only WRITES to vault notes (path, op,
-- sha_before, sha_after). Secret READS were invisible. This table closes
-- that gap: every /api/secrets/* call (get|list|set|delete|rotate|verify)
-- inserts a row with caller fingerprint + outcome.
--
-- Lives in vault_rag DB (not the secrets container) per vt-0134 isolation —
-- rag-api owns the auth context (knows the bearer, hashes it for caller_id)
-- and the standalone secrets-server stays minimal.

CREATE TABLE IF NOT EXISTS secret_audit (
  id         bigserial   PRIMARY KEY,
  ts         timestamptz NOT NULL DEFAULT now(),
  op         text        NOT NULL,         -- 'get' | 'list' | 'set' | 'delete' | 'rotate' | 'verify'
  name       text,                          -- null for 'list'/'verify'
  caller_id  text,                          -- sha256(bearer)[:12] fingerprint
  via        text,                          -- 'http' | 'mcp' | 'cli' (free-form)
  outcome    text        NOT NULL DEFAULT 'ok'   -- 'ok' | 'denied' | 'error'
);

CREATE INDEX IF NOT EXISTS idx_secret_audit_ts      ON secret_audit (ts DESC);
CREATE INDEX IF NOT EXISTS idx_secret_audit_name_ts ON secret_audit (name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_secret_audit_outcome ON secret_audit (outcome) WHERE outcome <> 'ok';
