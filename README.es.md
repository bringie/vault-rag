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
  <a href="README.ru.md">Русский</a> &middot;
  <strong>Español</strong>
</p>

<h1 align="center">vault-rag</h1>

<p align="center">
  <strong>Stack RAG multi-agente self-hosted para un vault markdown estilo Obsidian.</strong>
  <br /><br />
  <em>Un único Docker Compose. Memoria, recuperación, observabilidad y seguimiento de costes - en una sola caja. Tus notas se quedan en tu disco. Tus agentes se mantienen sincronizados.</em>
  <br /><br />
  <em>14 contenedores &middot; REST + MCP &middot; pgvector HNSW &middot; indexación con ofelia &middot; vt task CLI &middot; dashboards de Grafana</em>
  <br /><br />
  <a href="#cómo-funciona-en-la-práctica">Verlo en acción</a> &middot;
  <a href="#componentes">Todos los componentes</a> &middot;
  <a href="#instalación">Instalación</a> &middot;
  <a href="#configuración">Configuración</a> &middot;
  <a href="#configuración-del-agente">Configurar agente</a> &middot;
  <a href="#faq">FAQ</a>
</p>

---

## El Problema

Ejecutas varios agentes de IA. Cada uno arranca desde cero. Las conversaciones terminan, el contexto se evapora, las decisiones se olvidan por la mañana.

Escribes notas en Obsidian. Cientos de archivos. Los agentes no las leen, no las buscan semánticamente, no distinguen lo nuevo de lo viejo. En cada sesión vuelves a explicar el mismo proyecto.

Encima quemas tokens. No sabes cuánto cuesta cada agente. No sabes si el indexador corrió anoche. No sabes qué nota respondió a la última consulta.

**Vault, agentes, observabilidad y seguimiento de costes - cuatro problemas que normalmente se cubren con cuatro facturas SaaS.**

---

## Qué es

Un stack Docker de 14 contenedores que convierte un vault markdown en una base de conocimiento consultable, observable y amigable para agentes:

| | Stack SaaS típico | vault-rag |
|---|---|---|
| **Almacenamiento** | Nube del proveedor, opaca | Markdown plano en tu disco, versionado vía Forgejo |
| **Embeddings** | Coste por llamada API | Ollama nomic-embed-text local (768-dim), coste cero por consulta |
| **Índice vectorial** | Pinecone/Weaviate gestionado | Postgres + pgvector HNSW, en la misma BD que los metadatos |
| **Acceso de agentes** | HTTP custom para cada uno | REST + MCP, ambos hablan al mismo backend |
| **Indexación** | Manual o cron en VPS | Scheduler ofelia label-driven dentro del contenedor, watchdog incluido |
| **Observabilidad** | Logs en stdout, métricas en ningún lado | VictoriaMetrics + Grafana, 4 dashboards prefabricados |
| **Seguimiento de coste** | Ninguno | Endpoint ingest de token-monitor, todos los agentes loguean cada llamada |
| **Seguimiento de tareas** | Herramienta externa | CLI `vt`, las tareas viven como markdown dentro del propio vault |

Si quieres un vault que sea *legible para agentes y humanos, manteniendo el control total de los datos*, esto es lo que buscas.

---

## Cómo funciona en la práctica

**Un agente necesita contexto:** `POST /api/search` con `{"query":"postgres migration","k":5}`
Devuelve los top-k chunks con rutas de archivo, scores y `[[backlinks]]`. Entiende el vault. Coste: cero por consulta (embeddings locales).

**Sueltas una nota en `00-inbox/`:** ofelia dispara `vault-indexer` cada 5 min.
El indexador chunkea archivos nuevos, los embebe vía Ollama, hace upsert en pgvector. El watchdog mata corridas que cuelgan más de 30 min. Historial de jobs en la tabla `job_runs`.

**Un agente reclama una tarea:** `vt claim vt-0042`
Pone `status: in_progress`, `claimed_by: agent-name` en el frontmatter de la tarea. Otros agentes la ven como not-ready en `vt ready`. Contador atómico O_EXCL en `obsidian-vault/.vt/seq` - sin claims dobles.

**Quieres conectar un nuevo agente:** apúntalo a `https://your-domain/mcp`.
El servidor MCP expone tools `search`, `get`, `put`, `backlinks`. Misma interfaz para todos los agentes.

**Quieres saber cuánto costó la noche:** `https://your-domain/grafana/`
Token-monitor ingiere cada llamada LLM de cada agente. El dashboard muestra tokens por modelo, coste por proyecto, requests por agente. Sin adivinanzas.

**Una corrida se rompió en silencio:** El watchdog loguea jobs muertos.
`SELECT * FROM job_runs WHERE status='killed'` te dice qué job, cuándo y cuánto corrió antes de morir.

**Pregunta sobre el grafo de backlinks:** `POST /api/backlinks` con `{"path":"02-projects/foo.md"}`
Devuelve `[[wikilinks]]` inversos resueltos en tiempo de indexación. Sin escaneos on-the-fly.

**Commits cambios al vault:** Forgejo guarda la historia git del vault.
Push local, web UI, audit trail completo. El propio `obsidian-vault/` está gitignored de este repo - es *tu* vault, en *tu* git.

**Quieres montar una caja nueva esta noche:** `./deploy.sh install`
Un script. Genera secretos, renderiza Caddyfile desde plantilla, levanta 14 contenedores, dispara la indexación inicial. Idempotente - puedes re-ejecutarlo.

---

## Antes y después

| | Sin este stack | Con este stack |
|---|---|---|
| Agente lee una nota | File IO custom por agente | Un endpoint REST/MCP, todos lo usan |
| Búsqueda semántica | Coste API por consulta | Gratis, local, sub-100ms |
| Nota nueva indexada | Script reindex manual | ofelia dispara cada 5 min, watchdog protege |
| Embeddings obsoletos | Reconstrucción del vault entero | Incremental: hash compare + chunk diff |
| Backlinks | Grep `[[name]]` en runtime | Materializados en la tabla `backlinks` |
| Observabilidad | Ninguna | 4 dashboards Grafana de fábrica |
| Seguimiento de coste | "Mira el dashboard de OpenAI" | Por agente, por modelo, por proyecto, en tu propia BD |
| Seguimiento de tareas | Linear / GitHub Issues / TodoWrite | `vt`: tareas markdown en el mismo vault, contador atómico |
| TLS / rate limit | Config nginx que escribes | Caddy con `Caddyfile.tmpl`, rate_limit por ruta |
| Backup | Cronjob `pg_dump` manual | `deploy.sh backup` cubre postgres, vault, secretos |
| Historia del vault | Perdida si pierdes el disco | Forgejo en `/git/`, timeline git completo |
| Salud del stack | `docker ps`, ojo desnudo | `/api/healthz` + Grafana + tabla de jobs muertos por watchdog |

---

## Cómo está construido

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
  |   (mismo backend, dos protocolos)        |
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

**Layer 1** termina TLS, limita rate, enruta por prefijo de path.
**Layer 2** habla REST (para agentes HTTP-native) y MCP (para Claude Code, Codex, Gemini CLI).
**Layer 3** son los datos: chunks + vectores en Postgres, embeddings de Ollama, historia del vault en Forgejo, cada llamada LLM en tokmon.
**Layer 4** mantiene el índice vivo sin systemd timers - todos los crons viven como Docker labels en `vault-rag-tools`.
**Layer 5** responde "¿está sano?, ¿cuánto cuesta?, ¿está indexando?" sin que tengas que entrar por SSH.

---

## Componentes

### Edge

| Contenedor | Rol |
|---|---|
| `vault-rag-caddy` | TLS + reverse proxy + rate_limit por ruta, renderizado desde `Caddyfile.tmpl` |

### Agentes

| Contenedor | Rol |
|---|---|
| `vault-rag-api` | REST: `/api/search`, `/api/get`, `/api/put`, `/api/backlinks`, `/api/healthz` (todos POST con JSON, excepto healthz GET) |
| `vault-rag-mcp` | Servidor MCP, mismas operaciones expuestas como MCP tools |
| `vault-rag-tokmon-ingest` | Endpoint de seguimiento de coste, acepta eventos de llamadas LLM de agentes |

### Almacenamiento + compute

| Contenedor | Rol |
|---|---|
| `vault-rag-postgres` | pgvector. BDs: `vault_rag` (chunks/backlinks/meta/jobs/job_runs/vault_audit), `tokmon` |
| `vault-rag-ollama` | Embeddings locales, `nomic-embed-text` 768-dim |
| `vault-rag-forgejo` | Git self-hosted para versionado del vault |

### Scheduler

| Contenedor | Rol |
|---|---|
| `vault-rag-tools` | Host de labels ofelia - corre cron jobs como contenedores efímeros |
| `vault-rag-ofelia` | Daemon ofelia, lee labels de contenedores para el schedule |

| Job | Schedule | Qué hace |
|---|---|---|
| `vault-indexer` | cada 5 min | chunkea notas nuevas/cambiadas, embebe, upsert pgvector |
| `vault-watchdog` | cada 5 min | mata corridas de índice más viejas que 30 min |
| `cleanup-audit` | semanal | poda filas de `vault_audit` más viejas que el retention |

### Observabilidad

| Contenedor | Rol |
|---|---|
| `vault-rag-vmsingle` | VictoriaMetrics single-node, scrapea todo lo de abajo |
| `vault-rag-node-exporter` | métricas del host |
| `vault-rag-cadvisor` | métricas de contenedores |
| `vault-rag-postgres-exporter` | métricas de postgres |
| `vault-rag-grafana` | dashboards: stack overview, indexer jobs, postgres, token cost |

---

## vt: Vault Task CLI

Las tareas para agentes (y humanos) viven como markdown dentro del vault, no en un issue tracker SaaS.

```bash
vt create -t epic "Migrate indexer to v2"     # crear
vt ready                                       # tareas abiertas no bloqueadas
vt claim vt-0042                               # status=in_progress + claimed_by=$VT_AGENT
vt close vt-0042 --reason "shipped in #123"    # cerrar
vt dep add vt-0042 --blocked-by vt-0041        # grafo de dependencias
vt remember "Indexer chunks at 1024 tokens"    # guardar nota en 09-resources/notes/
```

| Comando | Qué hace |
|---|---|
| `vt create [-t type] [-p prio] "title"` | Nueva tarea en `06-tasks/vt-NNNN-slug.md` |
| `vt list [--all] [--status X]` | Lista tareas |
| `vt show <id> [--json]` | Imprime tarea |
| `vt claim <id> [--by agent] [--force]` | Reclama tarea |
| `vt close <id> --reason "..."` | Cierra tarea |
| `vt update <id> --status X` | Actualiza status |
| `vt ready` | Tareas abiertas sin blockers activos, ordenadas por prioridad |
| `vt dep add\|rm <id> --blocked-by <other>` | Gestiona el grafo de dependencias |
| `vt remember "text" [--tags ...]` | Nota persistente en `09-resources/notes/` |

El contador es atómico vía lockfile O_EXCL en `obsidian-vault/.vt/seq`. Sin doble numeración entre agentes paralelos. Las tareas son markdown plano - editables a mano.

Las mismas operaciones disponibles vía REST y MCP:

```bash
# REST
curl -X POST $VAULT_RAG_URL/api/task/create \
  -H "Authorization: Bearer $VAULT_RAG_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Refactor auth","type":"task","priority":1}'

# MCP (en config del agente)
# tool: task_create, args: {"title":"Refactor auth"}
```

Referencia completa: [docs/tasks.md](docs/tasks.md).

---

## Arquitectura del vault

`vault-skeleton/` se copia a `obsidian-vault/` en el primer arranque. `obsidian-vault/` está gitignored - guárdalo en tu propio repo git privado.

```
obsidian-vault/
+-- .vt/                # contador y estado de vt (gitignored desde el skeleton)
+-- 00-inbox/           # suelta notas nuevas aquí, el indexador las recoge
+-- 01-daily/           # logs diarios
+-- 02-projects/        # cuadernos por proyecto
+-- 05-sessions/        # dumps de sesiones de chat de los agentes
+-- 06-tasks/           # archivos de tareas vt-NNNN-slug.md
+-- 09-resources/       # referencias de larga vida
|   +-- notes/          # vt remember escribe aquí
|   +-- prompts/        # prompts guardados
+-- _CLAUDE.md          # manual de operación para agentes
+-- index.md            # punto de entrada
```

---

## Auto-sync del vault (opcional)

Si seteás `VAULT_GIT_REMOTE` en `.env`, vault-rag trata cada `/api/put` y `/api/task/*` como un commit. El proceso API debouncea las escrituras 1.5s y luego dispara `obsidian-vault/.sync/vault-sync.sh push`, que:

1. `git add -A` + `git commit` (taggeado por host: `auto-sync <hostname> <iso-ts>`).
2. Aplasta auto-commits consecutivos del mismo host dentro de los últimos 5 min, pero solo mientras estén por delante de `origin/main` (nunca reescribe historia ya pusheada).
3. `git pull --rebase --autostash origin main`. Si el rebase falla, los commits divergentes se guardan como patch en `_refactor/conflicts/conflict-<ts>-<host>.patch`, hard-reset a `origin/main`, y el snapshot del conflicto se commitea aparte.
4. `git push origin main`.

Concurrency-safe vía lockdir (`.sync/.lock`). Fire-and-forget: la respuesta REST no espera al git. Para forzar un flush bloqueante:

```bash
docker exec vault-rag-api bash /vault/.sync/vault-sync.sh flush
```

Deshabilitado cuando `VAULT_GIT_REMOTE` está vacío. Para activarlo después de un install: seteá la variable, corré `./deploy.sh --bootstrap-vault-git`, y recreá `vault-rag-api`.

---

## Instalación

Requisitos: host Linux con `docker`, `docker compose`, `openssl`, `envsubst`, y un dominio apuntando al host.

Una línea:

```bash
git clone https://github.com/bringie/vault-rag.git /opt/vault-rag && cd /opt/vault-rag && cp .env.example .env && $EDITOR .env && ./deploy.sh install
```

O paso a paso:

```bash
git clone https://github.com/bringie/vault-rag.git /opt/vault-rag
cd /opt/vault-rag
cp .env.example .env
# edita .env: pon VAULT_RAG_DOMAIN a tu dominio
./deploy.sh install
```

`deploy.sh` es idempotente. Re-ejecuta cuando quieras. Genera secretos en el primer arranque, renderiza `Caddyfile` desde `Caddyfile.tmpl`, levanta el stack y dispara la indexación inicial del vault.

Después de instalar:

| Endpoint | Qué |
|---|---|
| `https://${VAULT_RAG_DOMAIN}/api/healthz` | 200 `{"ok":true}` |
| `https://${VAULT_RAG_DOMAIN}/api/search` | búsqueda semántica - POST JSON `{"query":"...","k":5}`, header `Authorization: Bearer $VAULT_RAG_API_TOKEN` |
| `https://${VAULT_RAG_DOMAIN}/mcp` | endpoint del servidor MCP para agentes |
| `https://${VAULT_RAG_DOMAIN}/grafana/` | Grafana, password admin impreso por `deploy.sh` |
| `https://${VAULT_RAG_DOMAIN}/git/` | Forgejo |
| `https://${VAULT_RAG_DOMAIN}/tokmon/` | ingest de token-monitor |

---

## Configuración

Define en `.env` antes de `./deploy.sh install`:

| Clave | Requerida | Qué |
|---|---|---|
| `VAULT_RAG_DOMAIN` | sí | Tu dominio, p. ej. `vault.example.com` |
| `VAULT_RAG_API_TOKEN` | auto | Token de auth REST (`Authorization: Bearer ...`), autogenerado si vacío |
| `VAULT_RAG_MCP_TOKEN` | auto | Token de auth MCP (`X-Vault-Token: ...`), autogenerado si vacío |
| `POSTGRES_PASSWORD` | auto | Password de BD, generada en el primer arranque si vacía |
| `GRAFANA_ADMIN_PASSWORD` | auto | Password admin de Grafana, impresa por el instalador |
| `OLLAMA_MODEL` | no | Modelo de embeddings, default `nomic-embed-text` |
| `INDEXER_INTERVAL` | no | Expresión cron de ofelia, default `@every 5m` |
| `WATCHDOG_THRESHOLD_MIN` | no | Mata corridas más viejas que N min, default `30` |
| `AUDIT_RETENTION_DAYS` | no | Retention de `vault_audit`, default `90` |
| `VAULT_GIT_REMOTE` | no | Si está seteado, cada `/api/put` y `/api/task/*` auto-commitea + pushea el vault a este remote (debounce 1.5s). Vacío = auto-sync deshabilitado. |

Modos de `deploy.sh`:

```bash
./deploy.sh install        # primer arranque
./deploy.sh update         # pull + recreate
./deploy.sh restart        # reinicia todos los servicios
./deploy.sh backup         # postgres dump + tarball del vault + secretos
./deploy.sh status         # docker ps + healthz
./deploy.sh logs <svc>     # logs en follow
```

Mira [`docs/architecture.md`](docs/architecture.md) para el mapa completo de servicios y data flow, [`docs/operations.md`](docs/operations.md) para backup/restore/escalado, y [`docs/api.md`](docs/api.md) para la referencia REST + MCP.

---

## Configuración del Agente

Una vez que el stack está arriba, apunta tu agente hacia él. Dos caminos: **MCP** (recomendado para Claude Code, Codex, Gemini CLI) o **REST** (cualquier cliente HTTP).

Vas a necesitar:
- `https://${VAULT_RAG_DOMAIN}/mcp` - el endpoint MCP
- `VAULT_RAG_API_TOKEN` - para REST (`Authorization: Bearer ...`), impreso por `./deploy.sh install`, también en `.env`
- `VAULT_RAG_MCP_TOKEN` - para MCP (`X-Vault-Token: ...`), distinto del de REST, también impreso y en `.env`

### Claude Code

Añade el server al `.mcp.json` del proyecto (o al `~/.claude.json` a nivel de usuario):

```json
{
  "mcpServers": {
    "vault-rag": {
      "type": "http",
      "url": "https://your-domain/mcp",
      "headers": {
        "X-Vault-Token": "PASTE_VAULT_RAG_MCP_TOKEN_HERE"
      }
    }
  }
}
```

Reinicia Claude Code y `/mcp` debería listar `vault-rag` con las tools `put`, `search`, `get`, `backlinks`.

### Codex CLI

En `~/.codex/config.toml`:

```toml
[mcp_servers.vault-rag]
url = "https://your-domain/mcp"

[mcp_servers.vault-rag.headers]
X-Vault-Token = "PASTE_VAULT_RAG_MCP_TOKEN_HERE"
```

### Gemini CLI

En `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "vault-rag": {
      "httpUrl": "https://your-domain/mcp",
      "headers": { "X-Vault-Token": "PASTE_VAULT_RAG_MCP_TOKEN_HERE" }
    }
  }
}
```

### REST simple (cualquier agente / script)

```bash
export VAULT="https://your-domain"
export API_TOKEN="PASTE_VAULT_RAG_API_TOKEN_HERE"

# Healthz es el único GET; el resto son POST con body JSON.
curl -sS "$VAULT/api/healthz"

curl -sS -X POST -H "Authorization: Bearer $API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"query":"hello","k":5}' \
     "$VAULT/api/search"

curl -sS -X POST -H "Authorization: Bearer $API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"path":"00-inbox/note.md","content":"# hi","mode":"create"}' \
     "$VAULT/api/put"
```

### Cómo decirle al agente que use el vault

Después de cablear MCP, dale al agente un briefing único para que conozca las convenciones. Pega esto en el `CLAUDE.md` / `AGENTS.md` / system prompt de tu proyecto:

```
Tienes acceso a vault-rag vía el MCP server `vault-rag`.

Convenciones:
- Antes de responder cualquier cosa relacionada al proyecto, llama al
  tool `search` con la consulta del usuario. Lee los top results con
  `get` si los snippets no alcanzan.
- Cuando aprendas algo durable (decisión, patrón, gotcha), persístelo
  vía `put` en `09-resources/notes/YYYY-MM-DD-slug.md`.
- Tira los session dumps y los hilos largos de chat a `05-sessions/`.
- Nunca escribas fuera de tu namespace de agente excepto `00-inbox/`
  (intake), `05-sessions/` (transcripts) y `09-resources/notes/`
  (conocimiento).
- Para las tasks usa la CLI `vt` en el host (no MCP). Las tasks viven
  en `06-tasks/vt-NNNN-slug.md`. `vt ready` para encontrar trabajo,
  `vt claim` para tomarlo.
- Las escrituras vía `put` y `task_*` auto-commitean y pushean el vault al
  git remote configurado (debounce 1.5s). NO corras `vault-sync.sh` a mano
  durante el trabajo normal - es automático. Esperá que los commits aparezcan
  ~2s después de tu escritura. Manual flush solo si editaste archivos por
  fuera de MCP/REST.

El vault es la fuente de verdad. Buscá antes de preguntar. Persiste lo
que importa.
```

### Prompt de bootstrap (de cero a funcionando)

¿Querés que un agente levante vault-rag en una máquina nueva por vos? Pegá esto en una sesión de Claude Code / Codex / Gemini abierta en el host destino (o con acceso SSH a él):

````
Estás desplegando vault-rag, un stack RAG multi-agente self-hosted, en
este host Linux. Trabajá paso a paso. Verificá cada paso antes de
avanzar. No sigas tras una falla - arreglala primero.

Objetivo: un vault-rag totalmente corriendo en https://<VAULT_RAG_DOMAIN>/,
con el endpoint MCP accesible y un esqueleto de vault fresco indexado.

Inputs que el usuario debe proveer (preguntá si faltan):
- VAULT_RAG_DOMAIN: un dominio que apunte a este host (A/AAAA seteado).
- Opcional: email ACME para Let's Encrypt.
- Opcional: VAULT_GIT_REMOTE - URL git (ssh o https) donde el vault va a
  auto-commitear + pushear cada escritura. Vacío = sin auto-sync. Si lo
  seteás, después del install corré `./deploy.sh --bootstrap-vault-git`
  para inicializar el repo en `obsidian-vault/`.

Pasos:
1. Pre-flight checks:
   - `docker --version`, `docker compose version` - deben pasar
   - `openssl version`, `which envsubst` - deben pasar
   - confirmar que los puertos 80 y 443 están libres en este host
2. Cloná el repo:
   `git clone https://github.com/bringie/vault-rag.git /opt/vault-rag`
   `cd /opt/vault-rag`
3. Creá `.env` desde `.env.example`. Seteá `VAULT_RAG_DOMAIN`. Dejá los
   campos secretos vacíos - el installer los completa.
4. Corré `./deploy.sh install`. Capturá los valores impresos de
   `VAULT_RAG_API_TOKEN`, `VAULT_RAG_MCP_TOKEN` y `GRAFANA_ADMIN_PASSWORD`.
5. Health checks (reintentá hasta 2 minutos, el stack se calienta):
   - `curl -fsS https://${VAULT_RAG_DOMAIN}/api/healthz` -> 200
   - `docker ps --format '{{.Names}} {{.Status}}'` - los 14 containers `Up`
   - `curl -fsS -X POST -H "Authorization: Bearer $API_TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"query":"index","k":3}' \
       "https://${VAULT_RAG_DOMAIN}/api/search"` -> array JSON
6. Dispará una corrida del indexer y confirmá que terminó:
   `docker exec vault-rag-tools /usr/local/bin/run-indexer.sh`
   luego `psql ... -c "SELECT status, started_at FROM job_runs
   ORDER BY started_at DESC LIMIT 1;"` - última fila `status='ok'`.
7. Imprimí el resumen final al usuario:
   - MCP URL: https://${VAULT_RAG_DOMAIN}/mcp
   - REST base: https://${VAULT_RAG_DOMAIN}/api
   - Grafana: https://${VAULT_RAG_DOMAIN}/grafana/  (admin / <password>)
   - Forgejo: https://${VAULT_RAG_DOMAIN}/git/
   - VAULT_RAG_API_TOKEN: <token para REST `Authorization: Bearer`>
   - VAULT_RAG_MCP_TOKEN: <token para MCP `X-Vault-Token`>
8. Ofrecé escribir el bloque de config MCP para el agente del usuario
   (Claude Code / Codex / Gemini CLI - preguntá cuál).

Reglas:
- Nunca edites `obsidian-vault/` directamente durante el install - es
  el directorio de datos del usuario. El esqueleto está en
  `vault-skeleton/` y se copia en el primer arranque.
- Nunca commitees secretos. `.env` y `secrets/` están gitignored.
- Si un container queda unhealthy tras 2 minutos, corré
  `./deploy.sh logs <svc>` y reportá el error real al usuario antes de
  reintentar.
- Idempotente: volver a correr `./deploy.sh install` es seguro.
````

Pasale al agente ese prompt más acceso a shell (o corrélo vos mismo en una sesión de Claude Code en el host). Cuando termina, tenés un stack corriendo y las credenciales necesarias para conectar cualquier otro agente.

---

## FAQ

### ¿Por qué self-host en vez de un RAG SaaS gestionado?
Tus notas son tu foso. Los RAG SaaS de código cerrado son dueños de tus embeddings, tu retrieval y a menudo tus datos. vault-rag mantiene todo en disco que tú posees, con markdown plano como formato canónico. Puedes arrancar vault-rag mañana y tu vault sigue siendo tuyo.

### ¿Por qué Postgres + pgvector en vez de una BD vectorial dedicada?
Una sola base para vectores, metadatos, jobs, audit y tokmon significa un backup, un connection pool, un set de credenciales, una cosa que monitorizar. pgvector con HNSW es lo bastante rápido para vaults de hasta millones de chunks. Si te quedas corto, lo cambias - la API no cambia.

### ¿Por qué Ollama para embeddings?
El coste de embedding por consulta es cero, y `nomic-embed-text` es competitivo con APIs de embedding pagas para retrieval a escala de vault. Cambias modelo poniendo `OLLAMA_MODEL` y reindexando.

### ¿Por qué ofelia y no systemd timers o cron?
ofelia corre schedules como Docker labels sobre los mismos contenedores que orquesta. Migrar el stack a un host nuevo es `git pull && ./deploy.sh install` - sin copias de unit files de systemd, sin cron-on-host. El stack es portable.

### ¿Qué hace el watchdog?
Cada 5 min escanea `job_runs` buscando corridas de indexador marcadas `running` más viejas que `WATCHDOG_THRESHOLD_MIN` (default 30) y las mata. Sin él, una llamada Ollama colgada podría dejar pegado un contenedor de indexer para siempre.

### ¿Puedo correrlo sin dominio / TLS?
Sí - edita `Caddyfile.tmpl` para usar HTTP-only o `tls internal` para self-signed. El default asume un dominio real porque ese es el camino de la mayoría.

### ¿Cómo se autentican los agentes?
Dos tokens independientes, ambos autogenerados por `./deploy.sh install`:
- **REST API**: header `Authorization: Bearer ${VAULT_RAG_API_TOKEN}` en todas las rutas excepto `/api/healthz`. Todos los endpoints (`/search`, `/get`, `/backlinks`, `/put`) son POST con body JSON.
- **MCP**: header `X-Vault-Token: ${VAULT_RAG_MCP_TOKEN}` en la config del server del agente. El endpoint es `/mcp` (JSON-RPC 2.0 sobre HTTP).

Tokens distintos para poder rotar uno sin romper el otro.

### ¿Cómo maneja la indexación las eliminaciones y renames?
El indexador compara el estado del vault contra la tabla `meta` en cada corrida. Los archivos que desaparecen se marcan para eliminación de chunks. Los renames ahora se ven como delete+add (mejora futura).

### ¿Cómo hago backup?
`./deploy.sh backup` snapshota postgres (custom-format dump), el directorio del vault y los secretos. La salida va a `./backups/YYYY-MM-DD-HHMMSS/`. Para DR replica `backups/` a un sitio externo.

### ¿Cómo agrego un nuevo agente?
Apúntalo a `/mcp` (para agentes MCP-native) con `VAULT_RAG_MCP_TOKEN` o a `/api/*` (clientes HTTP, scripts) con `VAULT_RAG_API_TOKEN`. Opcionalmente que haga POST de cada llamada LLM a `/tokmon/` para aparecer en el dashboard de coste.

### ¿Dónde abro issues?
GitHub Issues en el repo. PRs bienvenidos.

### ¿En qué se diferencia `vt` de un issue tracker real?
`vt` es un tracker delgado markdown-native afinado para agentes trabajando junto a humanos sobre un vault único. Las tareas son diff-friendly, grep-friendly y sobreviven a perder la cuenta SaaS. No es un reemplazo de Jira en un equipo de 50 personas - es un reemplazo de una lista TodoWrite y una BD beads en un proyecto chico donde el vault es la fuente de verdad.

---

## Filosofía

La mayoría de las herramientas de "AI memory" te convierten en el conserje. Las alimentas, las podas, les ruegas que recuerden.

Este stack invierte eso. Tu vault es markdown plano. Tus agentes hablan un protocolo. Tu indexador corre solo. Tus costes están a la vista. Tus tareas viven al lado de tus notas.

Tú piensas y escribes. El stack recuerda, recupera, observa y cobra.

**El vault es la fuente de verdad. Todo lo demás es plomería.**

---

## Contribuir

PRs bienvenidos:
- Nuevos formatos de ingest (PDF, audio, OCR de imágenes)
- Backends alternativos de embedding (instructor, BGE, Voyage)
- Extensiones de MCP tools
- Dashboards de Grafana
- Mejoras de backup/restore
- Scripts de deploy multi-host

---

## Licencia

MIT. Ver [LICENSE](LICENSE).
