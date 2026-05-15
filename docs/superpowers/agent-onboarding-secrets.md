# Agent onboarding — secrets vault

Minimal "I'm a new agent on a new host, how do I get secrets" guide.

## Pre-requisites

You need exactly one thing: a valid `VAULT_RAG_API_TOKEN`.

Check:

```bash
# Should print 200
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $VAULT_RAG_API_TOKEN" \
  -H "Content-Type: application/json" -d '{}' \
  "$VAULT_RAG_API_URL/api/secrets/verify"
```

If you don't have it, ask the human operator to provision one (it's the same
token used for all other vault-rag tools).

## Three ways to use secrets

### From Claude Code (preferred)

MCP tools auto-register if vault-rag MCP is configured:

```
mcp__vault-rag__secret_get(name="GITLAB_TOKEN")        # → {value: "..."}
mcp__vault-rag__secret_list()                          # → {names: [...]}
mcp__vault-rag__secret_set(name="NEW_KEY", value="v")  # → {committed_sha: "..."}
mcp__vault-rag__secret_delete(name="NEW_KEY")
mcp__vault-rag__secret_rotate(name="NEW_KEY", value=null)  # null → server generates
mcp__vault-rag__secret_verify()                        # → {ok, version, count, last_rotated}
```

### From shell (`vt secrets …`)

```bash
vt secrets get GITLAB_TOKEN          # → stdout
vt secrets list                      # → newline names
vt secrets set NEW_KEY value         # interactive readline if value omitted
vt secrets delete NEW_KEY
vt secrets rotate NEW_KEY            # auto-generates 32-byte hex
vt secrets rotate NEW_KEY "explicit-value"
vt secrets verify                    # JSON report
vt secrets export-env                # echoes 'export K=V' lines (excludes *_env multi-line)
```

### From any code (Node / Python / Go / curl)

```python
import os, requests
def get_secret(name):
    r = requests.post(
        f"{os.environ['VAULT_RAG_API_URL']}/api/secrets/get",
        json={"name": name},
        headers={"Authorization": f"Bearer {os.environ['VAULT_RAG_API_TOKEN']}"},
    )
    r.raise_for_status()
    return r.json()["value"]
```

```javascript
async function getSecret(name) {
  const r = await fetch(`${process.env.VAULT_RAG_API_URL}/api/secrets/get`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.VAULT_RAG_API_TOKEN}`,
    },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`secret ${name}: ${r.status}`);
  return (await r.json()).value;
}
```

## Naming conventions

Run `vt secrets list` to see current names. Conventions:

- `UPPER_SNAKE` — one-line env-var-like tokens (e.g. `GITLAB_TOKEN`, `ANTHROPIC_API_KEY`)
- `<service>_env` — full `.env` file content for an application (multi-line)
  - Usage: `vt secrets get tarot_env > tarot/.env`

## What NOT to do

- **Don't commit plain-text secrets to git** — even in branches; old commits leak.
- **Don't paste secrets into shell history.** Use `HISTCONTROL=ignorespace` + leading space, or `vt secrets set NAME` (interactive prompt).
- **Don't share `VAULT_RAG_API_TOKEN` outside the team** — gives access to ALL secrets (Phase 1 has no scope-tokens yet).

## Onboarding a new host (operator)

1. Set `VAULT_RAG_API_URL=https://brain.itiswednesdaymydud.es` and `VAULT_RAG_API_TOKEN=...` in the host environment.
2. Verify: `curl ... /api/secrets/verify` returns 200.

That's it. No SSH-key distribution, no age install, no local git clone.

## Adding a new client class (e.g. a new production service)

Phase 1: same `VAULT_RAG_API_TOKEN` everywhere. Phase 2 will add per-service scope-tokens.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401 unauthorized` | wrong/missing token | check `VAULT_RAG_API_TOKEN` + `VAULT_RAG_API_URL` |
| `404 not_found` on `secret_get` | secret name mismatch | `vt secrets list` for actual names |
| `conflict_retries_exhausted` on `set` | 3 concurrent clients writing | retry (usually succeeds) |
| `verify` returns `{ok: false}` | server-side decrypt fail (age key missing/wrong) | contact operator |
| `404 not found` on every route | URL missing `/api/` prefix | check `VAULT_RAG_API_URL` includes scheme but no trailing path |

## See also

- Spec: `docs/superpowers/specs/2026-05-14-secrets-vault-design.md`
- Plan: `docs/superpowers/plans/2026-05-14-secrets-vault-implementation.md`
