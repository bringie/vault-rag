#!/usr/bin/env bash
set -euo pipefail
# Post-deploy smoke. Reads .env from cwd.
# shellcheck disable=SC1091
source .env

fail=0
say() { printf '%-30s %s\n' "$1" "$2"; }

code=$(curl -sS -o /dev/null -w '%{http_code}' "https://${VAULT_RAG_DOMAIN}/api/healthz" || echo 000)
if [ "$code" = "200" ]; then
  say "/api/healthz" "OK ($code)"
else
  say "/api/healthz" "FAIL ($code)"
  fail=1
fi

if curl -sS -H "X-Vault-Token: ${VAULT_RAG_API_TOKEN}" \
     "https://${VAULT_RAG_DOMAIN}/api/search?query=hello" \
     | jq -e 'type=="array" or type=="object"' >/dev/null; then
  say "/api/search" "OK"
else
  say "/api/search" "FAIL"
  fail=1
fi

gcode=$(curl -sS -o /dev/null -w '%{http_code}' "https://${VAULT_RAG_DOMAIN}/grafana/api/health" || echo 000)
if [ "$gcode" = "200" ]; then
  say "/grafana/api/health" "OK"
else
  say "/grafana/api/health" "FAIL ($gcode)"
  fail=1
fi

runs=$(docker exec vault-rag-postgres psql -U postgres -d vault_rag -t -c \
       "SELECT COUNT(*) FROM job_runs WHERE status='ok'" 2>/dev/null | tr -d ' \n' || echo 0)
if [ "${runs:-0}" -gt 0 ]; then
  say "job_runs ok" "OK ($runs)"
else
  say "job_runs ok" "FAIL ($runs)"
  fail=1
fi

healthy=$(docker ps --filter "name=vault-rag-" --format '{{.Status}}' | grep -c healthy || true)
if [ "$healthy" -ge 14 ]; then
  say "containers healthy" "OK ($healthy/14)"
else
  say "containers healthy" "FAIL ($healthy/14)"
  fail=1
fi

exit $fail
