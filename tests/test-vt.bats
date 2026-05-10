#!/usr/bin/env bats
# vt CLI tests. Each test uses fresh VT_VAULT_DIR.

setup() {
  export TMPDIR_TEST=$(mktemp -d)
  export VT_VAULT_DIR="$TMPDIR_TEST"
  export VT_AGENT="tester"
  export VT="/root/work/vault-rag-oss/scripts/bin/vt"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "create returns vt-0001 and writes file" {
  run "$VT" create -t epic -p 1 "First epic"
  [ "$status" -eq 0 ]
  [[ "$output" == vt-0001* ]]
  [ -f "$TMPDIR_TEST/04-tasks/vt-0001-first-epic.md" ]
  [ -f "$TMPDIR_TEST/.vt/seq" ]
  grep -q '^1$' "$TMPDIR_TEST/.vt/seq"
}

@test "counter increments on second create" {
  "$VT" create "First" >/dev/null
  run "$VT" create "Second"
  [ "$status" -eq 0 ]
  [[ "$output" == vt-0002* ]]
  grep -q '^2$' "$TMPDIR_TEST/.vt/seq"
}

@test "frontmatter has required fields" {
  "$VT" create -t task -p 1 "Demo" >/dev/null
  local f="$TMPDIR_TEST/04-tasks/vt-0001-demo.md"
  grep -q '^id: vt-0001' "$f"
  grep -q '^title: Demo' "$f"
  grep -q '^type: task' "$f"
  grep -q '^status: open' "$f"
  grep -q '^priority: 1' "$f"
  grep -q '^created:' "$f"
}

@test "list shows open tasks, hides closed by default" {
  "$VT" create "alpha" >/dev/null
  "$VT" create "beta" >/dev/null
  "$VT" close vt-0002 --reason "test" >/dev/null
  run "$VT" list
  [ "$status" -eq 0 ]
  [[ "$output" == *vt-0001* ]]
  [[ "$output" != *vt-0002* ]]
}

@test "list --all shows closed too" {
  "$VT" create "alpha" >/dev/null
  "$VT" create "beta" >/dev/null
  "$VT" close vt-0002 --reason "test" >/dev/null
  run "$VT" list --all
  [[ "$output" == *vt-0001* ]]
  [[ "$output" == *vt-0002* ]]
}

@test "list --status filters" {
  "$VT" create "alpha" >/dev/null
  "$VT" create "beta" >/dev/null
  "$VT" claim vt-0001 >/dev/null
  run "$VT" list --status in_progress
  [[ "$output" == *vt-0001* ]]
  [[ "$output" != *vt-0002* ]]
}

@test "show prints file content" {
  "$VT" create "demo" >/dev/null
  run "$VT" show vt-0001
  [ "$status" -eq 0 ]
  [[ "$output" == *"id: vt-0001"* ]]
  [[ "$output" == *"# demo"* ]]
}

@test "show --json valid" {
  "$VT" create "demo" >/dev/null
  run "$VT" show vt-0001 --json
  [ "$status" -eq 0 ]
  echo "$output" | python3 -c "import sys, json; d=json.load(sys.stdin); assert d['id']=='vt-0001'; assert d['title']=='demo'"
}

@test "show on missing id fails" {
  run "$VT" show vt-9999
  [ "$status" -ne 0 ]
}

@test "claim sets in_progress + claimed_by" {
  "$VT" create "demo" >/dev/null
  run "$VT" claim vt-0001
  [ "$status" -eq 0 ]
  grep -q '^status: in_progress' "$TMPDIR_TEST/04-tasks/vt-0001-demo.md"
  grep -q '^claimed_by: tester' "$TMPDIR_TEST/04-tasks/vt-0001-demo.md"
}

@test "claim --by overrides agent" {
  "$VT" create "demo" >/dev/null
  "$VT" claim vt-0001 --by alice >/dev/null
  grep -q '^claimed_by: alice' "$TMPDIR_TEST/04-tasks/vt-0001-demo.md"
}

@test "claim already-claimed needs --force" {
  "$VT" create "demo" >/dev/null
  "$VT" claim vt-0001 --by alice >/dev/null
  run "$VT" claim vt-0001 --by bob
  [ "$status" -ne 0 ]
  run "$VT" claim vt-0001 --by bob --force
  [ "$status" -eq 0 ]
  grep -q '^claimed_by: bob' "$TMPDIR_TEST/04-tasks/vt-0001-demo.md"
}

@test "close sets status=closed + reason" {
  "$VT" create "demo" >/dev/null
  run "$VT" close vt-0001 --reason "fixed"
  [ "$status" -eq 0 ]
  grep -q '^status: closed' "$TMPDIR_TEST/04-tasks/vt-0001-demo.md"
  grep -q "^closed_reason: fixed" "$TMPDIR_TEST/04-tasks/vt-0001-demo.md"
}

@test "update --status changes status" {
  "$VT" create "demo" >/dev/null
  run "$VT" update vt-0001 --status blocked
  [ "$status" -eq 0 ]
  grep -q '^status: blocked' "$TMPDIR_TEST/04-tasks/vt-0001-demo.md"
}

@test "update rejects bad status" {
  "$VT" create "demo" >/dev/null
  run "$VT" update vt-0001 --status weird
  [ "$status" -ne 0 ]
}

@test "ready lists unblocked open tasks" {
  "$VT" create "alpha" >/dev/null
  "$VT" create "beta" >/dev/null
  run "$VT" ready
  [ "$status" -eq 0 ]
  [[ "$output" == *vt-0001* ]]
  [[ "$output" == *vt-0002* ]]
}

@test "ready excludes claimed (in_progress)" {
  "$VT" create "alpha" >/dev/null
  "$VT" create "beta" >/dev/null
  "$VT" claim vt-0001 >/dev/null
  run "$VT" ready
  [[ "$output" != *vt-0001* ]]
  [[ "$output" == *vt-0002* ]]
}

@test "dep add blocks ready" {
  "$VT" create "alpha" >/dev/null
  "$VT" create "beta" >/dev/null
  "$VT" dep add vt-0002 --blocked-by vt-0001 >/dev/null
  run "$VT" ready
  [[ "$output" == *vt-0001* ]]
  [[ "$output" != *vt-0002* ]]
}

@test "dep released after blocker closes" {
  "$VT" create "alpha" >/dev/null
  "$VT" create "beta" >/dev/null
  "$VT" dep add vt-0002 --blocked-by vt-0001 >/dev/null
  "$VT" close vt-0001 --reason "done" >/dev/null
  run "$VT" ready
  [[ "$output" == *vt-0002* ]]
  [[ "$output" != *vt-0001* ]]
}

@test "dep rm unblocks" {
  "$VT" create "alpha" >/dev/null
  "$VT" create "beta" >/dev/null
  "$VT" dep add vt-0002 --blocked-by vt-0001 >/dev/null
  "$VT" dep rm vt-0002 --blocked-by vt-0001 >/dev/null
  run "$VT" ready
  [[ "$output" == *vt-0002* ]]
}

@test "ready sorts by priority asc" {
  "$VT" create -p 3 "low" >/dev/null
  "$VT" create -p 0 "high" >/dev/null
  run "$VT" ready
  local first_line=$(echo "$output" | head -1)
  [[ "$first_line" == *vt-0002* ]]
}

@test "remember writes note to 06-resources/notes" {
  run "$VT" remember "Pattern: use foo for bar" --tags pattern,arch
  [ "$status" -eq 0 ]
  ls "$TMPDIR_TEST/06-resources/notes/" | grep -q '\.md$'
  local f=$(ls "$TMPDIR_TEST/06-resources/notes/"*.md | head -1)
  grep -q '^type: note' "$f"
  grep -q 'Pattern: use foo for bar' "$f"
}

@test "missing vault dir errors" {
  export VT_VAULT_DIR="/nonexistent/path/$$"
  run "$VT" list
  [ "$status" -ne 0 ]
  [[ "$output" == *"vault directory not found"* ]]
}

@test "create with --epic + blocked-by sets fields" {
  "$VT" create -t epic "parent" >/dev/null
  "$VT" create "blocker" >/dev/null
  run "$VT" create --epic vt-0001 --blocked-by vt-0002 "child"
  [ "$status" -eq 0 ]
  local f=$(ls "$TMPDIR_TEST/04-tasks/vt-0003"*.md)
  grep -q '^epic: vt-0001' "$f"
  grep -q 'vt-0002' "$f"
}
