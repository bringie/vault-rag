# vt as REST + MCP first-class surface in vault-rag

**Date:** 2026-05-09
**Status:** Approved (direction); pending spec sign-off

## Goal

Make `vt` (vault task tracker) a first-class part of the vault-rag stack. Tasks live in the same vault that the RAG indexes; any agent talking to vault-rag (REST or MCP) can create, claim, close, and query tasks. Eliminates the current split where `vt` writes only to a local OSS-repo workspace invisible to the prod MCP.

## Why

- Today `vt` writes to `<oss-repo>/obsidian-vault/06-tasks/`, but production MCP indexes a different vault (`/root/obsidian-vault` on the brain server). Tasks are invisible to agents.
- We want one task tracker shared across all agents, queryable through the same API surface as the rest of the vault.
- We want vt to ship as part of the vault-rag project, advertised in the README.

## Decisions (from brainstorming)

| Area | Decision |
|---|---|
| Storage of truth | Markdown files in `/vault/06-tasks/*.md` (no extra DB table). |
| CLI mode | REST-only thin client. Requires `VAULT_RAG_URL` + `VAULT_RAG_API_TOKEN`. |
| Scope v1 | Full parity with current vt: create, list, ready, show, claim, close, update, dep add, dep rm, remember. |
| Agent identity | Self-declared via `by` field in body (or `X-Agent` header). One shared API token. |
| MCP shape | One tool per operation: `task_create`, `task_list`, `task_ready`, `task_show`, `task_claim`, `task_close`, `task_update`, `task_dep_add`, `task_dep_rm`. |
| Implementation strategy | Extract vt logic into `vt-core.js`; mount routes on existing `rag-api`. New MCP tools in existing `mcp-shim`. |

## Architecture

```
File layout (under /opt/vault-rag/scripts/):
  vt-core.js       NEW       Pure logic: frontmatter parsing, allocSeq, listing, filtering, file IO.
                             Zero HTTP. Operates on a vault-dir argument.
  rag-api.js       MODIFY    Imports vt-core. Mounts POST /api/task/* router. Vault dir = process.env.VAULT_PATH.
  mcp-shim.js      MODIFY    Registers 9 task_* tools. Each tool proxies to rag-api over HTTP.
  vt.js            REWRITE   REST client (~150 LOC). CLI parsing + fetch. No filesystem code.
  bin/vt           UNCHANGED Launcher script.
  vt-migrate.js    NEW       One-shot: copy local 06-tasks/*.md into vault via /api/task/import.

Containers:
  vault-rag-api    only writer to /vault/06-tasks/. Already mounts /vault rw.
  vault-rag-mcp    talks to rag-api over docker network (existing pattern).

Concurrency:
  Single rag-api process = single writer, no extra locking needed.
  .vt/seq counter atomicity preserved via O_EXCL retry loop (lifted verbatim from current vt.js).
```

### Data flow

```
vt CLI:
  vt create -t epic -p 1 "Goal"
    → POST https://brain/api/task/create  Bearer ...
       Body {title:"Goal", type:"epic", priority:1}
    → rag-api: vt-core.create(VAULT_PATH, args)
    → write /vault/06-tasks/vt-NNNN-goal.md
    → return {id:"vt-NNNN", path:...}

Agent via MCP:
  tool_call task_create {title:"Goal", type:"epic"}
    → mcp-shim: fetch http://vault-rag-api:5679/api/task/create  Bearer ...
    → rag-api: same path as above
    → return same JSON
```

## REST API

All routes are `POST` with JSON bodies. Auth: `Authorization: Bearer ${VAULT_RAG_API_TOKEN}` (same token as existing `/api/*`). Errors return `{error:"..."}` with appropriate HTTP status.

### `POST /api/task/create`

Body:
```json
{
  "title": "string (required)",
  "type": "task|epic|bug|chore (default: task)",
  "priority": "0-3 (default: 2)",
  "epic": "vt-NNNN (optional)",
  "blocked_by": ["vt-NNNN", "..."] ,
  "by": "agent-name (optional, default: 'agent')"
}
```
Returns: `{id:"vt-NNNN", path:"06-tasks/vt-NNNN-slug.md"}`. Increments `.vt/seq` atomically.

### `POST /api/task/list`

Body: `{status?, all?, type?}`. Default: open tasks only.
Returns: `[{id, title, type, status, priority, claimed_by, blocked_by[], epic, created}]`.

### `POST /api/task/ready`

Body: `{}`. Returns open tasks that are unblocked (no `blocked_by` referencing an open task), sorted by `priority` ascending.

### `POST /api/task/show`

Body: `{id, json?}`. Returns full task object (frontmatter + body). If `json:false`, returns rendered markdown string.

### `POST /api/task/claim`

Body: `{id, by?, force?}`. Sets `status:in_progress`, `claimed_by:<by>`. If already claimed and `force` not set: 409 conflict.

### `POST /api/task/close`

Body: `{id, reason (required)}`. Sets `status:closed`, `closed_reason:<reason>`, `closed_at:<ISO>`.

### `POST /api/task/update`

Body: `{id, status?, priority?, body?}`. Validates `status` against `open|in_progress|blocked|closed`.

### `POST /api/task/dep_add`

Body: `{id, blocked_by}`. Adds `<blocked_by>` to the `blocked_by` list. Idempotent.

### `POST /api/task/dep_rm`

Body: `{id, blocked_by}`. Removes from list. Idempotent.

### Error model

| Status | Meaning |
|---|---|
| 400 | Invalid body (missing required field, bad enum value, malformed id) |
| 401 | Missing/wrong Bearer |
| 404 | Task id not found |
| 409 | Conflict (e.g. claim already-claimed without `force`) |
| 500 | Filesystem or parse error |

## MCP Tools

Registered in `mcp-shim.js`. Auth: `X-Vault-Token: ${VAULT_RAG_MCP_TOKEN}` (existing MCP token). Each tool proxies to the matching REST endpoint with the same JSON body.

| Tool | REST mirror |
|---|---|
| `task_create` | `/api/task/create` |
| `task_list` | `/api/task/list` |
| `task_ready` | `/api/task/ready` |
| `task_show` | `/api/task/show` |
| `task_claim` | `/api/task/claim` |
| `task_close` | `/api/task/close` |
| `task_update` | `/api/task/update` |
| `task_dep_add` | `/api/task/dep_add` |
| `task_dep_rm` | `/api/task/dep_rm` |

Tool descriptions in MCP advertise the same input schema as REST bodies.

## CLI

`vt` becomes a thin REST client.

Required env:
- `VAULT_RAG_URL` (e.g. `https://brain.itiswednesdaymydud.es`)
- `VAULT_RAG_API_TOKEN`

Optional:
- `VT_AGENT` (default `agent`) - sent as `by` field on create/claim.

Command map (1:1 with current vt; flags unchanged where possible):

| Old command | New behaviour |
|---|---|
| `vt create -t epic -p 1 "X"` | POST /api/task/create |
| `vt list [--all] [--status S] [--type T]` | POST /api/task/list |
| `vt ready` | POST /api/task/ready |
| `vt show <id> [--json]` | POST /api/task/show |
| `vt claim <id> [--by NAME] [--force]` | POST /api/task/claim |
| `vt close <id> --reason "..."` | POST /api/task/close |
| `vt update <id> --status S [--priority P]` | POST /api/task/update |
| `vt dep add <id> --blocked-by <other>` | POST /api/task/dep_add |
| `vt dep rm <id> --blocked-by <other>` | POST /api/task/dep_rm |
| `vt remember "note" [--tags ...]` | POST /api/put (existing endpoint) |
| `vt prime` | static help text, no network |

If env missing: print actionable error and exit 1.

## Migration

Hard cut, no backward compat:

1. Implement server side + new CLI on a branch.
2. Run `vt-migrate.js`: reads existing `<oss-repo>/obsidian-vault/06-tasks/*.md` and posts each to `POST /api/task/import` with body `{path: "06-tasks/vt-NNNN-slug.md", content: "<full markdown including frontmatter>"}`. The endpoint writes verbatim and updates `.vt/seq` to `max(seq, max(id))`. It is gated on env `VAULT_RAG_ALLOW_IMPORT=1` and refuses if the file already exists.
3. After migration verified: remove `/api/task/import`, remove old vt.js filesystem code paths.
4. Existing local `obsidian-vault/06-tasks/` in the OSS repo is left as documentation/example, not used at runtime.

The two existing tasks (vt-0001, vt-0002) get migrated.

## Testing

| Layer | What | How |
|---|---|---|
| vt-core unit | Frontmatter parse/serialize, allocSeq atomic, list/ready filters, dep cycle prevention | `node --test` against tmpdir |
| REST routes | Each endpoint: happy path + 400/404/409 cases | `node --test` + supertest against an in-process rag-api with a tmpdir vault |
| MCP tools | Each tool round-trips through mcp-shim → rag-api | `node --test`, mock fetch or local rag-api |
| CLI | All current `tests/test-vt.bats` cases pass against a test rag-api | bats; rewrite setup() to spin up a temp rag-api or use `VAULT_RAG_URL` pointing at a fixture |
| Smoke (prod-like) | docker compose up; create/claim/close one task end-to-end via curl + MCP | shell script in `scripts/smoke-tasks.sh` |

CI: extend existing test pipeline to include the new node and bats tests.

## Documentation

- `README.md` (and `.ru.md`, `.es.md`): new "Task Tracking" section between "Indexing" and "FAQ". Show one curl example, one MCP tool example, one `vt` CLI example.
- `docs/api.md`: add `/api/task/*` endpoints.
- `docs/tasks.md` (new): full vt CLI reference, agent workflow, dependency model, examples.
- `docs/superpowers/specs/2026-05-09-vt-rest-mcp-design.md`: this file.

## Out of scope

- Postgres index of tasks (chosen explicitly: markdown only). If list-perf becomes an issue at >1000 tasks, revisit.
- Per-agent tokens (chosen self-declared). Can layer on later by mapping token → agent_id without changing the surface.
- Webhooks / change subscriptions. Not needed for v1; agents poll `task_ready`.
- Web UI. Markdown in Obsidian is the UI.

## Risks

| Risk | Mitigation |
|---|---|
| Local CLI users without server reachability | Document hard requirement; fail loudly with helpful error. Optional `--server-required-help` flag prints config example. |
| Race when two agents claim the same task | Server is single writer; `claim` checks `claimed_by` field before write inside the same handler. Last-writer-wins prevented by re-reading file before writing. |
| `.vt/seq` corruption | O_EXCL retry loop already battle-tested in current vt.js. Carry over verbatim. |
| Indexer churn from frequent task writes | Indexer is incremental (mtime). Task files are small. Acceptable. |
| Existing tests rely on filesystem layout | Rewrite bats tests to use REST. Keep vt-core unit tests for the filesystem invariants. |

## Acceptance criteria

- `vt create/list/ready/show/claim/close/update/dep` all work against prod via REST.
- All 9 MCP `task_*` tools listed by `tools/list` and callable.
- Existing `tests/test-vt.bats` passes against the new REST-backed CLI.
- README docs show three call patterns (curl, MCP, vt) and they all work.
- vt-0001 and vt-0002 visible in `/vault/06-tasks/` on prod after migration.
