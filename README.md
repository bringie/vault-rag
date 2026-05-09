# vault-rag

Self-hosted multi-agent vault RAG stack: **memory, information, observability, cost** in one place.

## What it is

A 14-container Docker stack that turns an Obsidian-style markdown vault into a queryable knowledge base for AI agents:

- **REST API + MCP** for agents to read/write notes, search semantically, and traverse `[[backlinks]]`.
- **PostgreSQL + pgvector** for chunked vector storage (HNSW, 768-dim Ollama nomic-embed-text).
- **Forgejo** for git-backed vault versioning.
- **VictoriaMetrics + Grafana** for full observability (host, containers, postgres, jobs).
- **token-monitor** ingest endpoint for tracking LLM cost across agents.
- **Caddy** as TLS reverse proxy with rate limiting.

## Quickstart

Requires: a Linux host with `docker`, `docker compose`, `openssl`, `envsubst`, and a domain pointed at the host.

```bash
git clone https://github.com/bringie/vault-rag.git /opt/vault-rag
cd /opt/vault-rag
cp .env.example .env
# edit .env: set VAULT_RAG_DOMAIN to your domain
./deploy.sh install
```

`deploy.sh` is idempotent: re-run safely. It generates secrets on first run, renders `Caddyfile` from `Caddyfile.tmpl`, brings the stack up, and triggers an initial vault index.

After install:

- `https://${VAULT_RAG_DOMAIN}/api/healthz` → 200
- `https://${VAULT_RAG_DOMAIN}/api/search?query=hello` (with `X-Vault-Token` header) → JSON
- `https://${VAULT_RAG_DOMAIN}/grafana/` → admin login (password printed by `deploy.sh`)
- `https://${VAULT_RAG_DOMAIN}/git/` → Forgejo

## Architecture

```
caddy (host:443) ── reverse proxy + rate_limit
 ├── /git/*        → forgejo:3000
 ├── /api/*        → vault-rag-api:5679
 ├── /mcp          → vault-rag-mcp:5680
 ├── /tokmon/*     → vault-rag-tokmon-ingest:5681
 ├── /grafana/*    → vault-rag-grafana:3000
 └── default       → vault-rag-api:5679

vault-rag-postgres (pgvector)
  ├─ db: vault_rag (chunks/backlinks/meta/jobs/job_runs/vault_audit)
  └─ db: tokmon (token-monitor)
vault-rag-ollama  ── nomic-embed-text 768d embeddings
vault-rag-tools   ── ofelia-cron host (vault-indexer 5m, watchdog 5m, cleanup-audit weekly)
vault-rag-vmsingle + node-exporter + cadvisor + postgres-exporter ── observability
```

See [`docs/architecture.md`](docs/architecture.md) for the full service map and data flow, [`docs/operations.md`](docs/operations.md) for backup/restore/scaling, and [`docs/api.md`](docs/api.md) for the REST + MCP reference.

## Vault layout

`vault-skeleton/` is copied to `obsidian-vault/` on first run. Layout:

- `00-inbox/` - drop new notes here
- `01-daily/` - daily logs
- `02-projects/` - per-project notebooks
- `05-sessions/` - chat session dumps from agents
- `09-resources/` - long-lived references

`obsidian-vault/` is gitignored - keep it in your own private git repo (or no git at all).

## License

MIT. See [LICENSE](LICENSE).
