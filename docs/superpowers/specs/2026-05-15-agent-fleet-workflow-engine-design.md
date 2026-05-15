---
type: spec
status: draft
epic: agent-fleet
date: 2026-05-15
---

# Agent-Fleet Workflow Engine — Design Spec

## 1. Goal

Дать пользователю возможность собирать многошаговые задачи как блок-схемы: визуальный редактор → DAG узлов → передача результата от узла к узлу с маршрутизацией по группам/labels через существующий fleet API. MVP покрывает три типа узлов (claude / branch / delay), синхронный async runner и live WS-просмотр исполнения.

Это под-проект #2 фазы C поверх существующего agent-fleet (hosts, sessions, groups, labels, REST/WS hub).

## 2. Architecture

Embedded в тот же hub-процесс (`scripts/rag-api.js`), без отдельного сервиса. Один runner на процесс, in-memory state + Postgres persistence.

```
[ web UI editor ]
       │  REST CRUD
       ▼
[ fleet-routes.js workflow handlers ] ──► [ Postgres: fleet_workflows ]
       │  POST /run
       ▼
[ fleet-workflow-runner.js ] ──► spawn fleet sessions via existing dispatch
       │                          (--session-id injected — exact cost attribution)
       │  ws broadcast
       ▼
[ web UI run viewer ]
```

Поток: пользователь рисует DAG → JSON definition в Postgres → POST /run создаёт run-row + runner.start(run_id) в фоне → runner тикает узел за узлом, выходы складывает в `state.outputs[node_id]`, прогресс шлёт по WS подписчикам.

**Существующие куски, которые переиспользуем:**

- `fleet-routes.js` dispatch (включая group filter) — runner просто строит body и зовёт ту же логику что и UI spawn.
- WS broker / role-based broadcast (новая role `workflow_viewer&run_id=X`).
- `--session-id <fleet_sid>` injection — каждый claude-узел получает точную cost attribution в tokmon без heuristic.

## 3. Schema

Миграция `sql/008-fleet-workflows.sql`:

```sql
CREATE TABLE fleet_workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text UNIQUE NOT NULL,
  description text,
  definition  jsonb NOT NULL,         -- {nodes:[...], edges:[...], start:'n1'}
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fleet_workflow_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  uuid REFERENCES fleet_workflows(id) ON DELETE SET NULL,
  snapshot     jsonb NOT NULL,        -- copy of definition at run-time (immutable)
  status       text NOT NULL DEFAULT 'pending',
                                       -- pending|running|done|failed|cancelled
  state        jsonb NOT NULL DEFAULT '{}'::jsonb,
                                       -- {current_node, outputs:{node_id:{...}}, error?}
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fleet_workflow_runs_wid ON fleet_workflow_runs(workflow_id, started_at DESC);
CREATE INDEX idx_fleet_workflow_runs_status ON fleet_workflow_runs(status) WHERE status IN ('pending','running');
```

`snapshot` фиксирует definition в момент запуска — изменения workflow после запуска не ломают историю.

## 4. Definition format

JSON definition хранится как `fleet_workflows.definition`:

```json
{
  "start": "n1",
  "nodes": [
    {
      "id": "n1",
      "type": "claude",
      "target": { "group": "backend" },
      "prompt": "Refactor file {{inputs.path}} and report changes",
      "timeout_s": 300,
      "headless": true,
      "position": { "x": 100, "y": 100 }
    },
    {
      "id": "n2",
      "type": "branch",
      "condition": "n1.exit_code === 0",
      "position": { "x": 320, "y": 100 }
    },
    {
      "id": "n3",
      "type": "claude",
      "target": { "capability": "tests" },
      "prompt": "Run tests after change:\n{{n1.output}}",
      "position": { "x": 540, "y": 40 }
    },
    {
      "id": "n4",
      "type": "delay",
      "seconds": 30,
      "position": { "x": 540, "y": 160 }
    }
  ],
  "edges": [
    { "from": "n1", "to": "n2" },
    { "from": "n2", "to": "n3", "label": "then" },
    { "from": "n2", "to": "n4", "label": "else" }
  ]
}
```

**Node types (MVP):**

- **claude** — спавн fleet-сессии. `target` = `{group}` | `{host_id}` | `{capability}` (передаётся как есть в существующий dispatch). `prompt` поддерживает template substitution. `timeout_s` — kill сессии, `exit_code=124`. `headless: true` → claude запускается с `-p` (one-shot), output собирается в stdout. Если false → interactive PTY, runner ждёт `ended_at`.
- **branch** — `condition` = JS expression в vm.runInNewContext sandbox, доступ к `inputs` + `nX.output` / `nX.exit_code` / `nX.session_id`. Ровно 2 outgoing edges (`label: "then"` + `label: "else"`).
- **delay** — `setTimeout(seconds * 1000)`. На время сна status=`running`, runner шлёт `node_progress` при пробуждении.

**Template substitution:** `{{node_id.field}}` и `{{inputs.field}}` заменяется перед exec. Single-pass replace через regex, не рекурсивно (выход одного узла НЕ интерполирует placeholders в выходе другого). Missing var → empty string + warning в run state. Доступные fields у claude: `output`, `exit_code`, `session_id`. Inputs приходят из POST /run body.

**Validation invariants:**

- start node existing и в nodes
- все edges указывают на existing ids
- нет циклов (DFS)
- branch имеет ровно 2 outgoing (then+else)
- claude.target непустой

## 5. Runner

Файл `scripts/lib/fleet-workflow-runner.js` (~250 LOC).

### Lifecycle

```
POST /run
  → load workflow.definition
  → INSERT fleet_workflow_runs (snapshot=definition, status='pending')
  → runner.start(run_id) detached (no await)
  → 201 { run_id }
```

Внутри runner:

```
async start(run_id):
  UPDATE status='running', started_at=now()
  broadcast {type:'run_state', status:'running'}
  current = snapshot.start
  while current && !cancelled:
    node = nodes[current]
    broadcast {type:'node_progress', node_id:current, status:'running'}
    try:
      result = await exec(node)            // claude / branch / delay
      state.outputs[current] = result
      broadcast {type:'node_progress', status:'done', output: result.output}
      current = nextNode(current, result)  // следует edges, для branch учитывает then/else
    except err:
      state.error = err.message
      broadcast {type:'node_progress', status:'failed', error: err.message}
      UPDATE status='failed', finished_at=now()
      return
  UPDATE status='done', finished_at=now()
  broadcast {type:'run_state', status:'done'}
```

### exec(node) per type

- **claude**: substituteTemplates(prompt) → создаёт fleet-сессию через ту же dispatch-логику (с `--session-id` injection для cost attribution), args = `['-p', prompt]` (headless) или PTY-spawn (interactive). Runner polls `fleet_sessions.status` пока не станет `exited|killed|orphaned` (или timeout_s). После завершения собирает output через `readTranscript(session_id, {kind:'pty_out'})` — concat payload в utf-8 string, truncate до 64KB. Возвращает `{output, exit_code, session_id}`.
- **branch**: substituteTemplates(condition) → `vm.runInNewContext(condition, sandbox, {timeout: 100})`. sandbox = `{inputs, n1: outputs.n1, n2: outputs.n2, ...}`. Возвращает `{result: bool}`. nextNode выбирает edge по `label: "then"` / `"else"`.
- **delay**: `await new Promise(r => setTimeout(r, seconds*1000))`. Возвращает `{}`. Cancellable: при cancel — clearTimeout + reject.

### Concurrency & cancellation

MVP — sequential, один узел за раз. Параллельные ветви (fork-join) откладываются до v2 (потребует waitgroups в state). 

Cancel: `POST /workflow-runs/:id/cancel` → флаг in-memory + UPDATE status='cancelled'. Runner проверяет флаг в начале каждого узла. Активный claude-узел получает SIGTERM через существующий kill-session endpoint.

### Process restart resilience

`pending` или `running` runs при перезапуске hub — UPDATE status='failed', error='hub restart'. (MVP — без resume; добавится при необходимости.) Реализация: при загрузке `fleet-workflow-runner.js` вызывает `orphanRunningRuns()` аналогично `orphanRunningSessions()`.

### Fail-handling

Default — node failed → run failed (abort). Дальше edges не идут. `on_fail: 'continue'` per-node — out of MVP scope.

## 6. REST + WS API

### REST endpoints (под `/api/fleet/`)

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET    | `/workflows` | — | `[{id, name, n_nodes, updated_at}]` |
| POST   | `/workflows` | `{name, description?, definition}` | `201 {id}` |
| GET    | `/workflows/:id` | — | `{id, name, description, definition, created_at, updated_at}` |
| PATCH  | `/workflows/:id` | `{name?, description?, definition?}` | `200 {...}` |
| DELETE | `/workflows/:id` | — | `204` (runs остаются, FK ON DELETE SET NULL) |
| POST   | `/workflows/:id/run` | `{inputs?}` | `201 {run_id}` |
| GET    | `/workflow-runs` | `?workflow_id=&status=&limit=` | list |
| GET    | `/workflow-runs/:id` | — | full state + node statuses |
| POST   | `/workflow-runs/:id/cancel` | — | `200` |

Auth: тот же bearer что для остальных fleet routes.

POST /run возвращает `201 {run_id}` сразу (async), UI подписывается на WS и видит первое `node_progress` через ~1 сек.

### WS protocol extension

Существующий WS hub получает новую role:

```
ws://hub/ws?role=workflow_viewer&run_id=<uuid>&token=<bearer>
```

**Server→client frames (JSON):**

```json
{ "type": "run_state",     "run_id": "...", "status": "running", "started_at": "..." }
{ "type": "node_progress", "run_id": "...", "node_id": "n1", "status": "running" }
{ "type": "node_progress", "run_id": "...", "node_id": "n1", "status": "done", "output": "...", "exit_code": 0, "session_id": "..." }
{ "type": "node_progress", "run_id": "...", "node_id": "n1", "status": "failed", "error": "timeout" }
{ "type": "node_log",      "run_id": "...", "node_id": "n1", "line": "..." }
```

**Client→server:** ничего (read-only). Cancel через REST.

Reconnect через существующий exponential backoff из других role.

## 7. UI Editor (SVG canvas)

Файл `agent-fleet/web/workflow-editor.js` + reusable `workflow-canvas.js` (~500-600 LOC vanilla JS+SVG, без библиотек).

### Routes

- `#/workflows` — list page (table: name, n_nodes, last_run, updated_at, actions[Edit/Run/Delete]) + "New workflow" button.
- `#/workflows/:id/edit` — editor.

### Layout (editor)

Split:

- **left toolbar** (~200px): "Add node ▾" (claude/branch/delay), Save, Run, Back. Validation errors list.
- **center**: SVG canvas (zoom/pan, grid background).
- **right inspector** (~320px): properties выбранного узла или edge.

### SVG canvas

Один `<svg>` viewport. Внутри:

- `<g class="grid">` — pattern dots (CSS).
- `<g class="edges">` — `<path d="M x1,y1 C cx1,cy1 cx2,cy2 x2,y2">` cubic bezier. Стрелка `<marker>` на конце.
- `<g class="nodes">` — каждый node = `<g transform="translate(x,y)">` с `<rect>` (140×60) + `<text>` label + status badge.

### Interactions

| Action | How |
|--------|-----|
| pan | mousedown on bg + drag → translate viewport |
| zoom | wheel → scale 0.5..2.0 |
| add node | toolbar click → ghost follows cursor → click to place |
| move node | mousedown on node + drag, snap to grid (20px) |
| connect | mousedown on output port (right edge dot) → drag → mouseup on input port (left edge) |
| delete | select + Delete key |
| select | click → highlight + populate inspector |

### Node shapes by type

- **claude** (rect, blue): label = node.id + "→" + (target.group||target.host_id||target.capability)
- **branch** (diamond rect with notched corners, amber): label = condition (first 30 chars)
- **delay** (rect, gray, rounded): label = `Wait Ns`

Edges of branch: два outgoing — green ✓ (then), red ✗ (else). Differentiate by `<path stroke>`.

### Inspector forms (per node-type)

- **claude**: target selector (group/host/cap with autocomplete from /api/fleet/groups, /api/fleet/hosts), prompt textarea (с подсказкой `{{n1.output}}`), timeout_s, headless checkbox
- **branch**: condition textarea (JS expression), хелпер со списком доступных vars `n1.exit_code`, `n1.output`
- **delay**: seconds input
- **edge**: from/to readonly, optional label

Изменения applied on blur. Save button сохраняет весь definition через PATCH.

### Validation (client-side, before Save)

Те же invariants что в Section 4. Errors → красный пунктир вокруг проблемного node + список в left toolbar.

### Out of MVP scope

- multi-select drag (выделить группу узлов и переместить)
- undo/redo
- copy/paste узлов

## 8. UI Run Viewer

Файл `agent-fleet/web/workflow-run-viewer.js` (~200 LOC, шарит `workflow-canvas.js`).

### Route

`#/workflow-runs/:id` — full-page split.

### Layout

- **top bar**: workflow name, run status badge (running/done/failed/cancelled), started/duration, Cancel button (if running), Re-run button (if finished).
- **left** (~60%): readonly canvas — тот же SVG что в editor, узлы подсвечены по статусу:
  - idle = gray
  - running = blue + pulse animation
  - done = green
  - failed = red
  - skipped = dashed border
- **right** (~40%): node detail panel. Click node → показывает:
  - input prompt (rendered, после template substitution)
  - output (truncated to 5KB, "Show full" → modal)
  - exit_code, duration
  - link to session: "Open session →" (если claude node, ведёт на `#/sessions/:sid`)
  - error stack trace (если failed)

### Live updates

При открытии — WS connect `?role=workflow_viewer&run_id=<id>`. Handlers:

- `run_state` → обновить top bar badge, при terminal status (done/failed/cancelled) — disable Cancel, enable Re-run.
- `node_progress` → перерисовать node в canvas, если этот node открыт в правой панели — refresh detail.
- `node_log` (опц.) → append в live log section правой панели для running claude node.

Reconnect через тот же exponential backoff.

### Re-run

Кнопка "Re-run" → `POST /workflows/:id/run` (same workflow, без inputs). Получив новый run_id → navigate(`#/workflow-runs/:newId`). Простой rerun без модификации параметров.

### History list

Дополнительно: на странице `#/workflows/:id/edit` снизу — collapsible "Recent runs" (last 10) с inline статусами и links на run viewer.

## 9. File layout

| File | Purpose | ~LOC |
|------|---------|------|
| `sql/008-fleet-workflows.sql` | Schema migration | 30 |
| `scripts/lib/fleet-workflow-db.js` | CRUD: workflows, runs | 60 |
| `scripts/lib/fleet-workflow-runner.js` | DAG execution engine | 250 |
| `scripts/lib/fleet-routes.js` (+= delta) | REST handlers, WS role | +120 |
| `agent-fleet/web/workflow-canvas.js` | Shared SVG renderer | 300 |
| `agent-fleet/web/workflow-editor.js` | Editor page logic | 350 |
| `agent-fleet/web/workflow-run-viewer.js` | Run viewer page | 200 |
| `agent-fleet/web/index.html` (+= delta) | Routes, nav button | +40 |
| `agent-fleet/web/app.js` (+= delta) | Routing wires | +30 |
| `agent-fleet/web/app.css` (+= delta) | Workflow styles | +120 |

Total new code ~1500 LOC.

## 10. Out-of-scope (v2 candidates)

- Parallel branches (fork-join) — runner sequential only
- Resume after hub restart — running → failed at boot
- Scheduled runs (cron) — manual trigger only
- Conditional `on_fail: continue|abort` per-node — default abort
- Webhooks / external triggers
- Workflow templates / clone
- Multi-select drag, undo/redo, copy/paste в редакторе
- Variable passing between non-adjacent nodes (workaround — branch с pass-through)

## 11. Success criteria

1. Создаём workflow в UI с 3 узлами (claude → branch → claude/delay), сохраняем, запускаем.
2. UI run viewer показывает прогресс live: узлы подсвечиваются, output появляется.
3. После завершения — fleet_workflow_runs.status=done, state.outputs полный.
4. Re-run работает, новый run_id, та же snapshot.
5. Cancel в середине running → SIGTERM claude-сессии, status=cancelled.
6. Branch с `n1.exit_code === 0` корректно ветвится по then/else.
7. Cost attribution точная — все session_id из workflow видны в tokmon.events с правильным fleet_sid (через --session-id injection).
