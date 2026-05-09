#!/usr/bin/env bash
# Starts test rag-api on free port. Sets RAG_PID, RAG_PORT, VT_VAULT.
set -euo pipefail
VT_VAULT=$(mktemp -d)
mkdir -p "$VT_VAULT/06-tasks" "$VT_VAULT/.vt" "$VT_VAULT/09-resources/notes"
RAG_PORT=$((10000 + RANDOM % 50000))
VAULT_PATH="$VT_VAULT" VAULT_RAG_API_TOKEN=test PORT=$RAG_PORT \
  node /root/work/vault-rag-oss/.claude/worktrees/feat-vt-rest-mcp/scripts/rag-api.js \
  >/tmp/rag-api-$$.log 2>&1 &
RAG_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -s -o /dev/null "http://127.0.0.1:$RAG_PORT/healthz"; then break; fi
  sleep 0.2
done
export RAG_PID RAG_PORT VT_VAULT
