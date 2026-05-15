#!/bin/bash
# End-to-end smoke: bootstrap → rag-api → mcp-shim → vt CLI on a single tmpdir.
# Requires age + node installed. No PG, no docker.

set -euo pipefail
TMP=$(mktemp -d)
trap "kill %1 %2 2>/dev/null || true; rm -rf $TMP" EXIT

cd "$TMP"
git init --bare -b master origin.git -q
git clone -q origin.git clone 2>/dev/null
(cd clone && git config user.email t@t && git config user.name t)

# Bootstrap
mkdir -p secrets_dir
bash /root/work/vault-rag-oss/scripts/secrets-bootstrap.sh "$TMP/clone" "$TMP/secrets_dir"
(cd clone && git add . && git commit -q -m init && git push -q origin HEAD:master)

# Start rag-api
PORT_API=$((5800 + RANDOM % 100))
VAULT_RAG_API_TOKEN=T VAULT_AGE_KEY_PATH="$TMP/secrets_dir/age.key" \
  VAULT_REPO_PATH="$TMP/clone" \
  VAULT_AGE_PATH="$TMP/clone/obsidian-vault/secrets/vault.age" \
  VAULT_RECIPIENTS_PATH="$TMP/clone/obsidian-vault/secrets/recipients" \
  VAULT_SECRETS_SKIP_PG=1 RAG_PORT=$PORT_API \
  node /root/work/vault-rag-oss/scripts/rag-api.js >"$TMP/api.log" 2>&1 &
sleep 1

# Start MCP shim
PORT_MCP=$((5900 + RANDOM % 100))
VAULT_RAG_MCP_TOKEN=Tmcp VAULT_RAG_API_TOKEN=T \
  RAG_API_URL="http://127.0.0.1:$PORT_API" MCP_PORT=$PORT_MCP \
  node /root/work/vault-rag-oss/scripts/mcp-shim.js >"$TMP/mcp.log" 2>&1 &
sleep 1

# Test via vt CLI
export VAULT_RAG_API_URL="http://127.0.0.1:$PORT_API"
export VAULT_RAG_API_TOKEN=T
VT=/root/work/vault-rag-oss/scripts/vt.js

echo "--- vt secrets list (empty) ---"
node "$VT" secrets list

echo "--- vt secrets set MY_TOKEN ---"
node "$VT" secrets set MY_TOKEN "secret-value-123"

echo "--- vt secrets get MY_TOKEN ---"
RESULT=$(node "$VT" secrets get MY_TOKEN)
test "$RESULT" = "secret-value-123" || { echo "FAIL: got '$RESULT'"; exit 1; }

echo "--- vt secrets list (should show MY_TOKEN) ---"
node "$VT" secrets list | grep -q '^MY_TOKEN$' || { echo "FAIL: not in list"; exit 1; }

echo "--- vt secrets verify ---"
node "$VT" secrets verify

# Test via MCP shim — tools/list contains secret_*
echo "--- MCP tools/list contains secret_* ---"
curl -sS -X POST -H "x-vault-token: Tmcp" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "http://127.0.0.1:$PORT_MCP/mcp" \
  | python3 -c "
import sys,json
t = json.load(sys.stdin)['result']['tools']
need = ['secret_get','secret_set','secret_list','secret_delete','secret_rotate','secret_verify']
names = [x['name'] for x in t]
missing = [n for n in need if n not in names]
assert not missing, f'missing tools: {missing} (have {names})'
print('OK')
"

# Test via MCP shim — actually call secret_get
echo "--- MCP secret_get returns value ---"
curl -sS -X POST -H "x-vault-token: Tmcp" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"secret_get","arguments":{"name":"MY_TOKEN"}}}' \
  "http://127.0.0.1:$PORT_MCP/mcp" \
  | python3 -c "
import sys,json
r = json.load(sys.stdin)
txt = r['result']['content'][0]['text']
data = json.loads(txt)
assert data['value'] == 'secret-value-123', f'wrong value: {data}'
print('OK')
"

echo "--- E2E SMOKE OK ---"
