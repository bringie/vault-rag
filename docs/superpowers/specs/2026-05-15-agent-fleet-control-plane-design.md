# Agent Fleet Control Plane — Design Spec

**Author:** dev@usedesk.com
**Status:** Draft (awaiting user review)
**Date:** 2026-05-15
**Scope:** Sub-project #1 of "vt-driven fleet" — host daemon + hub control plane

## Context

We run Claude Code interactively across multiple hosts (macOS laptop, Linux servers, VMs). Today, each host needs its own terminal session, manually orchestrated via ssh/tmux. No central visibility into "what is each claude instance doing right now," no programmatic way to spawn sessions remotely, no aggregated transcripts.

This spec covers the **foundation layer**: a host daemon and a central hub that together allow spawning, attaching to, and streaming Claude Code sessions across a fleet of hosts from a single web UI.

Three follow-up sub-projects will build on this foundation:
1. Web UI (sub-project #2)
2. `vt remote` CLI integration (sub-project #3)
3. Auto-routing + cost ingestion (sub-project #4)

## Goals

- Spawn a Claude Code session on any registered host from a single REST API call.
- Stream PTY stdout from a remote claude process to multiple viewers in real time.
- Send input from a viewer back to the remote PTY.
- Persist transcripts for replay and audit.
- Tolerate daemon/hub restarts, network blips, and host reboots without losing session continuity (where the kernel allows).

## Non-goals (for this sub-project)

- Web UI (sub-project #2)
- vt CLI integration (sub-project #3)
- Cost tracking / token-monitor integration (sub-project #4)
- Multi-user permissions
- Cross-host session migration
- Replay of `pty_input` events to a recovered daemon

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  brain.itiswednesdaymydud.es (existing)                     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Caddy (TLS, reverse proxy)                          │  │
│  │   handle_path /api/*  → rag-api :5679 (existing)     │  │
│  │     ├─ /api/secrets/*                                │  │
│  │     ├─ /api/fleet/*    (NEW — REST)                  │  │
│  │     └─ /api/fleet/ws   (NEW — WS upgrade)            │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  rag-api.js (Node, extended)                         │  │
│  │   └─ NEW: fleet module                               │  │
│  │       ├─ host registry      (in-mem + postgres)      │  │
│  │       ├─ session router     (host_id ↔ ws conn)      │  │
│  │       ├─ ws fanout          (daemon ↔ viewer)        │  │
│  │       └─ event log          (postgres append-only)   │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Postgres (existing)                                 │  │
│  │   └─ NEW: fleet_hosts, fleet_sessions, fleet_events  │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │ wss:// (outbound from each host)
                            │ Authorization: Bearer $VAULT_RAG_API_TOKEN
        ┌───────────────────┼───────────────────┐
        │                   │                   │
   ┌────┴────┐         ┌────┴────┐         ┌────┴────┐
   │ MacBook │         │ ai-host │         │ vm-rds  │
   │ daemon  │         │ daemon  │         │ daemon  │
   │ node-pty│         │ node-pty│         │ node-pty│
   │ spawns: │         │ spawns: │         │ spawns: │
   │ claude  │         │ claude  │         │ claude  │
   └─────────┘         └─────────┘         └─────────┘
```

### Key properties

- **Outbound-only from hosts** — daemons dial out; nothing inbound required. Works behind NAT, on laptops, in office networks.
- **Hub stateless for runtime** — persistent state in Postgres; routing in memory but reconstructable on reconnect.
- **One process per host = one daemon** — daemon manages multiple concurrent claude sessions via PTY.
- **No new Caddy routes** — reuses existing `handle_path /api/*` block; WS upgrade works through default Caddy reverse-proxy.

## Components

### `agent-fleet/daemon/` — Host daemon

Standalone npm package `@bringie/agent-fleet-daemon`.

**Install / run:**
```
npx @bringie/agent-fleet-daemon \
  --hub wss://brain.itiswednesdaymydud.es/api/fleet/ws \
  --token $VAULT_RAG_API_TOKEN \
  --host-name mac1 \
  [--caps docker,xcode,gpu]
```

**Dependencies:** `node-pty`, `ws`. ~350 LOC.

**Responsibilities:**
- Connect to hub (WS) with exponential reconnect+jitter backoff (1s, 2s, 4s, 8s, max 30s).
- Register via `hello` frame on connect; persist `host_id` returned in `welcome` to `~/.agent-fleet/config.json`.
- Heartbeat ping every 15s; treat as dead after 90s without pong.
- Spawn `claude` (or arbitrary command) in PTY upon `spawn` frame.
- Stream PTY stdout as `pty_data` frames with monotonic `seq`.
- Forward `input` frames to PTY stdin.
- Emit `session_exit` with exit code/signal when PTY closes.
- Maintain `~/.agent-fleet/sessions.json` (session_id → pid, last_seq) for restart recovery.
- On reconnect: send `reconciliation` frame with current local state for hub to merge.

### `scripts/lib/fleet-routes.js` — Hub HTTP/WS routes

Module wired into `rag-api.js` (alongside `vt-routes.js`).

**Responsibilities:**
- HTTP routes under `/fleet/*` (after Caddy strips `/api`).
- WS upgrade on `/fleet/ws`, dispatched by `role` query parameter (`daemon` or `viewer`).
- In-memory maps: `hostId → daemonWs`, `sessionId → Set<viewerWs>`.
- Persist all state-changing events to Postgres (host registration, session lifecycle, pty I/O).
- Per-session ring buffer (last 64 KiB) in memory for fast backfill on viewer attach.

### `scripts/lib/fleet-db.js` — Storage layer

Thin wrapper over existing `pg` pool. CRUD for hosts/sessions, append-only writes for events, retention job.

### `agent-fleet/web/` — UI assets (stub for sub-project #1)

For this sub-project, ship only a placeholder `index.html` with auth check + link list to sessions. Full UI is sub-project #2.

### `scripts/bin/fleet` — CLI

Bash wrapper using REST API. ~80 LOC.

```
fleet hosts                              # list registered hosts
fleet sessions list [--host <id>]        # list sessions
fleet sessions tail <session_id>         # follow transcript (curl /transcript)
fleet sessions kill <session_id>         # POST kill
fleet sessions spawn --host <id> -- claude --print 'hi'
```

## Data Model (Postgres)

Migration: `sql/004-fleet-init.sql`.

```sql
CREATE TABLE fleet_hosts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text UNIQUE NOT NULL,
  os             text,
  arch           text,
  capabilities   text[] DEFAULT '{}',
  status         text NOT NULL DEFAULT 'offline'
                   CHECK (status IN ('online','offline')),
  daemon_version text,
  claude_version text,
  registered_at  timestamptz NOT NULL DEFAULT now(),
  last_seen      timestamptz,
  metadata       jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE fleet_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id     uuid NOT NULL REFERENCES fleet_hosts(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','orphaned','exited','killed')),
  cwd         text NOT NULL,
  args        jsonb DEFAULT '[]'::jsonb,
  env         jsonb DEFAULT '{}'::jsonb,
  pid         integer,
  exit_code   integer,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  created_by  text,
  label       text,
  metadata    jsonb DEFAULT '{}'::jsonb
);
CREATE INDEX fleet_sessions_host_status ON fleet_sessions(host_id, status);
CREATE INDEX fleet_sessions_started ON fleet_sessions(started_at DESC);

CREATE TABLE fleet_events (
  id         bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES fleet_sessions(id) ON DELETE CASCADE,
  ts         timestamptz NOT NULL DEFAULT now(),
  kind       text NOT NULL
               CHECK (kind IN ('pty_out','pty_in','lifecycle','meta')),
  seq        bigint NOT NULL,
  payload    bytea,
  size       integer GENERATED ALWAYS AS (length(payload)) STORED
);
CREATE INDEX fleet_events_session_seq ON fleet_events(session_id, seq);
CREATE INDEX fleet_events_ts ON fleet_events(ts);
```

### Retention

Nightly cron in hub: `DELETE FROM fleet_events WHERE ts < now() - interval '30 days' AND kind != 'lifecycle'`. Lifecycle events kept indefinitely for audit. 30 days is the upper bound — may shrink based on real storage growth.

### Why `bytea` for `payload`?

PTY output contains ANSI escape sequences and may include arbitrary non-UTF8 bytes. Storing as `text` would risk encoding errors. `bytea` preserves raw fidelity; UI does decoding via xterm.js.

## API Contract

### REST (under `/api/fleet/*`)

All routes require `Authorization: Bearer $VAULT_RAG_API_TOKEN`. Reuses existing rag-api auth middleware.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/fleet/hosts` | — | `[{id, name, os, status, last_seen, capabilities, claude_version}]` |
| GET | `/fleet/hosts/:id` | — | host detail + active sessions count |
| DELETE | `/fleet/hosts/:id` | — | unregister; cascades sessions |
| GET | `/fleet/sessions` | query: `host_id`, `status`, `limit`, `offset` | session list |
| GET | `/fleet/sessions/:id` | — | session detail (no payload bytes) |
| POST | `/fleet/sessions` | `{host_id, cwd, args?, env?, label?, metadata?}` | `201 {session_id}` |
| POST | `/fleet/sessions/:id/input` | `{data}` (text or base64) | `204` |
| POST | `/fleet/sessions/:id/kill` | `{signal?}` (default SIGTERM; daemon escalates to SIGKILL after 5 s grace) | `204` |
| GET | `/fleet/sessions/:id/transcript` | `?since_seq&limit&kind` | NDJSON stream of events |
| GET | `/fleet/sessions/:id/transcript.txt` | — | plain text (ANSI stripped) |

Error codes:
- `401` — missing/invalid Bearer
- `404` — host/session not found
- `409` — attach attempt on exited session
- `410` — host offline
- `422` — invalid payload

### WebSocket — `/api/fleet/ws`

Single endpoint, role disambiguated by query.

**Daemon connect:** `?role=daemon&host_name=<name>&daemon_version=<v>`

```
daemon → hub:
  {type: "hello", host_name, os, arch, capabilities[], claude_version}
  {type: "ping"}
  {type: "spawn_ok", session_id, pid}
  {type: "spawn_err", session_id, error}
  {type: "pty_data", session_id, seq, data}        // data = base64(bytes)
  {type: "session_exit", session_id, exit_code, signal?}
  {type: "reconciliation", sessions: [{session_id, pid, alive, last_seq, exit_code?}]}

hub → daemon:
  {type: "welcome", host_id, server_version}
  {type: "pong"}
  {type: "spawn", session_id, cwd, args, env}
  {type: "input", session_id, data}                // base64
  {type: "kill", session_id, signal}
  {type: "resize", session_id, cols, rows}
```

**Viewer connect:** `?role=viewer&session_id=<id>`

```
hub → viewer:
  {type: "hello", session_id, host_id, status, cwd, cols, rows}
  {type: "backfill", from_seq, to_seq, data}       // ring-buffer dump
  {type: "pty_data", seq, data}                    // live stream
  {type: "session_exit", exit_code}

viewer → hub:
  {type: "input", data}
  {type: "resize", cols, rows}
  {type: "kill"}
```

### Frame size & ordering

- Max frame: 64 KiB. Larger PTY reads are fragmented into multiple `pty_data` frames with incrementing `seq`.
- `seq` is monotonic per session, never reset (survives reconnect).
- Daemon checkpoints `last_seq` to `sessions.json` every 100 frames or on graceful shutdown.
- Hub uses `seq` for dedup on reconnect (frames with seq already in Postgres are dropped).

## Data Flow

### Host enrollment

```
daemon start → WS dial /api/fleet/ws with Bearer token
hub: validate token → upsert fleet_hosts by name → status=online
hub → daemon: {welcome, host_id}
daemon: persist host_id to ~/.agent-fleet/config.json
```

Auto-enrollment on first connect (no manual approval flow in MVP).

### Session spawn

```
UI/CLI: POST /api/fleet/sessions {host_id, cwd, args}
hub: INSERT fleet_sessions(status=pending) → return session_id
hub → daemon WS: {spawn, session_id, cwd, args, env}
daemon: pty.spawn() → emit spawn_ok with pid
hub: UPDATE fleet_sessions(status=running, pid, started_at)
hub → viewers: broadcast {session_started}
```

### Live IO

```
claude writes stdout → daemon PTY reads → WS pty_data frame to hub
hub:
  ├─ append to fleet_events (batched, async)
  ├─ update ring buffer (last 64 KiB)
  └─ fanout to subscribed viewers

viewer types → WS input frame → hub forwards to daemon → daemon writes to PTY stdin
```

### Viewer attach

```
viewer opens /fleet/sessions/abc-123
WS dial ?role=viewer&session_id=abc-123
hub:
  ├─ check session exists, not exited
  ├─ send {hello, session_id, host_id, status, cwd, cols, rows}
  ├─ send {backfill, data: ring-buffer last 64 KiB}
  └─ subscribe to live stream
```

## Failure Handling

### Source of truth split

- **Hub (Postgres)** is authoritative for: host registry, session metadata (cwd, args, label, started_at), event log, viewer routing.
- **Daemon** is authoritative for: PTY runtime state (alive/dead, pid, current seq, exit code/signal). The kernel tells the daemon; the daemon tells the hub via frames.

On reconciliation conflicts, hub accepts daemon's runtime view (e.g., if hub had `status=running` but daemon's reconciliation says session is dead → hub updates to `exited`).

### Disconnect scenarios

| Scenario | Daemon behavior | Hub behavior | Viewer experience |
|---|---|---|---|
| Hub restart | WS close (1001) → reconnect with backoff | On startup: `UPDATE fleet_sessions SET status='orphaned' WHERE status='running'`; restored to `running` upon daemon reconciliation | Brief "host offline" → resume with seq-based backfill |
| Network blip (1-30s) | Reconnect with backoff + jitter | Heartbeat timeout (90s) → status=offline → broadcast | "host offline" badge; live stream pauses; auto-resume on reconnect |
| Hub unreachable >30 min | PTYs continue locally; daemon buffers `pty_data` to `~/.agent-fleet/buffer/<sid>.log`; reconnect every 30s | Sessions in DB stay `orphaned` | Dashboard shows host offline + last_seen |
| Daemon crash/kill | WS close; PTY children die with SIGHUP | Host offline; sessions → `exited` after 60s grace | Host offline; sessions marked exited |
| `claude` exits normally | PTY emits exit → daemon sends `session_exit, code=0` | UPDATE fleet_sessions: exited, code=0, ended_at | "session ended" badge |
| Host hard reboot | Daemon restarts (systemd/launchd); reads sessions.json; PIDs gone → marks all exited in reconciliation frame | Updates DB to exited | Sessions marked exited with no live data |

### Backpressure

- **Daemon → hub overflow**: WS write buffer >1 MiB → daemon pauses PTY read (`pty.pause()`). claude blocks on stdout write — acceptable; slow agent > lost data.
- **Hub → viewer slow consumer**: per-viewer queue, max 256 frames. Overflow → disconnect with code 4002. UI reconnects + backfills from ring buffer.
- **Postgres write lag**: events written in batches of 50 frames or 200 ms. If DB lags >5s, hub drops `pty_out` events (lifecycle still written) and logs an alert.

## Authentication

### Token model

Single shared token: `VAULT_RAG_API_TOKEN` (already stored in vault as secret). Reuses existing rag-api Bearer middleware.

Daemon reads token from `--token` flag, env var `AGENT_FLEET_TOKEN`, or fallback `VAULT_RAG_API_TOKEN`.

### Token rotation

`vt secrets rotate VAULT_RAG_API_TOKEN`. Requires rag-api process restart (same as current behavior for other secrets — not a regression). Daemons need `--token` update via redeploy.

### Not in MVP

- Per-host mTLS
- OIDC/web login (UI uses token in URL fragment or localStorage for MVP)
- Separate audit log table (lifecycle events in `fleet_events` already serve this)
- Per-host rate limiting (Caddy + daemon's reconnect backoff sufficient)

### Risks

- Single token compromise = full system breach. Same risk model as current vault-rag. Mitigation: rotation via `vt secrets rotate`.
- UI localStorage token exposed to XSS. Mitigation: UI served from same origin, strict CSP, no untrusted content rendered as HTML.

## Components Boundaries

Each component has one clear job and a well-defined interface:

- **daemon** owns PTY lifecycle on its host. Knows nothing about other hosts or about Postgres. Communicates only via WS frames.
- **fleet-routes.js** owns the WS protocol and HTTP API surface. Translates between WS frames and Postgres writes.
- **fleet-db.js** owns Postgres queries. Knows nothing about WS or HTTP. Reusable by any caller.
- **fleet CLI** is a pure REST client. Adds no logic; only formatting.

Files that change together stay together (daemon code in one dir, hub code split by concern in `scripts/lib/`).

## Testing Strategy

### Unit tests

- `daemon/`: mock PTY + mock WS. Verify reconnect/backoff, frame serialization, seq monotonicity, sessions.json round-trip.
- `fleet-routes.js`: supertest against in-process rag-api, ephemeral postgres in docker. Auth, validation, DB writes.
- `fleet-db.js`: CRUD against test DB. Migration up/down.

Coverage target: 70% line, 100% on reconnect logic, seq handling, kill flow.

### Integration test

`tests/fleet-e2e.sh` mirrors existing `tests/smoke.sh` style:

```
1. docker compose up
2. Start daemon: node scripts/fleet/daemon.js --host-name test-host &
3. POST /api/fleet/sessions with args ['--print', '-c', 'echo hello']
4. GET /api/fleet/sessions/<id>/transcript.txt → expect 'hello'
5. WS viewer: send input 'world\n', expect echo back
6. POST /api/fleet/sessions/<id>/kill → expect status=killed
7. SIGKILL daemon → restart → reconciliation frame → hub sees exited
8. docker compose down
```

`claude` is mocked via `tests/fleet/fake-claude.sh` (bash script echoing input back, configurable exit codes).

### Manual smoke

- Real MacBook → real brain hub: `npx @bringie/agent-fleet-daemon`.
- Spawn session with `claude --print`, then with interactive claude, then kill, then force-disconnect daemon.

### Not in MVP

- Load tests (concurrent sessions, sustained MB/s).
- CI workflow (will reuse whatever vault-rag-oss adds).

## Repo Layout

Monorepo `vault-rag-oss/`:

```
agent-fleet/
  daemon/
    package.json                  # @bringie/agent-fleet-daemon
    bin/daemon.js                 # entry point (npx invocation)
    src/
      pty-manager.js
      ws-client.js
      session-store.js            # sessions.json persistence
      reconnect.js
    test/
      pty-manager.test.js
      ws-client.test.js
      reconnect.test.js
  web/
    index.html                    # placeholder; real UI in sub-project #2
    fleet.css
  README.md
scripts/
  lib/
    fleet-routes.js               # NEW: HTTP + WS routes
    fleet-db.js                   # NEW: postgres CRUD
    fleet-event-batcher.js        # NEW: batched event writes
    fleet-ring-buffer.js          # NEW: per-session ring buffer
  bin/
    fleet                          # NEW: CLI
sql/
  004-fleet-init.sql              # NEW: schema migration
tests/
  fleet-e2e.sh                    # NEW: end-to-end smoke
  fleet/
    fake-claude.sh
    test-db.sql
```

`rag-api.js` gains one import + one route mount:

```js
const fleetRoutes = require('./lib/fleet-routes');
// ... existing route mounts ...
fleetRoutes.mount(app, server, db);  // server for WS upgrade
```

## Open Questions (deferred to later sub-projects)

- How does sub-project #3 (`vt remote claim --host=X`) route by capabilities? → Decided when we design sub-project #3.
- Token-monitor integration: per-session cost attribution requires capturing `claude` JSON `--output-format` somewhere. → Sub-project #4.
- Multi-user permissions: when does the system need them? Likely never — single operator + shared token. If shared, we'll add per-token scopes.

## Acceptance Criteria for Sub-project #1

- [ ] Daemon installs via `npx @bringie/agent-fleet-daemon` on macOS + Linux.
- [ ] Daemon registers with hub on first connect; persisted as `fleet_hosts` row.
- [ ] `POST /api/fleet/sessions` spawns claude on the chosen host; returns `session_id`.
- [ ] PTY output streams to viewers via WS in real time (<200 ms latency p99 on LAN).
- [ ] Input from viewer reaches PTY stdin.
- [ ] `POST .../kill` terminates session; status=killed in DB.
- [ ] Daemon crash + restart → reconciliation frame → hub correctly marks dead sessions exited.
- [ ] Hub restart → daemons reconnect; live sessions resume streaming.
- [ ] `tests/fleet-e2e.sh` passes in CI.
- [ ] `scripts/bin/fleet` CLI lists hosts, lists sessions, tails transcript.
