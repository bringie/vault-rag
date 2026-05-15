#!/usr/bin/env bash
# fleet-e2e: spawn daemon + hub locally, drive it through one full session.
# Requires: docker container fleet-test-pg on 127.0.0.1:55433 (or set FLEET_PG_PORT).
set -euo pipefail
trap 'echo FAIL line $LINENO >&2; kill 0 2>/dev/null; exit 1' ERR

cd "$(dirname "$0")/.."

PG_PORT="${FLEET_PG_PORT:-55433}"
PG_PASS="${FLEET_PG_PASS:-testpass}"
TOKEN="e2e-token-$$"
RAG_LOCAL_PORT=15679

# Reset DB
docker exec fleet-test-pg psql -U postgres -d vault_rag \
  -c "TRUNCATE fleet_hosts, fleet_sessions, fleet_events RESTART IDENTITY CASCADE" >/dev/null

# Start hub
RAG_PORT="$RAG_LOCAL_PORT" \
VAULT_RAG_API_TOKEN="$TOKEN" \
VAULT_RAG_PG_HOST=127.0.0.1 \
VAULT_RAG_PG_PORT="$PG_PORT" \
VAULT_RAG_PG_USER=postgres \
VAULT_RAG_PG_PASS="$PG_PASS" \
VAULT_PATH=/tmp \
  node scripts/rag-api.js > /tmp/fleet-e2e-rag.log 2>&1 &
RAG_PID=$!

# Wait for hub
for i in $(seq 1 30); do
  curl -fsSL "http://127.0.0.1:$RAG_LOCAL_PORT/api/fleet/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsSL "http://127.0.0.1:$RAG_LOCAL_PORT/api/fleet/healthz" | grep -q ok

# Start daemon
STATE=$(mktemp -d)
AGENT_FLEET_HUB="ws://127.0.0.1:$RAG_LOCAL_PORT/api/fleet/ws" \
AGENT_FLEET_TOKEN="$TOKEN" \
AGENT_FLEET_HOST_NAME=e2e-host \
AGENT_FLEET_CLAUDE_BIN="$(pwd)/tests/fleet/fake-claude.sh" \
  node agent-fleet/daemon/bin/daemon.js --state-dir "$STATE" > /tmp/fleet-e2e-daemon.log 2>&1 &
D_PID=$!

# Wait for host registration
HOST_ID=""
for i in $(seq 1 30); do
  hosts=$(curl -fsSL -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$RAG_LOCAL_PORT/api/fleet/hosts" || echo "[]")
  HOST_ID=$(echo "$hosts" | python3 -c 'import sys,json
d = json.load(sys.stdin)
e = [h for h in d if h["name"]=="e2e-host"]
print(e[0]["id"] if e else "")')
  if [ -n "$HOST_ID" ]; then break; fi
  sleep 0.5
done
[ -n "$HOST_ID" ] || { echo "host did not register" >&2; cat /tmp/fleet-e2e-daemon.log; false; }
echo "host registered: $HOST_ID"

# Spawn a print-mode session
SESS=$(curl -fsSL -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"host_id\":\"$HOST_ID\",\"cwd\":\"/tmp\",\"args\":[\"--print\",\"e2e-hello\"]}" \
  "http://127.0.0.1:$RAG_LOCAL_PORT/api/fleet/sessions")
SID=$(echo "$SESS" | python3 -c 'import sys,json; print(json.load(sys.stdin)["session_id"])')
echo "session: $SID"

# Wait for transcript to populate
TXT=""
for i in $(seq 1 30); do
  TXT=$(curl -fsSL -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$RAG_LOCAL_PORT/api/fleet/sessions/$SID/transcript.txt" || true)
  if echo "$TXT" | grep -q e2e-hello; then break; fi
  sleep 0.5
done
echo "transcript: $TXT"
echo "$TXT" | grep -q e2e-hello

# Cleanup
kill $D_PID 2>/dev/null || true
kill $RAG_PID 2>/dev/null || true
wait $D_PID 2>/dev/null || true
wait $RAG_PID 2>/dev/null || true
rm -rf "$STATE"
echo "fleet-e2e: OK"
