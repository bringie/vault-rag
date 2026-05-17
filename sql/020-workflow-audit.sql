-- vt-0198: workflow_audit. Workflows are RCE-capable (vm.runInContext)
-- and admin-gated; secret_audit (sql/017) covers secret ops, vault_audit
-- covers note writes — but workflow CRUD/run/cancel had ZERO forensic
-- trail. A brief admin compromise could insert a malicious workflow,
-- trigger it, then revert without anyone seeing how the host was reached.
--
-- Mirrors secret_audit shape so the upcoming Audit UI (vt-0196 deferred)
-- can render all three tables uniformly.

CREATE TABLE IF NOT EXISTS workflow_audit (
  id              bigserial   PRIMARY KEY,
  ts              timestamptz NOT NULL DEFAULT now(),
  op              text        NOT NULL,         -- 'create' | 'patch' | 'delete' | 'run' | 'cancel' | 'trigger'
  workflow_id     uuid,                          -- nullable for ops that don't carry one yet
  run_id          uuid,                          -- only for run/cancel
  caller_id       text,                          -- sha256(bearer)[:12]
  via             text,                          -- 'http' | 'webhook' | 'cron' | 'workflow_chain'
  outcome         text        NOT NULL DEFAULT 'ok',  -- 'ok' | 'denied' | 'error'
  definition_sha  text,                          -- sha256 of definition jsonb at write-time
  detail          jsonb       DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_workflow_audit_ts          ON workflow_audit (ts DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_audit_workflow_id ON workflow_audit (workflow_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_audit_outcome     ON workflow_audit (outcome) WHERE outcome <> 'ok';
