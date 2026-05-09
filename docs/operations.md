# Operations

## Daily

- `./scripts/smoke.sh` - verify all endpoints up.
- `docker compose -p vault-rag logs -f vault-rag-api` - tail API.

## Backup

```bash
docker run --rm -v vault-rag_pgdata:/v -v $(pwd):/out alpine \
  tar czf /out/pgdata-$(date +%F).tar.gz -C /v .
docker run --rm -v vault-rag_vmdata:/v -v $(pwd):/out alpine \
  tar czf /out/vmdata-$(date +%F).tar.gz -C /v .
# obsidian-vault/ - sync via rclone/syncthing/your git repo.
```

`vmdata` retention is 14d so prefer cheap re-collection over backup.

## Restart a single service

```bash
docker compose -p vault-rag restart vault-rag-api
```

## Reset embeddings (rebuild from scratch)

```bash
docker exec vault-rag-postgres psql -U postgres -d vault_rag -c \
  "TRUNCATE chunks, backlinks; DELETE FROM meta WHERE k LIKE 'last_indexed_sha:%'"
docker exec vault-rag-tools node /app/scripts/vault-indexer.js
```

## Rotate API token

Edit `.env`, set new `VAULT_RAG_API_TOKEN`, then:

```bash
docker compose -p vault-rag up -d --force-recreate vault-rag-api vault-rag-mcp vault-rag-caddy
```

## Stuck jobs

`watchdog-stuck-jobs.js` runs every 5 min, marks `job_runs.status='timeout'` for any `status='running'` row older than 30 min. Manual check:

```bash
docker exec vault-rag-postgres psql -U postgres -d vault_rag -c \
  "SELECT id,name,status,started_at FROM job_runs WHERE status='running'"
```
