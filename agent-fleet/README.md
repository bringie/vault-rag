# agent-fleet — multi-host control plane for Claude Code

Sub-project of [vault-rag-oss](..). Spawn, attach to, and stream Claude Code sessions across multiple hosts from a central web/REST/MCP interface.

## Components

| Component | Location | What it does |
|---|---|---|
| **Hub** | embedded in `scripts/rag-api.js` + `scripts/lib/fleet-routes.js` | REST `/api/fleet/*` + WS `/api/fleet/ws`. Routes between daemons and viewers. Persists hosts/sessions/transcripts to existing Postgres. |
| **Daemon** | [`daemon/`](daemon/) | Per-host npm package `@bringie/agent-fleet-daemon`. Outbound-only WebSocket to hub. PTY-backed `claude` spawn. |
| **Hub helpers** | `scripts/lib/fleet-db.js`, `fleet-ring-buffer.js`, `fleet-event-batcher.js` | Postgres CRUD, per-session ring buffer, batched event writes. |
| **CLI** | `scripts/bin/fleet` | Bash REST wrapper: `fleet hosts`, `fleet sessions list/tail/spawn/kill`. |

Architecture and protocol details: [`docs/superpowers/specs/2026-05-15-agent-fleet-control-plane-design.md`](../docs/superpowers/specs/2026-05-15-agent-fleet-control-plane-design.md).

## Quick start

On the hub (vault-rag-oss already running):

```
curl https://brain.example.com/api/fleet/healthz
```

On each host:

```
npx @bringie/agent-fleet-daemon \
  --hub wss://brain.example.com/api/fleet/ws \
  --token "$VAULT_RAG_API_TOKEN" \
  --host-name $(hostname)
```

Drive from CLI:

```
fleet hosts
fleet sessions spawn --host <host_id> -- --print 'hi'
fleet sessions tail <session_id>
```

## What's done (sub-project #1)

✅ Host daemon + hub control plane (this sub-project).
- Daemon: outbound WS reconnect, PTY spawn/write/resize/kill, sessions.json persistence, reconciliation on reconnect.
- Hub: REST hosts/sessions CRUD, WS daemon/viewer protocol, ring buffer + batched events, retention scheduler.
- 36/36 unit + 1 e2e tests pass.

## What's next

- Sub-project #2 — Web UI (HTMX + xterm.js dashboard).
- Sub-project #3 — `vt remote claim --host=X` CLI routing.
- Sub-project #4 — Auto-routing by capabilities + token-monitor cost attribution.

## Tests

```
# unit (against ephemeral pg)
cd scripts
VAULT_RAG_PG_PORT=55433 VAULT_RAG_PG_PASS=testpass \
  node --test lib/fleet-db.test.js lib/fleet-ring-buffer.test.js \
       lib/fleet-event-batcher.test.js lib/fleet-routes.test.js

# daemon
cd ../agent-fleet/daemon
npm test

# end-to-end
cd ../..
./tests/fleet-e2e.sh
```

The unit tests assume a Postgres on `127.0.0.1:55433` with password `testpass` and a `vault_rag` database with the `004-fleet-init.sql` migration applied. The e2e test reuses the same DB. To start one:

```
docker run -d --name fleet-test-pg \
  -p 55433:5432 -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=vault_rag \
  pgvector/pgvector:pg16
docker exec -i fleet-test-pg psql -U postgres -d vault_rag < sql/004-fleet-init.sql
```

## Deploy to brain

```
ssh root@brain.itiswednesdaymydud.es 'cd /opt/vault-rag && \
  git pull && \
  (cd scripts && npm install) && \
  docker compose restart vault-rag-api'
```

Then verify:

```
curl -fsSL https://brain.itiswednesdaymydud.es/api/fleet/healthz
```
