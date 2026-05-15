#!/bin/bash
# One-time migration of existing client secrets into vault-rag secrets store.
#
# Pre-req:
#   - VAULT_RAG_API_URL + VAULT_RAG_API_TOKEN exported
#   - vt CLI on PATH (or set VT_BIN to /path/to/vt)
#   - server-side bootstrap already done

set -euo pipefail
VT=${VT_BIN:-vt}

push() {
  local name=$1 value=$2
  if [ -z "$value" ]; then
    echo "  skip $name (empty)"
    return
  fi
  echo "  set $name (${#value} bytes)"
  $VT secrets set "$name" "$value" >/dev/null
}

push_file() {
  local name=$1 path=$2
  if [ ! -f "$path" ]; then
    echo "  skip $name (no file $path)"
    return
  fi
  push "$name" "$(cat "$path")"
}

push_env() {
  local name=$1 envfile=$2
  if [ ! -f "$envfile" ]; then
    echo "  skip $name (no file $envfile)"
    return
  fi
  push "$name" "$(grep -v '^\s*#' "$envfile" | grep -v '^\s*$' || true)"
}

echo "=== env vars ==="
push ANTHROPIC_API_KEY    "${ANTHROPIC_API_KEY:-}"
push GITLAB_TOKEN         "${GITLAB_TOKEN:-}"
push JIRA_TOKEN           "${JIRA_TOKEN:-}"
push GRAFANA_TOKEN        "${GRAFANA_TOKEN:-}"
push YANDEX_APP_PASSWORD  "${YANDEX_APP_PASSWORD:-}"
push DEV_VAULT_TOKEN      "${DEV_VAULT_TOKEN:-}"

echo "=== files ==="
push_file GH_PAT             "$HOME/.gh-token"
push_file GIT_CREDENTIALS    "$HOME/.git-credentials"
push_file CLAUDE_CREDS_JSON  "$HOME/.claude/.credentials.json"

echo "=== project .env blobs ==="
push_env tarot_env           "$HOME/tarot/.env"
push_env renaper_bot_env     "$HOME/renaper-bot/.env"
push_env token_monitor_env   "$HOME/token-monitor/.env"
push_env shop_env            "$HOME/shop/.env"
push_env hermes_env          "$HOME/.hermes/.env"
push_env yc_1c_state_env     "$HOME/yc-1c-infra/state.env"

echo ""
echo "Migration complete. Verify with: vt secrets list && vt secrets verify"
echo ""
echo "After verifying — manually remove plaintext sources:"
echo "  - bashrc/zshrc 'export XXX=...' lines"
echo "  - \$HOME/.gh-token \$HOME/.git-credentials \$HOME/.claude/.credentials.json"
echo "  - project .env files (or replace with 'vt secrets get <name>_env > .env' on startup)"
