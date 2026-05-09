<p align="center">
  <img src="https://img.shields.io/badge/Self--hosted-RAG_Stack-7C3AED?style=for-the-badge" alt="Self-hosted RAG Stack" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker Compose" />
  <img src="https://img.shields.io/badge/PostgreSQL-pgvector-336791?style=for-the-badge&logo=postgresql&logoColor=white" alt="Postgres + pgvector" />
  <img src="https://img.shields.io/badge/Ollama-nomic--embed--text-000000?style=for-the-badge&logo=ollama&logoColor=white" alt="Ollama" />
  <img src="https://img.shields.io/badge/MCP-Server-FF6F00?style=for-the-badge" alt="MCP Server" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="License: MIT" />
</p>

<p align="center">
  <strong>English</strong> &middot;
  <a href="README.ru.md">Русский</a> &middot;
  <a href="README.es.md">Español</a>
</p>

<h1 align="center">vault-rag</h1>

<p align="center">
  <strong>Self-hosted multi-agent RAG stack for an Obsidian-style markdown vault.</strong>
  <br /><br />
  <em>One Docker Compose. Memory, retrieval, observability, and cost tracking - in one box. Your notes stay on your disk. Your agents stay in sync.</em>
  <br /><br />
  <em>14 containers &middot; REST + MCP &middot; pgvector HNSW &middot; ofelia-driven indexing &middot; vt task CLI &middot; Grafana dashboards</em>
  <br /><br />
  <a href="#what-happens-when-you-use-it">See it in action</a> &middot;
  <a href="#components">All components</a> &middot;
  <a href="#install">Install</a> &middot;
  <a href="#configuration">Configuration</a> &middot;
  <a href="#agent-setup">Agent setup</a> &middot;
  <a href="#faq">FAQ</a>
</p>

---

## The Problem

You run multiple AI agents. Each starts from scratch. Conversations end, context evaporates, decisions are forgotten by morning.

You write notes in Obsidian. Hundreds of files. Agents can't read them, can't search them semantically, can't tell what's stale. You re-explain the same project every session.

You also burn tokens. You don't know which agent costs what. You don't know if your indexer ran last night. You don't know which note answered the last query.

**A vault, agents, observability, and cost tracking - four problems usually solved by four SaaS bills.**

---

## What it is

A 14-container Docker stack that turns a markdown vault into a queryable, observable, agent-friendly knowledge base:

| | Typical SaaS stack | vault-rag |
|---|---|---|
| **Storage** | Vendor cloud, opaque | Plain markdown on your disk, git-versioned via Forgejo |
| **Embeddings** | Per-call API charge | Local Ollama nomic-embed-text (768-dim), zero per-query cost |
| **Vector index** | Managed Pinecone/Weaviate | Postgres + pgvector HNSW, in the same DB as metadata |
| **Agent access** | Custom HTTP each | REST + MCP, both speak the same backend |
| **Indexing** | Manual or cron VPS | ofelia label-driven scheduler in-container, watchdog included |
| **Observability** | Logs in stdout, metrics nowhere | VictoriaMetrics + Grafana, 4 prebuilt dashboards |
| **Cost tracking** | None | token-monitor ingest endpoint, all agents log every call |
| **Task tracking** | External tool | `vt` CLI, tasks live as markdown inside the vault itself |

If you want a vault that is *legible to agents and to humans, while you stay in full control of the data*, this is that.

---

## What Happens When You Use It

**An agent needs context:** `POST /api/search` with `{"query":"postgres migration"}`
Returns top-k chunks with file paths, scores, and `[[backlinks]]`. Vault-aware. Cost: zero per query (local embeddings).

**You drop a note in `00-inbox/`:** ofelia fires `vault-indexer` every 5 min.
The indexer chunks new files, embeds them via Ollama, upserts into pgvector. Watchdog kills runs that hang past 30 min. Job history in `job_runs` table.

**An agent claims a task:** `vt claim vt-0042`
Sets `status: in_progress`, `claimed_by: agent-name` in the task's frontmatter. Other agents see it as not-ready in `vt ready`. Atomic O_EXCL counter at `obsidian-vault/.vt/seq` - no double-claims.

**You want to wire a new agent:** point it at `https://your-domain/mcp`.
MCP server exposes `search`, `get`, `put`, `backlinks`. Same interface every agent uses.

**You want to know what last night cost:** `https://your-domain/grafana/`
Token-monitor ingests every LLM call from every agent. Dashboard shows tokens-by-model, cost-by-project, requests-by-agent. No more guessing.

**A run silently broke:** Watchdog cron logs killed jobs.
`SELECT * FROM job_runs WHERE status='killed'` tells you which job, when, how long it ran before it died.

**A backlink graph question:** `POST /api/backlinks` with `{"target":"02-projects/foo.md"}`
Returns reverse `[[wikilinks]]` resolved at index time. No on-the-fly scanning.

**You commit a change to the vault:** Forgejo holds the vault git history.
Local push, web UI, full audit trail. `obsidian-vault/` itself is gitignored from this repo - it's *your* vault, in *your* git.

**You want a fresh box up tonight:** `./deploy.sh install`
One script. Generates secrets, renders Caddyfile from template, brings 14 containers up, triggers initial vault index. Idempotent - re-run safely.

---

## Before & After

| | Without this stack | With this stack |
|---|---|---|
| Agent reads a note | Custom file IO per agent | One REST/MCP endpoint, every agent uses it |
| Semantic search | Per-query API cost | Free, local, sub-100ms |
| New note indexed | Manual reindex script | ofelia fires every 5 min, watchdog protects |
| Stale embeddings | Whole-vault rebuild | Incremental: hash compare + chunk diff |
| Backlinks | Grep `[[name]]` at runtime | Materialized in `backlinks` table |
| Observability | None | 4 Grafana dashboards out of the box |
| Cost tracking | "Just check OpenAI dashboard" | Per-agent, per-model, per-project, in your own DB |
| Task tracking | Linear / GitHub Issues / TodoWrite | `vt`: markdown tasks in the same vault, atomic counter |
| TLS / rate limit | nginx config you write | Caddy with `Caddyfile.tmpl`, rate_limit per route |
| Backup | Manual `pg_dump` cronjob | `deploy.sh backup` covers postgres, vault, secrets |
| Vault history | Lost on disk loss | Forgejo at `/git/`, full git timeline |
| Stack health | `docker ps`, eyeball | `/api/healthz` + Grafana + watchdog killed-job table |

---

## How It Works

```
  +------------------------------------------+
  |                                          |
  |   LAYER 1: Edge                          |
  |   Caddy + TLS + rate_limit + auth        |
  |                                          |
  +------------------------------------------+
  |                                          |
  |   LAYER 2: Agents                        |
  |   REST API + MCP server                  |
  |   (same backend, two protocols)          |
  |                                          |
  +------------------------------------------+
  |                                          |
  |   LAYER 3: Storage + Compute             |
  |   Postgres + pgvector | Ollama embed     |
  |   Forgejo (git)       | tokmon ingest    |
  |                                          |
  +------------------------------------------+
  |                                          |
  |   LAYER 4: Scheduler                     |
  |   ofelia: indexer 5m, watchdog 5m,       |
  |           audit-cleanup weekly           |
  |                                          |
  +------------------------------------------+
  |                                          |
  |   LAYER 5: Observability                 |
  |   VictoriaMetrics + node + cAdvisor      |
  |   + postgres-exporter + Grafana          |
  |                                          |
  +------------------------------------------+
```

**Layer 1** terminates TLS, rate-limits, and routes by path prefix.
**Layer 2** speaks both REST (for HTTP-native agents) and MCP (for Claude Code, Codex, Gemini CLI).
**Layer 3** is the actual data: chunks + vectors in Postgres, embeddings from Ollama, vault history in Forgejo, every LLM call into tokmon.
**Layer 4** keeps the index live without systemd timers - all crons live as Docker labels on `vault-rag-tools`.
**Layer 5** answers "is it healthy, what does it cost, is it indexing" without you SSHing.

---

## Components

### Edge

| Container | Role |
|---|---|
| `vault-rag-caddy` | TLS + reverse proxy + per-route rate_limit, rendered from `Caddyfile.tmpl` |

### Agents

| Container | Role |
|---|---|
| `vault-rag-api` | REST: `/api/search`, `/api/get`, `/api/put`, `/api/backlinks`, `/api/healthz` (POST except healthz) |
| `vault-rag-mcp` | MCP server, same operations exposed as MCP tools |
| `vault-rag-tokmon-ingest` | Cost-tracking ingest endpoint, accepts agent LLM-call events |

### Storage + compute

| Container | Role |
|---|---|
| `vault-rag-postgres` | pgvector. DBs: `vault_rag` (chunks/backlinks/meta/jobs/job_runs/vault_audit), `tokmon` |
| `vault-rag-ollama` | Local embeddings, `nomic-embed-text` 768-dim |
| `vault-rag-forgejo` | Self-hosted git for vault versioning |

### Scheduler

| Container | Role |
|---|---|
| `vault-rag-tools` | ofelia label host - runs cron jobs as ephemeral containers |
| `vault-rag-ofelia` | ofelia daemon, reads container labels for schedule |

| Job | Schedule | What |
|---|---|---|
| `vault-indexer` | every 5 min | chunk new/changed notes, embed, upsert pgvector |
| `vault-watchdog` | every 5 min | kill index runs older than 30 min |
| `cleanup-audit` | weekly | prune `vault_audit` rows older than retention |

### Observability

| Container | Role |
|---|---|
| `vault-rag-vmsingle` | VictoriaMetrics single-node, scrapes everything below |
| `vault-rag-node-exporter` | host metrics |
| `vault-rag-cadvisor` | container metrics |
| `vault-rag-postgres-exporter` | postgres metrics |
| `vault-rag-grafana` | dashboards: stack overview, indexer jobs, postgres, token cost |

---

## vt: Vault Task CLI

Tasks for agents (and humans) live as markdown inside the vault, not in a SaaS issue tracker.

```bash
vt create -t epic "Migrate indexer to v2"     # create
vt ready                                       # unblocked open tasks
vt claim vt-0042                               # status=in_progress + claimed_by=$VT_AGENT
vt close vt-0042 --reason "shipped in #123"    # done
vt dep add vt-0042 --blocked-by vt-0041        # graph deps
vt remember "Indexer chunks at 1024 tokens"    # save note + auto-push to prod /api/put
vt search "indexer chunk size"                  # vector search via /api/search
```

| Command | What it does |
|---|---|
| `vt create [-t type] [-p prio] "title"` | New task in `06-tasks/vt-NNNN-slug.md` |
| `vt list [--all] [--status X]` | List tasks |
| `vt show <id> [--json]` | Print task |
| `vt claim <id> [--by agent] [--force]` | Claim task |
| `vt close <id> --reason "..."` | Close task |
| `vt update <id> --status X` | Update status |
| `vt ready` | Open tasks with no active blockers, priority-sorted |
| `vt dep add\|rm <id> --blocked-by <other>` | Manage dep graph |
| `vt remember "text" [--tags ...] [--no-sync] [--quiet]` | Note in `09-resources/notes/`, auto-POST to prod `/api/put` (Bearer) |
| `vt search "query" [--limit N] [--json]` | Vector search via `/api/search` (POST + Bearer) |
| `vt prime` | Print full command reference |

Counter is atomic via O_EXCL lockfile at `obsidian-vault/.vt/seq`. No double-numbering across parallel agents. Tasks are plain markdown - editable by hand.

### Client-side .env (for `vt remember`/`vt search` against a remote vault)

`vt` reads `<repo>/.env` (gitignored) to know where to push notes and where to search. Minimum:

```bash
VAULT_RAG_API_URL=https://your-vault.example.com
VAULT_RAG_API_TOKEN=<from /opt/vault-rag/.env on the server>
```

Without these, `vt remember` falls back to local-only and prints `vt: local-only (no VAULT_RAG_API_URL/TOKEN — note NOT pushed to prod)`. `vt search` errors out (it needs the API).

---

## Vault Architecture

`vault-skeleton/` is copied to `obsidian-vault/` on first run. `obsidian-vault/` is gitignored - keep it in your own private git repo.

```
obsidian-vault/
+-- .vt/                # vt counter + state (gitignored from skeleton)
+-- 00-inbox/           # drop new notes here, indexer picks them up
+-- 01-daily/           # daily logs
+-- 02-projects/        # per-project notebooks
+-- 05-sessions/        # chat session dumps from agents
+-- 06-tasks/           # vt-NNNN-slug.md task files
+-- 09-resources/       # long-lived references
|   +-- notes/          # vt remember writes here
|   +-- prompts/        # saved prompts
+-- _CLAUDE.md          # operating manual for agents
+-- index.md            # entry point
```

---

## Install

Requires: Linux host with `docker`, `docker compose`, `openssl`, `envsubst`, and a domain pointed at the host.

One-line:

```bash
git clone https://github.com/bringie/vault-rag.git /opt/vault-rag && cd /opt/vault-rag && cp .env.example .env && $EDITOR .env && ./deploy.sh install
```

Or step-by-step:

```bash
git clone https://github.com/bringie/vault-rag.git /opt/vault-rag
cd /opt/vault-rag
cp .env.example .env
# edit .env: set VAULT_RAG_DOMAIN to your domain
./deploy.sh install
```

`deploy.sh` is idempotent. Re-run any time. It generates secrets on first run, renders `Caddyfile` from `Caddyfile.tmpl`, brings the stack up, and triggers an initial vault index.

After install:

| Endpoint | What |
|---|---|
| `https://${VAULT_RAG_DOMAIN}/api/healthz` | 200 `{"ok":true}` |
| `POST https://${VAULT_RAG_DOMAIN}/api/search` body `{"query":"hello"}` | semantic search (needs `Authorization: Bearer $VAULT_RAG_API_TOKEN`) |
| `https://${VAULT_RAG_DOMAIN}/mcp` | MCP server endpoint for agents |
| `https://${VAULT_RAG_DOMAIN}/grafana/` | Grafana, admin pw printed by `deploy.sh` |
| `https://${VAULT_RAG_DOMAIN}/git/` | Forgejo |
| `https://${VAULT_RAG_DOMAIN}/tokmon/` | token-monitor ingest |

---

## Configuration

Set in `.env` before `./deploy.sh install`:

| Key | Required | What |
|---|---|---|
| `VAULT_RAG_DOMAIN` | yes | Your domain, e.g. `vault.example.com` |
| `VAULT_RAG_API_TOKEN` | auto | REST API auth token (`Authorization: Bearer ...`), generated on first run if empty |
| `VAULT_RAG_MCP_TOKEN` | auto | MCP server auth token (`X-Vault-Token: ...`), separate from API token |
| `POSTGRES_PASSWORD` | auto | DB password, generated on first run if empty |
| `GRAFANA_ADMIN_PASSWORD` | auto | Grafana admin pw, printed by installer |
| `OLLAMA_MODEL` | no | Embedding model, default `nomic-embed-text` |
| `INDEXER_INTERVAL` | no | ofelia cron expr, default `@every 5m` |
| `WATCHDOG_THRESHOLD_MIN` | no | Kill runs older than N min, default `30` |
| `AUDIT_RETENTION_DAYS` | no | `vault_audit` retention, default `90` |

`deploy.sh` modes:

```bash
./deploy.sh install        # first-time bring-up
./deploy.sh update         # pull + recreate
./deploy.sh restart        # restart all services
./deploy.sh backup         # postgres dump + vault tarball + secrets
./deploy.sh status         # docker ps + healthz
./deploy.sh logs <svc>     # follow logs
```

See [`docs/architecture.md`](docs/architecture.md) for the full service map and data flow, [`docs/operations.md`](docs/operations.md) for backup/restore/scaling, and [`docs/api.md`](docs/api.md) for the REST + MCP reference.

---

## Agent Setup

Once the stack is up, point your agent at it. Two paths: **MCP** (recommended for Claude Code, Codex, Gemini CLI) or **REST** (any HTTP client).

You will need:
- `https://${VAULT_RAG_DOMAIN}/mcp` - the MCP endpoint
- `https://${VAULT_RAG_DOMAIN}/api` - the REST base
- `VAULT_RAG_MCP_TOKEN` - for MCP clients (`X-Vault-Token` header)
- `VAULT_RAG_API_TOKEN` - for REST clients (`Authorization: Bearer ...`)

Both tokens are printed by `./deploy.sh install` and live in `.env`. They are distinct values - do not mix them up.

### Claude Code

Add the server to your project's `.mcp.json` (or to user-level `~/.claude.json`):

```json
{
  "mcpServers": {
    "vault-rag": {
      "type": "http",
      "url": "https://your-domain/mcp",
      "headers": {
        "X-Vault-Token": "PASTE_VAULT_RAG_MCP_TOKEN_HERE"
      }
    }
  }
}
```

Restart Claude Code, then `/mcp` should list `vault-rag` with tools `put`, `search`, `get`, `backlinks`.

### Codex CLI

In `~/.codex/config.toml`:

```toml
[mcp_servers.vault-rag]
url = "https://your-domain/mcp"

[mcp_servers.vault-rag.headers]
X-Vault-Token = "PASTE_VAULT_RAG_MCP_TOKEN_HERE"
```

### Gemini CLI

In `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "vault-rag": {
      "httpUrl": "https://your-domain/mcp",
      "headers": { "X-Vault-Token": "PASTE_VAULT_RAG_MCP_TOKEN_HERE" }
    }
  }
}
```

### Plain REST (any agent / script)

```bash
export VAULT="https://your-domain"
export API_TOKEN="PASTE_VAULT_RAG_API_TOKEN_HERE"

# Healthz is the only GET, the rest are POST with JSON body.
curl -sS "$VAULT/api/healthz"

curl -sS -X POST -H "Authorization: Bearer $API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"query":"hello","k":5}' \
     "$VAULT/api/search"

curl -sS -X POST -H "Authorization: Bearer $API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"path":"00-inbox/note.md","content":"# hi","mode":"create"}' \
     "$VAULT/api/put"
```

### Telling the agent how to use the vault

After wiring MCP, give the agent a one-time briefing so it knows the conventions. Drop this into your project's `CLAUDE.md` / `AGENTS.md` / system prompt:

```
You have access to vault-rag via the `vault-rag` MCP server.

Conventions:
- Before answering anything project-related, call the `search` MCP tool with
  the user's query. Read the top results with the `get` tool if the snippets
  are not enough.
- When you learn something durable (decision, pattern, gotcha), persist it
  via the `put` tool to `09-resources/notes/YYYY-MM-DD-slug.md`.
- Drop session dumps and long chat threads into `05-sessions/`.
- Never write outside your agent namespace except `00-inbox/` (intake) and
  `05-sessions/` (transcripts) and `09-resources/notes/` (knowledge).
- For tasks, use the `vt` CLI on the host (not MCP). Tasks live in
  `06-tasks/vt-NNNN-slug.md`. `vt ready` to find work, `vt claim` to take it.

The vault is the source of truth. Search before asking. Persist what matters.
```

### Bootstrap prompt (zero-to-running)

Want an agent to bring up vault-rag on a fresh box for you? Paste this into a Claude Code / Codex / Gemini session opened at the target host (or with SSH access to it):

````
You are deploying vault-rag, a self-hosted multi-agent RAG stack, on this
Linux host. Work step by step. Verify every step before moving on. Do not
proceed past a failure - fix it first.

Goal: a fully running vault-rag at https://<VAULT_RAG_DOMAIN>/, with the
MCP endpoint reachable and a fresh vault skeleton indexed.

Inputs the user must supply (ask if missing):
- VAULT_RAG_DOMAIN: a domain pointing at this host (A/AAAA record set).
- Optional: ACME email for Let's Encrypt.

Steps:
1. Pre-flight checks:
   - `docker --version`, `docker compose version` - must succeed
   - `openssl version`, `which envsubst` - must succeed
   - confirm port 80 and 443 are free on this host
2. Clone the repo:
   `git clone https://github.com/bringie/vault-rag.git /opt/vault-rag`
   `cd /opt/vault-rag`
3. Create `.env` from `.env.example`. Set `VAULT_RAG_DOMAIN`. Leave the
   secret fields empty - the installer will fill them.
4. Run `./deploy.sh install`. Capture the printed
   `VAULT_RAG_API_TOKEN`, `VAULT_RAG_MCP_TOKEN`, and `GRAFANA_ADMIN_PASSWORD`.
5. Health checks (retry for up to 2 minutes, the stack warms up):
   - `curl -fsS https://${VAULT_RAG_DOMAIN}/api/healthz` -> 200
   - `docker ps --format '{{.Names}} {{.Status}}'` - all 14 containers `Up`
   - `curl -fsS -X POST -H "Authorization: Bearer $VAULT_RAG_API_TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"query":"index"}' \
       "https://${VAULT_RAG_DOMAIN}/api/search"` -> JSON with `results` array
6. Trigger an indexer run and confirm it completed:
   `docker exec vault-rag-tools /usr/local/bin/run-indexer.sh`
   then `psql ... -c "SELECT status, started_at FROM job_runs
   ORDER BY started_at DESC LIMIT 1;"` - last row `status='ok'`.
7. Print the final summary to the user:
   - MCP URL: https://${VAULT_RAG_DOMAIN}/mcp
   - REST base: https://${VAULT_RAG_DOMAIN}/api
   - Grafana: https://${VAULT_RAG_DOMAIN}/grafana/  (admin / <password>)
   - Forgejo: https://${VAULT_RAG_DOMAIN}/git/
   - VAULT_RAG_API_TOKEN: <api-token>  (REST, Bearer)
   - VAULT_RAG_MCP_TOKEN: <mcp-token>  (MCP, X-Vault-Token)
8. Offer to write the MCP config block for the user's agent
   (Claude Code / Codex / Gemini CLI - ask which).

Rules:
- Never edit `obsidian-vault/` directly during install - it is the user's
  data dir. The skeleton is in `vault-skeleton/` and is copied on first run.
- Never commit secrets. `.env` and `secrets/` are gitignored.
- If a container is unhealthy after 2 minutes, run `./deploy.sh logs <svc>`
  and report the actual error to the user before retrying.
- Idempotent: re-running `./deploy.sh install` is safe.
````

Hand the agent that prompt plus shell access (or run it yourself in a Claude Code session at the host). When it finishes, you have a running stack and the credentials needed to wire any other agent at it.

---

## FAQ

### Why self-host this instead of using a managed RAG SaaS?
Your notes are the moat. Closed-source RAG SaaS owns your embeddings, your retrieval, and often your data. vault-rag keeps everything on disk you own, with plain markdown as the canonical format. You can rip out vault-rag tomorrow and your vault is still your vault.

### Why Postgres + pgvector instead of a dedicated vector DB?
One database for vectors, metadata, jobs, audit, and tokmon means one backup, one connection pool, one set of credentials, one thing to monitor. pgvector with HNSW is fast enough for vaults up to millions of chunks. If you outgrow it, swap it - the API doesn't change.

### Why Ollama for embeddings?
Per-query embedding cost is zero, and `nomic-embed-text` is competitive with paid embedding APIs for vault-scale retrieval. You can switch models by setting `OLLAMA_MODEL` and reindexing.

### Why ofelia and not systemd timers or cron?
ofelia runs schedules as Docker labels on the same containers it orchestrates. Migrating the stack to a new host means `git pull && ./deploy.sh install` - no systemd unit copies, no cron-on-host. The stack is portable.

### What does the watchdog do?
Every 5 min it scans `job_runs` for index runs marked `running` older than `WATCHDOG_THRESHOLD_MIN` (default 30) and kills them. Without it, a hung Ollama call could pin an indexer container forever.

### Can I run this without a domain / TLS?
Yes - edit `Caddyfile.tmpl` to use HTTP-only or `tls internal` for self-signed. The default assumes a real domain because that's the path most users want.

### How do agents authenticate?
Two-token model. The REST API expects `Authorization: Bearer ${VAULT_RAG_API_TOKEN}` on every route except `/api/healthz`. The MCP server expects `X-Vault-Token: ${VAULT_RAG_MCP_TOKEN}` (a distinct value). Both tokens are in `.env`, auto-generated on first install, and printed by `./deploy.sh install`. Keep them separate so a leaked agent config does not give cross-protocol access.

### How does indexing handle deletes and renames?
The indexer compares vault state against the `meta` table on every run. Files that vanish are flagged for chunk deletion. Renames look like delete+add right now (a future improvement).

### How do I back up?
`./deploy.sh backup` snapshots postgres (custom-format dump), the vault dir, and the secrets. Output goes to `./backups/YYYY-MM-DD-HHMMSS/`. For DR, replicate `backups/` offsite.

### How do I add a new agent?
Point it at `/mcp` (for MCP-native agents, with `VAULT_RAG_MCP_TOKEN`) or `/api/*` (for HTTP, with `VAULT_RAG_API_TOKEN`). Optionally have it POST every LLM call to `/tokmon/` to show up on the cost dashboard.

### Where do I file issues?
GitHub Issues at the repo. PRs welcome.

### What's the difference between `vt` and a real issue tracker?
`vt` is a thin markdown-native tracker tuned for agents working alongside humans on a single vault. Tasks are diff-friendly, grep-friendly, and survive losing the SaaS account. It's not a replacement for Jira on a 50-person team - it's a replacement for a TodoWrite list and a beads DB on a small project where the vault is the source of truth.

---

## Philosophy

Most "AI memory" tools make you the janitor. You feed them, prune them, beg them to remember.

This stack inverts that. Your vault is plain markdown. Your agents speak one protocol. Your indexer runs itself. Your costs are visible. Your tasks live next to your notes.

You think and write. The stack remembers, retrieves, observes, and bills.

**The vault is the source of truth. Everything else is plumbing.**

---

## Contributing

PRs welcome:
- New ingest formats (PDF, audio, image OCR)
- Alternative embedding backends (instructor, BGE, Voyage)
- MCP tool extensions
- Grafana dashboards
- Backup/restore improvements
- Multi-host deploy scripts

---

## License

MIT. See [LICENSE](LICENSE).
