# Secret rotation playbook (vt-0215)

Six secrets/tokens drive vault-rag. Each has a different blast radius and a
different rotation procedure. **All rotations must be tested in staging
first; production rotation should be done off-peak with a 30-minute
maintenance window for tokens with cascading effects.**

## Token map

| Token | Purpose | Blast radius on rotation |
|---|---|---|
| `VAULT_RAG_API_TOKEN` | Viewer bearer for `/api/*` (notes/get, search, backlinks, secrets reads, fleet reads) | All daemons + UIs + MCP clients lose access until reconfigured |
| `VAULT_RAG_FLEET_ADMIN_TOKEN` | Admin bearer for fleet mutations (`/dispatch`, `/exec`, workflows, host PATCH/DELETE) | All admin UI sessions + automation hitting fleet POST/PATCH/DELETE fail |
| `VAULT_RAG_FLEET_WS_SECRET` | HMAC key for short-lived WS tickets (vt-0136) | All in-flight browser WS sessions invalidated (auto-reconnect should re-mint) |
| `VAULT_RAG_SECRETS_TOKEN` | Internal token rag-api → secrets-server (split-process per vt-0134) | rag-api → secrets-server calls fail until BOTH containers see the new value |
| `VAULT_RAG_TOKMON_INGEST_TOKEN` | Daemon → hub tokmon ingest (vt-0140) | All daemons stop reporting Claude usage events until reconfigured |
| age private key (`/opt/vault-rag/.secrets/age.key`) | Decrypts `vault.age` ciphertext | **CATASTROPHIC** — loss = entire secret vault unreadable forever. Rotate keys + re-encrypt vault.age. Backup first. |

## Procedures

### `VAULT_RAG_API_TOKEN` (viewer)

Rotates frequently — quarterly recommended.

```bash
# 1. Generate new token
NEW=$(openssl rand -hex 32)

# 2. Edit /opt/vault-rag/.env, update line
ssh -p 977 root@hub 'cd /opt/vault-rag && sed -i "s/^VAULT_RAG_API_TOKEN=.*/VAULT_RAG_API_TOKEN=$NEW/" .env'

# 3. Recreate rag-api (loads .env on start)
ssh -p 977 root@hub 'cd /opt/vault-rag && docker compose up -d vault-rag-api'

# 4. Roll out to every daemon + CLI consumer
#    Daemons:  ssh host 'sed -i ... /etc/agent-fleet/config.json && systemctl restart agent-fleet-daemon'
#    CLI: vt secrets set VAULT_RAG_API_TOKEN "$NEW"  (and re-source .env)
#    UI: each operator must clear localStorage.fleetToken + paste new on next login

# 5. Verify
curl -H "Authorization: Bearer $NEW" https://hub/api/healthz/detail | jq .ok
```

Downtime: ~10s rag-api restart. Daemons disconnect + reconnect; in-flight sessions survive (PTY state lives on host, hub WS just re-attaches).

### `VAULT_RAG_FLEET_ADMIN_TOKEN`

Rotate at the same cadence as the viewer token, OR immediately if you suspect compromise (it's RCE-capable via `/fleet/exec` + workflow runner).

Same procedure as viewer token, plus:

```bash
# UI: every admin operator must clear localStorage.fleetToken + paste new
# Automation: update any cron jobs / external systems that POST to /api/fleet/*
```

### `VAULT_RAG_FLEET_WS_SECRET`

This is the HMAC key for browser WS tickets. Rotating it invalidates every active browser session immediately.

```bash
# 1. Generate
NEW=$(openssl rand -hex 32)

# 2. Update + restart
ssh -p 977 root@hub 'cd /opt/vault-rag && sed -i "s/^VAULT_RAG_FLEET_WS_SECRET=.*/VAULT_RAG_FLEET_WS_SECRET=$NEW/" .env && docker compose up -d vault-rag-api'

# 3. UI auto-reconnects after WS 1006 close. No daemon/CLI impact.
```

### `VAULT_RAG_SECRETS_TOKEN`

Internal token between rag-api and the standalone secrets-server (vt-0134). Both containers read it from `.env`.

```bash
# 1. Update env
NEW=$(openssl rand -hex 32)
ssh -p 977 root@hub 'cd /opt/vault-rag && sed -i "s/^VAULT_RAG_SECRETS_TOKEN=.*/VAULT_RAG_SECRETS_TOKEN=$NEW/" .env'

# 2. Restart BOTH containers at once — order matters less since both read
#    the same .env, but a small window may exist where one has the new
#    token and the other the old.
ssh -p 977 root@hub 'cd /opt/vault-rag && docker compose up -d vault-rag-api vault-rag-secrets'

# 3. Verify: should see 200 from /api/healthz/detail with secrets.status=ok
```

Downtime: ~10s. All secret reveals/sets queue and retry.

### `VAULT_RAG_TOKMON_INGEST_TOKEN`

Token daemons use to POST cost events to the hub.

```bash
# 1. Generate
NEW=$(openssl rand -hex 32)
ssh -p 977 root@hub 'cd /opt/vault-rag && sed -i "s/^VAULT_RAG_TOKMON_INGEST_TOKEN=.*/VAULT_RAG_TOKMON_INGEST_TOKEN=$NEW/" .env && docker compose up -d vault-rag-api'

# 2. Roll to every daemon host
for host in host1 host2 host3; do
  ssh $host "sed -i 's/^AGENT_FLEET_TOKMON_TOKEN=.*/AGENT_FLEET_TOKMON_TOKEN=$NEW/' /etc/agent-fleet/env && systemctl restart agent-fleet-daemon"
done

# 3. Verify: cost events flow within ~30s
curl -H "Authorization: Bearer $VIEWER_TOKEN" https://hub/api/fleet/sessions/cost-batch -d '{"ids":[]}'
```

While daemons are mid-rotation, cost events get rejected (visible in logs). No session impact.

### age private key

Rotation is a **multi-step process** — see vt-secrets-vault docs for full procedure. Outline:

```bash
# 1. Back up current age.key OFFLINE — to a different physical medium.
vault-rag-backup --to /mnt/usb/before-rotation.tar.age --pg-dump

# 2. Generate new age key
age-keygen -o /tmp/new-age.key

# 3. Add new pubkey to recipients (vault.age stays encrypted to BOTH keys
#    during the transition window)
echo "$(grep 'public key:' /tmp/new-age.key | awk '{print $4}')" >> obsidian-vault/secrets/recipients

# 4. Re-encrypt vault.age to the new recipients set
age -d -i /opt/vault-rag/.secrets/age.key obsidian-vault/secrets/vault.age \
  | age $(awk '{print "-r " $1}' obsidian-vault/secrets/recipients) \
  > obsidian-vault/secrets/vault.age.new
mv obsidian-vault/secrets/vault.age.new obsidian-vault/secrets/vault.age

# 5. Replace the active key
cp /opt/vault-rag/.secrets/age.key /opt/vault-rag/.secrets/age.key.bak.$(date +%s)
install -m 0600 /tmp/new-age.key /opt/vault-rag/.secrets/age.key
docker compose restart vault-rag-secrets

# 6. Verify a secret reveal works
vt secrets get TEST_SECRET

# 7. Once stable for >1 week, remove the OLD pubkey from recipients and
#    re-encrypt vault.age to just the new key. Destroy backup of old
#    age.key (the .bak.* files).
```

**Never skip step 1.** A broken rotation with no backup = data loss.

## Audit after rotation

Every rotation is a high-value security event. Check the audit tables:

```bash
docker exec vault-rag-postgres psql -U postgres -d vault_rag -c \
  "SELECT ts, op, name, caller_id, outcome FROM secret_audit ORDER BY ts DESC LIMIT 50"
```

Look for `outcome='denied'` spikes that line up with the rotation window — those are clients still holding the old token. If they persist beyond ~10 minutes, find and fix the stale config.
