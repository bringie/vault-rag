# Portal e2e Test Plan

Coverage matrix for brain.itiswednesdaymydud.es. Runs via Playwright;
delegated to a Haiku sub-agent after every deploy. Spec files live in
`tests/e2e/specs/`. The harness writes `tests/e2e/last-run.json` so the
sub-agent can produce a concise pass/fail report without re-reading
Playwright's HTML output.

## Test environment

| Item | Value |
|---|---|
| Base URL | `https://brain.itiswednesdaymydud.es` |
| Viewer token | `$VAULT_RAG_API_TOKEN` (from `.env`) |
| Admin token | `$VAULT_RAG_FLEET_ADMIN_TOKEN` (from `.env`) |
| Browser | Chromium headless |
| Timeout | 30s per test, 5min total |
| Parallel | 1 worker (avoid cross-test interference) |

## Coverage matrix

### Auth & navigation (smoke)

| ID | Scenario | Pass criteria |
|---|---|---|
| nav-01 | Cold load, no token in localStorage | Auth screen visible, no JS errors |
| nav-02 | Paste viewer token → app shows | `#app` visible, no JS errors |
| nav-03 | Paste admin token → app shows with admin flag | `state.isAdmin = true` via whoami |
| nav-04 | Click every nav button (dashboard, vault, archive, cost, groups, workflows, prices, vault, health, audit, agent-roles) | Each panel becomes visible, no console errors |
| nav-05 | Back button returns to dashboard | `#vaultview` etc. become hidden |
| nav-06 | Hash routing direct: `#/agent-roles` opens roles | Panel visible without click |

### REST surface (no UI)

| ID | Endpoint | Method | Auth | Expected |
|---|---|---|---|---|
| rest-01 | `/api/fleet/auth/whoami` | GET | viewer | 200 `{role:viewer}` |
| rest-02 | `/api/fleet/auth/whoami` | GET | admin | 200 `{role:admin}` |
| rest-03 | `/api/fleet/auth/whoami` | GET | none | 401 |
| rest-04 | `/api/fleet/features` | GET | viewer | 200 array |
| rest-05 | `/api/fleet/features/audit` | PATCH | viewer | 403 admin required |
| rest-06 | `/api/fleet/features/audit` | PATCH | admin | 200 toggle works |
| rest-07 | `/api/fleet/agent-roles` | GET | viewer | 200 redacted (no `prompt` field) |
| rest-08 | `/api/fleet/agent-roles` | GET | admin | 200 full `prompt` present |
| rest-09 | `/api/fleet/recycle-bin` | GET | viewer | 200 `{groups, workflows}` |
| rest-10 | `/api/fleet/prices` | GET | viewer | 200 array |
| rest-11 | `/api/fleet/prices/resolve` | POST | admin | 200 `{matched}` |
| rest-12 | `/api/fleet/hosts` | GET | viewer | 200 array |
| rest-13 | `/api/fleet/sessions` | GET | viewer | 200 array |
| rest-14 | `/api/fleet/groups` | GET | viewer | 200 array |
| rest-15 | `/api/fleet/cost/summary?days=7` | GET | viewer | 200 `{days,hosts}` |
| rest-16 | `/api/fleet/workflow-pending-approvals` | GET | viewer | 200 array |
| rest-17 | `/api/fleet/stack-status` | GET | viewer | 200 |
| rest-18 | `/api/secrets/list` | POST | viewer | 200 `{names}` |
| rest-19 | `/api/secrets/set` | POST | viewer | 403 admin required (C1) |
| rest-20 | `/api/secrets/set` | POST | admin | 200 (with cleanup) |
| rest-21 | `/api/healthz/detail` | GET | viewer | 200 with subsystems |
| rest-22 | `/api/audit?limit=10` | GET | viewer | 200 array |
| rest-23 | `/api/notes/index` | GET | viewer | 200 |
| rest-24 | `/api/notes/list?prefix=` | GET | viewer | 200 array |
| rest-25 | `/api/search` | POST | viewer | 200 `{results}` |

### Vault tab (read-only SPA)

| ID | Scenario | Pass criteria |
|---|---|---|
| vault-01 | Open vault → notes tree loads | `#vault-tree` has children, no error text |
| vault-02 | Click a note → markdown renders | `<article>` content visible |
| vault-03 | Search box filter changes tree | Reduces visible items |
| vault-04 | Switch to graph tab | Canvas element visible |
| vault-05 | Switch to secrets tab | Secret list loads (names only, viewer-OK) |

### Agent-roles tab

| ID | Scenario | Pass criteria |
|---|---|---|
| roles-01 | List opens, shows ≥ 1 row | Table populated |
| roles-02 | Viewer sees `prompt_bytes` + `prompt_sha`, NOT raw prompt | Inspect first row JSON |
| roles-03 | Admin sees raw `prompt` field | Inspect first row JSON |
| roles-04 | Admin create role → row appears | New row visible, then delete cleanup |
| roles-05 | Admin edit role → save | Updated row reflects change |

### Workflows tab

| ID | Scenario | Pass criteria |
|---|---|---|
| wf-01 | Workflows list opens | List populated or empty-state visible |
| wf-02 | Click a workflow → editor opens | Workflow canvas/JSON visible |

### Prices tab

| ID | Scenario | Pass criteria |
|---|---|---|
| price-01 | Prices list opens | Table populated |
| price-02 | Resolve modal works | Match preview renders for `claude-opus-4-7` |

### Cost / dashboards

| ID | Scenario | Pass criteria |
|---|---|---|
| cost-01 | Cost trends page opens | Chart container visible |
| cost-02 | 7-day summary numbers render | At least one row total > 0 |
| health-01 | Health page opens | Subsystem grid visible |
| health-02 | All subsystems report ok/warn (not error) | No 🔴 indicators |
| audit-01 | Audit feed opens, populated | Rows visible |
| audit-02 | Filter by op → fewer rows | Count decreases |
| audit-03 | CSV export | Downloads / 200 response |

### Recycle bin

| ID | Scenario | Pass criteria |
|---|---|---|
| recycle-01 | Open recycle-bin route | Panel visible |
| recycle-02 | Lists empty or populated | No JS error |

### Security regression suite

| ID | Scenario | Pass criteria |
|---|---|---|
| sec-01 (C1) | Viewer `/api/secrets/set` | 403 |
| sec-02 (C1) | Admin `/api/secrets/set` | 200 + cleanup |
| sec-03 (C2) | Caddy responds with rate-limit aware on bursts | First 30 ok, 31st 429 within 1m window — skip in normal smoke |
| sec-04 (H4) | Mint ticket with scope_id "sess-A", attempt WS upgrade to session_id "sess-B" | WS closes 4001 |
| sec-05 (H4) | Mint ticket scoped correctly | WS upgrade succeeds (or progresses past auth) |
| sec-06 (L7) | CSP header | Contains `connect-src 'self' wss://${VAULT_RAG_DOMAIN}` |
| sec-07 (favicon) | `/favicon.ico` | 204 |
| sec-08 (fonts) | No external font requests in fleet HTML | `grep -v fonts.googleapis` on response body |
| sec-09 (audit-feed) | Audit endpoint reachable, returns rows | viewer 200 |

### Console hygiene

| ID | Scenario | Pass criteria |
|---|---|---|
| console-01 | After visiting every nav route, no `console.error`/`error` event | Array empty |
| console-02 | No `Uncaught` or `Failed` in `page.on('pageerror')` | Array empty |
| console-03 | No CSP violations | No `Content Security Policy` warnings |

## Non-goals (out of scope)

- Spawning real Claude sessions on a daemon host
- Workflow execution end-to-end (requires admin token in CI + real host)
- Forgejo (third-party UI)
- Grafana (third-party UI)
- MCP transport via stdio (uses different protocol)

## Run modes

- **Full suite** (CI / pre-release): `npx playwright test`
- **Smoke** (post-deploy gate): `npx playwright test --grep "@smoke"`
- **REST only** (no browser): `npx playwright test specs/rest.spec.js`

## Delegation pattern

After every `vault-rag-upgrade --skip-backup` completes, dispatch a
Haiku sub-agent with the prompt:

> Run `tests/e2e/run.sh` from `/root/work/vault-rag-oss`. It executes
> `npx playwright test` headless against prod. Report only failures.
> If `last-run.json` shows 0 failures, reply `ok`. Otherwise list the
> failing test IDs and the first 200 chars of each error message.
> Stay under 200 words.

The sub-agent has read-only access (no Edit/Write tools) — it cannot
fix what it finds. The parent agent triages and fixes.
