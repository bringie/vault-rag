#!/bin/bash
# One-time bootstrap of secrets vault on the vault-rag server.
#
# Usage: secrets-bootstrap.sh <repo-path> <secrets-dir>
#   repo-path:   path to vault-rag git checkout (e.g. /opt/vault-rag)
#   secrets-dir: where to store private age key (e.g. /opt/vault-rag/.secrets)
#
# Idempotent on second run: if secrets/ already exists with vault.age, aborts.

set -euo pipefail
REPO=${1:?repo path required}
SECRETS_DIR=${2:?secrets dir required}

if [ -d "$REPO/obsidian-vault/secrets" ] && [ -f "$REPO/obsidian-vault/secrets/vault.age" ]; then
  echo "ERROR: $REPO/obsidian-vault/secrets/vault.age already exists; bootstrap aborted" >&2
  echo "       (delete it manually if you really want to re-init)" >&2
  exit 1
fi

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

# Generate age keypair
age-keygen -o "$SECRETS_DIR/age.key" 2>/dev/null
chmod 600 "$SECRETS_DIR/age.key"
PUB=$(grep '^# public key:' "$SECRETS_DIR/age.key" | cut -d: -f2 | tr -d ' ')

# Create vault structure
mkdir -p "$REPO/obsidian-vault/secrets"

cat > "$REPO/obsidian-vault/secrets/.gitignore" <<'GI'
# Never commit plain-text secrets accidentally.
*.json
*.plain
*.env
vault.txt
age.key
GI

cat > "$REPO/obsidian-vault/secrets/recipients" <<RC
# host: vault-rag server
$PUB
RC

cat > "$REPO/obsidian-vault/secrets/README.md" <<'MD'
# Secrets vault

Server-side age-encrypted secret storage. Plain-text access through:

- MCP tools: `mcp__vault-rag__secret_get` / `_set` / `_list` / `_delete` / `_rotate` / `_verify`
- REST: `POST /api/secrets/<verb>` with `Authorization: Bearer $VAULT_RAG_API_TOKEN`
- CLI: `vt secrets {get,list,set,delete,rotate,verify,export-env}`

See `docs/superpowers/specs/2026-05-14-secrets-vault-design.md` for design.

**DO NOT** commit plain-text secrets into this directory. `.gitignore` blocks
common patterns but is not exhaustive.
MD

# Initial empty vault.age
TMP=$(mktemp -d)
echo '{"_meta":{"schema":1,"version":1,"rotated_at":{}}}' > "$TMP/init.json"
age -R "$REPO/obsidian-vault/secrets/recipients" -o "$REPO/obsidian-vault/secrets/vault.age" "$TMP/init.json"
shred -u "$TMP/init.json" 2>/dev/null || rm -P "$TMP/init.json" 2>/dev/null || rm "$TMP/init.json"
rmdir "$TMP"

echo "bootstrap OK"
echo "  age.key:        $SECRETS_DIR/age.key (BACKUP THIS!)"
echo "  recipients:     $REPO/obsidian-vault/secrets/recipients"
echo "  vault.age:      $REPO/obsidian-vault/secrets/vault.age"
echo ""
echo "Next: cd $REPO && git add obsidian-vault/secrets/ && git commit -m 'secrets: init' && git push"
