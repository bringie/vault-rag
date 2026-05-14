---
type: spec
status: approved
date: 2026-05-14
topic: secrets-vault
related_task: vt-0059
---

# Secrets vault — age-encrypted in vault-rag, server-side decryption

## Summary

Хранилище всех секретов агента (Claude + admin + project `.env` + usedesk infra) в существующем vault-rag git-репозитории. Шифрование at-rest через `age` с одним server-side ключом. Сервер vault-rag расшифровывает в RAM при старте, выдаёт значения клиентам через расширенный MCP/REST API. Аутентификация — существующий `VAULT_RAG_API_TOKEN` (как для остальных vault-rag tools).

## Goals / Non-goals

**Goals**

- Один источник истины для всех секретов агента, синхронизируемый через git.
- Защита **at-rest** в git (encrypted blob); если кто-то получит read-only доступ к git remote — не получит plain-text.
- Lazy propagation: новый секрет добавленный одним агентом виден другим при следующем `secret_get` (через server-side cache refresh).
- Linux + macOS + WSL для клиентов (zero deps кроме curl/HTTPS).
- Bootstrap нового клиента — просто `VAULT_RAG_API_TOKEN` (уже есть для остальных vault-rag tools).

**Non-goals (отложено в Phase 2)**

- Защита от компромисса самого vault-rag сервера (root на brain.itiswednesdaymydud.es = leak всех секретов). Mitigation — harden server, periodic rotate, access monitoring.
- Per-client SSH-key-based decryption (zero-trust клиентов).
- Audit log (кто когда читал X).
- Per-secret scope-tokens.
- Auto-rotation cron.
- Web UI.

## Threat model

**Что защищаем:**

- **At-rest leak в git**: git remote доступен через https/ssh; если кто-то прочитает `vault.age` напрямую (через GitHub clone или браузер) — это encrypted blob, без сервера бесполезно. ✓
- **Случайный commit плейн-текст-секрета в obsidian-vault**: `.gitignore` блокирует `*.json *.plain *.env vault.txt`. ✓
- **Компромисс одного клиента** (laptop, Claude session): атакующий получает `VAULT_RAG_API_TOKEN`, может читать секреты через API. Mitigation — token rotation, IP-allowlist на сервере. Phase 2 — per-client scoped tokens.

**Что НЕ защищаем (acceptable risk):**

- **Компромисс vault-rag сервера**: атакующий с root на brain.itiswednesdaymydud.es получает private age key (`/opt/vault-rag/.secrets/age.key`) и расшифровывает всё. Mitigation: server harden + monitoring + periodic key rotation.

Это сознательный trade-off в пользу простоты: один ключ на сервере вместо распределения SSH-ключей всем клиентам, никаких specific deps на клиентах (только HTTPS).

## Architecture

```
┌─ Claude session (Linux ai / macOS / WSL) ─────────────────┐
│                                                            │
│  Tool calls:                                              │
│   mcp__vault-rag__secret_get / _set / _list / etc.        │
│                                                            │
└────────────────────────┬──────────────────────────────────┘
                         │ HTTPS to https://brain.itiswednesdaymydud.es/mcp
                         │ Bearer / OAuth (existing)
                         ▼
┌─ vault-rag-mcp container (HTTP MCP shim, on server) ──────┐
│  TOOLS += { secret_get, secret_list, secret_set,           │
│             secret_delete, secret_rotate, secret_verify }  │
│  delegates to vault-rag-api via Bearer auth                │
└────────────────────────┬──────────────────────────────────┘
                         │ HTTP to vault-rag-api:5679
                         ▼
┌─ vault-rag-api container (on server) ─────────────────────┐
│  /api/secrets/get, /api/secrets/list, /api/secrets/set,    │
│  /api/secrets/delete, /api/secrets/rotate, /api/secrets/verify│
│                                                            │
│  in-memory state:                                          │
│    decrypted_blob: dict | None                            │
│    blob_sha: str (current git commit sha)                 │
│    last_fetch: timestamp                                   │
│  on startup: load /opt/vault-rag/.secrets/age.key + decrypt│
│  on /api/secrets/set: re-encrypt vault.age + git push      │
│  on /api/secrets/get: optional refresh if TTL > 10s        │
└────────────────────────┬──────────────────────────────────┘
                         │ git pull/push (local clone in container)
                         ▼
┌─ git (obsidian-vault repo on the same server) ────────────┐
│  obsidian-vault/secrets/vault.age      ← encrypted blob   │
│  obsidian-vault/secrets/recipients     ← server pubkey    │
│  obsidian-vault/secrets/.gitignore     ← blocks plaintext │
│  obsidian-vault/secrets/README.md                         │
└───────────────────────────────────────────────────────────┘
```

### Key properties

- **Granularity**: один файл `vault.age` со всеми секретами внутри (flat JSON map + `_meta`).
- **Шифрование**: один server-side age keypair. `private` хранится в `/opt/vault-rag/.secrets/age.key` (chmod 0600, в .gitignore через repo-level + filesystem-level). `public` записан в `secrets/recipients`.
- **Hot path**: server держит decrypted blob в RAM. На `secret_get` — O(1) лукап в dict.
- **Sync after set**: после успешного `secret_set` сервер делает `git push`; cache invalidated. На след get — re-decrypt.
- **CLI fallback**: `vt secrets get NAME` → `curl https://brain.itiswednesdaymydud.es/api/secrets/get -H "Authorization: Bearer $VAULT_RAG_API_TOKEN"` (или wraps как другие `vt` subcommands).
- **Никаких локальных deps на клиенте**: ни `age`, ни `git clone vault-rag` локально, ни SSH-keys для decrypt. Только token + HTTPS.

## Components

### `obsidian-vault/secrets/vault.age`

Бинарный age-encrypted файл. После расшифровки на сервере — JSON:

```json
{
  "_meta": {
    "schema": 1,
    "rotated_at": { "GITLAB_TOKEN": "2026-05-14" },
    "version": 47
  },
  "ANTHROPIC_API_KEY": "sk-ant-...",
  "GITLAB_TOKEN": "glpat-...",
  "GH_PAT": "ghp_...",
  "tarot_env": "BOT_TOKEN=...\nDB_URL=...\n"
}
```

- Flat ключи для одиночных значений (env vars / tokens).
- `<service>_env` для multi-line `.env`-блоков целиком.
- `_meta` — служебное; `secret_list` его не возвращает.

### `obsidian-vault/secrets/recipients`

Текстовый файл, в Phase 1 содержит **один публичный age-ключ** сервера:

```
# host: vault-rag server (brain.itiswednesdaymydud.es)
age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Phase 2 может добавить per-client SSH-public-keys для прямой client-side decryption — но в Phase 1 один recipient (server).

### `/opt/vault-rag/.secrets/age.key` (server filesystem)

Private age-key файл. Hostage сервера. Mode 0600 owner root. **Backup** должен делаться отдельно (вне git, например в keepass/1password оператора).

Внутри:
```
# created: 2026-05-14
# public key: age1xxx...
AGE-SECRET-KEY-1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### MCP tools (extending `scripts/mcp-shim.js`)

Все tools — namespace `mcp__vault-rag__secret_*`. Регистрируются в массиве `TOOLS`, прокси к rag-api с тем же Bearer auth pattern что и существующие.

| Tool | Params | Returns | Errors |
|---|---|---|---|
| `secret_get` | `name: str` | `{ value: str }` | `not_found` |
| `secret_list` | — | `{ names: list[str] }` | (excludes `_meta`) |
| `secret_set` | `name: str`, `value: str` | `{ committed_sha: str }` | `git_push_failed` |
| `secret_delete` | `name: str` | `{ committed_sha: str }` | `not_found` |
| `secret_rotate` | `name: str`, `new_value: str \| null` | `{ committed_sha: str }` | (null → server генерит 32-byte hex) |
| `secret_verify` | — | `{ ok: bool, version: int, last_rotated: dict, count: int }` | — |

### REST API (`scripts/rag-api.js`)

Новые handlers:

```
POST /api/secrets/get      body {name}            → {value}
POST /api/secrets/list     body {}                → {names: [...]}
POST /api/secrets/set      body {name, value}     → {committed_sha}
POST /api/secrets/delete   body {name}            → {committed_sha}
POST /api/secrets/rotate   body {name, value?}    → {committed_sha}
POST /api/secrets/verify   body {}                → {ok, version, last_rotated, count}
```

Все требуют существующий `Authorization: Bearer $VAULT_RAG_API_TOKEN` (как остальные endpoints).

### CLI fallback (`vt secrets <subcommand>`)

Для bash/cron/applications вне Claude session — встраиваем в существующий `vt` CLI (`scripts/vt.js`):

```
vt secrets get NAME              # → stdout (one value)
vt secrets list                  # → newline names
vt secrets set NAME [VALUE]      # interactive readline (no-echo) если VALUE не дан
vt secrets delete NAME           
vt secrets rotate NAME [VALUE]   # generates 32-byte hex если VALUE не дан
vt secrets verify
vt secrets export-env            # печатает 'export K=V' для всех flat keys (не для $service_env)
```

Все subcommands — wrap'ы над REST API. Реализация — extension в `vt.js`. Не нужен age binary локально.

### Server-side internals (`scripts/secrets-handler.js`, new module)

```javascript
class SecretsHandler {
  constructor({ageKeyPath, vaultRepoPath, vaultAgePath, recipientsPath}) { ... }

  // In-memory state
  _blob = null;          // dict | null
  _blobSha = null;       // string
  _lastFetch = 0;        // timestamp ms
  _fetchTTL = 10_000;    // 10 seconds

  async _ensureFresh() {
    if (Date.now() - this._lastFetch < this._fetchTTL) return;
    await this._gitFetch();
    const remoteSha = await this._headSha('vault.age');
    if (remoteSha !== this._blobSha) {
      await this._gitPull();
      this._blob = await this._decryptVaultAge();
      this._blobSha = remoteSha;
    }
    this._lastFetch = Date.now();
  }

  async get(name) {
    await this._ensureFresh();
    if (!(name in this._blob)) throw new NotFound(name);
    return this._blob[name];
  }

  async set(name, value) {
    // Optimistic concurrency: pull, modify, encrypt, push. Retry 3x.
    for (let attempt = 0; attempt < 3; attempt++) {
      await this._gitPull();
      const blob = await this._decryptVaultAge();
      blob[name] = value;
      blob._meta.version = (blob._meta.version || 0) + 1;
      await this._encryptAndWrite(blob);
      try {
        await this._gitCommitAndPush(`secrets: set ${name}`);
        this._blob = blob;
        this._blobSha = null; // force re-fetch
        return await this._headSha('vault.age');
      } catch (e) {
        if (!isPushReject(e)) throw e;
        await this._gitResetHard();
        continue;
      }
    }
    throw new ConflictRetriesExhausted();
  }

  async _decryptVaultAge() {
    return execAge(['-d', '-i', this.ageKeyPath, this.vaultAgePath]);
  }

  async _encryptAndWrite(blob) {
    await execAge(['-R', this.recipientsPath, '-o', this.vaultAgePath], JSON.stringify(blob));
  }
}
```

### Files in vault-rag git

```
obsidian-vault/
├── secrets/
│   ├── vault.age           # encrypted blob (binary)
│   ├── recipients          # server age public key
│   ├── .gitignore          # blocks plaintext (*.json, *.plain, *.env, vault.txt)
│   └── README.md           # short usage docs + link to spec
scripts/
├── mcp-shim.js             # +secret_* tools in TOOLS array
├── rag-api.js              # +secret_* handlers
├── secrets-handler.js      # NEW: SecretsHandler class
├── vt.js                   # +secrets subcommand
docs/superpowers/
├── specs/2026-05-14-secrets-vault-design.md
└── plans/2026-05-14-secrets-vault-implementation.md
```

### Server-side filesystem

```
/opt/vault-rag/
└── .secrets/
    └── age.key             # private age key (chmod 0600, root)
```

Mount как docker secret или volume в `vault-rag-api` container.

## Concurrency

### Read

Кэш decrypt в server RAM с TTL 10s. Свежий read = git fetch + (если HEAD изменился) re-decrypt при первом обращении после TTL.

### Write

Per-process write lock (mutex в node) + optimistic git CAS:

```
loop max 3:
  git pull --rebase
  decrypt
  modify
  encrypt
  commit
  push → if reject, reset --hard origin/master, continue loop
```

### Multi-client propagation

| Action | Эффект |
|---|---|
| Client A: `secret_set("X")` | server commits + push, updates cache |
| Client B: `secret_get("X")` | server: TTL check → если cache expired → fetch + reload → возвращает свежее |
| Client C: ничего не запрашивает | Ничего не происходит |

Никаких background jobs. Lazy "consistent on read" модель.

## Operational flows

### Bootstrap (одноразово на сервере vault-rag)

```bash
# На сервере brain.itiswednesdaymydud.es:
mkdir -p /opt/vault-rag/.secrets
chmod 700 /opt/vault-rag/.secrets

# Генерим age keypair
age-keygen -o /opt/vault-rag/.secrets/age.key
chmod 600 /opt/vault-rag/.secrets/age.key
PUB=$(grep "^# public key:" /opt/vault-rag/.secrets/age.key | cut -d: -f2 | tr -d ' ')

# В git репо: создаём recipients + .gitignore
cd /opt/vault-rag/obsidian-vault   # local clone
mkdir -p secrets
cat > secrets/.gitignore <<'EOF'
*.json
*.plain
*.env
vault.txt
age.key
EOF
cat > secrets/recipients <<EOF
# host: vault-rag server
$PUB
EOF

# Первое наполнение (пустой blob с _meta)
TMP=$(mktemp -d)
echo '{"_meta": {"schema": 1, "version": 1, "rotated_at": {}}}' > $TMP/vault.json
age -R secrets/recipients -o secrets/vault.age $TMP/vault.json
shred -u $TMP/vault.json; rmdir $TMP

# Commit
git add secrets/{vault.age,recipients,.gitignore}
git commit -m "secrets: init server-side age vault"
git push

# Mount age.key как volume в docker-compose vault-rag-api
# (см. task в plan)
```

### Adding a secret (через MCP tool / CLI)

```bash
# Через CLI
vt secrets set GITLAB_TOKEN "glpat-..."

# Через Claude MCP tool
mcp__vault-rag__secret_set(name="GITLAB_TOKEN", value="glpat-...")
```

### Rotation

```bash
# Manual rotation одного секрета (после regen в Gitlab UI)
vt secrets rotate GITLAB_TOKEN "glpat-new..."

# Server-generated 32-byte hex (для internal HMAC keys и т.п.)
vt secrets rotate INTERNAL_HMAC_KEY
```

Wrapper обновляет `_meta.rotated_at[name]`.

### Server-key rotation (раз в год / при подозрении на leak)

```bash
# 1. На сервере: сгенерить новый age key
age-keygen -o /opt/vault-rag/.secrets/age.key.new
NEW_PUB=$(grep "^# public key:" /opt/vault-rag/.secrets/age.key.new | cut -d: -f2 | tr -d ' ')

# 2. Decrypt текущий vault.age старым ключом → re-encrypt новым
OLD=$(age -d -i /opt/vault-rag/.secrets/age.key obsidian-vault/secrets/vault.age)
echo "$OLD" | age -r $NEW_PUB > obsidian-vault/secrets/vault.age.new

# 3. Подменить keys + recipients atomically
mv /opt/vault-rag/.secrets/age.key.new /opt/vault-rag/.secrets/age.key
mv obsidian-vault/secrets/vault.age.new obsidian-vault/secrets/vault.age
sed -i "s/^age1.*/$NEW_PUB/" obsidian-vault/secrets/recipients

# 4. Commit + restart vault-rag-api (чтобы перечитать новый key)
git add obsidian-vault/secrets/{vault.age,recipients}
git commit -m "secrets: rotate server age key"
git push
docker restart vault-rag-api
```

⚠ После rotation: старая `vault.age` в git history дешифруется СТАРЫМ ключом. Если ротация — реакция на leak, обязателен также `vt secrets rotate --all` (regen каждое значение).

### Migration текущих секретов

Одноразовый bootstrap-скрипт `scripts/migrate-to-vault.sh`:

1. Собирает все секреты из текущих источников локально на client:
   - env vars (`GITLAB_TOKEN`, `JIRA_TOKEN`, `GRAFANA_TOKEN`, `YANDEX_APP_PASSWORD`)
   - файлы (`/root/.gh-token`, `/root/.git-credentials`, `/root/.claude/.credentials.json`)
   - `.env` приложений (как `tarot_env`, `renaper_bot_env`, etc.)
   - `usedesk` инфра-секреты (из `yc-1c-infra/state.env`)
2. Делает `vt secrets set` для каждого через REST API.
3. `vt secrets verify` → проверяет count.
4. Печатает список файлов и env-строк для ручной очистки.

## Agent onboarding

Чтобы новый агент (Claude Code instance, sub-agent, bash script, telegram-bot) получил доступ к секретам:

1. **Установить `VAULT_RAG_API_TOKEN`** в окружение (или в `vault-rag-oss/.env` для CLI / в Claude MCP config для tools).
2. **Готово.** Никаких локальных deps, ни SSH-ключей, ни age binary.

После этого:

- Из Claude: tool calls `mcp__vault-rag__secret_get` / `_set` / `_list` доступны автоматически (после deploy MCP shim расширения).
- Из bash/script: `vt secrets get NAME` / `vt secrets set NAME val`.

### Что НЕ делать

- Не commit'ить секреты plain-text в obsidian-vault (тогда они утекут в git перед encrypt'ом). `.gitignore` в `secrets/` помогает.
- Не запускать секрет-set в shell-history без `set +o history` для commands с секретами (`HISTCONTROL=ignorespace` + leading space).
- Не выдавать `VAULT_RAG_API_TOKEN` сторонним сервисам — он даёт доступ ко всем секретам, не только своим. Phase 2 это исправит scoped-tokens.

## Testing

- Unit tests для `SecretsHandler`: encrypt/decrypt round-trip, JSON parse, missing key handling.
- Integration test: запуск 5 параллельных `secret_set` через REST API, проверка что финальный HEAD содержит все 5 коммитов.
- Manual smoke: bootstrap age key → set несколько секретов → list → verify → restart vault-rag-api → re-read через get (cache rebuilt) → ОК.

## Что выпадает (Phase 2)

- Audit log — server-side endpoint логирует каждый `secret_get` с client identity, agent_id, timestamp.
- Per-client scoped tokens — отдельный `VAULT_RAG_SECRETS_TOKEN_<service>` с whitelist разрешённых ключей.
- Server-side key rotation в auto-mode (раз в год).
- Web UI для редактирования / просмотра audit log.
- Per-secret recipients — namespace `vault-<service>.age` если потребуется scope.
- True client-side decryption (zero-trust клиентов) — это уже другая архитектура; делать только если threat model изменится.

## Open questions (resolve during plan execution)

- Точное место подключения новых handlers в `rag-api.js` (структуру файла увидим при implementation).
- Стоит ли встроить age в Node через `pyrage`/`@dgraph-io/ristretto` или вызывать external `age` binary? (Subprocess проще, deps меньше. Default — subprocess.)
- Имя CLI subcommand: `vt secrets` или `vt s` short. (Cosmetic, default `vt secrets`.)
