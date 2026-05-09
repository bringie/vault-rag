#!/usr/bin/env bash
set -euo pipefail

# vault-rag idempotent installer.
# Sub-commands (for tests + ops):
#   --check-deps        verify required binaries are on PATH
#   --bootstrap-env     copy .env.example -> .env, fill change-me with random secrets
#   --bootstrap-vault   seed obsidian-vault/ from vault-skeleton/ if empty
#   --bootstrap-vault-git  init obsidian-vault/.git + push to VAULT_GIT_REMOTE (no-op if unset)
#   --render-caddy      envsubst Caddyfile.tmpl -> Caddyfile using .env
#   --install-scripts-deps  npm ci inside scripts/ (populates node_modules for bind mount)
# No flag = full install.

CMD="${1:-install}"

check_deps() {
  local missing=()
  for bin in docker openssl envsubst curl jq; do
    command -v "$bin" >/dev/null 2>&1 || missing+=("$bin")
  done
  docker compose version >/dev/null 2>&1 || missing+=("docker-compose-v2")
  if [ ${#missing[@]} -gt 0 ]; then
    for m in "${missing[@]}"; do echo "$m not found" >&2; done
    return 1
  fi
}

install_scripts_deps() {
  # scripts/ is bind-mounted into vault-rag-api / -mcp / -tokmon-ingest / -tools
  # as :ro, so node_modules must be pre-populated on the host.
  if [ ! -d scripts/node_modules ]; then
    docker run --rm -v "$(pwd)/scripts:/s" -w /s node:22-alpine npm ci --omit=dev
  fi
}

bootstrap_env() {
  if [ ! -f .env ]; then
    cp .env.example .env
  fi
  while grep -qE '=change-me$' .env; do
    secret=$(openssl rand -hex 32)
    awk -v s="$secret" 'BEGIN{done=0} /=change-me$/ && !done {sub("=change-me$","="s); done=1} {print}' .env > .env.tmp
    mv .env.tmp .env
  done
}

bootstrap_vault() {
  if [ ! -d obsidian-vault ] || [ -z "$(ls -A obsidian-vault 2>/dev/null)" ]; then
    cp -r vault-skeleton obsidian-vault
  fi
}

bootstrap_vault_git() {
  # Init vault as git repo + push to VAULT_GIT_REMOTE if set. No-op otherwise.
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  [ -n "${VAULT_GIT_REMOTE:-}" ] || return 0
  if [ ! -d obsidian-vault/.git ]; then
    git -C obsidian-vault init -q -b main
    git -C obsidian-vault config user.name  "vault-rag-api"
    git -C obsidian-vault config user.email "vault-rag-api@$(hostname)"
    git -C obsidian-vault remote add origin "$VAULT_GIT_REMOTE" 2>/dev/null || \
      git -C obsidian-vault remote set-url origin "$VAULT_GIT_REMOTE"
    git -C obsidian-vault add -A
    git -C obsidian-vault diff --cached --quiet || \
      git -C obsidian-vault commit -q -m "initial vault skeleton"
    git -C obsidian-vault push -u origin main 2>/dev/null || true
  fi
}

render_caddy() {
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  # shellcheck disable=SC2016
  envsubst '${VAULT_RAG_DOMAIN} ${VAULT_RAG_ACME_EMAIL}' < Caddyfile.tmpl > Caddyfile
}

install_full() {
  check_deps
  bootstrap_env
  bootstrap_vault
  bootstrap_vault_git
  install_scripts_deps
  render_caddy
  docker compose -p vault-rag up -d --build
  echo "Waiting for /api/healthz..."
  for i in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:5679/api/healthz >/dev/null 2>&1; then
      echo "API healthy after ${i}s"
      break
    fi
    sleep 1
  done
  docker exec vault-rag-tools node /scripts/vault-indexer.js || true
  echo ""
  echo "================================================="
  # shellcheck disable=SC1091
  source .env
  echo "  vault-rag deployed."
  echo "  Domain:           https://${VAULT_RAG_DOMAIN}"
  echo "  API token:        ${VAULT_RAG_API_TOKEN}"
  echo "  Grafana admin:    ${VAULT_RAG_GRAFANA_ADMIN_PASS}"
  echo "================================================="
}

case "$CMD" in
  --check-deps) check_deps ;;
  --bootstrap-env) bootstrap_env ;;
  --bootstrap-vault) bootstrap_vault ;;
  --bootstrap-vault-git) bootstrap_vault_git ;;
  --render-caddy) render_caddy ;;
  --install-scripts-deps) install_scripts_deps ;;
  install) install_full ;;
  *) echo "unknown command: $CMD" >&2; exit 2 ;;
esac
