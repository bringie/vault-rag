#!/usr/bin/env bats

setup() {
  export TMPDIR_TEST=$(mktemp -d)
  cp -r /root/work/vault-rag-oss/{deploy.sh,.env.example,Caddyfile.tmpl,vault-skeleton} "$TMPDIR_TEST/"
  cd "$TMPDIR_TEST"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "deploy.sh exits non-zero if docker is missing" {
  PATH="/usr/bin:/bin" run env PATH="" /bin/bash deploy.sh --check-deps
  [ "$status" -ne 0 ]
  [[ "$output" == *"docker not found"* ]]
}

@test "deploy.sh creates .env from .env.example if missing" {
  run bash deploy.sh --bootstrap-env
  [ "$status" -eq 0 ]
  [ -f .env ]
  grep -q "^VAULT_RAG_DOMAIN=" .env
}

@test "deploy.sh generates random secret for change-me values" {
  run bash deploy.sh --bootstrap-env
  [ "$status" -eq 0 ]
  ! grep -q '=change-me$' .env
  grep -E '^VAULT_RAG_API_TOKEN=[a-f0-9]{64}$' .env
}

@test "deploy.sh copies vault-skeleton if obsidian-vault is empty" {
  run bash deploy.sh --bootstrap-vault
  [ "$status" -eq 0 ]
  [ -d obsidian-vault/00-inbox ]
  [ -f obsidian-vault/README.md ]
}

@test "deploy.sh skips vault bootstrap if obsidian-vault has files" {
  mkdir -p obsidian-vault/01-daily
  echo "# my note" > obsidian-vault/01-daily/note.md
  run bash deploy.sh --bootstrap-vault
  [ "$status" -eq 0 ]
  [ -f obsidian-vault/01-daily/note.md ]
  [ ! -d obsidian-vault/00-inbox ]
}

@test "deploy.sh renders Caddyfile from Caddyfile.tmpl" {
  printf 'VAULT_RAG_DOMAIN=test.example.com\nVAULT_RAG_ACME_EMAIL=ops@example.com\n' > .env
  run bash deploy.sh --render-caddy
  [ "$status" -eq 0 ]
  grep -q 'test.example.com' Caddyfile
  grep -q 'ops@example.com' Caddyfile
  ! grep -q '\${VAULT_RAG_DOMAIN}' Caddyfile
  ! grep -q '\${VAULT_RAG_ACME_EMAIL}' Caddyfile
}
