# REST + MCP API

All requests require header `X-Vault-Token: ${VAULT_RAG_API_TOKEN}`.

## REST

### `GET /api/healthz`
No auth. Returns `200 OK` with `{"status":"ok"}`.

### `POST /api/put`
Body: `{"path": "00-inbox/foo.md", "content": "...", "mode": "create|upsert|append", "reindex": true}`.
- `path` may begin with `00-inbox/` or `05-sessions/` (no agent_id required), or `<agent_id>/<any>`.
- `content` is the markdown body (key is `content`, NOT `body`).
- `mode=append` splits by `# heading` -> multiple chunks.
- `reindex=true` (default) embeds immediately; `false` defers to next cron tick.

### `GET /api/search?query=...`
Top-K vector search.

### `GET /api/get?path=...`
Returns full file content.

### `GET /api/backlinks?target=...`
Returns array of `source` paths linking to `target`.

## MCP

Endpoint: `POST /mcp` (single endpoint, JSON-RPC). Tools:

- `vault.put` (mirrors `/api/put`)
- `vault.search` (mirrors `/api/search`)
- `vault.get` (mirrors `/api/get`)
- `vault.backlinks` (mirrors `/api/backlinks`)
