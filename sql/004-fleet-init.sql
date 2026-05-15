-- sql/004-fleet-init.sql
-- agent-fleet schema: hosts, sessions, events (append-only).
-- Apply: docker exec -i vault-rag-postgres psql -U postgres -d vault_rag < sql/004-fleet-init.sql

CREATE TABLE IF NOT EXISTS fleet_hosts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text UNIQUE NOT NULL,
  os             text,
  arch           text,
  capabilities   text[] DEFAULT '{}',
  status         text NOT NULL DEFAULT 'offline'
                   CHECK (status IN ('online','offline')),
  daemon_version text,
  claude_version text,
  registered_at  timestamptz NOT NULL DEFAULT now(),
  last_seen      timestamptz,
  metadata       jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS fleet_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id     uuid NOT NULL REFERENCES fleet_hosts(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','orphaned','exited','killed')),
  cwd         text NOT NULL,
  args        jsonb DEFAULT '[]'::jsonb,
  env         jsonb DEFAULT '{}'::jsonb,
  pid         integer,
  exit_code   integer,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  created_by  text,
  label       text,
  metadata    jsonb DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS fleet_sessions_host_status ON fleet_sessions(host_id, status);
CREATE INDEX IF NOT EXISTS fleet_sessions_started ON fleet_sessions(started_at DESC);

CREATE TABLE IF NOT EXISTS fleet_events (
  id         bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES fleet_sessions(id) ON DELETE CASCADE,
  ts         timestamptz NOT NULL DEFAULT now(),
  kind       text NOT NULL
               CHECK (kind IN ('pty_out','pty_in','lifecycle','meta')),
  seq        bigint NOT NULL,
  payload    bytea,
  size       integer GENERATED ALWAYS AS (length(payload)) STORED
);
CREATE INDEX IF NOT EXISTS fleet_events_session_seq ON fleet_events(session_id, seq);
CREATE INDEX IF NOT EXISTS fleet_events_ts ON fleet_events(ts);
