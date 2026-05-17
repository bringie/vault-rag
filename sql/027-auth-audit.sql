-- vt-0280: audit trail for auth-events. Currently only mutating ops are
-- audited (vault_audit / secret_audit / workflow_audit) — granting a
-- WS ticket is a "soft mutation" (gives the bearer a new capability)
-- and currently invisible. Add per-grant rows so the operator can
-- trace "who got workflow_viewer access at 03:14" during incident review.

CREATE TABLE IF NOT EXISTS auth_audit (
  id         bigserial PRIMARY KEY,
  ts         timestamptz NOT NULL DEFAULT now(),
  op         text NOT NULL,          -- e.g. 'ws_ticket_grant', 'ws_ticket_deny'
  role       text,                   -- requested role (viewer | workflow_viewer | metrics_viewer)
  caller_id  text,                   -- hash of bearer (matches other audit tables)
  caller_ip  text,                   -- best-effort
  user_agent text,
  outcome    text NOT NULL DEFAULT 'ok',  -- ok | denied | error
  detail     jsonb
);
CREATE INDEX IF NOT EXISTS idx_auth_audit_ts  ON auth_audit (ts DESC);
CREATE INDEX IF NOT EXISTS idx_auth_audit_op  ON auth_audit (op, ts DESC);
