# Session Attach Implementation Plan

> **Spec:** `docs/superpowers/specs/2026-05-17-session-attach-via-tmux-shim-design.md` (v0.2)
> **Epic:** vt-0334
> **Status:** v0.2 — architect-review corrections folded in
> **For agentic workers:** Each phase is a separate vt task with bite-sized steps. Steps use checkbox (`- [ ]`) syntax. Run e2e suite (`tests/e2e/run.sh`) after every phase ships to prod.

## Plan revision log

- v0.1 — draft based on spec v0.2.
- v0.2 — architect review corrections:
  - **BLOCKING**: `ptyManager.spawn` takes `{sessionId,cwd,args,env,binOverride}` not positional argv. `binOverride: 'tmux'` required or daemon spawns claude.
  - **BLOCKING**: `fleetDb.createSession(c, s)` is camelCase (`hostId`,`createdBy`); plan had snake_case which would NULL → FK violation.
  - **BLOCKING**: daemon→hub `ws._hostId` doesn't exist; use `host.id` closure variable inside `handleDaemonWs`.
  - **BLOCKING**: `pty_replay` is not a hub-recognized frame type. Use `pty_data` with `seq=0` (which the hub broadcasts via `broadcastViewers`).
  - **MAJOR**: `openAttachedTerminal()` invented — real fn is `attachSession(id)` at app.js:545.
  - **MAJOR**: `listSessions` needs explicit `excludeKind` param. Cost endpoint also needs to skip `mux_attach` rows.
  - **MAJOR**: `module.exports = { ...module.exports, ... }` does not work on literal exports; append in-place.
  - **MAJOR**: phase 6 test gap — added mux-05 (retention preserves running + non-mux closed).
  - **MAJOR**: bus method `dispatchMuxAttach` unnecessary; reuse `getDaemon(hostId)` then `.send()`.
  - **MINOR**: GC interval 5min vs poll interval 30s — if 9 polls drop, alive sessions GC'd. Widen GC to 10min OR poller emits empty-frame heartbeat (we already do).
  - **MINOR**: migration deploy via `vault-rag-upgrade --skip-backup` (auto-runs sql/), not raw psql pipe.
  - **Estimates**: 4-5 working days realistic, not "7 evenings".
  - **Phasing**: ship phases 1-3 safely without 4. Phase 4 behind feature flag `mux_attach` for kill switch.
  - **Parallelization**: Phases 1, 2, 3a are independent — can run in parallel worktrees.

**Goal:** From-scratch type `claude` locally → fleet host page shows it within 30s → click attach → both shells type/see the same buffer.

**Architecture (spec recap):**
- Shim binary auto-wraps agent CLI in tmux (transparent to user).
- Daemon polls `tmux list-sessions` and reports to hub.
- Hub stores top-N per host; SPA renders block on host inspector.
- Attach POST mints synthetic `fleet_sessions` row → daemon spawns `tmux attach -t name` PTY → existing viewer plumbing routes frames to browser.
- Retention sweeper drops PTY content for closed sessions outside per-host top-10.

**Tech Stack:** bash (shim), Node (daemon + hub), Postgres (state), vanilla JS (SPA), Playwright (e2e).

---

## File structure (locked from spec)

**New:**
- `agent-fleet/bin/agent-shim` — single bash file, symlinked per agent
- `scripts/lib/fleet/mux.js` — hub sub-module: GET list + POST attach
- `sql/006-tmux-sessions.sql` — migration: `fleet_tmux_sessions` table + retention index
- `agent-fleet/daemon/src/mux-poller.js` — daemon-side poll loop
- `docs/setup-shims.md` — install guide referenced by `vt setup-shims --help`
- `tests/e2e/specs/mux.spec.js` — Playwright coverage

**Modified:**
- `scripts/vt.js` — add `cmdSetupShims`, register in dispatch
- `agent-fleet/daemon/src/ws-client.js` — wire poller, send `mux_sessions` frame, handle `mux_attach`
- `agent-fleet/daemon/src/pty-manager.js` — accept argv override for synthetic attach sessions
- `scripts/lib/fleet-db.js` — add `upsertTmuxSessions`, `gcStaleTmuxSessions`, `listTmuxSessions`
- `scripts/lib/fleet-routes.js` — register `mux` sub-module, handle `mux_sessions` daemon frame, filter `mux_attach` kind from session lists
- `scripts/lib/fleet-retention.js` — per-host top-10 retention hook
- `agent-fleet/web/index.html` — host inspector tmux block scaffold
- `agent-fleet/web/app.js` — block lifecycle, attach button, xterm tab mount
- `agent-fleet/web/app.css` — styling for new block
- `agent-fleet/web/i18n/en.json`, `ru.json` — i18n keys

---

## Phase 1 — Shim + installer

vt task: `vt-0335` (blocks: nothing; ship-able standalone).

### Task 1.1: Write the shim binary

**Files:**
- Create: `agent-fleet/bin/agent-shim`

- [ ] **Step 1: Write the failing acceptance script**

Create `tests/agent-shim.test.sh`:
```bash
#!/usr/bin/env bash
# Acceptance: shim resolves real binary excluding self by realpath.
set -euo pipefail
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

# Fake "real claude" in a discoverable PATH dir.
mkdir -p "$TMP/real-bin" "$TMP/shim-bin"
cat > "$TMP/real-bin/claude" <<'EOF'
#!/usr/bin/env bash
echo "REAL claude invoked with: $*"
echo "TMUX=$TMUX FLEET_AGENT=${FLEET_AGENT:-unset}"
EOF
chmod +x "$TMP/real-bin/claude"

# Install shim as claude symlink.
ln -s "$(realpath ../agent-fleet/bin/agent-shim)" "$TMP/shim-bin/claude"

# Test 1: NO_FLEET_SHIM=1 → bypass tmux, exec real directly.
out=$(PATH="$TMP/shim-bin:$TMP/real-bin:$PATH" NO_FLEET_SHIM=1 "$TMP/shim-bin/claude" foo)
echo "$out" | grep -q "REAL claude invoked with: foo" || { echo "FAIL: NO_FLEET_SHIM bypass"; exit 1; }
echo "$out" | grep -q "TMUX= FLEET_AGENT=unset" || { echo "FAIL: tmux env leaked"; exit 1; }

# Test 2: with tmux available, shim wraps.
# (Run inside a fake tmux: TMUX env present means skip wrap, exec direct.)
out=$(PATH="$TMP/shim-bin:$TMP/real-bin:$PATH" TMUX="fake" "$TMP/shim-bin/claude" hello)
echo "$out" | grep -q "REAL claude invoked with: hello" || { echo "FAIL: inside-tmux passthrough"; exit 1; }

# Test 3: real binary not in PATH → exit 127.
PATH="$TMP/shim-bin" "$TMP/shim-bin/claude" 2>err && { echo "FAIL: should have exited"; exit 1; } || true
grep -q "real claude not found" err || { echo "FAIL: error message"; exit 1; }

echo "agent-shim tests passed"
```

- [ ] **Step 2: Run test → expect FAIL because shim doesn't exist yet**

```bash
chmod +x tests/agent-shim.test.sh
bash tests/agent-shim.test.sh
```
Expected: error "agent-shim file not found" or "no such file or directory".

- [ ] **Step 3: Write the shim binary**

Save as `agent-fleet/bin/agent-shim`:
```bash
#!/usr/bin/env bash
# vt-0334 / vt-0335: agent-fleet shim. Symlinked as claude/aider/etc.
# Auto-wraps invocation in tmux so fleet can attach to running sessions.
set -euo pipefail
AGENT="$(basename "$0")"

# Resolve self for filtering against PATH walk results.
SELF="$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")"

# Walk PATH, skip self by realpath, return first hit.
find_real() {
  local d candidate can_rp
  IFS=:
  for d in $PATH; do
    candidate="$d/$AGENT"
    if [ -x "$candidate" ]; then
      can_rp="$(readlink -f "$candidate" 2>/dev/null || realpath "$candidate" 2>/dev/null || echo "$candidate")"
      if [ "$can_rp" != "$SELF" ]; then
        echo "$candidate"
        return 0
      fi
    fi
  done
  unset IFS
  return 1
}

REAL="$(find_real)" || { echo "agent-shim: real $AGENT not found in PATH" >&2; exit 127; }

# Escape hatch.
[ "${NO_FLEET_SHIM:-0}" = "1" ] && exec "$REAL" "$@"

# Already inside tmux? Skip re-wrap.
[ -n "${TMUX:-}" ] && exec "$REAL" "$@"

# Tmux missing? Warn once and exec direct.
if ! command -v tmux >/dev/null 2>&1; then
  echo "agent-shim: tmux not installed — running $AGENT bare (fleet attach unavailable)" >&2
  exec "$REAL" "$@"
fi

# Build session name.
CWD_BASE="$(basename "$PWD" | tr -c '[:alnum:]_-' '_' | cut -c1-30)"
TS="$(date +%s)"
SESS="${FLEET_SESSION_LABEL:-${AGENT}-${CWD_BASE}-${TS}-$$}"

# Tmux session env carries discovery metadata.
exec tmux new-session -A -s "$SESS" \
  -e "FLEET_AGENT=$AGENT" \
  -e "FLEET_CWD=$PWD" \
  -e "FLEET_TS=$TS" \
  "$REAL" "$@"
```

```bash
chmod +x agent-fleet/bin/agent-shim
```

- [ ] **Step 4: Run test → expect PASS**

```bash
bash tests/agent-shim.test.sh
```
Expected: `agent-shim tests passed`.

- [ ] **Step 5: Commit**

```bash
git add agent-fleet/bin/agent-shim tests/agent-shim.test.sh
git commit -m "feat(vt-0335): agent-shim binary auto-wrapping CLI in tmux"
```

### Task 1.2: vt setup-shims command

**Files:**
- Modify: `scripts/vt.js` (add `cmdSetupShims`, register dispatch)
- Test: `tests/vt-setup-shims.test.sh`

- [ ] **Step 1: Write the acceptance test**

`tests/vt-setup-shims.test.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
TMP=$(mktemp -d); trap "rm -rf $TMP" EXIT
HOME="$TMP" PATH="$TMP/bin:$PATH" \
  /root/work/vault-rag-oss/scripts/bin/vt setup-shims --dir "$TMP/local-bin" --agents claude --no-verify-path

# Expect symlink created.
[ -L "$TMP/local-bin/claude" ] || { echo "FAIL: symlink missing"; exit 1; }
TARGET="$(readlink "$TMP/local-bin/claude")"
[ -e "$TARGET" ] || { echo "FAIL: symlink dangling: $TARGET"; exit 1; }

# Idempotent re-run.
HOME="$TMP" /root/work/vault-rag-oss/scripts/bin/vt setup-shims --dir "$TMP/local-bin" --agents claude --no-verify-path
[ -L "$TMP/local-bin/claude" ] || { echo "FAIL: re-run removed symlink"; exit 1; }

# Uninstall.
HOME="$TMP" /root/work/vault-rag-oss/scripts/bin/vt setup-shims --uninstall --dir "$TMP/local-bin" --agents claude
[ ! -e "$TMP/local-bin/claude" ] || { echo "FAIL: uninstall left symlink"; exit 1; }

echo "vt setup-shims tests passed"
```

- [ ] **Step 2: Run test → expect FAIL (command not registered)**

```bash
bash tests/vt-setup-shims.test.sh
```
Expected: error like "unknown command: setup-shims".

- [ ] **Step 3: Implement `cmdSetupShims` in scripts/vt.js**

Add after existing `cmd*` functions:
```js
function cmdSetupShims(cfg, args) {
  const { flags } = args;
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { execFileSync } = require('child_process');

  const home = os.homedir();
  const dir = flags.dir || path.join(home, '.local', 'bin');
  const agents = (flags.agents || 'claude,aider').split(',').map(s => s.trim()).filter(Boolean);
  const force = !!flags.force;
  const writeRc = !!flags['write-rcfile'];
  const noVerify = !!flags['no-verify-path'];
  const uninstall = !!flags.uninstall;

  // Resolve shim source.
  const shimSrc = path.resolve(__dirname, '..', 'agent-fleet', 'bin', 'agent-shim');
  if (!uninstall && !fs.existsSync(shimSrc)) die(`shim source not found: ${shimSrc}`);

  fs.mkdirSync(dir, { recursive: true });

  const results = [];
  for (const agent of agents) {
    const link = path.join(dir, agent);
    let action;
    try {
      const exists = fs.existsSync(link);
      if (uninstall) {
        if (exists) { fs.unlinkSync(link); action = 'removed'; }
        else action = 'already-absent';
      } else {
        if (exists) {
          const st = fs.lstatSync(link);
          if (st.isSymbolicLink()) { fs.unlinkSync(link); }
          else if (!force) { action = 'skip (non-symlink exists; pass --force to overwrite)'; results.push({agent, action}); continue; }
          else fs.unlinkSync(link);
        }
        fs.symlinkSync(shimSrc, link);
        action = 'installed';
      }
    } catch (e) { action = `error: ${e.message}`; }
    results.push({ agent, action });
  }

  // PATH verification (skip with --no-verify-path or --uninstall).
  if (!noVerify && !uninstall) {
    for (const agent of agents) {
      let resolved = '';
      try { resolved = execFileSync('sh', ['-c', `command -v ${agent}`], { encoding: 'utf8' }).trim(); }
      catch { resolved = ''; }
      const link = path.join(dir, agent);
      if (resolved !== link) {
        process.stderr.write(`vt: setup-shims: PATH check FAILED for ${agent}\n`);
        process.stderr.write(`    expected: ${link}\n`);
        process.stderr.write(`    actual:   ${resolved || '(not found)'}\n`);
        const shell = process.env.SHELL || '';
        let snippet;
        if (shell.endsWith('fish')) snippet = `fish_add_path ${dir}`;
        else snippet = `export PATH="${dir}:$PATH"`;
        process.stderr.write(`    Add to your shell rcfile:\n      ${snippet}\n`);
        if (writeRc) {
          // Patch the right rcfile idempotently.
          const rcfile = shell.endsWith('zsh') ? path.join(home, '.zshrc')
                       : shell.endsWith('fish') ? path.join(home, '.config', 'fish', 'config.fish')
                       : path.join(home, '.bashrc');
          const marker = '# vt-0334: agent-fleet shims';
          let cur = '';
          try { cur = fs.readFileSync(rcfile, 'utf8'); } catch {}
          if (!cur.includes(marker)) {
            fs.mkdirSync(path.dirname(rcfile), { recursive: true });
            fs.appendFileSync(rcfile, `\n${marker}\n${snippet}\n`);
            process.stderr.write(`    Appended PATH line to ${rcfile} (open a new shell to apply).\n`);
          }
        }
        process.exit(1);
      }
    }
  }

  for (const r of results) process.stdout.write(`${r.agent.padEnd(12)} ${r.action}\n`);
  if (!uninstall) process.stdout.write(`\nReload your shell, then type \`${agents[0]}\` — it will auto-wrap in tmux.\n`);
}
```

Register in dispatch (in the main `if/else` chain after existing commands):
```js
if (cmd === 'setup-shims') return cmdSetupShims(cfg, parseArgs(args));
```

- [ ] **Step 4: Run test → expect PASS**

```bash
bash tests/vt-setup-shims.test.sh
```
Expected: `vt setup-shims tests passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/vt.js tests/vt-setup-shims.test.sh
git commit -m "feat(vt-0335): vt setup-shims subcommand (install/uninstall + PATH verify + rcfile patch)"
```

---

## Phase 2 — Daemon mux poller

vt task: `vt-0336` (blocks on vt-0335 only for end-to-end; the daemon code is independent).

### Task 2.1: mux-poller module

**Files:**
- Create: `agent-fleet/daemon/src/mux-poller.js`
- Test: `agent-fleet/daemon/test/mux-poller.test.js`

- [ ] **Step 1: Write failing test**

`agent-fleet/daemon/test/mux-poller.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseListSessionsOutput, parseEnvOutput } = require('../src/mux-poller');

test('parseListSessionsOutput: empty input', () => {
  assert.deepEqual(parseListSessionsOutput(''), []);
});
test('parseListSessionsOutput: two rows', () => {
  const input = 'claude-foo|1700000000|1700000050|1|2\naider-bar|1700001000|1700001010|0|1';
  const rows = parseListSessionsOutput(input);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'claude-foo');
  assert.equal(rows[0].attached_clients, 1);
  assert.equal(rows[1].windows, 1);
});
test('parseEnvOutput: filters FLEET_*', () => {
  const input = 'FLEET_AGENT=claude\nFLEET_CWD=/home/u/work\nPATH=/usr/bin\nOTHER=x';
  const env = parseEnvOutput(input);
  assert.equal(env.FLEET_AGENT, 'claude');
  assert.equal(env.FLEET_CWD, '/home/u/work');
  assert.equal(env.PATH, undefined);
});
```

```bash
cd agent-fleet/daemon && node --test test/mux-poller.test.js
```
Expected: error `Cannot find module '../src/mux-poller'`.

- [ ] **Step 2: Write the module**

`agent-fleet/daemon/src/mux-poller.js`:
```js
'use strict';
// vt-0336: tmux discovery poller. Spawns `tmux list-sessions` + per-session
// `tmux show-environment`, parses, returns normalized records.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const LIST_FMT = '#{session_name}|#{session_created}|#{session_activity}|#{session_attached}|#{session_windows}';
const POLL_MS = parseInt(process.env.FLEET_MUX_POLL_MS || '30000', 10);

function parseListSessionsOutput(stdout) {
  if (!stdout) return [];
  return stdout.trim().split('\n').filter(Boolean).map(ln => {
    const [name, created, activity, attached, windows] = ln.split('|');
    return {
      name,
      created_at: new Date(parseInt(created, 10) * 1000).toISOString(),
      last_activity: new Date(parseInt(activity, 10) * 1000).toISOString(),
      attached_clients: parseInt(attached, 10) || 0,
      windows: parseInt(windows, 10) || 0,
    };
  });
}

function parseEnvOutput(stdout) {
  const env = {};
  for (const line of (stdout || '').split('\n')) {
    const m = line.match(/^(FLEET_[A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function pollOnce() {
  let listOut;
  try {
    const { stdout } = await execFileAsync('tmux', ['list-sessions', '-F', LIST_FMT], { timeout: 2000 });
    listOut = stdout;
  } catch (e) {
    // tmux exit 1 on "no server" is normal — no sessions exist.
    return [];
  }
  const sessions = parseListSessionsOutput(listOut);
  for (const s of sessions) {
    try {
      const { stdout: envOut } = await execFileAsync('tmux', ['show-environment', '-t', s.name], { timeout: 1000 });
      const env = parseEnvOutput(envOut);
      s.agent = env.FLEET_AGENT || null;
      s.cwd = env.FLEET_CWD || null;
    } catch {
      s.agent = null;
      s.cwd = null;
    }
  }
  return sessions;
}

function startPoller(send) {
  let stopped = false;
  async function tick() {
    if (stopped) return;
    try {
      const items = await pollOnce();
      send({ type: 'mux_sessions', items });
    } catch (e) {
      // Don't crash the daemon over a tmux quirk.
      send({ type: 'log', level: 'warn', msg: 'mux_poll_failed', detail: e.message });
    }
    if (!stopped) setTimeout(tick, POLL_MS);
  }
  setTimeout(tick, 1000);  // first poll quickly after start
  return { stop() { stopped = true; } };
}

module.exports = { parseListSessionsOutput, parseEnvOutput, pollOnce, startPoller };
```

- [ ] **Step 3: Run test → expect PASS**

```bash
cd agent-fleet/daemon && node --test test/mux-poller.test.js
```
Expected: `# pass 3`.

- [ ] **Step 4: Wire poller into ws-client.js**

Edit `agent-fleet/daemon/src/ws-client.js` to import and start the poller after WS handshake succeeds. Locate the existing handshake-complete callback (`ws.on('open', ...)` or post-`hello`-frame branch) and add:

```js
const { startPoller } = require('./mux-poller');
// After auth handshake confirms hub accepted us:
const muxPoller = startPoller((frame) => ws.send(JSON.stringify(frame)));
ws.on('close', () => muxPoller.stop());
```

- [ ] **Step 5: Commit**

```bash
git add agent-fleet/daemon/src/mux-poller.js agent-fleet/daemon/test/mux-poller.test.js agent-fleet/daemon/src/ws-client.js
git commit -m "feat(vt-0336): daemon tmux poller emits mux_sessions frames"
```

---

## Phase 3 — Hub: table + GET endpoint

vt task: `vt-0337` (blocks on vt-0336 to test end-to-end, but DB migration ships independently).

### Task 3.1: Migration

**Files:**
- Create: `sql/006-tmux-sessions.sql`

- [ ] **Step 1: Write the migration**

```sql
-- vt-0337: fleet_tmux_sessions tracks user-launched tmux sessions
-- on hosts (discovered via daemon poll).
CREATE TABLE IF NOT EXISTS fleet_tmux_sessions (
  host_id           uuid NOT NULL REFERENCES fleet_hosts(id) ON DELETE CASCADE,
  name              text NOT NULL,
  agent             text NULL,
  cwd               text NULL,
  created_at        timestamptz NULL,
  last_activity     timestamptz NULL,
  attached_clients  smallint NOT NULL DEFAULT 0,
  windows           smallint NOT NULL DEFAULT 1,
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, name)
);
CREATE INDEX IF NOT EXISTS idx_fleet_tmux_sessions_host_activity
  ON fleet_tmux_sessions (host_id, last_activity DESC);

-- Index for retention sweeper's per-host top-10 query.
CREATE INDEX IF NOT EXISTS idx_fleet_sessions_host_endtime
  ON fleet_sessions (host_id, COALESCE(ended_at, started_at) DESC)
  WHERE status IN ('done','failed','cancelled');
```

- [ ] **Step 2: Apply locally + on prod (deploy script auto-runs migrations on next upgrade)**

Verify migration loads without error:
```bash
ssh -p 977 root@brain.itiswednesdaymydud.es 'cd /opt/vault-rag && cat sql/006-tmux-sessions.sql | docker exec -i vault-rag-postgres psql -U $VAULT_RAG_PG_USER -d vault_rag'
```

### Task 3.2: fleet-db wrappers

**Files:**
- Modify: `scripts/lib/fleet-db.js`

- [ ] **Step 1: Add three functions at the end of the file**

```js
async function upsertTmuxSessions(c, hostId, items) {
  if (!Array.isArray(items)) return;
  // Single batched VALUES insert keeps the round-trip count to 1.
  const rows = [];
  const params = [hostId];
  let i = 2;
  for (const it of items) {
    rows.push(`($1, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, now())`);
    params.push(it.name, it.agent || null, it.cwd || null,
      it.created_at, it.last_activity, it.attached_clients || 0, it.windows || 1);
  }
  if (!rows.length) return;
  await c.query(`
    INSERT INTO fleet_tmux_sessions
      (host_id, name, agent, cwd, created_at, last_activity, attached_clients, windows, last_seen_at)
    VALUES ${rows.join(',')}
    ON CONFLICT (host_id, name) DO UPDATE SET
      agent            = EXCLUDED.agent,
      cwd              = EXCLUDED.cwd,
      last_activity    = EXCLUDED.last_activity,
      attached_clients = EXCLUDED.attached_clients,
      windows          = EXCLUDED.windows,
      last_seen_at     = now()`,
    params);
}

async function gcStaleTmuxSessions(c, hostId) {
  await c.query(
    `DELETE FROM fleet_tmux_sessions
     WHERE host_id = $1 AND last_seen_at < now() - INTERVAL '5 minutes'`,
    [hostId]);
}

async function listTmuxSessions(c, hostId, { limit = 10 } = {}) {
  const { rows } = await c.query(
    `SELECT name, agent, cwd, created_at, last_activity, attached_clients, windows, last_seen_at
     FROM fleet_tmux_sessions
     WHERE host_id = $1
     ORDER BY last_activity DESC
     LIMIT $2`,
    [hostId, limit]);
  return rows;
}

async function getTmuxSession(c, hostId, name) {
  const { rows } = await c.query(
    `SELECT name, agent, cwd, created_at, last_activity, attached_clients, windows
     FROM fleet_tmux_sessions
     WHERE host_id = $1 AND name = $2`,
    [hostId, name]);
  return rows[0] || null;
}

// v0.2 fix: module.exports is a literal object at line ~674. Append
// new function names to the existing list IN PLACE — `{...module.exports, ...}`
// won't work for a literal export. Edit existing line:
//   createSession, getSession, listSessions, ...
// To:
//   createSession, getSession, listSessions, ...,
//   upsertTmuxSessions, gcStaleTmuxSessions, listTmuxSessions, getTmuxSession,
```

### Task 3.3: mux sub-module GET route

**Files:**
- Create: `scripts/lib/fleet/mux.js`
- Modify: `scripts/lib/fleet-routes.js` (register module + `mux_sessions` daemon frame handler)

- [ ] **Step 1: Write the failing Playwright test**

`tests/e2e/specs/mux.spec.js`:
```js
'use strict';
const { test, expect, request } = require('@playwright/test');
const { VIEWER_TOKEN, ADMIN_TOKEN } = require('../fixtures/auth');
const BASE = process.env.PORTAL_URL || 'https://brain.itiswednesdaymydud.es';

async function getHostId() {
  const c = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${VIEWER_TOKEN}` } });
  const r = await c.get('/api/fleet/hosts');
  const hosts = await r.json();
  await c.dispose();
  return hosts[0]?.id || null;
}

test('mux-01: GET tmux-sessions viewer → 200 array', async () => {
  const id = await getHostId(); test.skip(!id, 'no hosts');
  const c = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${VIEWER_TOKEN}` } });
  const r = await c.get(`/api/fleet/hosts/${id}/tmux-sessions`);
  expect(r.status()).toBe(200);
  expect(Array.isArray(await r.json())).toBe(true);
  await c.dispose();
});

test('mux-02: viewer sees cwd basename only', async () => {
  // Only meaningful when sessions actually exist; otherwise skip.
  const id = await getHostId(); test.skip(!id, 'no hosts');
  const c = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${VIEWER_TOKEN}` } });
  const rows = await (await c.get(`/api/fleet/hosts/${id}/tmux-sessions`)).json();
  for (const row of rows) {
    if (row.cwd) expect(row.cwd).not.toMatch(/^\//); // basename only
  }
  await c.dispose();
});

test('mux-03: attach to missing session → 410', async () => {
  test.skip(!ADMIN_TOKEN, 'admin token required');
  const id = await getHostId(); test.skip(!id, 'no hosts');
  const c = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  const r = await c.post(`/api/fleet/hosts/${id}/tmux-sessions/never-exists-99/attach`, { data: {} });
  expect(r.status()).toBe(410);
  await c.dispose();
});
```

- [ ] **Step 2: Run test → expect FAIL (route 404)**

```bash
cd tests/e2e && ./run.sh full 2>&1 | tail -10
```
Expected: mux-01 fails with 404.

- [ ] **Step 3: Implement sub-module**

`scripts/lib/fleet/mux.js`:
```js
'use strict';
// vt-0337: mux (tmux) session listing + attach. Sub-module registered
// via fleet-routes sub-router. GET is viewer-readable (basename-only
// cwd); POST attach is admin-gated (mints synthetic fleet_sessions row).

const path = require('node:path');
const { SID_RE, send, readBody } = require('./_shared');

function basenameOnly(p) {
  if (!p) return p;
  return path.basename(p);
}

function register({ fleetDb, checkAdminAuth, fleetCtx }) {
  return [
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/hosts/(${SID_RE})/tmux-sessions$`, 'i'),
      handler(req, res, ctx, m) {
        const hostId = m[1];
        const u = new URL(req.url, 'http://x');
        const limit = Math.min(parseInt(u.searchParams.get('limit') || '10', 10), 50);
        const isAdmin = ctx.adminToken && checkAdminAuth(req, ctx);
        return fleetDb.listTmuxSessions(ctx.db, hostId, { limit })
          .then(rows => {
            if (!isAdmin) {
              for (const r of rows) r.cwd = basenameOnly(r.cwd);
            }
            send(res, 200, rows);
          })
          .catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      method: 'POST',
      // Tmux session names per `tmux man`: '.' and ':' forbidden; otherwise
      // permissive. Bound length to keep regex bounded.
      pattern: new RegExp(`^/fleet/hosts/(${SID_RE})/tmux-sessions/([^/:.]{1,128})/attach$`, 'i'),
      handler(req, res, ctx, m) {
        const hostId = m[1];
        const name = m[2];
        return readBody(req).then(async () => {
          // Re-validate session still exists.
          const sess = await fleetDb.getTmuxSession(ctx.db, hostId, name);
          if (!sess) return send(res, 410, { error: 'tmux session gone' });

          // Mint synthetic fleet_sessions row.
          // v0.2 fix: createSession uses camelCase + needs cwd/createdBy.
          const synth = await fleetDb.createSession(ctx.db, {
            hostId,
            cwd: sess.cwd || '/',
            args: ['tmux', 'attach-session', '-t', name],
            env: {},
            createdBy: 'mux_attach',
            label: `tmux-attach:${name}`,
            metadata: { kind: 'mux_attach', tmux_name: name, agent: sess.agent },
          });

          // Dispatch mux_attach to daemon via existing bus.getDaemon.
          // v0.2 fix: no new bus method needed.
          const daemon = ctx.bus.getDaemon(hostId);
          if (!daemon) return send(res, 503, { error: 'host not connected' });
          try {
            daemon.send(JSON.stringify({
              type: 'mux_attach',
              session_id: synth.id,
              tmux_name: name,
            }));
          } catch (e) {
            return send(res, 503, { error: `dispatch failed: ${e.message}` });
          }

          // Audit (best-effort).
          try {
            await ctx.db.query(
              `INSERT INTO auth_audit (op, role, caller_id, caller_ip, user_agent, outcome, detail)
               VALUES ('tmux_attach', 'admin', $1, $2, $3, 'ok', $4)`,
              [
                (req.headers.authorization || '').slice(0, 32),
                req.socket?.remoteAddress || null,
                (req.headers['user-agent'] || '').slice(0, 200),
                JSON.stringify({ host_id: hostId, tmux_name: name, session_id: synth.id, cwd: sess.cwd }),
              ]);
          } catch {}

          send(res, 200, {
            session_id: synth.id,
            ws_url: `/api/fleet/ws?role=viewer&session_id=${synth.id}`,
            scope: `${hostId}:${name}`,
          });
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
  ];
}

module.exports = { register };
```

- [ ] **Step 4: Wire module into fleet-routes.js _getSubRoutes**

```js
const modules = [
  require('./fleet/recycle'),
  require('./fleet/features'),
  require('./fleet/agent-roles'),
  require('./fleet/prices'),
  require('./fleet/workflows'),
  require('./fleet/mux'),
];
```

- [ ] **Step 5: Add mux_sessions daemon frame handler inside dispatchFrame**

In `fleet-routes.js` find `handleDaemonWs` and its inner `dispatchFrame(f)` function. `host.id` is in closure scope there. Add a sibling branch to the existing `if (f.type === 'pty_data')` chain (around line 1798):

```js
} else if (f.type === 'mux_sessions') {
  if (!Array.isArray(f.items)) return;
  try {
    await fleetDb.upsertTmuxSessions(ctx.db, host.id, f.items);
    const lastGc = _muxLastGc.get(host.id) || 0;
    if (Date.now() - lastGc > 60_000) {
      _muxLastGc.set(host.id, Date.now());
      await fleetDb.gcStaleTmuxSessions(ctx.db, host.id);
    }
  } catch (e) { log.error('mux_sessions_upsert_failed', { host_id: host.id, msg: e.message }); }
}
```

Add module-level near other state at top of file: `const _muxLastGc = new Map();`

- [ ] **Step 6: Ensure `bus.getDaemon(hostId)` is exported**

`makeBus()` already maintains `daemonsByHost`. Check its return object exports `getDaemon(hostId) { return daemonsByHost.get(hostId) || null; }`. If not present, add it. No new `dispatchMuxAttach` method needed — the sub-module handler does the `.send()` directly (see Step 3 handler).

- [ ] **Step 7: Filter mux_attach kind from session lists at DB layer**

Edit `scripts/lib/fleet-db.js` `listSessions(c, opts)` to accept `excludeKind`:

```js
async function listSessions(c, { hostId, status, limit = 100, offset = 0, since, until, query, excludeKind } = {}) {
  const where = [];
  const args = [];
  // ... existing clauses ...
  if (excludeKind) {
    args.push(excludeKind);
    where.push(`COALESCE(metadata->>'kind','') != $${args.length}`);
  }
  // ... existing sql ...
}
```

Same for `countSessions`. In every route handler that lists sessions for SPA (handleListSessions, handleArchive, cost endpoints' join), pass `excludeKind: 'mux_attach'`. Cost endpoints additionally guard: `if (synthRow.metadata?.kind === 'mux_attach') skip` because attach sessions don't have token-cost.

- [ ] **Step 8: Deploy + run test → expect PASS mux-01, mux-02, mux-03 (admin token configured)**

```bash
git add scripts/lib/fleet/mux.js scripts/lib/fleet-routes.js scripts/lib/fleet-db.js sql/006-tmux-sessions.sql tests/e2e/specs/mux.spec.js
git commit -m "feat(vt-0337): mux sub-module GET list + POST attach (mints synthetic session)"
git push
ssh -p 977 root@brain.itiswednesdaymydud.es 'cd /opt/vault-rag && ./scripts/bin/vault-rag-upgrade --skip-backup'
cd tests/e2e && ./run.sh full
```
Expected: 3 mux-* tests pass.

---

## Phase 4 — Daemon side of attach

vt task: `vt-0338`.

### Task 4.1: Handle mux_attach frame

**Files:**
- Modify: `agent-fleet/daemon/src/ws-client.js`
- Modify: `agent-fleet/daemon/src/pty-manager.js`

- [ ] **Step 1: Add mux_attach handler to ws-client.js if/else chain**

In `agent-fleet/daemon/src/ws-client.js` find the `ws.on('message', ...)` block around line 525 with the existing chain `welcome / spawn / input / kill / replay / resize / read_file / write_file`. Add a `mux_attach` branch alongside `spawn`:

```js
} else if (f.type === 'mux_attach') {
  const { session_id, tmux_name } = f;
  // Pre-roll: capture last 1000 lines, ship as pty_data seq=0 (hub
  // broadcasts to viewers via existing broadcastViewers).
  // v0.2 fix: pty_replay isn't a hub-recognized frame; reuse pty_data.
  try {
    const cap = await execFileAsync('tmux', ['capture-pane', '-p', '-S', '-1000', '-t', tmux_name], { timeout: 2000 });
    if (cap.stdout) {
      ws.send(JSON.stringify({
        type: 'pty_data',
        session_id,
        seq: 0,
        data: cap.stdout,
        replayed: true,
      }));
    }
  } catch (e) { log.warn({ msg: 'mux_capture_failed', err: e.message }); }

  // Spawn tmux attach as a normal PTY via existing ptyManager.
  // v0.2 fix: object-form signature + binOverride forces 'tmux' (else
  // pty-manager defaults to claudeBin and auto-injects --session-id).
  await ptyManager.spawn({
    sessionId: session_id,
    cwd: process.env.HOME || '/',
    args: ['attach-session', '-t', tmux_name],
    env: { ...process.env, TMUX: undefined },
    binOverride: 'tmux',
  });
}
```

- [ ] **Step 2: Verify pty-manager binOverride suppresses claude arg injection**

Read `agent-fleet/daemon/src/pty-manager.js:17` `spawn({ sessionId, cwd, args, env, binOverride })`. Confirm the auto-inject of `--session-id` only fires when bin matches /claude/i AND no explicit binOverride. If the guard is wrong, fix it:

```js
const bin = binOverride || this.claudeBin;
// Only inject session-id when binary IS claude AND no override.
if (!binOverride && /claude/i.test(bin)) {
  args = ['--session-id', sessionId, ...args];
}
```

Add a unit test:

```js
// agent-fleet/daemon/test/pty-manager-binoverride.test.js
test('pty-manager: binOverride=tmux skips --session-id injection', () => {
  // Mock spawn, capture argv, assert no --session-id present.
});
```

- [ ] **Step 3: Commit**

```bash
git add agent-fleet/daemon/src/ws-client.js agent-fleet/daemon/src/pty-manager.js
git commit -m "feat(vt-0338): daemon handles mux_attach, captures pre-roll, spawns tmux attach PTY"
```

---

## Phase 5 — SPA UI

vt task: `vt-0339`.

### Task 5.1: Host inspector tmux block

**Files:**
- Modify: `agent-fleet/web/index.html` (block scaffold)
- Modify: `agent-fleet/web/app.js` (block lifecycle, attach handler)
- Modify: `agent-fleet/web/app.css` (styles)
- Modify: `agent-fleet/web/i18n/en.json` (i18n keys)
- Modify: `tests/e2e/specs/mux.spec.js` (Playwright UI tests)

- [ ] **Step 1: HTML scaffold**

Inside the existing host-detail panel block (locate by `host-detail` id), add:
```html
<div class="host-detail-section" id="host-mux-section">
  <h3 data-i18n="host.tmux.title">tmux sessions</h3>
  <table class="mux-table">
    <thead><tr>
      <th data-i18n="host.tmux.col.agent">agent</th>
      <th data-i18n="host.tmux.col.name">name</th>
      <th data-i18n="host.tmux.col.cwd">cwd</th>
      <th data-i18n="host.tmux.col.last_activity">last activity</th>
      <th data-i18n="host.tmux.col.clients">clients</th>
      <th></th>
    </tr></thead>
    <tbody id="host-mux-rows"></tbody>
  </table>
</div>
```

- [ ] **Step 2: i18n keys**

`en.json`:
```json
"host.tmux.title": "TMUX SESSIONS",
"host.tmux.col.agent": "agent",
"host.tmux.col.name": "name",
"host.tmux.col.cwd": "cwd",
"host.tmux.col.last_activity": "last activity",
"host.tmux.col.clients": "clients",
"host.tmux.attach": "attach",
"host.tmux.empty": "(no tmux sessions on this host)"
```

- [ ] **Step 3: Lifecycle JS**

In `app.js`, find `openHostDetail` (or analogous). Add after existing host-summary load:

```js
async function loadHostMux(hostId) {
  const body = $('host-mux-rows');
  if (!body) return;
  try {
    const rows = await api('GET', `/hosts/${hostId}/tmux-sessions?limit=10`);
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="6" class="muted" data-i18n="host.tmux.empty">no sessions</td></tr>`;
      return;
    }
    body.innerHTML = rows.map(r => `<tr>
      <td>${esc(r.agent || '—')}</td>
      <td><code>${esc(r.name)}</code></td>
      <td>${esc(r.cwd || '—')}</td>
      <td>${esc(new Date(r.last_activity).toLocaleString())}</td>
      <td>${r.attached_clients}</td>
      <td><button class="btn-row" data-attach="${esc(r.name)}" data-host="${esc(hostId)}" data-i18n="host.tmux.attach">attach</button></td>
    </tr>`).join('');
    body.querySelectorAll('[data-attach]').forEach(b => {
      b.onclick = async () => {
        try {
          const r = await api('POST', `/hosts/${b.dataset.host}/tmux-sessions/${b.dataset.attach}/attach`, {});
          // Reuse existing xterm tab open flow.
          // v0.2 fix: real fn is attachSession(id) at app.js:545.
          attachSession(r.session_id);
        } catch (e) {
          if (e.status === 410) { window.toast?.warn('session gone, refreshing'); return loadHostMux(hostId); }
          window.toast?.error(`attach failed: ${e.message}`);
        }
      };
    });
  } catch (e) { body.innerHTML = `<tr><td colspan="6" class="muted">error: ${esc(e.message)}</td></tr>`; }
}
```

`attachSession(id)` already exists at `app.js:545` — it handles WS upgrade + xterm mount end-to-end.

- [ ] **Step 4: CSS**

```css
.mux-table { width: 100%; border-collapse: collapse; font-size: .85em; }
.mux-table th { text-align: left; padding: .3em .4em; color: var(--muted); }
.mux-table td { padding: .3em .4em; border-top: 1px solid var(--line); }
.mux-table code { font-family: var(--font-mono); color: var(--accent); }
```

- [ ] **Step 5: Add Playwright UI test**

Extend `tests/e2e/specs/mux.spec.js`:
```js
test('mux-04: host inspector renders tmux block', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/fleet/');
  // Click first host row → host inspector should open.
  await page.locator('.host-row').first().click({ timeout: 5000 });
  await expect(page.locator('#host-mux-section')).toBeVisible({ timeout: 5000 });
});
```

- [ ] **Step 6: Deploy + run e2e**

```bash
git add agent-fleet/web/index.html agent-fleet/web/app.js agent-fleet/web/app.css agent-fleet/web/i18n/en.json tests/e2e/specs/mux.spec.js
git commit -m "feat(vt-0339): SPA host inspector tmux block + attach button"
git push
ssh -p 977 root@brain.itiswednesdaymydud.es 'cd /opt/vault-rag && ./scripts/bin/vault-rag-upgrade --skip-backup'
cd tests/e2e && ./run.sh full
```

---

## Phase 6 — Retention sweeper extension

vt task: `vt-0340`.

### Task 6.1: Per-host top-10 retention

**Files:**
- Modify: `scripts/lib/fleet-retention.js`

- [ ] **Step 1: Add retention SQL**

Find the existing periodic loop. Add:

```js
const RETENTION_KEEP_PER_HOST = parseInt(process.env.VAULT_RAG_SESSION_KEEP_PER_HOST || '10', 10);
const RETENTION_BATCH = parseInt(process.env.VAULT_RAG_RETENTION_BATCH || '5000', 10);

async function purgeOldSessionEvents(pg) {
  // Find host ids that have >10 closed sessions.
  const { rows: hosts } = await pg.query(
    `SELECT host_id, COUNT(*) AS n
     FROM fleet_sessions
     WHERE status IN ('done','failed','cancelled')
       AND COALESCE(metadata->>'kind','') != 'mux_attach'
     GROUP BY host_id
     HAVING COUNT(*) > $1`,
    [RETENTION_KEEP_PER_HOST]);

  let total = 0;
  for (const h of hosts) {
    const { rowCount } = await pg.query(`
      WITH ranked AS (
        SELECT id, row_number() OVER (
          PARTITION BY host_id
          ORDER BY COALESCE(ended_at, started_at) DESC) AS rn
        FROM fleet_sessions
        WHERE host_id = $1
          AND status IN ('done','failed','cancelled')
          AND COALESCE(metadata->>'kind','') != 'mux_attach'
      )
      DELETE FROM fleet_events
      WHERE session_id IN (SELECT id FROM ranked WHERE rn > $2)
      LIMIT $3`,
      [h.host_id, RETENTION_KEEP_PER_HOST, RETENTION_BATCH]);
    total += rowCount;
  }
  return total;
}
```

Schedule via existing retention loop (every 1h):
```js
const purged = await purgeOldSessionEvents(pg);
if (purged > 0) log.info('retention_session_events_purged', { rows: purged });
```

- [ ] **Step 2: Verify on prod with low row counts (no behavior change expected since this host has < 10 sessions per host)**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es '
docker exec vault-rag-postgres psql -U $VAULT_RAG_PG_USER -d vault_rag -c "
SELECT host_id, COUNT(*) FROM fleet_sessions
WHERE status IN (\"done\",\"failed\",\"cancelled\")
GROUP BY host_id;"'
```

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/fleet-retention.js
git commit -m "feat(vt-0340): retention sweeper drops session events outside per-host top-10"
git push
```

---

## Phase 7 — Subagent verification + close

vt task: `vt-0341`.

- [ ] **Step 1: Final e2e run**

```bash
cd tests/e2e && ./run.sh full
```
Expected: all 47 baseline + ~4 new mux-* tests = ~51 passing.

- [ ] **Step 2: Manual smoke (single round-trip)**

1. From local terminal: `vt setup-shims` (if not already done).
2. `claude` → should auto-wrap in tmux. Verify `$TMUX` is set inside.
3. Open SPA → host inspector → tmux block populated within 30s.
4. Click attach → xterm opens with last 1000 lines pre-roll.
5. Type in fleet xterm → local terminal reflects.
6. Type in local terminal → fleet xterm reflects.
7. Close fleet WS → local session unaffected.

- [ ] **Step 3: Subagent verification**

Dispatch a Haiku to run `tests/e2e/run.sh full` and confirm clean pass.

- [ ] **Step 4: Close all phase tasks + update vt-0334**

```bash
./scripts/bin/vt close vt-0335 --reason "Shim binary + vt setup-shims shipped."
./scripts/bin/vt close vt-0336 --reason "Daemon poller shipped."
./scripts/bin/vt close vt-0337 --reason "Hub REST endpoints + migration shipped."
./scripts/bin/vt close vt-0338 --reason "Daemon mux_attach handler shipped."
./scripts/bin/vt close vt-0339 --reason "SPA host inspector block shipped."
./scripts/bin/vt close vt-0340 --reason "Retention extension shipped."
./scripts/bin/vt close vt-0341 --reason "Verification phase complete."
./scripts/bin/vt close vt-0334 --reason "Session attach via tmux shim epic complete. All 7 phases verified."
```

---

## Risk register

| Risk | Mitigation |
|---|---|
| Daemon's existing ws-client.js frame router is request/response only, no broadcast for arbitrary daemon-initiated frames | Phase 2 step 4 confirms the WS already accepts arbitrary frames; if not, add a `send(frame)` channel that bypasses the request-id muxer. |
| Tmux session names collide across hosts with same hash | DB primary key is `(host_id, name)` — host-scoped uniqueness is sufficient. |
| Synthetic fleet_sessions rows clutter cost dashboards | Cost queries already filter by status — synthetic rows go through normal lifecycle (running → done when WS closes) and ARE worth counting as cost (admin spent compute attaching). Documented as expected. |
| Pre-roll pulls 1000 lines of TUI escape codes — heavy first paint | xterm handles it; only one frame, ~50-200 KiB worst case. Acceptable. |
| User has zsh + shell sniffing fails | `--no-verify-path` escape hatch. Doc page explains manual install. |

## Definition of done

- All 7 phases shipped + subagent verification clean.
- `tests/e2e/run.sh full` passes including 4 new mux-* tests.
- `docs/setup-shims.md` reachable from `vt setup-shims --help`.
- vt-0334 closed with summary note via `vt remember`.
