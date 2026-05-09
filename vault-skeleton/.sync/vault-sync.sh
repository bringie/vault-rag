#!/usr/bin/env bash
# Vault git auto-sync. Safe to call concurrently; silent on success.
# Modes:
#   pull    - sync remote -> local (blocking, short)
#   push    - commit local + push (backgrounded)
#   flush   - commit + pull + push (blocking, used at session end)
#
# Triggered by scripts/lib/git-sync.js after every /api/put and /api/task/*
# write (1.5s debounce). Manual: bash <vault>/.sync/vault-sync.sh flush
set -u
MODE="${1:-flush}"
VAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$VAULT/.sync/sync.log"
LOCK="$VAULT/.sync/.lock"

run_sync() {
  (
    if ! mkdir "$LOCK" 2>/dev/null; then
      exit 0
    fi
    trap 'rmdir "$LOCK" 2>/dev/null' EXIT
    cd "$VAULT" || exit 0
    case "$MODE" in
      pull)
        git pull --rebase --autostash origin main
        ;;
      push|flush)
        git add -A
        if ! git diff --cached --quiet; then
          git commit -m "auto-sync $(hostname) $(date -u +%FT%TZ)"
        fi
        # Squash consecutive same-host auto-sync commits within 5min, but only
        # while they are still ahead of origin/main (never rewrite pushed history).
        SH_ME="$(hostname)"
        SH_GUARD=0
        while [ "$SH_GUARD" -lt 10 ]; do
          SH_GUARD=$((SH_GUARD+1))
          SH_AHEAD="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
          [ "$SH_AHEAD" -ge 2 ] || break
          SH_HEAD_MSG="$(git log -1 --format=%s HEAD 2>/dev/null || true)"
          SH_PREV_MSG="$(git log -1 --format=%s HEAD~1 2>/dev/null || true)"
          case "$SH_HEAD_MSG" in "auto-sync ${SH_ME} "*) : ;; *) break ;; esac
          case "$SH_PREV_MSG" in "auto-sync ${SH_ME} "*) : ;; *) break ;; esac
          SH_HEAD_TS="${SH_HEAD_MSG##* }"
          SH_PREV_TS="${SH_PREV_MSG##* }"
          SH_HE="$(date -u -d "$SH_HEAD_TS" +%s 2>/dev/null || echo 0)"
          SH_PE="$(date -u -d "$SH_PREV_TS" +%s 2>/dev/null || echo 0)"
          [ "$SH_HE" -gt 0 ] && [ "$SH_PE" -gt 0 ] || break
          SH_DIFF=$((SH_HE - SH_PE)); [ "$SH_DIFF" -lt 0 ] && SH_DIFF=$((-SH_DIFF))
          [ "$SH_DIFF" -lt 300 ] || break
          git reset --soft HEAD~1
          git commit --amend -m "auto-sync ${SH_ME} ${SH_HEAD_TS}" >/dev/null
        done
        if ! git pull --rebase --autostash origin main; then
          # Conflict during rebase: save diverged commits as a patch,
          # then abort + hard-reset to origin so sync recovers. The dropped
          # changes are preserved in _refactor/conflicts/<ts>-<host>.patch.
          CONFLICT_DIR="_refactor/conflicts"
          mkdir -p "$CONFLICT_DIR"
          CTS="$(date -u +%FT%TZ | tr ':' '-')"
          CHOST="$(hostname)"
          PATCH_FILE="${CONFLICT_DIR}/conflict-${CTS}-${CHOST}.patch"
          if ! git format-patch --stdout origin/main..ORIG_HEAD > "$PATCH_FILE" 2>/dev/null; then
            git diff origin/main..ORIG_HEAD > "$PATCH_FILE" 2>/dev/null || true
          fi
          if [ ! -s "$PATCH_FILE" ]; then
            git diff origin/main > "$PATCH_FILE" 2>/dev/null || true
          fi
          git rebase --abort 2>/dev/null || true
          git reset --hard origin/main
          echo "vault-sync: conflict on rebase, hard-reset to origin/main; snapshot=$PATCH_FILE" >&2
          git add "$CONFLICT_DIR"
          if ! git diff --cached --quiet; then
            git commit -m "conflict-snapshot ${CHOST} ${CTS}"
          fi
        fi
        git push origin main
        ;;
    esac
  ) >>"$LOG" 2>&1
}

case "$MODE" in
  push)
    run_sync &
    disown 2>/dev/null
    ;;
  *)
    run_sync
    ;;
esac
exit 0
