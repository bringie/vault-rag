# Session Attach via Tmux Shim — Design Spec

**Date:** 2026-05-17
**Owner:** vt-0334
**Status:** Revised after subagent review (BLOCKING #1, #2 + MAJOR #3-#7 addressed)
**Revision history:**
- v0.1 — initial draft
- v0.2 — reviewer findings folded back: shim PATH filter, attach plumbing via synthetic fleet_sessions, LOC re-baseline, retention SQL, PATH validation, mux_sessions hub handler skeleton, cwd basename for viewer

## Problem

Юзер на персональном ноуте запускает Claude/Aider/etc локально и работает там же. Возникает потребность подсесть к этой сессии из другого устройства через fleet web — без потери истории и контекста, обе клавиатуры активны одновременно. Также fleet-spawned сессии должны быть доступны с локальной машины (одна и та же tmux multi-client semantics).

Сейчас в fleet есть spawn (создать новую сессию через WS) и attach к fleet-spawned сессиям. Чужие, локально-запущенные tmux/raw процессы — не видны.

## Goal

1. Юзер набирает `claude` (или `aider`/etc) в локальном терминале — как раньше — и сессия автоматически attachable из fleet.
2. Из fleet host-page видны до 10 последних tmux-сессий хоста с возможностью attach.
3. Tmux multi-client: оба экрана работают одновременно, видят одно и то же.
4. Для устаревших закрытых сессий (старше top-10 на хосте) — хранится только summary (duration, cost), не transcript.

## Non-goals (Phase 1)

- Snapshot-resume для агентов без tmux (отдельная Mode B, отложена).
- Zellij / screen support — только tmux (mux-абстракция готова к расширению).
- "Migrate" — переместить running session между хостами. Только attach к существующему.
- Cross-user attach — у нас single-tenant deployment, всё под admin token.

## Architecture

```
┌──────── user laptop ────────┐         ┌──────── fleet hub ────────┐         ┌── web ──┐
│                             │         │                           │         │         │
│  ~/.local/bin/claude (shim) │   WS    │  /api/fleet/hosts/:id/    │  WS     │  xterm  │
│     │                       │ ───────►│    tmux-sessions          │ ◄────── │         │
│     ▼                       │         │                           │         │         │
│  tmux new-session -A        │ poll    │  fleet_tmux_sessions      │         │         │
│     │                       │ 30s     │     (host_id, name,       │         │         │
│     ▼                       │ ◄────── │      agent, last_act, ...)│         │         │
│  real claude (TUI)          │         │                           │         │         │
│     ▲                       │         │  mux_attach cmd ─────────────────► WS bridge  │
│     │                       │         │                           │         │  ◄──────┤
│  user shell ─ tmux attach ──┘         └──────────────────────────┘         └─────────┘
```

### Components

1. **agent-shim** (~150 LOC bash) — single binary symlinked as `claude`, `aider`, etc. Wraps invocation in tmux when one's not already running.
2. **vt setup-shims** (~80 LOC) — vt subcommand that installs symlinks, validates PATH, optional `~/.bashrc` patch.
3. **daemon mux poller** (~120 LOC JS) — periodic `tmux list-sessions` + per-session `show-environment FLEET_AGENT FLEET_CWD`, reports via existing WS to hub.
4. **hub mux store** (~80 LOC JS, new sub-module `scripts/lib/fleet/mux.js`) — REST `GET /fleet/hosts/:id/tmux-sessions`, upsert from daemon report, GC stale rows.
5. **hub mux attach** (~50 LOC JS) — `POST .../tmux-sessions/:name/attach` mints scoped ticket; daemon receives `mux_attach` frame, spawns PTY with `tmux attach -t`.
6. **SPA mux block** (~120 LOC JS + CSS) — list on host inspector, attach button, route reuse for xterm.
7. **retention sweeper extension** (~40 LOC JS) — keep last-10 sessions content per host, drop older PTY data.

Total estimate (re-baselined after review): **~1300 LOC**. Per-component:
- agent-shim bash: ~120 (incl. POSIX `type -a` walk, realpath self-filter, shell sniff)
- `vt setup-shims` + uninstall: ~150 (PATH validation + bash/zsh/fish snippet emit + bashrc patch + smoke check)
- daemon mux poller: ~140 (poll + parse + `show-environment` single-call + emit frame)
- hub mux_sessions WS handler: ~80 (debounced GC + UPSERT batch)
- hub fleet_tmux_sessions table + DB wrapper: ~60
- new sub-module `scripts/lib/fleet/mux.js`: ~120 (GET list + POST attach mints synthetic session)
- daemon-side: tmux-attach spawn already routes through existing pty-manager — only argv synthesis, ~30 LOC
- SPA host-inspector mux block: ~220 (HTML scaffold in index.html + i18n keys + CSS + JS lifecycle + attach button + xterm tab mount)
- pre-roll capture-pane integration: ~80 (daemon: capture before spawn → ws frame; SPA: render in xterm before live stream)
- retention sweeper extension: ~60 (per-host top-10 keep + ctx.rings cleanup + batched DELETE)
- migrations: ~30 SQL
- e2e tests: ~150

Wiring changes also touch: `agent-fleet/daemon/src/ws-client.js` (frame router), `agent-fleet/daemon/src/pty-manager.js` (mux-attach argv pass-through), `scripts/lib/fleet-routes.js` (sub-module registration).

## Detailed design

### 1. Shim binary

Single bash script `agent-fleet/bin/agent-shim`. Symlinked as `claude`, `aider`, etc.

**Key correction (reviewer BLOCKING #1)**: filter self by EXACT realpath only, not by directory. Claude lives in `~/.local/bin/claude` on stock installs — original filter would have stripped the real binary too. Also use POSIX `type -a` walk (`which -a` is GNU-only; busybox/alpine daemons don't have it).

```bash
#!/usr/bin/env bash
set -euo pipefail
AGENT="$(basename "$0")"

# Escape hatch: NO_FLEET_SHIM=1 bypasses entirely.
if [ "${NO_FLEET_SHIM:-0}" = "1" ]; then
  # Find non-self via PATH walk; exec directly.
  SELF="$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")"
  IFS=:
  for d in $PATH; do
    candidate="$d/$AGENT"
    if [ -x "$candidate" ]; then
      can_rp="$(readlink -f "$candidate" 2>/dev/null || realpath "$candidate" 2>/dev/null || echo "$candidate")"
      [ "$can_rp" != "$SELF" ] && exec "$candidate" "$@"
    fi
  done
  echo "agent-shim: real $AGENT not found (NO_FLEET_SHIM bypass)" >&2; exit 127
fi

# Find the REAL binary — skip only ourselves by realpath comparison.
SELF="$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")"
REAL=""
IFS=:
for d in $PATH; do
  candidate="$d/$AGENT"
  if [ -x "$candidate" ]; then
    can_rp="$(readlink -f "$candidate" 2>/dev/null || realpath "$candidate" 2>/dev/null || echo "$candidate")"
    if [ "$can_rp" != "$SELF" ]; then
      REAL="$candidate"
      break
    fi
  fi
done
unset IFS
[ -z "$REAL" ] && { echo "agent-shim: real $AGENT not found in PATH" >&2; exit 127; }

# Already inside tmux? Exec direct (no double-wrap).
[ -n "${TMUX:-}" ] && exec "$REAL" "$@"

# Tmux missing? Warn and exec direct (no attach support).
command -v tmux >/dev/null 2>&1 || {
  echo "agent-shim: tmux not installed — running $AGENT bare (fleet attach unavailable)" >&2
  exec "$REAL" "$@"
}

# Build a unique, human-readable session name.
CWD_BASE="$(basename "$PWD" | tr -c '[:alnum:]_-' '_' | cut -c1-30)"
TS="$(date +%s)"
SESS="${FLEET_SESSION_LABEL:-${AGENT}-${CWD_BASE}-${TS}-$$}"

# Mark for discovery: FLEET_AGENT env propagates into tmux's env table,
# discoverable via `tmux show-environment -t $SESS FLEET_AGENT`.
exec tmux new-session -A -s "$SESS" \
  -e "FLEET_AGENT=$AGENT" \
  -e "FLEET_CWD=$PWD" \
  -e "FLEET_TS=$TS" \
  "$REAL" "$@"
```

**Decisions baked in:**
- `-A` = attach if session with same name exists (idempotent re-run). Won't happen with timestamp+PID suffix in practice, but defensive.
- `which -a | grep -v` filters self by full path comparison (handles case where shim is also called via absolute path).
- CWD_BASE sanitized to `[A-Za-z0-9_-]{1..30}` so tmux session names are valid.
- `NO_FLEET_SHIM=1` opt-out for one-shot bypass without uninstalling.
- Failure modes (no real binary / no tmux) degrade gracefully — never block agent launch.

### 2. `vt setup-shims` command

New `cmdSetupShims(cfg, args)` in `scripts/vt.js`. Flags:
- `--agents=<comma-list>` — which agents to install (default: `claude,aider`)
- `--dir=<path>` — install dir (default: `~/.local/bin`)
- `--write-rcfile` — also append PATH line if not present to the user's shell rcfile (asks confirmation)
- `--uninstall` — remove symlinks (rolls back)
- `--force` — overwrite non-symlink targets
- `--no-verify-path` — skip post-install PATH/exec resolution check (only for CI/automation)

Behavior:
1. Resolve `agent-shim` source path (env `VAULT_RAG_ROOT` or fall back to repo-local sibling).
2. Mkdir target.
3. Symlink each `<dir>/<agent>` → shim source. Fail if non-symlink file exists at target without `--force`.
4. **Hard PATH validation (reviewer MAJOR #5)**: after install, run `which -a <agent>` (or POSIX `command -v`) and require the FIRST hit to be the symlink we just placed. If not, **exit 1** with explicit message + the snippet the user must add to their rcfile. `--no-verify-path` skips this for automation.
5. **Shell sniff (reviewer MAJOR #5)**: detect `$SHELL` and emit syntax-correct snippet — bash/zsh use `export PATH=...`, fish uses `set -gx PATH ...`. `--write-rcfile` patches the right file (`~/.bashrc`, `~/.zshrc`, `~/.config/fish/config.fish`), idempotent via marker comment `# vt-0334: agent-fleet shims`.
6. Output: per-agent status table (installed/skipped/error), final shell-specific reload hint.

### 3. Daemon mux poller

Add to `agent-fleet/daemon/src/ws-client.js` (reviewer NIT #11 — actual file path). Poll loop every `FLEET_MUX_POLL_MS` (default 30000). Tmux version compat (reviewer MINOR #9): call `tmux show-environment -t name` with NO var args (returns the full env) and filter `FLEET_*` in JS — single exec per session, works on tmux 2.x+.

```js
async function pollMuxSessions() {
  if (!hasCommand('tmux')) return [];
  const fmt = '#{session_name}|#{session_created}|#{session_activity}|#{session_attached}|#{session_windows}';
  let lines;
  try {
    const { stdout } = await execFile('tmux', ['list-sessions', '-F', fmt], { timeout: 2000 });
    lines = stdout.trim().split('\n').filter(Boolean);
  } catch (e) {
    // tmux returns exit 1 + "no server running" when zero sessions — normal.
    return [];
  }
  const out = [];
  for (const ln of lines) {
    const [name, created, activity, attached, windows] = ln.split('|');
    // Per-session env lookup.
    let env = {};
    try {
      const { stdout: envOut } = await execFile('tmux', ['show-environment', '-t', name, 'FLEET_AGENT', 'FLEET_CWD'], { timeout: 1000 });
      for (const line of envOut.split('\n')) {
        const m = line.match(/^(FLEET_[A-Z_]+)=(.*)$/);
        if (m) env[m[1]] = m[2];
      }
    } catch {}
    out.push({
      name,
      agent: env.FLEET_AGENT || null,
      cwd: env.FLEET_CWD || null,
      created_at: new Date(parseInt(created, 10) * 1000).toISOString(),
      last_activity: new Date(parseInt(activity, 10) * 1000).toISOString(),
      attached_clients: parseInt(attached, 10) || 0,
      windows: parseInt(windows, 10) || 0,
    });
  }
  return out;
}
```

Daemon reports each tick via existing WS:
```json
{"type":"mux_sessions","items":[...]}
```

Capability advertised at handshake: `caps.mux: ["tmux"]`.

### 4. Hub mux store

New table:
```sql
CREATE TABLE fleet_tmux_sessions (
  host_id        uuid NOT NULL REFERENCES fleet_hosts(id) ON DELETE CASCADE,
  name           text NOT NULL,
  agent          text NULL,         -- 'claude'|'aider'|null (manual tmux)
  cwd            text NULL,
  created_at     timestamptz NULL,
  last_activity  timestamptz NULL,
  attached_clients smallint NOT NULL DEFAULT 0,
  windows        smallint NOT NULL DEFAULT 1,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, name)
);
CREATE INDEX ON fleet_tmux_sessions (host_id, last_activity DESC);
```

Hub WS handler — reviewer MAJOR #6 made this explicit. Add to `handleDaemonWs` in `fleet-routes.js` strict-elif chain:

```js
} else if (f.type === 'mux_sessions') {
  // f.items: array of {name, agent, cwd, created_at, last_activity, attached_clients, windows}
  const hostId = ws._hostId;  // bound at handshake
  if (!Array.isArray(f.items) || !hostId) return;
  try {
    await fleetDb.upsertTmuxSessions(ctx.db, hostId, f.items);
    // Debounced GC: only run if we haven't GC'd this host in the last 60s.
    const lastGc = _muxLastGc.get(hostId) || 0;
    if (Date.now() - lastGc > 60_000) {
      _muxLastGc.set(hostId, Date.now());
      await fleetDb.gcStaleTmuxSessions(ctx.db, hostId);
    }
  } catch (e) { log.error('mux_sessions_upsert_failed', { host_id: hostId, msg: e.message }); }
}
```

`_muxLastGc` is a module-level `Map<host_id, ts>` (small, bounded by host count).

**Reviewer MAJOR #7: cwd disclosure**. Viewer GET returns `cwd_base` only (`path.basename(cwd)`); full path requires admin. Audit row already records the full cwd for forensics.

New sub-module `scripts/lib/fleet/mux.js` exports register with two routes:

- `GET /fleet/hosts/:hostId/tmux-sessions?limit=10` — viewer-readable. Returns top-N by `last_activity DESC` with cwd basename only. Admin gets full cwd via passthrough to `checkAdminAuth(req, ctx)` shaping.
- `POST /fleet/hosts/:hostId/tmux-sessions/:name/attach` — admin-gated (outer `isAdminPath`). Re-validates session exists (reviewer Open Q §6 mortality race → 410 Gone if missing). Mints a SYNTHETIC `fleet_sessions` row (see §5 below) and returns `{session_id, ws_url, ws_ticket, scope}` so the SPA opens xterm using the same pathway as a spawned session.

### 5. Hub mux attach via synthetic fleet_sessions row (reviewer BLOCKING #2)

**Critical correction**: the existing bus is keyed by `session_id` (UUID), not by an arbitrary `ws_id`. `PtyManager.spawn` requires a `sessionId` and injects `--session-id <uuid>` into argv. The original spec's "spawn keyed by ws_id" had no plumbing. Revised approach:

`POST /fleet/hosts/:hostId/tmux-sessions/:name/attach` flow:

1. Re-validate tmux session row exists (else 410).
2. Mint a NEW `fleet_sessions` row via `fleetDb.createSession()` with:
   - `host_id`: the host
   - `label`: `tmux-attach:${name}`
   - `args`: `['tmux', 'attach-session', '-t', name]`
   - `metadata.kind`: `'mux_attach'` — discriminator to keep these out of normal session lists
   - `metadata.tmux_name`: original session name (for audit + replay)
3. Send `mux_attach` frame to daemon (NOT a `spawn` frame — daemon handles `mux_attach` separately so the spawn audit trail keeps normal spawns clean):
   ```json
   {"type":"mux_attach","session_id":"<uuid>","tmux_name":"<name>"}
   ```
4. Daemon receives → optionally fetch `tmux capture-pane -p -S -1000 -t name` for pre-roll, send as `pty_replay` frame (existing frame type for backfill on attach).
5. Daemon spawns PTY: `pty.spawn('tmux', ['attach-session', '-t', name])`, registers under `session_id` in `ctx.rings` (existing path).
6. Hub viewer pathway (already working) routes frames by `session_id` to attached browsers.
7. Mint H4-scoped WS ticket: `scope = ${host_id}:${name}` so a captured ticket can't be replayed against a different tmux name.
8. Audit `tmux_attach` row in `auth_audit` (caller, host, name).
9. Response: `{ session_id, ws_url, ws_ticket, scope }` — SPA opens xterm using the same `viewer` role pathway as normal sessions.

**Session list pollution defense**: `handleListSessions` in `fleet-routes.js` (and the WHERE clause in archive views) must filter `metadata->>'kind' IS DISTINCT FROM 'mux_attach'` to exclude these synthetic rows from the "all your sessions" UI. Synthetic rows ARE still cost/duration-accounted — visible in cost dashboards but not in operational session lists.

**Symmetric multi-client**: `tmux attach-session -t X` natively adds a client. Local user's `tmux attach -t X` in their shell remains attached. Both see same buffer. When fleet WS closes → daemon PTY ends → daemon's tmux client process exits → underlying tmux session keeps running locally.

**Pre-roll**: `tmux capture-pane -p -S -1000 -t <name>` produces the last 1000 lines of current pane content. Daemon sends it before live stream as `pty_replay` (existing frame type for buffered backfill). xterm renders it on first paint, then live stream resumes from current cursor.

### 6. SPA UI

In `agent-fleet/web/app.js` host inspector view (existing function), add block above session-history table:

```
┌──── tmux sessions on this host (last 10) ────┐
│ AGENT  NAME                CWD        AGE  ACT  CLIENTS  [attach] │
│ claude vault-rag-1715...   vault-rag  2h   3m   1        [attach] │
│ aider  scratch-1715...     scratch    1d   1h   0        [attach] │
│ (manual) work-on-bug       —          3h   30m  1        [attach] │
└──────────────────────────────────────────────┘
```

Click `[attach]`:
1. POST `/api/fleet/hosts/:id/tmux-sessions/:name/attach` → `{ticket, ws_url}`
2. Open xterm in a new tab/panel reusing existing terminal component
3. WS with subprotocol `ticket.${ticket}`, role `viewer` (or `mux_viewer`), scope_id=ticket payload's `host:name`

Toast feedback if attach fails (session disappeared between list and click → 410).

### 7. Retention sweeper (reviewer MAJOR #4)

Existing `scripts/lib/fleet-retention.js` runs periodically. Add hook:

```sql
-- Per host: identify session_ids NOT in top-10 by completion time AND closed.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY host_id ORDER BY COALESCE(ended_at, started_at) DESC) AS rn
  FROM fleet_sessions
  WHERE host_id = $1
    AND status IN ('done', 'failed', 'cancelled')      -- explicit, never 'running'/'pending'
    AND COALESCE(metadata->>'kind', '') != 'mux_attach' -- skip synthetic attach rows
)
DELETE FROM fleet_events
WHERE session_id IN (SELECT id FROM ranked WHERE rn > 10)
LIMIT 5000;  -- batch per tick to keep lock window short
```

Run every 1h. Bounded by batch limit so a host with 10k retroactive purges drains over a few hours instead of single-tick saturating pg.

**ctx.rings cleanup**: in-memory ring buffer keyed by session_id holds active stream data. For purged sessions (status in done/failed/cancelled), the ring should already be gone — `pty-manager` deletes on exit. But defensively, the sweeper also calls `ctx.rings.delete(sessionId)` for each purged id.

**Index requirement**: `fleet_sessions(host_id, status, COALESCE(ended_at, started_at))` for the window function. Add `CREATE INDEX IF NOT EXISTS idx_fleet_sessions_host_endtime ON fleet_sessions(host_id, COALESCE(ended_at, started_at) DESC) WHERE status IN ('done','failed','cancelled');` in migration.

**FK note**: `fleet_events.session_id REFERENCES fleet_sessions(id) ON DELETE CASCADE`. We DELETE from `fleet_events` directly without touching `fleet_sessions`, so cascade doesn't fire — explicit, no surprises.

## Open question resolutions

1. **Single-shim binary, `$0`-detect** — yes, one bash file, symlinks. Easier updates.
2. **Session name conflicts** — append `$$` (PID) after timestamp. Collision-free.
3. **Force-detach default** — OFF (multi-client). Long-press → menu with "force takeover" later.
4. **Scrollback pre-roll** — yes, last 1000 lines via `tmux capture-pane -p -S -1000` sent as `pty_replay` frame before live stream begins. Reuses existing replay protocol.
5. **Mux abstraction** — **revised after reviewer NIT #12**: defer abstraction to phase 7. Phase 1 has only tmux; hard-code direct calls + a small adapter shape so the door's open but not over-built.
6. **Mortality race** — re-validate at attach mint. If gone → 410, SPA refreshes list. Daemon also auto-cleans rows after 5min stale (debounced GC at 60s minimum interval).
7. **Install flow** — `vt setup-shims` with hard PATH verification (fail-loud), shell-specific snippet (bash/zsh/fish), opt-in `--write-rcfile`.

## Security model

- `GET /fleet/hosts/:id/tmux-sessions` — viewer-readable. Returns name + timestamps + agent + **cwd basename only** (reviewer MAJOR #7); full cwd path requires admin bearer (route reads `checkAdminAuth` to shape response).
- `POST .../attach` — admin-gated (active stream, can interact with running process; pre-existing `isAdminPath` rule covers POST).
- Audit event `tmux_attach` inserted into `auth_audit` on every successful attach (admin compromise leaves a trail) including caller fp, host_id, full tmux_name, full cwd.
- WS ticket H4 scope: `${host_id}:${name}` so ticket can't be replayed against a different session.
- No new secrets in tmux sessions by design (user contract). No special opt-in needed.
- Synthetic `fleet_sessions` rows for attaches are flagged `metadata.kind='mux_attach'` and excluded from normal session list endpoints (no leakage of attach activity into archive UI).

## Failure modes

| Scenario | Behavior |
|---|---|
| `tmux` not installed on host | Daemon advertises `caps.mux: []`. SPA block hidden. Shim falls back to bare exec with warning. |
| Tmux session dies between list and attach | 410 Gone, SPA toast + refresh. |
| Daemon disconnected | Last reported rows remain in DB until 5min stale GC. SPA shows them dimmed "host offline". Attach returns 503. |
| Multiple fleet clients attach to same session | Native multi-client; all see same buffer; resize to min(rows, cols) of all clients. |
| User attached locally + fleet wants force-takeover | UI option to `tmux attach -d` (kicks others). Default OFF. |

## Test plan

### Unit
- shim: dry-run against fake `tmux` (PATH override) verifies env-pass + naming + escape hatch.
- daemon poller: feed canned `tmux list-sessions` output, verify parse.
- mux sub-module: register() route table matches expected shape.

### Integration (Playwright)
- `vt-0334-01`: GET /fleet/hosts/:id/tmux-sessions returns array sorted by last_activity desc.
- `vt-0334-02`: viewer can list, viewer admin-gated for attach (403).
- `vt-0334-03`: attach to nonexistent name → 410.
- `vt-0334-04`: H4 ticket scope mismatch on attach → WS close 4001.
- `vt-0334-05`: shim install via `vt setup-shims` symlinks correctly.

### Manual smoke
- Local host run `tmux setup` + `claude` in shim → appears in SPA within 30s.
- SPA attach → xterm shows current claude state with last 1000 lines pre-roll.
- Type on local terminal → fleet xterm reflects within 200ms.
- Type on fleet xterm → local terminal reflects within 200ms.
- Close fleet WS → local session unaffected.

## Migration / rollout

- DB migration: new table only, no existing-data impact.
- Daemon: capability is additive, old hubs ignore unknown WS frames.
- SPA: host inspector block hidden when `caps.mux` empty (graceful for hosts without tmux).
- Retention sweeper: starts working on first run after deploy; older deployments will see their fleet_events shrink over time.

## Phasing

| Phase | Scope | Ship gate |
|---|---|---|
| 1 | shim + `vt setup-shims` | Manual smoke: `claude` opens in tmux session, named correctly, env vars present |
| 2 | daemon poller + report frame | Daemon logs show poll output |
| 3 | hub table + REST GET | Curl returns sessions for connected host |
| 4 | hub attach + daemon mux_attach | Manual attach via WS produces real terminal |
| 5 | SPA host inspector block + attach button | Playwright tests vt-0334-* pass |
| 6 | retention sweeper extension | Per-host last-10 retained, older session_events purged |
| 7 | (deferred) zellij adapter, force-detach UI, additional agents (hermes/codex/gemini once verified) | per-agent acceptance |

Phases 1-6 are this epic. Phase 7 is follow-up.
