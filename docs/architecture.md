# vault-rag architecture

## Services (14)

| Service | Image | Role |
|---|---|---|
| `vault-rag-caddy` | local `Dockerfile.caddy` (caddy 2.11 + rate_limit) | TLS reverse proxy on host :443 |
| `vault-rag-api` | local `Dockerfile.tools` | REST API on `:5679`, runs `scripts/rag-api.js` |
| `vault-rag-mcp` | local `Dockerfile.tools` | MCP shim on `:5680`, runs `scripts/mcp-shim.js` |
| `vault-rag-tokmon-ingest` | local `Dockerfile.tools` | Token-usage ingest on `:5681` |
| `vault-rag-tools` | local `Dockerfile.tools` | Cron host (ofelia labels), `node` runtime |
| `vault-rag-ofelia` | mcuadros/ofelia | Cron daemon |
| `vault-rag-postgres` | pgvector/pgvector:pg16 | Postgres 16 + pgvector |
| `vault-rag-ollama` | ollama/ollama | nomic-embed-text 768d embeddings |
| `vault-rag-forgejo` | codeberg.org/forgejo/forgejo:7 | Self-hosted git on `/git/`, ssh on host :222 |
| `vault-rag-grafana` | grafana/grafana | Dashboards on `/grafana/` |
| `vault-rag-vmsingle` | victoriametrics/victoria-metrics | TSDB |
| `vault-rag-node-exporter` | prom/node-exporter | Host metrics |
| `vault-rag-cadvisor` | gcr.io/cadvisor/cadvisor | Container metrics |
| `vault-rag-postgres-exporter` | prometheuscommunity/postgres-exporter | Postgres metrics + custom queries.yaml |

## Data flow

1. User edits markdown in `obsidian-vault/`.
2. `vault-indexer.js` (every 5 min, ofelia) walks the tree, computes SHA-256 per file, skips unchanged files via `meta.last_indexed_sha`.
3. Changed files: chunked by markdown headings -> embedded via Ollama -> upserted into `chunks` (HNSW `m=16, ef_construction=64`).
4. `[[wiki-link]]` extraction populates `backlinks`.
5. Every op recorded in `vault_audit` with `sha_before` / `sha_after`.
6. Search: `/api/search?query=X` -> embed query -> cosine search top-K from `chunks`.

## Schema

- `chunks` (path, idx PK, content, vector(768) emb, sha) - HNSW index
- `backlinks` (source, target)
- `meta` (k, v, last_indexed_sha) - single-row state per key
- `ingest_log` (ts, op, path, count)
- `jobs` (name PK, schedule, last_run_id) - cron catalogue
- `job_runs` (id PK, name, status, started_at, finished_at, duration_ms, exit_code, summary)
- `vault_audit` (ts, path, op, sha_before, sha_after)

## Networking

```
external 443 ──► caddy ──┬─► /api/*       :5679 vault-rag-api
                         ├─► /mcp         :5680 vault-rag-mcp
                         ├─► /tokmon/*    :5681 vault-rag-tokmon-ingest
                         ├─► /git/*       :3000 vault-rag-forgejo
                         ├─► /grafana/*   :3000 vault-rag-grafana
                         └─► default      :5679 vault-rag-api
```

All non-Caddy services bind only to the docker bridge `vault-rag_default`.
