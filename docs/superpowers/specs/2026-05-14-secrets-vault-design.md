---
type: spec
status: approved
date: 2026-05-14
topic: secrets-vault
related_task: vt-0059
---

# Secrets vault — age-encrypted in vault-rag git

## Summary

Хранилище всех секретов агента (Claude + admin + project `.env` + usedesk infra) в существующем vault-rag git-репозитории. Шифрование at-rest через `age` с SSH-публичными ключами клиентов как recipients. Plain-text живёт только в RAM процесса MCP-сервера или $EDITOR в tmpfs. Никаких background jobs — доступ через MCP tools при каждом запросе.

## Goals / Non-goals

**Goals**

- Один источник истины для всех секретов агента, синхронизируемый через git.
- Защита от компромисса vault-rag сервера — сервер хранит только encrypted blob, ключа дешифровки не имеет.
- Lazy propagation: новый секрет, добавленный одним агентом, виден другим при следующем `secret_get`.
- Linux + macOS + WSL поддержка.
- Bootstrap нового хоста за один `grant` + `git pull`.

**Non-goals (отложено в Phase 2)**

- Audit log (кто когда читал X).
- Per-secret recipients (scoped namespaces).
- Auto-rotation cron.
- Web UI.

## Threat model

Основная угроза — **компромисс vault-rag сервера**. Решение: сервер НЕ recipient age. Plain-text никогда не попадает на сервер. При root-доступе на `brain.itiswednesdaymydud.es` атакующий получает encrypted blob + git history, без приватного SSH-ключа клиента это бесполезно.

Вторичные:

- Compromise одного клиента — атакующий может расшифровать текущий vault.age и любые предыдущие commits. Mitigation: `secret_revoke <client>` + `secret_rotate --all` (manual rotation токенов на стороне сервисов).
- Случайный commit секрета в plain-text — mitigation: `.gitignore` блокирует `*.json *.plain *.env vault.txt`.

## Architecture

```
┌─ Claude Code session (Linux ai / macOS / WSL) ────────────┐
│                                                            │
│  Tool calls:                                              │
│   mcp__vault-rag__secret_get / _set / _list / etc.        │
│                                                            │
└────────────────────────┬──────────────────────────────────┘
                         │ MCP stdio
                         ▼
┌─ vault-rag MCP server (per-session, stdio) ───────────────┐
│  state in RAM only:                                       │
│    - last_git_fetch_at                                    │
│    - decrypted blob (JSON)                                │
│    - blob_sha                                             │
│  reads ~/.ssh/id_{ed25519,rsa} on every decrypt           │
│  git pull/push for sync                                   │
└────────────────────────┬──────────────────────────────────┘
                         │ git over HTTPS or SSH
                         ▼
┌─ vault-rag git remote (brain.itiswednesdaymydud.es) ──────┐
│  obsidian-vault/secrets/vault.age      ← encrypted blob   │
│  obsidian-vault/secrets/recipients     ← SSH public keys  │
│  obsidian-vault/secrets/.gitignore                        │
│  obsidian-vault/secrets/README.md                         │
└───────────────────────────────────────────────────────────┘
```

### Key properties

- **Granularity**: один файл `vault.age` со всеми секретами внутри (flat JSON map + `_meta`).
- **Distribution**: lazy — каждый MCP-server делает git fetch при первом запросе и кэширует на 10s. На write — git pull → modify → git push с optimistic retry (max 3).
- **Plain-text destination**: только RAM MCP-процесса. Для `edit` команды — tmpfs/`$TMPDIR` с secure overwrite на cleanup.
- **vault-rag server в recipients age НЕТ** — сервер не может расшифровать blob.
- **Per-session stdio MCP** — каждая Claude session запускает свой MCP, общая SSH-ключевая идентичность хоста. Никакого daemon-а.

## Components

### `obsidian-vault/secrets/vault.age`

Бинарный age-encrypted файл. После расшифровки — JSON:

```json
{
  "_meta": {
    "schema": 1,
    "rotated_at": { "GITLAB_TOKEN": "2026-05-14", "...": "..." },
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

Текстовый файл, по одному SSH-публичному ключу на строку, с маркерным комментарием перед каждым:

```
# host: ai (root)
ssh-rsa AAAAB3Nz... root@ai

# host: macbook-pro
ssh-ed25519 AAAAC3... user@macbook
```

Маркер `# host: <name>` используется командами `grant`/`revoke` для идентификации.

### MCP tools

Расширение существующего `vault-rag` MCP сервера. Все tools — namespace `mcp__vault-rag__secret_*`.

| Tool | Params | Returns | Errors |
|---|---|---|---|
| `secret_get` | `name: str` | `value: str` | `not_found`, `decrypt_failed` |
| `secret_list` | — | `names: list[str]` | (excludes `_meta`) |
| `secret_set` | `name: str`, `value: str` | `committed_sha: str` | `conflict_retries_exhausted` |
| `secret_delete` | `name: str` | `committed_sha: str` | `not_found` |
| `secret_grant` | `pubkey: str` (полная строка `ssh-rsa AAAA...`), `comment: str` | `committed_sha: str` | `invalid_pubkey`, `comment_taken` |
| `secret_revoke` | `comment: str` | `committed_sha: str` | `not_found`; warns про необходимость `rotate --all` |
| `secret_rotate` | `name: str`, `new_value: str \| None` (None → server генерит 32-byte hex) | `committed_sha: str` | как `secret_set`; обновляет `_meta.rotated_at[name]` |
| `secret_verify` | — | `{recipients_ok: [...], errors: [...]}` | — |

### CLI fallback (`vt secrets <subcommand>`)

Для bash/cron/applications вне Claude session — встраиваем в существующий `vt` CLI:

```
vt secrets get NAME              # → stdout
vt secrets list                  # → newline names
vt secrets set NAME [VALUE]      # interactive readline если VALUE не дан
vt secrets edit                  # $EDITOR на tmpfs/$TMPDIR копию vault.json
vt secrets grant <pubkey-file> <comment>
vt secrets revoke <comment>
vt secrets rotate NAME [VALUE]   # generates 32-byte hex если VALUE не дан
vt secrets verify
vt secrets export-env            # печатает 'export K=V' для всех flat keys
```

`vt secrets edit` — единственная команда работающая через файл. Wrapper:

1. `tmpdir = secrets_tmpdir()` (Linux → `$XDG_RUNTIME_DIR/vault-edit-$$`; macOS → `$TMPDIR/vault-edit-$$`)
2. `mkdir -m 700 $tmpdir; trap "secrets_shred $tmpdir/*; rmdir $tmpdir" EXIT`
3. `age -d -i $SSH_KEY vault.age > $tmpdir/vault.json`
4. `$EDITOR $tmpdir/vault.json`
5. `age -R recipients -o vault.age $tmpdir/vault.json`
6. `git pull --rebase && git add && git commit && git push` (с retry)

### MCP server internals

Псевдокод:

```python
class SecretsModule:
    state = {
        "last_fetch": 0,
        "decrypted": None,
        "blob_sha": None,
    }
    write_lock = threading.Lock()
    fetch_ttl = 10  # seconds

    def _ssh_key(self):
        for k in [os.environ.get("VAULT_SSH_KEY"),
                  "~/.ssh/id_ed25519", "~/.ssh/id_rsa",
                  "/root/.ssh/id_ed25519", "/root/.ssh/id_rsa"]:
            if k and os.path.isfile(os.path.expanduser(k)):
                return os.path.expanduser(k)
        raise RuntimeError("no SSH key")

    def _ensure_fresh(self):
        now = time.time()
        if now - self.state["last_fetch"] < self.fetch_ttl:
            return
        run("git fetch")
        remote_sha = run("git rev-parse origin/master:secrets/vault.age")
        if remote_sha != self.state["blob_sha"]:
            run("git pull --ff-only")
            blob = read("obsidian-vault/secrets/vault.age")
            self.state["decrypted"] = json.loads(
                run(f"age -d -i {self._ssh_key()}", stdin=blob))
            self.state["blob_sha"] = remote_sha
        self.state["last_fetch"] = now

    def get(self, name):
        self._ensure_fresh()
        if name not in self.state["decrypted"]:
            raise NotFound(name)
        return self.state["decrypted"][name]

    def set(self, name, value):
        with self.write_lock:
            for attempt in range(3):
                self._ensure_fresh()
                blob = dict(self.state["decrypted"])
                blob[name] = value
                blob["_meta"]["version"] += 1
                encrypted = run("age -R recipients", stdin=json.dumps(blob))
                write("obsidian-vault/secrets/vault.age", encrypted)
                run("git add && git commit -m 'secrets: set " + name + "'")
                try:
                    run("git push")
                    self.state["blob_sha"] = None  # force re-fetch on next read
                    return run("git rev-parse HEAD")
                except PushReject:
                    run("git reset --hard origin/master")
                    continue
            raise ConflictRetriesExhausted()
```

### Permissions

| Файл | Mode | Comment |
|---|---|---|
| `secrets/vault.age` | `0644` | encrypted, OK to read |
| `secrets/recipients` | `0644` | public keys |
| `secrets/.gitignore` | `0644` | — |
| Private SSH key | `0600` | как обычно |
| tmpfs / $TMPDIR /vault-edit-$$/ | `0700` | временно, через `umask 077` + `mkdir -m 700` |

## Cross-platform helpers

```bash
secrets_tmpdir() {
  case "$(uname -s)" in
    Linux*)
      [ -d "$XDG_RUNTIME_DIR" ] && { echo "$XDG_RUNTIME_DIR/vault-edit-$$"; return; }
      echo "/dev/shm/vault-edit-$$"
      ;;
    Darwin*)
      echo "${TMPDIR:-/tmp}/vault-edit-$$"
      ;;
    *)
      echo "${TMPDIR:-/tmp}/vault-edit-$$"
      ;;
  esac
}

secrets_shred() {
  if command -v shred >/dev/null 2>&1; then
    shred -u "$@"                          # GNU coreutils (Linux)
  elif command -v srm >/dev/null 2>&1; then
    srm "$@"                                # macOS via brew
  else
    for f in "$@"; do
      rm -P "$f" 2>/dev/null || python3 -c "
import os, sys
p = sys.argv[1]
n = os.path.getsize(p)
with open(p, 'r+b') as f:
    f.write(os.urandom(n)); f.flush(); os.fsync(f.fileno())
os.unlink(p)
" "$f"
    done
  fi
}

detect_ssh_key() {
  [ -n "$VAULT_SSH_KEY" ] && { echo "$VAULT_SSH_KEY"; return; }
  for k in "$HOME/.ssh/id_ed25519" "$HOME/.ssh/id_rsa" \
           /root/.ssh/id_ed25519 /root/.ssh/id_rsa; do
    [ -r "$k" ] && echo "$k" && return
  done
  echo "ERROR: no SSH key (try VAULT_SSH_KEY=/path/to/key)" >&2; exit 1
}
```

## Concurrency

### Read

Кэш decrypt в RAM с TTL 10s. Свежий read = git fetch + age decrypt при первом обращении после TTL expire или после обнаружения нового HEAD.

### Write

Per-process write lock + optimistic git CAS:

```
loop max 3:
  git pull --rebase
  decrypt
  apply diff
  encrypt
  commit
  push → if reject, continue loop
```

Conflict resolution: последний-кто-сохранит на одном ключе побеждает; добавление РАЗНЫХ ключей разными агентами параллельно не теряется (каждый retry заново применяет свой diff поверх свежей версии).

### Multi-agent propagation

| Action | Эффект на других агентов |
|---|---|
| Agent A: `secret_set("X")` → push | Other MCPs не знают пока |
| Agent B: `secret_get("X")` | Их MCP делает fetch (если TTL прошёл) → видит новый HEAD → reload → returns значение |
| Agent C: ничего не запрашивает | Ничего не происходит |

Никакого active push. Lazy "consistent on read".

## Operational flows

### Bootstrap (первый раз)

```bash
cd /opt/vault-rag/obsidian-vault   # на vault-rag сервере, либо через git pull локально
mkdir -p secrets
cat > secrets/.gitignore <<'EOF'
*.json
*.plain
*.env
vault.txt
EOF

# Recipients — публичные ключи первого хоста (например ai/root)
cat > secrets/recipients <<EOF
# host: ai (root)
$(cat ~/.ssh/id_ed25519.pub || cat ~/.ssh/id_rsa.pub)
EOF

# Первое наполнение
TMPDIR=$(secrets_tmpdir); mkdir -m 700 "$TMPDIR"
trap "secrets_shred $TMPDIR/*; rmdir $TMPDIR" EXIT
echo '{"_meta": {"schema": 1, "version": 1, "rotated_at": {}}}' > "$TMPDIR/vault.json"
age -R secrets/recipients -o secrets/vault.age "$TMPDIR/vault.json"

git add secrets/{vault.age,recipients,.gitignore}
git commit -m "secrets: init"
git push
```

### Adding a new host (grant)

```bash
# На новом хосте:
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519   # если ключа ещё нет
cat ~/.ssh/id_ed25519.pub

# С уже-доверенного хоста (Claude session или CLI):
vt secrets grant ~/Downloads/new-host.pub "macbook-air"
# или: mcp__vault-rag__secret_grant(pubkey="ssh-ed25519 ...", comment="macbook-air")
```

На новом хосте после первого `vt secrets get NAME` → автоматический git pull → MCP decrypt.

### Revoke

```bash
vt secrets revoke "macbook-air"
# warns:
#   ⚠ recipient удалён, vault.age перешифрован для оставшихся.
#   НО старая версия в git history расшифровывается старым ключом.
#   Запусти 'vt secrets rotate --all' и обнови tokens на стороне сервисов.
```

### Migration текущих секретов

Одноразовый bootstrap-скрипт `scripts/migrate-to-vault.sh`:

1. Собирает все секреты из текущих источников в `$tmpdir/initial.json`:
   - env vars (`GITLAB_TOKEN`, `JIRA_TOKEN`, `GRAFANA_TOKEN`, `YANDEX_APP_PASSWORD`)
   - файлы (`/root/.gh-token`, `/root/.git-credentials`, `/root/.claude/.credentials.json`)
   - `.env` приложений (как `tarot_env`, `renaper_bot_env`, etc.)
   - `usedesk` инфра-секреты (из `yc-1c-infra/state.env`, knowledge note про DEV_VAULT_TOKEN)
2. `vt secrets edit < $tmpdir/initial.json` — batch-import.
3. `vt secrets verify`.
4. Печатает список файлов и env-строк для ручной очистки на стороне источников.

## Agent onboarding (instruction)

Чтобы агент (Claude Code instance или sub-agent) мог пользоваться vault-ом, нужны три условия:

1. **SSH-ключ хоста в recipients.** Если хост новый — на него должна прийти `secret_grant` с уже-доверенного хоста (или вручную добавить публ.ключ в `secrets/recipients` + recrypt). Проверка: `vt secrets verify` → ключ хоста должен быть в `recipients_ok`.

2. **Установленные deps.** Один раз на хост:

   ```bash
   # Linux
   apt install -y age jq git python3
   # macOS
   brew install age jq git
   ```

3. **Доступ к vault-rag git remote.** Уже есть, потому что vault-rag MCP уже сконфигурирован.

После этого:

- **Запросить секрет:** `mcp__vault-rag__secret_get(name="GITLAB_TOKEN")` → возвращает значение в RAM tool-call'а.
- **Добавить новый:** `mcp__vault-rag__secret_set(name="MY_NEW_TOKEN", value="abc123")`.
- **Список доступных:** `mcp__vault-rag__secret_list()`.

Альтернатива из shell — `vt secrets get NAME` / `vt secrets set NAME value`.

### Что НЕ делать

- Не записывать секреты в plain-text файлы (включая `.env`, `~/.bashrc` и пр.) при коммитах в git — `.gitignore` поможет, но не покрывает все случаи.
- Не запускать `vt secrets edit` через SSH-сессию без `$TMPDIR` — wrapper остановится с ошибкой если tmpdir не определён или не tmpfs.
- При revoke хоста — всегда после `secret_revoke` запускать `secret_rotate --all` (Phase 2 автоматизирует).

## Files in vault-rag git

```
obsidian-vault/
├── secrets/
│   ├── vault.age           # encrypted blob
│   ├── recipients          # SSH pubkeys (one per line + # host: comments)
│   ├── .gitignore          # blocks plaintext (*.json, *.plain, *.env, vault.txt)
│   └── README.md           # short usage docs + link to spec
scripts/
├── bin/vt                  # existing CLI; добавляется subcommand `secrets`
└── install-deps.sh         # bootstrap install для age/jq/git
docs/superpowers/
├── specs/2026-05-14-secrets-vault-design.md   # this file
└── plans/...               # будет написан writing-plans skill'ом
```

## Что выпадает (Phase 2)

- Audit log — server-side endpoint, требует authenticated request с client identity.
- Per-secret recipients — namespace `vault.<service>.age` с отдельными recipients для production-сервисов.
- Auto-rotation — cron генерит новые tokens для секретов где это возможно (passwords, internal HMAC keys), для external tokens (GitLab/Anthropic/etc.) — reminders.
- Encrypted git history scrubber — после revoke провести `git filter-repo` чтобы старые blob'ы исчезли. Сложно потому что переписывает SHAs.

## Testing

- Unit tests для CLI/MCP module: encrypt/decrypt round-trip, JSON parse, missing key handling, recipients mutation.
- Integration test: запуск 5 параллельных `secret_set` в скрипт-моке, проверка что все 5 successful commits в финальном HEAD.
- Manual smoke: bootstrap → grant → set → revoke + rotate → verify на двух хостах (Linux + macOS).

## Open questions (resolve before plan)

- Куда конкретно интегрируется MCP module — отдельный subprocess в существующем vault-rag MCP, или новая Python module? (Зависит от структуры существующего vault-rag MCP — узнаем при writing-plans.)
- Имя CLI subcommand: `vt secrets` или `vt s` short? (Cosmetic, выбрать позже.)
- Стоит ли встроить age-encrypt в Python directly (через `pyrage` или `python-age`) или вызывать external `age` binary? (Subprocess проще, deps меньше, но slower на больших blob'ах — пока vault < 100KB разница неощутима.)
