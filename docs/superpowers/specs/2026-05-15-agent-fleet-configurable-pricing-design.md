---
type: spec
status: draft
epic: agent-fleet
date: 2026-05-15
---

# Agent-Fleet Configurable LLM Pricing — Design Spec

## 1. Goal

Заменить hardcoded таблицу цен в `scripts/lib/fleet-cost.js` на конфигурируемый источник, чтобы оператор мог добавлять/обновлять цены на любые LLM (Claude новых версий, GPT, Gemini, локальные модели) без релиза кода. Сохранить точность исторических отчётов через temporal pricing (snapshot at event time).

## 2. Constraints / non-goals

- Один глобальный price-table (без per-tenant, per-host, per-time-of-day rates)
- 4 token-типа: `input`, `output`, `cache_creation_5m`, `cache_read` (как сейчас)
- Без discount/credit-plans (если у юзера Claude Pro — это вне scope cost-аналитики)
- Tokmon events table остаётся as-is (внешний DB, мы его не трогаем — храним только цены в нашем `vault_rag`)

## 3. Architecture

```
[ tokmon.events ]      [ fleet_model_prices ]      [ rag-api hub ]
   model='claude-opus-4-7'   pattern='claude-opus-%'    in-memory cache (60s TTL)
   ts                        priority=100               on read:
   tokens...                 valid_from=1970-01-01      pick row where
                             input_per_mtok=15            pattern LIKE model
                             ...                          AND valid_from <= ts
                                                          AND !deleted_at
                                                        sort: priority DESC, valid_from DESC
                                                        first match wins
```

Поток: cost-эндпоинты (sessionCost, hostSummary, timeline) уже агрегируют события по `model`. Сейчас они зовут `rowCost(row)` который синхронно достаёт цены из in-memory `PRICES`. Меняем на `rowCost(row, ts)` где price resolver работает с in-memory кешем загруженным из БД.

**Существующее переиспользуем:**
- `fleet-routes.js` REST pattern (auth, send, readBody)
- `vault_rag` Postgres pool (тот же что для fleet_*)
- UI routing pattern (#/cost, #/groups → новый #/prices)

## 4. Schema

Миграция `sql/010-fleet-model-prices.sql`:

```sql
CREATE TABLE fleet_model_prices (
  id                    bigserial PRIMARY KEY,
  match_pattern         text NOT NULL,            -- LIKE pattern, e.g. 'claude-opus-%' or '*' for default
  priority              int NOT NULL DEFAULT 100, -- higher wins among multiple matches
  valid_from            timestamptz NOT NULL DEFAULT now(),
  input_per_mtok        numeric(10,4) NOT NULL,
  output_per_mtok       numeric(10,4) NOT NULL,
  cache_create_per_mtok numeric(10,4) NOT NULL DEFAULT 0,
  cache_read_per_mtok   numeric(10,4) NOT NULL DEFAULT 0,
  flagged               boolean NOT NULL DEFAULT false,  -- UI signals unpriced/fallback model
  note                  text,
  deleted_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fleet_model_prices_priority
  ON fleet_model_prices (priority DESC, valid_from DESC)
  WHERE deleted_at IS NULL;

-- Seed current hardcoded values at epoch so all historical events match.
INSERT INTO fleet_model_prices
  (match_pattern, priority, valid_from, input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok)
VALUES
  ('claude-opus-%',   200, '1970-01-01', 15.00, 75.00, 18.75, 1.50),
  ('claude-sonnet-%', 200, '1970-01-01',  3.00, 15.00,  3.75, 0.30),
  ('claude-haiku-%',  200, '1970-01-01',  1.00,  5.00,  1.25, 0.10),
  ('%',                 0, '1970-01-01',  0.00,  0.00,  0.00, 0.00);  -- fallback, flagged on resolve
```

**Invariants:**
- `valid_from` immutable — UPDATE never bumps it. Edits = new INSERT, original stays for history.
- Soft-delete via `deleted_at` IS NOT NULL. Cache filters on read.
- `flagged` only on the `%` row to surface "unpriced model" warnings in UI.

## 5. Price resolution

Один in-memory cache на хабе:

```js
let cache = { rows: [], loadedAt: 0 };

async function ensureCache(db) {
  if (Date.now() - cache.loadedAt < 60_000 && cache.rows.length) return cache;
  const { rows } = await db.query(`
    SELECT id, match_pattern, priority, valid_from,
           input_per_mtok, output_per_mtok,
           cache_create_per_mtok, cache_read_per_mtok, flagged
    FROM fleet_model_prices
    WHERE deleted_at IS NULL
    ORDER BY priority DESC, valid_from DESC`);
  cache = { rows, loadedAt: Date.now() };
  return cache;
}

function resolve(rows, model, ts) {
  const m = (model || '').toLowerCase();
  const at = ts instanceof Date ? ts : new Date(ts || Date.now());
  for (const r of rows) {
    if (new Date(r.valid_from) > at) continue;
    if (likeMatch(r.match_pattern.toLowerCase(), m)) return r;
  }
  return null;
}

// LIKE-pattern matcher: '%' = any chars, '_' = single char (translates to regex).
function likeMatch(pattern, s) {
  const re = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.') + '$', 'i');
  return re.test(s);
}
```

Cache invalidation: POST/DELETE handlers сбрасывают `cache.loadedAt = 0`. 60s TTL — safety-net на случай шеренги хабов в будущем.

**Resolution algorithm:**
1. Sort by (priority DESC, valid_from DESC) — once, at load
2. Linear scan: pick first row where `valid_from <= ts AND pattern LIKE model`
3. Return row including `flagged` boolean
4. If nothing matched (table totally empty?) → return `null` → caller uses ZERO_PRICE fallback

## 6. fleet-cost.js refactor

Изменения:

```js
// before:
function priceFor(model) { ... hardcoded ... }
function rowCost(r) { const [pi,po,pcc,pcr] = priceFor(r.model); ... }

// after:
const prices = require('./fleet-prices');  // new module

async function rowCost(r, ts, db) {
  const p = await prices.priceFor(db, r.model, ts);
  return (
    Number(r.input_tokens)      / 1e6 * p.input +
    Number(r.output_tokens)     / 1e6 * p.output +
    Number(r.cache_creation_5m) / 1e6 * p.cache_create +
    Number(r.cache_read)        / 1e6 * p.cache_read
  );
}
```

`rowCost` становится async — все callers (sessionCost, hostSummary, timeline, timelineByLabel) обновляются через `Promise.all` для batch resolve.

**Performance**: для одного timeline call — single `ensureCache(db)` upfront → 1 SQL hit max per minute. Resolver работает в JS over ~10-50 rows.

## 7. fleet-prices.js (new module)

```js
'use strict';
// fleet-prices: cache-backed price resolver. Single source of truth: fleet_model_prices.
let cache = { rows: [], loadedAt: 0 };
const TTL_MS = 60_000;
const ZERO_PRICE = { input: 0, output: 0, cache_create: 0, cache_read: 0, flagged: true, id: null };

async function load(db) {
  const { rows } = await db.query(`...`);  // see Section 5
  cache = { rows, loadedAt: Date.now() };
}

async function ensure(db) {
  if (Date.now() - cache.loadedAt >= TTL_MS || !cache.rows.length) await load(db);
}

function invalidate() { cache.loadedAt = 0; }

async function priceFor(db, model, ts) {
  await ensure(db);
  const m = (model || '').toLowerCase();
  const at = ts instanceof Date ? ts : new Date(ts || Date.now());
  for (const r of cache.rows) {
    if (new Date(r.valid_from) > at) continue;
    if (likeMatch(r.match_pattern.toLowerCase(), m)) {
      return {
        input: Number(r.input_per_mtok),
        output: Number(r.output_per_mtok),
        cache_create: Number(r.cache_create_per_mtok),
        cache_read: Number(r.cache_read_per_mtok),
        flagged: r.flagged,
        id: r.id,
      };
    }
  }
  return ZERO_PRICE;
}

function likeMatch(pattern, s) { ... }  // see Section 5

module.exports = { priceFor, invalidate, load, _cache: () => cache };
```

## 8. REST API

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET    | `/fleet/prices` | — | `[{id, match_pattern, priority, valid_from, input_per_mtok, ..., flagged, note}]` — active rows (deleted_at IS NULL) |
| GET    | `/fleet/prices?history=1` | — | то же + soft-deleted, full history |
| POST   | `/fleet/prices` | `{match_pattern, priority?, valid_from?, input_per_mtok, output_per_mtok, cache_create_per_mtok?, cache_read_per_mtok?, note?}` | `201 {id, ...}` — INSERT only, never UPDATE existing. valid_from defaults to now() |
| DELETE | `/fleet/prices/:id` | — | `204` — soft (set deleted_at = now()) |
| POST   | `/fleet/prices/resolve` | `{model, at?}` | `{matched: {id, pattern, ...}, computed: {input, output, cache_create, cache_read}}` — debug endpoint |

**No PATCH.** Чтобы изменить цену — POST новой строки. История остаётся reproducible. Operator hint в UI: "Edit → create new snapshot at current time".

Auth: тот же bearer что для остальных fleet endpoints.

## 9. UI: `#/prices` page

Standalone overlay (как `#/groups`, `#/cost`). Доступ из main nav: новая кнопка `$ pricing` или ссылка из cost view "Edit pricing →".

**Layout:**
- Header: PRICING title, "+ new" button, "show history" toggle, back-to-dashboard
- Table:

| Pattern | Priority | Valid From | Input/Mtok | Output/Mtok | Cache 5m | Cache Read | Actions |
|---------|----------|------------|------------|-------------|----------|------------|---------|
| claude-opus-% | 200 | 1970-01-01 | 15.00 | 75.00 | 18.75 | 1.50 | edit / delete |
| ... | | | | | | | |
| % (default) | 0 | — | 0.00 | 0.00 | 0.00 | 0.00 | ⚠ unpriced fallback — flagged |

- "edit" → modal with current values pre-filled, POST creates new snapshot
- "delete" → confirm + soft-delete
- "+ new" → modal for new pattern
- Toggle "show history" expands per-pattern history (collapsed snapshots)

**UI signals:**
- В cost timeline legend: при наличии flagged-matched событий — желтый бейдж `N events @ unpriced model` со ссылкой на /prices

## 10. Migration order

1. Apply `sql/010-fleet-model-prices.sql` — таблица с seed. Endpoint /fleet/prices ещё не работает (route не зарегистрирован), но table готова.
2. Deploy code: новый `fleet-prices.js` module + рефактор `fleet-cost.js`. Cost endpoints читают из новой таблицы. Seeded rows воспроизводят ровно те же числа что hardcoded — pre/post values совпадают, никаких видимых изменений.
3. Deploy UI + /fleet/prices REST. Operator может теперь добавлять модели.

**Rollback:** revert code → cost endpoints вернутся на hardcoded `PRICES`. Table останется (orphan, безвредна).

## 11. File layout

| File | Purpose | Status |
|------|---------|--------|
| `sql/010-fleet-model-prices.sql` | Schema + seed | new |
| `scripts/lib/fleet-prices.js` | Cache + resolver | new |
| `scripts/lib/fleet-prices.test.js` | Resolver tests | new |
| `scripts/lib/fleet-cost.js` | rowCost async, uses fleet-prices | modify |
| `scripts/lib/fleet-cost.test.js` | Update for async rowCost | modify |
| `scripts/lib/fleet-routes.js` | /fleet/prices CRUD + resolve | modify (+~80 LOC) |
| `scripts/lib/fleet-routes.test.js` | 4-5 new tests | modify |
| `agent-fleet/web/prices.js` | Page logic | new (~200 LOC) |
| `agent-fleet/web/index.html` | nav button + container | modify |
| `agent-fleet/web/app.js` | route wiring | modify (+~15 LOC) |
| `agent-fleet/web/app.css` | small additions | modify |

Total new code ~600 LOC.

## 12. Out-of-scope (v2)

- Per-tenant / per-customer pricing
- Time-of-day or volume-tier rates
- Currency other than USD
- Cost forecasting (project current burn → end-of-month)
- Cross-LLM-vendor normalization (just store raw $/Mtok)
- Auto-import from vendor APIs (manual entry only for MVP)

## 13. Success criteria

1. Migration 010 применена; `SELECT count(*) FROM fleet_model_prices` = 4 (3 claude + default).
2. `GET /fleet/cost/timeline` возвращает идентичные числа pre/post deploy.
3. `POST /fleet/prices` создаёт новую row, cache инвалидируется, следующий cost-запрос видит новую цену.
4. `POST /fleet/prices/resolve {model:"gpt-4o"}` возвращает default row с `flagged:true` (до того как оператор добавит gpt-4o явно).
5. После добавления gpt-4o row через UI — следующий fleet-сессии с этой моделью считается по новой цене.
6. Историчность: оператор обновляет opus до 20 в полдень. События до полудня — по 15 (старая row valid_from='1970-01-01'), события после — по 20 (новая row valid_from=now()). Один и тот же timeline-запрос разделяет правильно.

## 14. Open question for user review

Один пункт где мы с sub-agent разошлись и оставлен на твоё решение:

**Cache TTL — 60s или mtime-based invalidate?** Sub-agent: 60s TTL для будущего multi-hub setup. Я склонялся к чистой invalidate-on-write (без TTL). Сейчас фактически в спеке оба — invalidate срабатывает на CRUD, TTL 60s — safety-net для multi-process развёртывания которого пока нет.

Решение по умолчанию: **оставить TTL 60s + invalidate** — не вредит сейчас, не требует доп-усилий для multi-hub.
