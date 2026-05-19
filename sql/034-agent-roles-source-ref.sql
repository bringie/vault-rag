-- vt-0442 / vt-0431 epic: track external-catalog provenance for agent roles.
-- The 2.5 MB sql/033 inline seed has no way to map a DB row back to the
-- upstream agency-agents file once it lands. This column stores the
-- "<repo>@<sha>:<path>" reference so a future sync script can compare
-- and apply incremental updates without re-running the whole seed.
--
-- NULL = manually-created role (no external source) — that's the
-- default for the 4 seed roles in sql/025 and any operator-authored
-- entries. Idempotent ALTER.

ALTER TABLE fleet_agent_roles
  ADD COLUMN IF NOT EXISTS source_ref text;

CREATE INDEX IF NOT EXISTS idx_fleet_agent_roles_source_ref
  ON fleet_agent_roles (source_ref)
  WHERE source_ref IS NOT NULL AND deleted_at IS NULL;

-- Backfill: the 185 rows from sql/033 all came from a single import.
-- We don't know per-row filenames in the DB without re-running the
-- importer, but we can tag the COMMIT as the canonical origin. The
-- next sync script can replace these with per-file refs.
UPDATE fleet_agent_roles
   SET source_ref = 'msitarzewski/agency-agents@783f6a72:bulk-seed'
 WHERE source_ref IS NULL
   AND category IN ('academic','design','engineering','finance','game-development',
                    'integrations','marketing','paid-media','product','project-management',
                    'sales','spatial-computing','specialized','support','testing')
   AND deleted_at IS NULL;
