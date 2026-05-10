-- sql/004-inbox-classifier-state.sql
-- Per-file state for the inbox auto-classifier.

CREATE TABLE IF NOT EXISTS inbox_classifier_state (
  path           text PRIMARY KEY,
  sha            text NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending','processing','done','deadletter')),
  attempts       int  NOT NULL DEFAULT 0,
  last_error     text,
  classified_at  timestamptz,
  started_at     timestamptz,
  target_folder  text,
  confidence     real,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbox_classifier_state_status_idx
  ON inbox_classifier_state (status);
