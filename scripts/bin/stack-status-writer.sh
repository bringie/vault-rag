#!/usr/bin/env bash
# vt-0115: host-side writer producing stack-status.json for the agent-fleet UI.
# Runs on the prod host (NOT inside any container) since it shells out to
# `docker inspect`. Writes to /opt/vault-rag/agent-fleet/stack-status.json
# so the rag-api container picks it up via the existing ./agent-fleet:ro
# volume mount.
#
# Wire as a systemd timer (.service + .timer 30s) or via cron @every-minute.

set -eu
OUT="${VAULT_RAG_STACK_STATUS_FILE:-/opt/vault-rag/agent-fleet/stack-status.json}"
NAMES=$(docker ps --filter "name=vault-rag-" --format '{{.Names}}' | sort)

services=()
for n in $NAMES; do
  info=$(docker inspect "$n" --format '{{.State.Status}}|{{or .State.Health.Status "none"}}|{{.State.StartedAt}}|{{.RestartCount}}' 2>/dev/null) || continue
  IFS='|' read -r status health started_at restarts <<< "$info"
  services+=("{\"name\":\"$n\",\"status\":\"$status\",\"health\":\"$health\",\"started_at\":\"$started_at\",\"restarts\":$restarts}")
done

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
joined=$(IFS=,; echo "${services[*]:-}")
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
printf '{"updated_at":"%s","services":[%s]}\n' "$ts" "$joined" > "$TMP"
mv "$TMP" "$OUT"
chmod 0644 "$OUT"
