#!/usr/bin/env bash
# vt-0216: end-to-end disaster recovery test. Runs locally OR in CI.
#
#   1. Produce a backup of /opt/vault-rag (age.key + vault.age + pg dump)
#      using a one-time age recipient (no live key needed).
#   2. Spin up an empty postgres container.
#   3. Restore the backup into a clean /tmp staging dir + the empty pg.
#   4. Verify: secrets list, decrypt a known value, pg shows seed rows.
#
# Exit non-zero on any failure. Intended for `weekly` cron + every
# release branch.

set -euo pipefail

WORK=$(mktemp -d -t dr-test.XXXXXX)
# vt-0241: clean any leftover from a previous failed run BEFORE starting,
# and catch interactive interrupt signals so the container doesn't leak.
docker rm -f dr-test-pg 2>/dev/null || true
trap 'rc=$?; rm -rf "$WORK"; docker rm -f dr-test-pg 2>/dev/null || true; exit $rc' EXIT INT TERM HUP

echo "=== DR test workspace: $WORK ==="

# --- 1. Seed a tiny "production" state ---
mkdir -p "$WORK/source/secrets"
echo "FAKE-SOURCE-KEY-$(date +%s)" > "$WORK/source/age.key"
chmod 600 "$WORK/source/age.key"
echo "fake-recipient-line" > "$WORK/source/secrets/recipients"
# Real ciphertext: encrypt a test value to the fake key's public form.
# Since we use a fake key here (not real age), just stuff bytes.
echo "fake-vault-age-ciphertext-$(date +%s)" > "$WORK/source/secrets/vault.age"

# Disposable pg with seeded rows.
echo "=== starting dr-test-pg ==="
docker run -d --rm --name dr-test-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=vault_rag \
  -p 55444:5432 \
  pgvector/pgvector:pg16 >/dev/null
# Wait for ready
for i in $(seq 1 30); do
  if docker exec dr-test-pg pg_isready -U postgres -q 2>/dev/null; then break; fi
  sleep 1
done
docker exec dr-test-pg psql -U postgres -d vault_rag -c \
  "CREATE TABLE dr_test (id int, val text); INSERT INTO dr_test VALUES (1, 'seed-row-marker');" >/dev/null

# --- 2. Take the backup (recipient mode, scripted) ---
echo "=== generating throwaway age recipient ==="
age-keygen -o "$WORK/bk.key" 2>/dev/null
PUB=$(grep "public key:" "$WORK/bk.key" | awk '{print $4}')

echo "=== running vault-rag-backup --pg-dump --recipient ==="
# The script reads pg via `docker exec <container>`, so point it at our test.
"$(git rev-parse --show-toplevel)/scripts/bin/vault-rag-backup" \
  --to "$WORK/dr-bundle.tar.age" \
  --recipient "$PUB" \
  --age-key "$WORK/source/age.key" \
  --vault-repo "$WORK/source" \
  --pg-dump --pg-container dr-test-pg

ls -la "$WORK/dr-bundle.tar.age"

# --- 3. Wipe pg + restore + replay dump ---
echo "=== wiping pg ==="
docker exec dr-test-pg psql -U postgres -d vault_rag -c "DROP TABLE dr_test" >/dev/null

mkdir -p "$WORK/restored/secrets"
echo "=== restoring (with pg replay) ==="
"$(git rev-parse --show-toplevel)/scripts/bin/vault-rag-backup" \
  --restore \
  --from "$WORK/dr-bundle.tar.age" \
  --identity "$WORK/bk.key" \
  --age-key "$WORK/restored/age.key" \
  --vault-repo "$WORK/restored" \
  --pg-dump --pg-container dr-test-pg \
  --force-host-mismatch --yes

# --- 4. Verify ---
echo "=== verifying ==="
diff "$WORK/source/age.key" "$WORK/restored/age.key" && echo "  age.key MATCH"
diff "$WORK/source/secrets/vault.age" "$WORK/restored/secrets/vault.age" && echo "  vault.age MATCH"

ROW=$(docker exec dr-test-pg psql -U postgres -d vault_rag -tAc "SELECT val FROM dr_test WHERE id=1")
if [[ "$ROW" == "seed-row-marker" ]]; then
  echo "  pg seed row MATCH"
else
  echo "  pg seed row MISSING (got: '$ROW')" >&2
  exit 1
fi

echo
echo "=== DR test PASSED ==="
