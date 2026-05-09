<p align="center">
  <img src="https://img.shields.io/badge/Self--hosted-RAG_Stack-7C3AED?style=for-the-badge" alt="Self-hosted RAG Stack" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker Compose" />
  <img src="https://img.shields.io/badge/PostgreSQL-pgvector-336791?style=for-the-badge&logo=postgresql&logoColor=white" alt="Postgres + pgvector" />
  <img src="https://img.shields.io/badge/Ollama-nomic--embed--text-000000?style=for-the-badge&logo=ollama&logoColor=white" alt="Ollama" />
  <img src="https://img.shields.io/badge/MCP-Server-FF6F00?style=for-the-badge" alt="MCP Server" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="License: MIT" />
</p>

<p align="center">
  <a href="README.md">English</a> &middot;
  <strong>Русский</strong> &middot;
  <a href="README.es.md">Español</a>
</p>

<h1 align="center">vault-rag</h1>

<p align="center">
  <strong>Self-hosted multi-agent RAG-стек для markdown-волта в стиле Obsidian.</strong>
  <br /><br />
  <em>Один Docker Compose. Память, поиск, наблюдаемость и учёт стоимости - в одной коробке. Заметки лежат на вашем диске. Агенты держатся в синхроне.</em>
  <br /><br />
  <em>14 контейнеров &middot; REST + MCP &middot; pgvector HNSW &middot; индексация через ofelia &middot; vt task CLI &middot; дашборды Grafana</em>
  <br /><br />
  <a href="#как-это-работает-на-практике">Посмотреть в деле</a> &middot;
  <a href="#компоненты">Все компоненты</a> &middot;
  <a href="#установка">Установка</a> &middot;
  <a href="#конфигурация">Конфигурация</a> &middot;
  <a href="#faq">FAQ</a>
</p>

---

## Проблема

Вы запускаете несколько AI-агентов. Каждый стартует с нуля. Разговоры заканчиваются, контекст испаряется, к утру решения забыты.

Вы пишете заметки в Obsidian. Сотни файлов. Агенты не могут их читать, не умеют семантический поиск, не отличают свежее от устаревшего. Каждую сессию вы заново объясняете один и тот же проект.

Вы ещё и жжёте токены. Не знаете, какой агент сколько стоит. Не знаете, отработал ли индексер ночью. Не знаете, какая заметка ответила на последний запрос.

**Волт, агенты, наблюдаемость и учёт стоимости - четыре проблемы, которые обычно покрываются четырьмя SaaS-счетами.**

---

## Что это

14-контейнерный Docker-стек, превращающий markdown-волт в queryable, наблюдаемую, дружелюбную к агентам базу знаний:

| | Типичный SaaS-стек | vault-rag |
|---|---|---|
| **Хранилище** | Облако вендора, непрозрачно | Plain markdown на вашем диске, версионирование через Forgejo |
| **Эмбеддинги** | Оплата за вызов | Локальный Ollama nomic-embed-text (768-dim), ноль за запрос |
| **Векторный индекс** | Managed Pinecone/Weaviate | Postgres + pgvector HNSW в одной БД с метаданными |
| **Доступ агентов** | Кастомный HTTP под каждого | REST + MCP, оба ходят в один backend |
| **Индексация** | Вручную или cron на VPS | ofelia label-driven scheduler внутри контейнера, watchdog в комплекте |
| **Наблюдаемость** | Логи в stdout, метрики нигде | VictoriaMetrics + Grafana, 4 готовых дашборда |
| **Учёт стоимости** | Никакого | token-monitor ingest endpoint, все агенты логируют каждый вызов |
| **Учёт задач** | Внешний инструмент | `vt` CLI, задачи как markdown внутри самого волта |

Если хотите волт, *читаемый агентами и людьми, при этом полностью под вашим контролем* - это оно.

---

## Как это работает на практике

**Агенту нужен контекст:** `GET /api/search?query=postgres+migration`
Возвращает top-k чанков с путями файлов, скорами и `[[backlinks]]`. Понимает структуру волта. Стоимость: ноль за запрос (локальные эмбеддинги).

**Вы кидаете заметку в `00-inbox/`:** ofelia каждые 5 мин запускает `vault-indexer`.
Индексер чанкует новые файлы, эмбеддит через Ollama, апсертит в pgvector. Watchdog убивает прогоны висящие больше 30 мин. История прогонов в таблице `job_runs`.

**Агент берёт задачу:** `vt claim vt-0042`
Ставит `status: in_progress`, `claimed_by: agent-name` во frontmatter задачи. Другие агенты видят задачу как not-ready в `vt ready`. Атомарный O_EXCL счётчик в `obsidian-vault/.vt/seq` - двойного захвата не будет.

**Хотите подключить нового агента:** направьте его на `https://your-domain/mcp`.
MCP-сервер выставляет search, read, write, list, backlinks. Один интерфейс для всех агентов.

**Хотите узнать сколько стоила ночь:** `https://your-domain/grafana/`
Token-monitor собирает каждый LLM-вызов от каждого агента. Дашборд показывает токены по моделям, стоимость по проектам, запросы по агентам. Никаких догадок.

**Прогон молча сломался:** Watchdog логирует убитые задачи.
`SELECT * FROM job_runs WHERE status='killed'` скажет какая задача, когда, сколько отработала до смерти.

**Вопрос про граф backlinks:** `GET /api/backlinks?file=02-projects/foo.md`
Возвращает обратные `[[wikilinks]]`, разрешённые на этапе индексации. Никакого on-the-fly сканирования.

**Вы коммитите в волт:** Forgejo держит git-историю волта.
Локальный push, web UI, полный аудит. Сам `obsidian-vault/` gitignored из этого репо - это *ваш* волт в *вашем* git.

**Хотите поднять свежую коробку сегодня вечером:** `./deploy.sh install`
Один скрипт. Генерирует секреты, рендерит Caddyfile из шаблона, поднимает 14 контейнеров, запускает первичную индексацию. Идемпотентный - можно перезапускать.

---

## До и после

| | Без этого стека | С этим стеком |
|---|---|---|
| Агент читает заметку | Кастомный file IO у каждого | Один REST/MCP endpoint, один на всех |
| Семантический поиск | Оплата за запрос | Бесплатно, локально, sub-100ms |
| Новая заметка проиндексирована | Ручной reindex-скрипт | ofelia каждые 5 мин, watchdog подстрахует |
| Устаревшие эмбеддинги | Перестройка всего волта | Инкрементально: hash compare + chunk diff |
| Backlinks | Grep `[[name]]` в рантайме | Материализованы в таблице `backlinks` |
| Наблюдаемость | Никакой | 4 дашборда Grafana из коробки |
| Учёт стоимости | "Ну посмотри в OpenAI dashboard" | По агентам, по моделям, по проектам, в вашей же БД |
| Учёт задач | Linear / GitHub Issues / TodoWrite | `vt`: markdown-задачи в том же волте, атомарный счётчик |
| TLS / rate limit | nginx-конфиг, который вы пишете | Caddy через `Caddyfile.tmpl`, rate_limit per route |
| Бэкап | Ручной `pg_dump` cronjob | `deploy.sh backup` покрывает postgres, волт, секреты |
| История волта | Потеряна при потере диска | Forgejo на `/git/`, полный git-таймлайн |
| Здоровье стека | `docker ps`, на глаз | `/api/healthz` + Grafana + таблица убитых watchdog'ом задач |

---

## Как устроено

```
  +------------------------------------------+
  |                                          |
  |   LAYER 1: Edge                          |
  |   Caddy + TLS + rate_limit + auth        |
  |                                          |
  +------------------------------------------+
  |                                          |
  |   LAYER 2: Agents                        |
  |   REST API + MCP server                  |
  |   (один backend, два протокола)          |
  |                                          |
  +------------------------------------------+
  |                                          |
  |   LAYER 3: Storage + Compute             |
  |   Postgres + pgvector | Ollama embed     |
  |   Forgejo (git)       | tokmon ingest    |
  |                                          |
  +------------------------------------------+
  |                                          |
  |   LAYER 4: Scheduler                     |
  |   ofelia: indexer 5m, watchdog 5m,       |
  |           audit-cleanup weekly           |
  |                                          |
  +------------------------------------------+
  |                                          |
  |   LAYER 5: Observability                 |
  |   VictoriaMetrics + node + cAdvisor      |
  |   + postgres-exporter + Grafana          |
  |                                          |
  +------------------------------------------+
```

**Layer 1** терминирует TLS, лимитит rate, маршрутизирует по префиксу пути.
**Layer 2** говорит и REST (для HTTP-агентов), и MCP (для Claude Code, Codex, Gemini CLI).
**Layer 3** - сами данные: чанки + векторы в Postgres, эмбеддинги от Ollama, история волта в Forgejo, каждый LLM-вызов в tokmon.
**Layer 4** держит индекс живым без systemd-таймеров - все cron'ы лежат как Docker-лейблы на `vault-rag-tools`.
**Layer 5** отвечает на вопросы "здоров ли", "сколько стоит", "индексирует ли" без вашего ssh.

---

## Компоненты

### Edge

| Контейнер | Роль |
|---|---|
| `vault-rag-caddy` | TLS + reverse proxy + per-route rate_limit, рендерится из `Caddyfile.tmpl` |

### Агенты

| Контейнер | Роль |
|---|---|
| `vault-rag-api` | REST: `/api/search`, `/api/read`, `/api/write`, `/api/backlinks`, `/api/healthz` |
| `vault-rag-mcp` | MCP-сервер, те же операции как MCP tools |
| `vault-rag-tokmon-ingest` | Endpoint для учёта стоимости, принимает события LLM-вызовов от агентов |

### Хранилище + compute

| Контейнер | Роль |
|---|---|
| `vault-rag-postgres` | pgvector. БД: `vault_rag` (chunks/backlinks/meta/jobs/job_runs/vault_audit), `tokmon` |
| `vault-rag-ollama` | Локальные эмбеддинги, `nomic-embed-text` 768-dim |
| `vault-rag-forgejo` | Self-hosted git для версионирования волта |

### Планировщик

| Контейнер | Роль |
|---|---|
| `vault-rag-tools` | Хост ofelia-лейблов - запускает cron-задачи как эфемерные контейнеры |
| `vault-rag-ofelia` | Демон ofelia, читает лейблы контейнеров для расписания |

| Задача | Расписание | Что делает |
|---|---|---|
| `vault-indexer` | каждые 5 мин | чанкует новые/изменённые заметки, эмбеддит, апсертит pgvector |
| `vault-watchdog` | каждые 5 мин | убивает индекс-прогоны старше 30 мин |
| `cleanup-audit` | еженедельно | чистит строки `vault_audit` старше retention |

### Наблюдаемость

| Контейнер | Роль |
|---|---|
| `vault-rag-vmsingle` | VictoriaMetrics single-node, скрейпит всё ниже |
| `vault-rag-node-exporter` | метрики хоста |
| `vault-rag-cadvisor` | метрики контейнеров |
| `vault-rag-postgres-exporter` | метрики postgres |
| `vault-rag-grafana` | дашборды: stack overview, indexer jobs, postgres, token cost |

---

## vt: Vault Task CLI

Задачи для агентов (и людей) лежат как markdown внутри волта, а не в SaaS-трекере.

```bash
vt create -t epic "Migrate indexer to v2"     # создать
vt ready                                       # незаблокированные открытые задачи
vt claim vt-0042                               # status=in_progress + claimed_by=$VT_AGENT
vt close vt-0042 --reason "shipped in #123"    # закрыть
vt dep add vt-0042 --blocked-by vt-0041        # граф зависимостей
vt remember "Indexer chunks at 1024 tokens"    # сохранить заметку в 09-resources/notes/
```

| Команда | Что делает |
|---|---|
| `vt create [-t type] [-p prio] "title"` | Новая задача в `06-tasks/vt-NNNN-slug.md` |
| `vt list [--all] [--status X]` | Список задач |
| `vt show <id> [--json]` | Печать задачи |
| `vt claim <id> [--by agent] [--force]` | Захват задачи |
| `vt close <id> --reason "..."` | Закрыть задачу |
| `vt update <id> --status X` | Обновить статус |
| `vt ready` | Открытые задачи без активных блокеров, с сортировкой по приоритету |
| `vt dep add\|rm <id> --blocked-by <other>` | Управление графом зависимостей |
| `vt remember "text" [--tags ...]` | Постоянная заметка в `09-resources/notes/` |

Счётчик атомарный через O_EXCL lockfile в `obsidian-vault/.vt/seq`. Параллельные агенты не получат одинаковые номера. Задачи - plain markdown, можно править руками.

---

## Архитектура волта

`vault-skeleton/` копируется в `obsidian-vault/` при первом запуске. `obsidian-vault/` gitignored - храните в собственном приватном git-репо.

```
obsidian-vault/
+-- .vt/                # счётчик и состояние vt (gitignored из скелета)
+-- 00-inbox/           # бросайте новые заметки сюда, индексер подберёт
+-- 01-daily/           # ежедневные логи
+-- 02-projects/        # ноутбуки по проектам
+-- 05-sessions/        # дампы чат-сессий от агентов
+-- 06-tasks/           # vt-NNNN-slug.md файлы задач
+-- 09-resources/       # долгоживущие референсы
|   +-- notes/          # сюда пишет vt remember
|   +-- prompts/        # сохранённые промты
+-- _CLAUDE.md          # operating manual для агентов
+-- index.md            # точка входа
```

---

## Установка

Требования: Linux-хост с `docker`, `docker compose`, `openssl`, `envsubst` и доменом, направленным на хост.

В одну строку:

```bash
git clone https://github.com/bringie/vault-rag.git /opt/vault-rag && cd /opt/vault-rag && cp .env.example .env && $EDITOR .env && ./deploy.sh install
```

Или по шагам:

```bash
git clone https://github.com/bringie/vault-rag.git /opt/vault-rag
cd /opt/vault-rag
cp .env.example .env
# отредактируйте .env: задайте VAULT_RAG_DOMAIN на ваш домен
./deploy.sh install
```

`deploy.sh` идемпотентный. Перезапускайте сколько хотите. Генерирует секреты при первом запуске, рендерит `Caddyfile` из `Caddyfile.tmpl`, поднимает стек, запускает первичную индексацию волта.

После установки:

| Endpoint | Что |
|---|---|
| `https://${VAULT_RAG_DOMAIN}/api/healthz` | 200 `{"ok":true}` |
| `https://${VAULT_RAG_DOMAIN}/api/search?query=hello` | семантический поиск (нужен `X-Vault-Token`) |
| `https://${VAULT_RAG_DOMAIN}/mcp` | MCP-эндпоинт для агентов |
| `https://${VAULT_RAG_DOMAIN}/grafana/` | Grafana, admin-пароль печатает `deploy.sh` |
| `https://${VAULT_RAG_DOMAIN}/git/` | Forgejo |
| `https://${VAULT_RAG_DOMAIN}/tokmon/` | token-monitor ingest |

---

## Конфигурация

Задайте в `.env` до `./deploy.sh install`:

| Ключ | Обязателен | Что |
|---|---|---|
| `VAULT_RAG_DOMAIN` | да | Ваш домен, напр. `vault.example.com` |
| `VAULT_RAG_TOKEN` | авто | API-токен авторизации, генерируется при первом запуске если пуст |
| `POSTGRES_PASSWORD` | авто | Пароль БД, генерируется при первом запуске если пуст |
| `GRAFANA_ADMIN_PASSWORD` | авто | Пароль Grafana admin, печатает инсталлер |
| `OLLAMA_MODEL` | нет | Модель эмбеддингов, дефолт `nomic-embed-text` |
| `INDEXER_INTERVAL` | нет | ofelia cron-выражение, дефолт `@every 5m` |
| `WATCHDOG_THRESHOLD_MIN` | нет | Убивать прогоны старше N мин, дефолт `30` |
| `AUDIT_RETENTION_DAYS` | нет | Retention `vault_audit`, дефолт `90` |

Режимы `deploy.sh`:

```bash
./deploy.sh install        # первый запуск
./deploy.sh update         # pull + recreate
./deploy.sh restart        # рестарт всех сервисов
./deploy.sh backup         # postgres dump + tarball волта + секреты
./deploy.sh status         # docker ps + healthz
./deploy.sh logs <svc>     # логи в follow
```

См. [`docs/architecture.md`](docs/architecture.md) - полная карта сервисов и data flow, [`docs/operations.md`](docs/operations.md) - бэкап/restore/масштабирование, [`docs/api.md`](docs/api.md) - REST + MCP reference.

---

## FAQ

### Зачем self-host вместо managed RAG SaaS?
Ваши заметки - ваш ров. Закрытый RAG SaaS владеет вашими эмбеддингами, ретривалом и часто данными. vault-rag держит всё на диске, который ваш, с plain markdown как канонической формой. Можете завтра выкинуть vault-rag - ваш волт всё ещё ваш.

### Почему Postgres + pgvector, а не отдельная векторная БД?
Одна БД для векторов, метаданных, задач, аудита и tokmon - один бэкап, один пул соединений, один набор кредов, один объект для мониторинга. pgvector + HNSW шустрый для волтов до миллионов чанков. Вырастете - swap БД, API не меняется.

### Почему Ollama для эмбеддингов?
Стоимость эмбеддинга на запрос - ноль, и `nomic-embed-text` конкурентен с платными API на vault-scale ретривале. Меняете модель через `OLLAMA_MODEL` и переиндексируете.

### Почему ofelia, а не systemd-таймеры или cron?
ofelia запускает расписания как Docker-лейблы на тех же контейнерах, которые оркеструет. Миграция стека на новый хост - `git pull && ./deploy.sh install`, без копий systemd-юнитов и cron-on-host. Стек портативный.

### Что делает watchdog?
Каждые 5 мин сканирует `job_runs` на индекс-прогоны со статусом `running` старше `WATCHDOG_THRESHOLD_MIN` (дефолт 30) и убивает их. Без этого зависший Ollama-вызов мог бы навечно прибить контейнер индексера.

### Можно без домена/TLS?
Можно - правьте `Caddyfile.tmpl` под HTTP-only или `tls internal` для self-signed. По дефолту предполагается реальный домен, потому что это путь большинства пользователей.

### Как агенты авторизуются?
Заголовок `X-Vault-Token` на всех REST-маршрутах кроме `/api/healthz`. Токен в `.env` как `VAULT_RAG_TOKEN`, автогенерируется при первой установке. MCP использует тот же токен через свой server config.

### Как индексация обрабатывает удаления и переименования?
Индексер сравнивает состояние волта с таблицей `meta` на каждом прогоне. Исчезнувшие файлы помечаются на удаление чанков. Переименования сейчас выглядят как delete+add (улучшение в будущем).

### Как делать бэкап?
`./deploy.sh backup` снимает postgres (custom-format dump), директорию волта и секреты. Выхлоп идёт в `./backups/YYYY-MM-DD-HHMMSS/`. Для DR реплицируйте `backups/` на удалённый сторадж.

### Как добавить нового агента?
Направьте на `/mcp` (для MCP-native агентов) или `/api/*` (для HTTP). Используйте `VAULT_RAG_TOKEN`. Опционально пусть POST'ит каждый LLM-вызов в `/tokmon/`, чтобы попадать на дашборд стоимости.

### Где открывать issues?
GitHub Issues в репо. PR'ы приветствуются.

### Чем `vt` отличается от полноценного issue-трекера?
`vt` - тонкий markdown-native трекер под агентов работающих рядом с людьми над одним волтом. Задачи diff-friendly, grep-friendly, переживают потерю SaaS-аккаунта. Это не замена Jira на 50-человечной команде - это замена TodoWrite-листа и beads-БД на маленьком проекте, где волт и есть source of truth.

---

## Философия

Большинство "AI memory" инструментов делают вас уборщиком. Вы их кормите, чистите, умоляете запомнить.

Этот стек инвертирует это. Ваш волт - plain markdown. Ваши агенты говорят на одном протоколе. Индексер крутится сам. Стоимость на виду. Задачи живут рядом с заметками.

Вы думаете и пишете. Стек запоминает, ищет, наблюдает и считает счета.

**Волт - source of truth. Всё остальное - сантехника.**

---

## Контрибьютинг

PR'ы приветствуются:
- Новые форматы загрузки (PDF, аудио, OCR картинок)
- Альтернативные backends эмбеддингов (instructor, BGE, Voyage)
- Расширения MCP tools
- Дашборды Grafana
- Улучшения backup/restore
- Скрипты multi-host деплоя

---

## Лицензия

MIT. См. [LICENSE](LICENSE).
