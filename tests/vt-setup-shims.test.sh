#!/usr/bin/env bash
# vt-0335: acceptance tests for `vt setup-shims`.
# Verifies install/uninstall/idempotency in a sandboxed HOME.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VT="$HERE/../scripts/bin/vt"
[ -x "$VT" ] || { echo "FAIL: vt not executable at $VT"; exit 1; }

TMP="$(mktemp -d)"
trap "rm -rf $TMP" EXIT

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "PASS: $*"; }
nope() { fail=$((fail+1)); echo "FAIL: $*"; }

# ---- Test 1: install — symlink created, points at real shim ----
out=$(HOME="$TMP" "$VT" setup-shims \
  --dir "$TMP/local-bin" --agents claude --no-verify-path 2>&1)
if [ -L "$TMP/local-bin/claude" ]; then
  target="$(readlink "$TMP/local-bin/claude")"
  if [ -e "$target" ] && grep -q "agent-fleet shim" "$target"; then
    ok "install creates symlink → real agent-shim"
  else
    nope "symlink target wrong: $target"
  fi
else
  nope "no symlink created. Output: $out"
fi

# ---- Test 2: idempotent re-run leaves symlink intact ----
HOME="$TMP" "$VT" setup-shims \
  --dir "$TMP/local-bin" --agents claude --no-verify-path >/dev/null 2>&1
if [ -L "$TMP/local-bin/claude" ]; then
  ok "re-run is idempotent"
else
  nope "re-run lost the symlink"
fi

# ---- Test 3: uninstall removes ----
HOME="$TMP" "$VT" setup-shims \
  --uninstall --dir "$TMP/local-bin" --agents claude >/dev/null 2>&1
if [ ! -e "$TMP/local-bin/claude" ] && [ ! -L "$TMP/local-bin/claude" ]; then
  ok "uninstall removes symlink"
else
  nope "uninstall failed"
fi

# ---- Test 4: multi-agent install ----
HOME="$TMP" "$VT" setup-shims \
  --dir "$TMP/local-bin" --agents "claude,aider,hermes" --no-verify-path >/dev/null 2>&1
n=0
for a in claude aider hermes; do
  [ -L "$TMP/local-bin/$a" ] && n=$((n+1))
done
if [ "$n" = "3" ]; then
  ok "install creates symlinks for all 3 agents"
else
  nope "expected 3 symlinks, got $n"
fi

# ---- Test 5: --force overwrites non-symlink file ----
echo "I am a regular file" > "$TMP/local-bin/codex"
HOME="$TMP" "$VT" setup-shims --dir "$TMP/local-bin" --agents codex \
  --no-verify-path 2>&1 | grep -q "skip" || { nope "skip-non-symlink not detected"; }
HOME="$TMP" "$VT" setup-shims --dir "$TMP/local-bin" --agents codex \
  --no-verify-path --force >/dev/null 2>&1
if [ -L "$TMP/local-bin/codex" ]; then
  ok "--force overwrites non-symlink"
else
  nope "--force failed to overwrite"
fi

# ---- Test 6: PATH verification — when shim ISN'T in PATH, fail with exit 1 ----
rc=0
# We set PATH to something WITHOUT $TMP/local-bin, so verification must fail.
out=$(HOME="$TMP" PATH="/usr/bin:/bin" "$VT" setup-shims \
  --dir "$TMP/local-bin" --agents claude 2>&1) || rc=$?
if [ "$rc" = "1" ] && echo "$out" | grep -q "PATH verification FAILED"; then
  ok "PATH verification fails loudly when shim isn't on PATH"
else
  nope "PATH verification didn't fail-loud — rc=$rc out=$out"
fi

echo "---"
echo "vt setup-shims: $pass passed, $fail failed"
[ "$fail" = "0" ] || exit 1
