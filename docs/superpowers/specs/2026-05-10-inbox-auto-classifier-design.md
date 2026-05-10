---
type: spec
status: approved
epic: vt-0032
date: 2026-05-10
topic: inbox-auto-classifier
---

# Inbox Auto-Classifier (server-side, Haiku via claude CLI)

## Goal

Автоматическая классификация файлов из `00-inbox/` Obsidian-vault на стороне сервера vault-rag. Классификатор перемещает каждый файл в правильную Johnny.Decimal-папку и обогащает frontmatter (tags, summary, type) с помощью Anthropic Haiku, вызываемого через `claude` CLI с подписочной авторизацией.

## Non-goals

- Не классифицируем файлы вне `00-inbox/`.
- Не индексируем содержимое (за это отвечает `vault-indexer`).
- Не делаем suggest-режим (только auto-move).
- Не обрабатываем не-`.md` файлы.
- Не работаем с папками глубже первого уровня `00-inbox/` (за исключением `_deadletter/`, который сами создаём).

## Constraints

- Хост: `brain.itiswednesdaymydud.es` (vault-rag stack).
- Vault host path: `/root/obsidian-vault` (bind-mounted в контейнеры как `/vault`).
- Runtime: Node.js 22 (как `vault-indexer.js`).
- Auth для Haiku: `claude` CLI с `~/.claude/.credentials.json` (subscription, не API-key).
- Schedule: `ofelia` (Docker labels), `@every 15m`, `no-overlap: true`.
- Allowlist целевых папок: `01-knowledge`, `02-projects`, `05-logs`, `06-resources`. Перемещение в иные пути запрещено.
- Skip: `current-context.md`, файлы с `type: index` в frontmatter, имена с префиксом `_`, всё под `_deadletter/`.
- Confidence threshold: `≥0.7` → move, `<0.7` → dead-letter.
- Retry policy: `attempts < 3` → возврат в `pending` (повторит следующий tick); `attempts >= 3` → dead-letter.
- Dead-letter path: `00-inbox/_deadletter/`.

## Architecture

```
ofelia @15m → vault-rag-tools контейнер
  └─ node /scripts/run-job.js inbox-classifier
       └─ node /scripts/inbox-classifier.js
            ├─ pg client (vault-rag postgres) — state + audit_log
            ├─ /vault (bind, rw) — read inbox, write target/_deadletter
            ├─ /root/.claude/.credentials.json (host) — ro mount, auth для claude CLI
            └─ claude CLI → Haiku (claude-haiku-4-5-20251001), --output-format json
```

Bind mounts `vault-rag-tools`:
- `/root/obsidian-vault` → `/vault` (rw, уже есть).
- `/opt/vault-rag/scripts` → `/scripts` (ro, уже есть).
- `/root/.claude/.credentials.json` → `/root/.claude/.credentials.json` (ro, **новый**).
- `/root/.claude/settings.json` → `/root/.claude/settings.json` (ro, **новый**).

## Components

### `scripts/inbox-classifier.js` (новый, ~280 строк)

Главный entrypoint. Жизненный цикл:

1. `pg.connect()`.
2. `recoverStaleProcessing()` — `UPDATE inbox_classifier_state SET status='pending', attempts=attempts+1 WHERE status='processing' AND started_at < now() - interval '5 min'`.
3. `files = glob('/vault/00-inbox/*.md')`.
4. Цикл по файлам:
   - `if shouldSkip(file)` → continue.
   - `row = stateLookup(path)`.
   - Решение по статусу (см. §3.1 ниже).
   - `claim(path, sha)`.
   - `try { result = await callClaude(file, 60s); apply(result) } catch (e) { handleError(e) }`.
5. `pg.disconnect()`.

### `scripts/lib/classifier-lib.js` (новый, чистые функции)

- `buildPrompt(content, frontmatter, basename) → string`
- `parseClaudeResponse(stdout) → {target_folder, tags, summary, type, confidence}` (throws на parse-fail)
- `shouldSkip(basename, frontmatter) → bool`
- `validateTargetFolder(folder) → void` (throws если вне allowlist)
- `enrichFrontmatter(existing, result) → Object` (merge tags с дедупом, ставит classified_*)

### `scripts/lib/claude-cli.js` (новый)

Wrapper над `child_process.execFile('claude', ['-p', prompt, '--model', 'claude-haiku-4-5-20251001', '--output-format', 'json'])`. Timeout 60s. Парсит exit code, stderr, нормализует ошибки в типизированные исключения (`ClaudeAuthError`, `ClaudeTimeoutError`, `ClaudeParseError`).

### `sql/004-inbox-classifier-state.sql`

```sql
CREATE TABLE inbox_classifier_state (
  path           text PRIMARY KEY,
  sha            text NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending','processing','done','deadletter')),
  attempts       int  NOT NULL DEFAULT 0,
  last_error     text,
  classified_at  timestamptz,
  started_at     timestamptz,
  target_folder  text,
  confidence     real,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbox_classifier_state_status_idx
  ON inbox_classifier_state(status);
```

### `Dockerfile.tools` (patch)

```dockerfile
RUN npm install -g @anthropic-ai/claude-code
```

### `docker-compose.yml` (patch)

```yaml
vault-rag-tools:
  volumes:
    - /root/.claude/.credentials.json:/root/.claude/.credentials.json:ro
    - /root/.claude/settings.json:/root/.claude/settings.json:ro
  labels:
    ofelia.job-exec.inbox-classifier.schedule: "${INBOX_CLASSIFIER_SCHEDULE:-@every 15m}"
    ofelia.job-exec.inbox-classifier.command: "node /scripts/run-job.js inbox-classifier node /scripts/inbox-classifier.js"
    ofelia.job-exec.inbox-classifier.no-overlap: "true"
```

### Метрики (Prometheus)

Через тот же механизм, что у `vault-indexer` (либо `prom-client` если уже есть, либо текстовый файл в `/var/lib/node_exporter/textfile_collector/inbox_classifier.prom`):

- `inbox_classifier_processed_total{status="done|deadletter|skipped|error"}` (counter)
- `inbox_classifier_confidence` (histogram, buckets 0.5/0.6/0.7/0.8/0.9/1.0)
- `inbox_classifier_duration_seconds` (histogram, buckets 1/5/10/30/60)
- `inbox_classifier_pending` (gauge, count где status='pending' или 'processing')

## Data flow

### 3.1 Detect → Claim

```
file = /vault/00-inbox/foo.md
sha  = sha1(content)
row  = SELECT * FROM inbox_classifier_state WHERE path=$1

case row:
  null                              → INSERT (status=pending, attempts=0, sha)
  {status='done',sha=stored}        → if sha == stored → SKIP
                                      else             → reset (sha changed = новый файл с тем же путём)
  {status='deadletter',sha=stored}  → if sha == stored → SKIP
                                      else             → reset (re-attempt новой версии)
  {status='pending'}                → claim
  {status='processing'}             → if started_at < now()-5min → recovered (заберём)
                                      else             → SKIP (другой run в процессе)

claim(path, sha):
  UPDATE inbox_classifier_state
     SET status='processing', started_at=now(), sha=$1, updated_at=now()
   WHERE path=$path
```

### 3.2 Claude call

System prompt:
```
You classify markdown notes into a Johnny.Decimal vault.
Folders:
  01-knowledge  : durable concepts, references, cheat-sheets
  02-projects   : ongoing project artefacts (active work)
  05-logs       : session logs, incident notes, debug transcripts
  06-resources  : external links, prompts, raw resources

Output JSON only, no prose:
{
  "target_folder": "01-knowledge"|"02-projects"|"05-logs"|"06-resources",
  "tags": [3-5 short kebab-case strings],
  "summary": "<= 200 chars",
  "type": "note|log|reference|project|prompt|other",
  "confidence": 0.0-1.0
}
```

User prompt:
```
PATH: 00-inbox/foo.md
EXISTING_FRONTMATTER:
<yaml or "(none)">

BODY:
<file body, capped at 6000 chars>
```

Cmd:
```
claude -p "$prompt" --model claude-haiku-4-5-20251001 --output-format json
```

### 3.3 Apply

```
if result.confidence < 0.7:
  moveTo('00-inbox/_deadletter/' + basename, reason='low_conf:' + confidence)
  state.status='deadletter', state.last_error='low_confidence', state.confidence=...
  metric.processed.deadletter.inc()
else:
  validateTargetFolder(result.target_folder)   // throws → catches как parse_error
  fm_new = enrichFrontmatter(fm_old, {
    tags: dedupe([...fm_old.tags||[], ...result.tags]),
    summary: result.summary,
    type: fm_old.type || result.type,
    classified_at: ISO8601_now(),
    classified_by: 'haiku/inbox-classifier-v1',
    classifier_confidence: result.confidence
  })
  write(file, serialize(fm_new) + body)
  rename(file, /vault/${target_folder}/${basename})
  state.status='done', state.classified_at=now(), state.target_folder, state.confidence
  audit_log INSERT (op='classify', path=new_path, sha_after=sha(content_new))
  metric.processed.done.inc()
  metric.confidence.observe(result.confidence)
```

### 3.4 Failure paths

```
catch e:
  attempts := state.attempts + 1
  last_error := e.code + ':' + e.message.slice(0,200)
  if attempts >= 3:
    moveTo('00-inbox/_deadletter/' + basename, reason=last_error)
    state.status='deadletter', state.attempts, state.last_error
    metric.processed.deadletter.inc()
  else:
    state.status='pending', state.attempts, state.last_error
    metric.processed.error.inc()
```

### 3.5 Skip rules

```
shouldSkip(basename, frontmatter):
  basename === 'current-context.md'                          → true
  frontmatter?.type === 'index'                               → true
  basename.startsWith('_')                                    → true
  path contains '/_deadletter/'                               → true
  default                                                     → false
```

## Error handling

| Сценарий | Detection | Action |
|---|---|---|
| `claude` CLI не найден | `ENOENT` от execFile | Hard fail скрипта (exit 1), файлы не трогаем, ofelia рестартует следующий tick |
| Auth expired/невалиден | exit ≠0, stderr содержит `auth`/`login` | Hard fail скрипта + alert; alert через метрику + лог-уровень `error` |
| Claude timeout (60s) | child_process kill | attempts++, retry; на 3-й fail → DL |
| Stdout не валидный JSON | `JSON.parse` throws | attempts++, last_error='parse_error' |
| `target_folder` вне allowlist | validate throws | attempts++, last_error='invalid_target' |
| Confidence < 0.7 | numeric check | move в DL без retry (это решение, не ошибка) |
| Файл-приёмник уже существует | `EEXIST` от `rename` | suffix `-${ts}` к имени |
| Postgres недоступен | connection error | Hard fail скрипта |
| Stale `processing` (контейнер упал в середине) | `started_at < now()-5min` | `recoverStaleProcessing` вернёт в `pending` (attempts++) |
| Concurrent ofelia ticks | n/a | `no-overlap: true` лейбл; ofelia блокирует overlap нативно |

## Testing

### Unit (`node:test`)

`classifier-lib.test.js`:
- `parseClaudeResponse`: valid JSON / malformed / missing fields / лишние поля.
- `validateTargetFolder`: allow=`01-knowledge`, deny=`07-trash`, deny=`../etc`.
- `shouldSkip`: `current-context.md` / `type:index` / `_x.md` / `_deadletter/y.md` / нормальный файл.
- `enrichFrontmatter`: merge tags с дедупом, не перезаписывает существующий `type`, ставит `classified_*`.
- `buildPrompt`: содержит body cap 6000 chars, frontmatter присутствует, system-секция полная.

`state-machine.test.js`:
- Spy на pg-клиент (in-process mock).
- Переходы: `null → pending → processing → done`, `processing → pending → processing → deadletter` (3 attempts), `done(sha=X) → skip`, `done(sha=X) → reset(sha=Y)`.
- `recoverStaleProcessing` поднимает stale row в pending и инкрементит attempts.

### Integration (docker-compose)

Spin-up postgres + tools-контейнер с переменной `CLAUDE_BIN=/scripts/test/fake-claude.sh` (стаб, читает stdin/argv → возвращает заранее заданный JSON).

Фикстуры в tmp-vault:
1. `valid-knowledge.md` → moves в `01-knowledge/`, frontmatter обогащён.
2. `low-conf.md` (стаб возвращает confidence 0.5) → DL.
3. `timeout.md` (стаб спит 90s) → retry, после 3 attempts → DL.
4. `current-context.md` → skip.
5. `done-noop.md` (preset state row, sha совпадает) → skip.

Проверки: pg state, фактические file moves, audit_log rows, метрики.

### Smoke (на проде, post-deploy)

1. `echo "test content" > /root/obsidian-vault/00-inbox/classifier-smoke-$(date +%s).md`
2. `docker exec vault-rag-tools node /scripts/inbox-classifier.js` (ручной trigger или подождать tick).
3. Проверить:
   - файл уехал в target,
   - frontmatter содержит `classified_by: haiku/inbox-classifier-v1`,
   - `audit_log` row с `op='classify'`,
   - `inbox_classifier_processed_total{status="done"}` инкрементилась.

### TDD порядок

1. RED: `classifier-lib` parser/skip/validate/enrich tests.
2. GREEN: реализация `classifier-lib.js`.
3. RED: `state-machine` тесты на pg-mock.
4. GREEN: state-machine в `inbox-classifier.js`.
5. RED: integration тест с fake-claude.
6. GREEN: connect everything, debug.
7. REFACTOR: вытащить общее с `vault-indexer.js` в `lib/vault-lib.js` если найдём.

## Rollout

1. Migration `sql/004-inbox-classifier-state.sql` применить через существующий migration runner.
2. Залогиниться на хосте: `claude login` → проверить `~/.claude/.credentials.json` exists.
3. `docker compose build vault-rag-tools` (Dockerfile.tools обновлён).
4. `docker compose up -d vault-rag-tools` (новые volume mounts).
5. Verify: `docker exec vault-rag-tools claude --version`.
6. Manual trigger: `docker exec vault-rag-tools node /scripts/inbox-classifier.js` на пустом inbox → должен отработать без файлов.
7. Smoke: подкинуть testовый файл (см. выше).
8. Включить ofelia label (или подождать перезапуска ofelia).
9. Мониторить `inbox_classifier_pending` gauge - должен спадать в первые 30 минут.

## Open questions / future

- Если subscription claude CLI окажется нестабилен в headless-режиме (например, требует TTY) - перейти на `ANTHROPIC_API_KEY` через Anthropic Messages API. Закладываемся на возможность подмены `claude-cli.js` на `messages-api.js` без изменения остального кода.
- Возможный апгрейд: повторное переклассифицирование при изменении контента файла в target-папке (сейчас done+sha-match = skip навсегда).
- DL retention: пока бесконечная (файлы лежат в `_deadletter/`), при росте - добавить TTL job.
