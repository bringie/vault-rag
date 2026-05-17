-- vt-0311: feature flags. Server-side toggle for major subsystems.
-- Personal/team operator can disable modules they don't use to reduce
-- attack surface and UI clutter. Flags apply BOTH to UI gating (hide
-- nav, disable forms) and to daemons (skip collectors, skip module
-- WS handlers — see vt-0313).
--
-- Why a table vs env: env requires container restart per flip; DB row
-- changes via `vt features set NAME enabled` and SPA polls every 60s
-- to pick up the new mask. Default is "all enabled" — no migration
-- shock for existing deployments.

CREATE TABLE IF NOT EXISTS fleet_features (
  name         text PRIMARY KEY,
  enabled      boolean NOT NULL DEFAULT true,
  description  text DEFAULT '',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text         -- caller_id hash, for audit
);

-- Seed the canonical feature set. Operator can INSERT new rows for
-- experimental modules; the SPA renders unknown features under
-- "experimental" so they're not invisible.
INSERT INTO fleet_features (name, enabled, description) VALUES
  ('vault_rag',      true,  'Vault RAG: /api/search, /api/get, /api/put, notes browser, graph view'),
  ('secrets',        true,  'Age-encrypted secrets store (vault-rag-secrets container + /api/secrets/*)'),
  ('fleet',          true,  'Fleet hosts + sessions + WS terminals'),
  ('workflows',      true,  'Workflow editor + runner (RCE-capable surface)'),
  ('agent_roles',    true,  'Reusable prompt personas attached to groups'),
  ('tokmon',         true,  'Token-usage ingest + cost dashboards'),
  ('grafana',        true,  'Embedded Grafana at /grafana/'),
  ('forgejo',        true,  'Self-hosted git (Forgejo) at /git/'),
  ('graph_view',     true,  'Note graph visualisation (force-directed layout from backlinks)'),
  ('audit',          true,  'Unified audit feed (/audit) — read-only')
ON CONFLICT (name) DO NOTHING;
