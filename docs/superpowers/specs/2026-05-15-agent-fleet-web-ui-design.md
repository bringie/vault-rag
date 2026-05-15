# Agent Fleet Web UI — Design Spec

**Date:** 2026-05-15
**Status:** Draft
**Scope:** Sub-project #2 of agent-fleet — browser UI for the hub built in sub-project #1.

## Goal

Single-page split-pane web app served from rag-api. Lists hosts and sessions on the left, shows live session terminal on the right. Auth via existing `VAULT_RAG_API_TOKEN`. Mobile-friendly enough that I can check a long-running session from a phone.

## Non-goals

- No multi-user, no per-user permissions
- No file editor / diff viewer (sub-project for later)
- No graph/charts (cost UI is sub-project #4)
- No offline mode / PWA

## Architecture

```
Browser
├── GET /fleet/ → index.html (static, served by rag-api)
├── GET /fleet/static/* → app.js, app.css, xterm.css, xterm.js, addon-fit.js
└── auth: token in localStorage; on first load read from URL fragment (#token=...) and persist

Browser ↔ Hub
├── REST polling: GET /api/fleet/hosts, /api/fleet/sessions every 5s for sidebar
├── WS: /api/fleet/ws?role=viewer&session_id=... for terminal stream
└── Bearer header on all requests
```

## UI Layout

```
┌────────────────────────────────────────────────────────────┐
│  agent-fleet · 3 hosts · 2 active sessions    [⟳] [+ new] │
├──────────────────┬─────────────────────────────────────────┤
│ HOSTS            │ session: a3b… on macbook-1 · running    │
│ ● mac1   (2)     │ cwd: /Users/me/proj                     │
│ ○ ai-host (0)    │ [send input] [kill] [resize]            │
│ ○ vm-rds (1)     ├─────────────────────────────────────────┤
│                  │                                         │
│ SESSIONS         │   (xterm.js terminal — 80×24+)          │
│ ▶ a3b… macbook   │                                         │
│   ▶ b2c… vm-rds  │                                         │
│   ◇ exit f8d…    │                                         │
│                  │                                         │
├──────────────────┤                                         │
│ [+ Spawn session]│                                         │
│ host: [mac1   ▼] │                                         │
│ args: [--print…] │                                         │
│ [Spawn]          │                                         │
└──────────────────┴─────────────────────────────────────────┘
```

Mobile (<768px): sidebar collapses behind a hamburger; terminal takes full width.

## Components

| File | Purpose |
|---|---|
| `agent-fleet/web/index.html` | static page, links to css+js, includes xterm css |
| `agent-fleet/web/app.css` | layout + dark theme |
| `agent-fleet/web/app.js` | vanilla JS: auth, polling, WS viewer, xterm init, spawn form |
| `agent-fleet/web/xterm.min.js` (vendored) | xterm.js v5 |
| `agent-fleet/web/xterm.min.css` (vendored) | xterm.js styles |
| `agent-fleet/web/xterm-addon-fit.min.js` (vendored) | resize addon |
| `scripts/lib/fleet-static.js` | rag-api handler that serves `agent-fleet/web/*` |

Vendoring: tiny single-file `app.js`. xterm.js loaded from local copies to avoid CDN dependency (per vault-rag-oss "no CDN" convention).

## Routes added

- `GET /fleet/` → serve `index.html` (no auth, page handles auth via fragment+localStorage)
- `GET /fleet/static/<file>` → serve from `agent-fleet/web/<file>` (no auth on static)
- (existing `/api/fleet/*` and `/api/fleet/ws` reused)

Note: `dispatchHttp` currently sends 404 for GET to non-existing fleet path. Need fleet-static handler to intercept `GET /fleet/` and `GET /fleet/static/...` **before** auth check.

## App.js behavior

**Auth flow**:
1. On load: check `localStorage.fleetToken`
2. If missing: check URL fragment `#token=...`, persist to localStorage, strip fragment
3. If still missing: show centered "paste token" prompt input

**State**:
```js
state = {
  token: string,
  hosts: [],
  sessions: [],
  selectedSessionId: null,
  ws: null,  // active viewer ws
  term: null, // xterm instance
}
```

**Polling**: every 5s, fetch hosts+sessions; redraw sidebar (diff-based — don't blow away DOM).

**WS attach**: on session click, close existing ws, open new viewer ws, hook ws messages → terminal:
- `hello` → set title bar
- `backfill` → `term.write(base64decode(data))`
- `pty_data` → `term.write(base64decode(data))`
- `session_exit` → show grey overlay

**Input from terminal**: xterm `onData` → `ws.send({type:'input', data})`

**Resize**: FitAddon → on container resize, `ws.send({type:'resize', cols, rows})`

**Spawn form**: POST `/api/fleet/sessions {host_id, cwd, args}`. On 201, select new session immediately.

## Failure UI

- Token rejected (401): show "token invalid" + clear localStorage
- WS close: show "disconnected, retrying…" + auto-reconnect with 1s/2s/4s backoff
- Session ended: grey overlay over terminal, "session exited (code N)"
- Host offline: hosts list shows ○ vs ●, sessions on that host shown as grey

## Testing strategy

- Unit: `fleet-static.test.js` — verify path serving + content-type
- Manual: open browser, end-to-end flow (no headless automation in MVP)
- Use existing `tests/fleet-e2e.sh` daemon + brain pg, browse `http://127.0.0.1:15679/fleet/`

## Acceptance

- [ ] `GET /fleet/` returns HTML page
- [ ] Static assets served correctly
- [ ] Auth via fragment + localStorage works
- [ ] Hosts/sessions list updates every 5s
- [ ] Click session → terminal attaches, backfill + live stream
- [ ] Typing in terminal → input reaches daemon
- [ ] Kill button → session ends
- [ ] Spawn form creates session
- [ ] Mobile layout responsive
