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
# obsidian-vault/ - if VAULT_GIT_REMOTE is set, every /api/put and /api/task/*
# write auto-commits + pushes (1.5s debounce). The remote IS your backup.
# Otherwise: tar the directory, or sync via rclone/syncthing.
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

## Vault auto-sync (optional)

Enabled by `VAULT_GIT_REMOTE` in `.env`. Every write via `/api/put` and `/api/task/*` (except read-only routes) calls `obsidian-vault/.sync/vault-sync.sh push` with a 1.5s debounce.

```bash
# Manual sync (commit + pull --rebase + push, blocking):
docker exec vault-rag-api bash /vault/.sync/vault-sync.sh flush

# Sync log (host):
tail -f obsidian-vault/.sync/sync.log

# Conflicts (rare): rebase failure saves diverged commits as a patch and
# hard-resets to origin/main. Inspect:
ls obsidian-vault/_refactor/conflicts/
```

`bootstrap_vault_git` (run by `./deploy.sh install`) is a no-op when `VAULT_GIT_REMOTE` is empty. To enable auto-sync after the fact: set the var, then run `./deploy.sh --bootstrap-vault-git` and recreate `vault-rag-api`.

## Stuck jobs

`watchdog-stuck-jobs.js` runs every 5 min, marks `job_runs.status='timeout'` for any `status='running'` row older than 30 min. Manual check:

```bash
docker exec vault-rag-postgres psql -U postgres -d vault_rag -c \
  "SELECT id,name,status,started_at FROM job_runs WHERE status='running'"
```
