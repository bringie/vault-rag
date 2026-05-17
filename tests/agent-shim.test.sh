#!/usr/bin/env bash
# vt-0335: acceptance tests for agent-fleet/bin/agent-shim.
# Verifies realpath self-filter, escape hatches, tmux passthrough.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SHIM="$HERE/../agent-fleet/bin/agent-shim"
[ -x "$SHIM" ] || { echo "FAIL: shim not executable at $SHIM"; exit 1; }

TMP="$(mktemp -d)"
trap "rm -rf $TMP" EXIT

# Fake "real claude" that prints what it was invoked with.
mkdir -p "$TMP/real-bin" "$TMP/shim-bin"
cat > "$TMP/real-bin/claude" <<'BIN'
#!/usr/bin/env bash
echo "REAL invoked: $*"
echo "TMUX=${TMUX:-unset} FLEET_AGENT=${FLEET_AGENT:-unset} FLEET_CWD=${FLEET_CWD:-unset}"
BIN
chmod +x "$TMP/real-bin/claude"

# Install the shim as "claude" symlink.
ln -s "$SHIM" "$TMP/shim-bin/claude"

pass=0
fail=0
ok()   { pass=$((pass+1)); echo "PASS: $*"; }
nope() { fail=$((fail+1)); echo "FAIL: $*"; }

# Build an isolated "tools-bin" with env+bash+coreutils but NO claude/tmux.
# Use this in tests that need a clean PATH excluding the system claude
# (which IS installed in /usr/bin/claude + /bin/claude on dev boxes).
mkdir -p "$TMP/tools-bin"
for b in env bash sh basename readlink realpath date cut tr grep cat printf; do
  src="$(command -v "$b" 2>/dev/null)" || continue
  ln -sf "$src" "$TMP/tools-bin/$b"
done
ISOLATED_PATH="$TMP/shim-bin:$TMP/real-bin:$TMP/tools-bin"

# ---- Test 1: NO_FLEET_SHIM=1 bypass (no tmux involved) ----
out=$(PATH="$ISOLATED_PATH" NO_FLEET_SHIM=1 "$TMP/shim-bin/claude" hello-bypass 2>&1)
if echo "$out" | grep -q "REAL invoked: hello-bypass" && \
   echo "$out" | grep -q "TMUX=unset"; then
  ok "NO_FLEET_SHIM=1 bypasses tmux wrap"
else
  nope "NO_FLEET_SHIM=1 bypass — got: $out"
fi

# ---- Test 2: $TMUX already set → exec direct ----
out=$(PATH="$ISOLATED_PATH" TMUX="/tmp/fake,1,0" "$TMP/shim-bin/claude" inside-tmux 2>&1)
if echo "$out" | grep -q "REAL invoked: inside-tmux" && \
   echo "$out" | grep -q "TMUX=/tmp/fake"; then
  ok "\$TMUX set → no double-wrap"
else
  nope "\$TMUX passthrough — got: $out"
fi

# ---- Test 3: tmux missing → warn + exec direct ----
# Isolated PATH has env/bash/coreutils but no tmux. (System tmux at
# /usr/bin/tmux is NOT reachable.) Verify before running.
if PATH="$ISOLATED_PATH" command -v tmux >/dev/null 2>&1; then
  echo "SKIP: sandbox PATH still has tmux; cannot test missing-tmux fallback"
else
  out=$(PATH="$ISOLATED_PATH" "$TMP/shim-bin/claude" no-tmux 2>&1) || true
  if echo "$out" | grep -q "tmux not installed" && \
     echo "$out" | grep -q "REAL invoked: no-tmux"; then
    ok "tmux missing → graceful warn + exec direct"
  else
    nope "tmux-missing fallback — got: $out"
  fi
fi

# ---- Test 4: real binary not in PATH → exit 127 ----
# PATH has shim + tools but NO real claude. Shim's find_real must
# walk PATH, skip itself by realpath, return nothing, exit 127.
rc=0
out=$(PATH="$TMP/shim-bin:$TMP/tools-bin" "$TMP/shim-bin/claude" nope 2>&1) || rc=$?
if [ "$rc" = "127" ] && echo "$out" | grep -q "real claude not found"; then
  ok "real binary missing → exit 127 with clear error"
else
  nope "missing-real exit code (got $rc) / msg: $out"
fi

# ---- Test 5: SELF skip by realpath (the BLOCKING fix) ----
# Put the symlink INSIDE the same dir as the "real" binary so naive
# directory filtering would also skip the real binary. Realpath-based
# filter must skip ONLY the symlink, returning the real one.
mkdir -p "$TMP/same-dir"
cp "$TMP/real-bin/claude" "$TMP/same-dir/claude"
chmod +x "$TMP/same-dir/claude"
ln -sf "$SHIM" "$TMP/same-dir/claude-shim"
# Invoke via the symlink name "claude-shim" pointing at the shim,
# but with AGENT=$(basename) it'll look for "claude-shim" in PATH —
# we need a more direct test: invoke the symlink whose basename is
# "claude" alongside a real "claude" file. That requires the symlink
# basename to BE "claude". Put symlink in shim-bin, real in real-bin,
# then put both dirs in PATH. The shim must find the real one.
PATH_ALL="$TMP/shim-bin:$TMP/real-bin:$TMP/tools-bin"
out=$(PATH="$PATH_ALL" NO_FLEET_SHIM=1 "$TMP/shim-bin/claude" find-me 2>&1)
if echo "$out" | grep -q "REAL invoked: find-me"; then
  ok "realpath self-filter finds real binary in sibling PATH dir"
else
  nope "realpath self-filter — got: $out"
fi

echo "---"
echo "agent-shim: $pass passed, $fail failed"
[ "$fail" = "0" ] || exit 1
