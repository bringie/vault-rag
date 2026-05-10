#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
export VAULT_PATH="$TMP"
mkdir -p "$VAULT_PATH/00-inbox" \
         "$VAULT_PATH/01-knowledge" \
         "$VAULT_PATH/02-projects" \
         "$VAULT_PATH/05-logs" \
         "$VAULT_PATH/06-resources"

export CLAUDE_BIN="$ROOT/scripts/test/integration/fake-claude.sh"
export PROM_TEXTFILE_DIR="$TMP/prom"

: "${VAULT_RAG_PG_HOST:=127.0.0.1}"
: "${VAULT_RAG_PG_PORT:=5432}"
: "${VAULT_RAG_PG_DB:=vault_rag}"
: "${VAULT_RAG_PG_USER:=postgres}"
: "${VAULT_RAG_PG_PASS:=postgres}"
export VAULT_RAG_PG_HOST VAULT_RAG_PG_PORT VAULT_RAG_PG_DB VAULT_RAG_PG_USER VAULT_RAG_PG_PASS

PGPASSWORD="$VAULT_RAG_PG_PASS" psql -h "$VAULT_RAG_PG_HOST" -p "$VAULT_RAG_PG_PORT" \
  -U "$VAULT_RAG_PG_USER" -d "$VAULT_RAG_PG_DB" -v ON_ERROR_STOP=1 \
  -f "$ROOT/sql/004-inbox-classifier-state.sql" >/dev/null

PGPASSWORD="$VAULT_RAG_PG_PASS" psql -h "$VAULT_RAG_PG_HOST" -p "$VAULT_RAG_PG_PORT" \
  -U "$VAULT_RAG_PG_USER" -d "$VAULT_RAG_PG_DB" -v ON_ERROR_STOP=1 \
  -c "DELETE FROM inbox_classifier_state WHERE path LIKE '00-inbox/it-%'" >/dev/null

cat > "$VAULT_PATH/00-inbox/it-valid.md" <<'MD'
# Valid note
Body of a perfectly classifiable note.
MD

cat > "$VAULT_PATH/00-inbox/current-context.md" <<'MD'
---
type: index
---
# Index file
MD

cat > "$VAULT_PATH/00-inbox/it-low.md" <<'MD'
# Ambiguous
short
MD

node "$ROOT/scripts/inbox-classifier.js"

FAKE_CLAUDE_MODE=low_conf node "$ROOT/scripts/inbox-classifier.js"

test -f "$VAULT_PATH/01-knowledge/it-valid.md" || { echo FAIL: it-valid not moved; exit 1; }
test -f "$VAULT_PATH/00-inbox/current-context.md" || { echo FAIL: current-context.md was moved; exit 1; }
test -f "$VAULT_PATH/00-inbox/_deadletter/it-low.md" || { echo FAIL: it-low not in deadletter; exit 1; }

grep -q 'classified_by: haiku/inbox-classifier-v1' "$VAULT_PATH/01-knowledge/it-valid.md" \
  || { echo FAIL: frontmatter not enriched; exit 1; }

PGPASSWORD="$VAULT_RAG_PG_PASS" psql -h "$VAULT_RAG_PG_HOST" -p "$VAULT_RAG_PG_PORT" \
  -U "$VAULT_RAG_PG_USER" -d "$VAULT_RAG_PG_DB" -tAc \
  "SELECT count(*) FROM vault_audit WHERE op='classify' AND path='01-knowledge/it-valid.md'" \
  | grep -q '^[1-9]' || { echo FAIL: audit row missing; exit 1; }

echo OK
