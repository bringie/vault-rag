---
type: spec
status: draft
epic: agent-fleet
date: 2026-05-16
---

# Agent-Fleet Daemon Metrics + Inventory — Design Spec

## 1. Goal

Расширить daemon-наблюдаемость двумя потоками:
- **Metrics** (high-frequency, lossy) — CPU%, RAM, disk usage. Каждые 10s.
- **Inventory** (low-frequency, snapshot) — Claude skills, MCP servers, Claude version + settings.json. На hello + при изменении + heartbeat каждые 15 мин.

UI получает live sparkline через WS push + initial backfill из time-series таблицы. Tabs на host detail для skills/MCP/settings.

## 2. Constraints / non-goals

- Linux + macOS only (Windows позже)
- Нет внешних npm-deps в daemon (vanilla node + /proc + shellouts на df/vm_stat)
- Нет alerting/thresholds в MVP
- Нет per-process metrics (только host-aggregate)
- Settings JSON шлём read-only — credentials/tokens скрываем

## 3. Architecture

```
[ daemon (each host) ]              [ hub (single)             ]    [ browser UI ]
  /proc + os.cpus()        metrics    insertHostMetric           
  10s setInterval           ────WS───►  → fleet_host_metrics      
  /proc/meminfo + df                                                ◄── WS push ──
  + diff jiffies                                                   GET /hosts/:id/metrics?since=1h
                                                                   (initial backfill)
  ~/.claude/plugins        inventory  setHostInventory             
  ~/.claude/mcp.json       ────WS───► → fleet_hosts.metadata     
  on hello / 15min / mtime              .inventory JSONB           
```

Два WS-frame type'а в существующем daemon→hub protocol: `metrics`, `inventory`.

UI viewer WS получает новый role-extension `subscribe:host_metrics&host_id=X` — hub fanout metrics-фрейма всем подписчикам этого хоста.

## 4. Schema

Миграция `sql/011-fleet-host-metrics.sql`:

```sql
-- Raw time-series, 24h retention.
CREATE TABLE IF NOT EXISTS fleet_host_metrics (
  host_id        uuid NOT NULL REFERENCES fleet_hosts(id) ON DELETE CASCADE,
  ts             timestamptz NOT NULL DEFAULT now(),
  cpu_pct        real,
  ram_used_bytes bigint,
  ram_total_bytes bigint,
  disk           jsonb,    -- [{mount, size_bytes, used_bytes, avail_bytes}, ...]
  net            jsonb,    -- {rx_bps, tx_bps} or null
  error          text      -- 'proc_unavailable' etc.
);

CREATE INDEX IF NOT EXISTS idx_fleet_host_metrics_ts_brin
  ON fleet_host_metrics USING brin (ts);
CREATE INDEX IF NOT EXISTS idx_fleet_host_metrics_host_ts
  ON fleet_host_metrics (host_id, ts DESC);

-- Downsampled 5-min rollup, 7d retention. Filled by cron from raw.
CREATE TABLE IF NOT EXISTS fleet_host_metrics_5m (
  host_id        uuid NOT NULL REFERENCES fleet_hosts(id) ON DELETE CASCADE,
  bucket         timestamptz NOT NULL,   -- date_trunc('5 minutes', ts)
  cpu_pct_avg    real,
  cpu_pct_max    real,
  ram_used_bytes bigint,
  PRIMARY KEY (host_id, bucket)
);

CREATE INDEX IF NOT EXISTS idx_fleet_host_metrics_5m_bucket
  ON fleet_host_metrics_5m (bucket DESC);
```

Inventory хранится в `fleet_hosts.metadata` JSONB (существующая колонка) под ключом `inventory`:

```json
{
  "inventory": {
    "collected_at": "2026-05-16T12:00:00Z",
    "skills": [{"plugin":"superpowers", "version":"5.1.0", "name":"brainstorming"}],
    "mcp_servers": [{"name":"vault-rag", "enabled":true, "command":"node", "args":["..."]}],
    "claude_version": "1.5.2",
    "settings": {"model":"claude-opus-4-7", "permissionMode":"acceptEdits"}
  },
  "latest_metrics": {"ts":"...","cpu_pct":17.3,"ram_used_bytes":...}
}
```

**Retention strategy:**
- Raw: cron каждый час `DELETE FROM fleet_host_metrics WHERE ts < now() - interval '24 hours'`
- Rollup: cron каждые 5 мин — `INSERT INTO ... _5m SELECT host_id, date_trunc('5 minutes', ts), avg(cpu_pct), max(cpu_pct), avg(ram_used_bytes) FROM fleet_host_metrics WHERE ts > coalesce(last_bucket, '1970') GROUP BY host_id, bucket ON CONFLICT DO UPDATE`. Старше 7 дней — DELETE.

## 5. Daemon collectors

### `collectMetrics()` — ~80 LOC, vanilla node

```js
// agent-fleet/daemon/src/metrics-collector.js
const fs = require('node:fs');
const os = require('node:os');
const { execSync } = require('node:child_process');

let prevCpu = null;
let prevNet = null;
let prevNetTs = null;

async function collectMetrics() {
  const ts = new Date().toISOString();
  try {
    return {
      ts,
      cpu_pct: await getCpuPct(),
      ram_used_bytes: getRamUsed(),
      ram_total_bytes: os.totalmem(),
      disk: getDisk(),
      net: getNet(),
    };
  } catch (e) {
    return { ts, cpu_pct: null, ram_used_bytes: null, error: e.message };
  }
}

async function getCpuPct() {
  // Linux /proc/stat — fields: user nice system idle iowait irq softirq steal guest guest_nice
  // We use idle ONLY (not idle+iowait) because iowait is unreliable on busy I/O hosts
  // and can produce >100% or negative deltas (kernel can revise it downward).
  if (fs.existsSync('/proc/stat')) {
    const sample = () => {
      const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
      const [, ...vals] = line.split(/\s+/).map(Number);
      const idle = vals[3];                          // idle only (NOT idle+iowait)
      const total = vals.reduce((a, b) => a + b, 0); // total includes iowait — that's fine
      return { idle, total };
    };
    const a = sample();
    await new Promise(r => setTimeout(r, 200));
    const b = sample();
    const idleDiff = b.idle - a.idle;
    const totalDiff = b.total - a.total;
    if (!totalDiff) return 0;
    const pct = 100 * (1 - idleDiff / totalDiff);
    return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));  // clamp [0,100]
  }
  // macOS: os.cpus() returns cumulative times
  const sample = () => {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const c of cpus) {
      for (const k in c.times) { total += c.times[k]; if (k === 'idle') idle += c.times[k]; }
    }
    return { idle, total };
  };
  const a = sample();
  await new Promise(r => setTimeout(r, 200));
  const b = sample();
  const idleDiff = b.idle - a.idle;
  const totalDiff = b.total - a.total;
  if (!totalDiff) return 0;
  const pct = 100 * (1 - idleDiff / totalDiff);
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));  // clamp [0,100]
}

function getRamUsed() {
  if (fs.existsSync('/proc/meminfo')) {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = parseInt(/MemTotal:\s+(\d+)/.exec(meminfo)[1], 10) * 1024;
    const avail = parseInt(/MemAvailable:\s+(\d+)/.exec(meminfo)[1], 10) * 1024;
    return total - avail;
  }
  return os.totalmem() - os.freemem();
}

function getDisk() {
  try {
    const out = execSync('df -kP', { encoding: 'utf8', timeout: 2000 });
    return out.trim().split('\n').slice(1).map(line => {
      const [fs_, blocks, used, avail, _pct, mount] = line.split(/\s+/);
      return { mount, size_bytes: +blocks * 1024, used_bytes: +used * 1024, avail_bytes: +avail * 1024 };
    }).filter(d => !d.mount.startsWith('/snap/') && !d.mount.startsWith('/dev')
                && !['/proc','/sys','/run','/run/lock'].some(p => d.mount.startsWith(p))
                && !d.mount.startsWith('/var/lib/docker/')
                && !d.mount.startsWith('/var/lib/containerd/'));
  } catch { return []; }
}

function getNet() {
  if (!fs.existsSync('/proc/net/dev')) return null;
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    let rx = 0, tx = 0;
    for (const line of lines) {
      const m = line.trim().match(/^([^:]+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
      if (!m) continue;
      if (m[1] === 'lo' || m[1].startsWith('docker') || m[1].startsWith('veth')) continue;
      rx += Number(m[2]); tx += Number(m[3]);
    }
    const now = Date.now();
    if (!prevNet) { prevNet = { rx, tx }; prevNetTs = now; return null; }
    const dt = (now - prevNetTs) / 1000;
    const result = dt > 0 ? { rx_bps: Math.round((rx - prevNet.rx) / dt), tx_bps: Math.round((tx - prevNet.tx) / dt) } : null;
    prevNet = { rx, tx }; prevNetTs = now;
    return result;
  } catch { return null; }
}

module.exports = { collectMetrics };
```

### `collectInventory()` — ~60 LOC

```js
// agent-fleet/daemon/src/inventory-collector.js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

let lastMtimes = {};

// mtime check only watches mcp.json + settings.json (single files — reliable).
// Plugin tree (~/.claude/plugins/cache) is NOT mtime-checked because
// parent-dir mtime doesn't propagate for nested version updates
// (e.g. cache/X/plugin/5.1.1/ landing inside existing X/plugin/ dir).
// Plugin changes show up at the 15-min heartbeat.
function inventoryChanged() {
  const home = os.homedir();
  const targets = [
    path.join(home, '.claude', 'mcp.json'),
    path.join(home, '.claude', 'settings.json'),
  ];
  let changed = false;
  for (const p of targets) {
    try {
      const stat = fs.statSync(p);
      const m = stat.mtimeMs;
      if (lastMtimes[p] !== m) { lastMtimes[p] = m; changed = true; }
    } catch {
      // File deleted — treat as change too
      if (lastMtimes[p] !== undefined) { lastMtimes[p] = undefined; changed = true; }
    }
  }
  return changed;
}

// Called on WS reconnect — clears cache so first post-reconnect tick sends inventory.
function resetInventoryCache() { lastMtimes = {}; }

function collectInventory() {
  const home = os.homedir();
  return {
    collected_at: new Date().toISOString(),
    skills: scanSkills(home),
    mcp_servers: parseMcpServers(home),
    claude_version: detectClaudeVersion(),
    settings: parseSettings(home),
  };
}

function scanSkills(home) {
  const root = path.join(home, '.claude', 'plugins', 'cache');
  if (!fs.existsSync(root)) return [];
  const skills = [];
  try {
    // .claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>
    for (const mp of fs.readdirSync(root)) {
      const mpDir = path.join(root, mp);
      for (const plugin of safeReaddir(mpDir)) {
        const pluginDir = path.join(mpDir, plugin);
        for (const version of safeReaddir(pluginDir)) {
          const skillsDir = path.join(pluginDir, version, 'skills');
          for (const name of safeReaddir(skillsDir)) {
            skills.push({ plugin, version, name });
          }
        }
      }
    }
  } catch {}
  return skills;
}

function safeReaddir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
}

function parseMcpServers(home) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'mcp.json'), 'utf8'));
    const out = [];
    for (const [name, def] of Object.entries(cfg.mcpServers || {})) {
      out.push({
        name,
        enabled: def.disabled !== true,
        command: def.command || null,
        args: Array.isArray(def.args) ? def.args.slice(0, 5) : [],
      });
    }
    return out;
  } catch { return []; }
}

function detectClaudeVersion() {
  try { return execSync('claude --version', { encoding: 'utf8', timeout: 1500 }).trim(); }
  catch { return null; }
}

// SECURITY POLICY: settings.json forwarding is a STRICT ALLOWLIST.
// Adding fields requires security review. The following keys are EXCLUDED:
//   env        — contains API tokens (GITLAB_TOKEN, GRAFANA_TOKEN, etc.)
//   hooks      — shell commands that may include credentials
//   permissions.allow/deny — reveal internal URLs and command patterns
//   disabledMcpjsonServers — minor info-leak about config
//   credentials/.credentials.json refs
// Allowed value types per field validated below — drop value if shape unexpected.
function parseSettings(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    const out = {};
    if (typeof raw.model === 'string')          out.model = raw.model;
    if (typeof raw.permissionMode === 'string') out.permissionMode = raw.permissionMode;
    if (raw.autoUpdater && typeof raw.autoUpdater === 'object'
        && typeof raw.autoUpdater.enabled === 'boolean') {
      out.autoUpdater = { enabled: raw.autoUpdater.enabled };
    }
    // enabledPlugins must be Record<string, boolean> — drop if not
    if (raw.enabledPlugins && typeof raw.enabledPlugins === 'object'
        && Object.values(raw.enabledPlugins).every(v => typeof v === 'boolean')) {
      out.enabledPlugins = raw.enabledPlugins;
    }
    return out;
  } catch { return null; }
}

module.exports = { collectInventory, inventoryChanged, resetInventoryCache };
```

### Daemon main loop wiring

В `agent-fleet/daemon/bin/daemon.js` после hello-frame:

```js
// On each WS open (initial + reconnect): reset inventory cache so we re-send
// fresh inventory once. Otherwise hub may carry stale inventory after daemon restart.
ws.on('open', () => {
  resetInventoryCache();
  // Send first inventory immediately on hello so hub has data within seconds.
  safeSend(ws, { type: 'inventory', ...collectInventory() });
});

setInterval(async () => {
  try {
    const m = await collectMetrics();
    safeSend(ws, { type: 'metrics', ...m });
  } catch (e) { /* swallow — next tick retries */ }
}, 10_000);

setInterval(() => {
  if (inventoryChanged()) {
    safeSend(ws, { type: 'inventory', ...collectInventory() });
  }
}, 60_000);  // check mtime every minute

setInterval(() => {
  // Heartbeat — always send every 15 min даже без mtime-change.
  // Also catches plugin-tree updates which aren't mtime-watched.
  safeSend(ws, { type: 'inventory', ...collectInventory() });
}, 900_000);
```

## 6. Hub ingestion

В `scripts/lib/fleet-routes.js` `handleDaemonWs` добавить cases:

```js
if (f.type === 'metrics') {
  await fleetDb.insertHostMetric(ctx.db, host.id, f);
  await fleetDb.setHostLatestMetrics(ctx.db, host.id, f);  // merge into metadata
  ctx.bus.broadcastHostMetrics(host.id, { type: 'metrics', host_id: host.id, ...f });
}
if (f.type === 'inventory') {
  await fleetDb.setHostInventory(ctx.db, host.id, f);
  ctx.bus.broadcastHostMetrics(host.id, { type: 'inventory', host_id: host.id, ...f });
}
```

Bus добавит `addMetricsViewer(hostId, ws)` + `broadcastHostMetrics(hostId, frame)` — паттерн как для workflow_viewer.

## 7. REST API

| Method | Path | Response |
|--------|------|----------|
| GET | `/fleet/hosts/:id/metrics?since=1h` | `[{ts, cpu_pct, ram_used_bytes, disk, ...}]` — raw из `fleet_host_metrics` |
| GET | `/fleet/hosts/:id/metrics?since=24h&downsampled=1` | rollup из `fleet_host_metrics_5m` |
| GET | `/fleet/hosts/:id/inventory` | `{skills, mcp_servers, claude_version, settings}` — из metadata.inventory |

`since` parameter: `1h`, `24h`, `7d`. Hub validates whitelist.

## 8. WS protocol extension

Новая viewer role: `?role=metrics_viewer&host_id=<uuid>`. Hub:
- На connect — отдельный subscription (не путать с session viewer)
- Daemon `metrics` frame → hub broadcastHostMetrics всем `metrics_viewer` с этим host_id
- Same for `inventory`

**Lifecycle decoupling**: `metrics_viewer` subscription is per `host_id`, NOT tied to a daemon socket. If the daemon disconnects:
- Subscribers stay connected to hub, just stop receiving frames until daemon reconnects.
- UI shows "host offline" badge but keeps last-known sparkline data visible.
Hub's bus tracks `metricsViewersByHost = Map<host_id, Set<ws>>`. On viewer ws.close → remove from set. On daemon disconnect → no cleanup needed (set already correct, just no incoming traffic).

### Existing host_info vs new metrics — overlap

`collectHostInfo()` (existing, sent in hello frame at daemon startup) reports static-ish host description: `cpu_model`, `cpu_cores`, `ram_total_bytes`, `node_version`, `hostname`, `platform_release`, `uptime_seconds`. Stored once in `fleet_hosts.metadata`.

`collectMetrics()` (new, every 10s) reports the live stream: `cpu_pct`, `ram_used_bytes`, `disk`, `net`. Stored in `fleet_host_metrics`.

**Reconciliation**: `ram_total_bytes` appears in BOTH (static at hello + live in metrics). This is intentional — UI doesn't fetch hello-data per-frame; the metrics frame carries enough for self-contained rendering. `cpu_pct` is metrics-only; `cpu_model` stays in host_info. No code dedup needed.

## 9. UI — host detail page

Существующая страница `#/hosts/:id` (часть dashboard host detail) дополняется:

**Live metrics row:**
```
CPU [████░░░░░░] 42.3%   RAM [██████░░░░] 6.1/16 GB   net ↓2.1MB/s ↑0.3MB/s
```

**Sparklines:**
- CPU% за последний час (SVG polyline, ~360 точек = 1h@10s)
- RAM% за час
- Click → zoom 24h (downsampled rollup)

**Disk usage:**
Таблица: mount, used/size + progress bar.

**Tabs:**
- **Sessions** (текущие fleet-сессии — already exists)
- **Skills** — таблица plugin/version/name (фильтруемый поиск)
- **MCP servers** — таблица name/enabled-badge/command (✓ зелёный/✗ красный)
- **Settings** — JSON pretty-print (read-only)

Лоадинг:
1. На вход — REST `GET /hosts/:id/metrics?since=1h` для sparkline backfill + `GET /hosts/:id/inventory` для tabs
2. WS connect `?role=metrics_viewer&host_id=X` для live tail
3. Append каждый incoming metrics frame, shift старые

## 10. File layout

| File | Purpose | Status |
|------|---------|--------|
| `sql/011-fleet-host-metrics.sql` | Schema + indices | new |
| `agent-fleet/daemon/src/metrics-collector.js` | /proc + df collectors | new (~120 LOC) |
| `agent-fleet/daemon/src/inventory-collector.js` | Skills + MCP + settings | new (~100 LOC) |
| `agent-fleet/daemon/src/ws-client.js` | Wire metrics + inventory intervals | modify (~30 LOC) |
| `agent-fleet/daemon/test/metrics-collector.test.js` | Unit tests | new |
| `agent-fleet/daemon/test/inventory-collector.test.js` | Unit tests | new |
| `scripts/lib/fleet-db.js` | insertHostMetric, setHostInventory, etc. | modify (+~80 LOC) |
| `scripts/lib/fleet-db.test.js` | Tests | modify |
| `scripts/lib/fleet-routes.js` | handleDaemonWs cases, REST endpoints, metrics_viewer role | modify (+~120 LOC) |
| `scripts/lib/fleet-routes.test.js` | Tests | modify |
| `scripts/lib/fleet-retention.js` | Cron-driven downsampling + cleanup | new (~50 LOC) |
| `agent-fleet/web/host-detail.js` | Page enhancement: sparklines + tabs | new (~250 LOC) |
| `agent-fleet/web/index.html` | Containers | modify |
| `agent-fleet/web/app.css` | Sparkline + bar styles | modify |

Total ~750 LOC.

## 11. Retention implementation

Использовать существующий ofelia container (cron) или добавить `setInterval` в hub:

```js
// scripts/lib/fleet-retention.js — called from rag-api.js every 5 min + once at boot.
// Wider 30-min lookback window covers late-arriving samples (WS reconnect buffering,
// brief hub downtime). ON CONFLICT DO UPDATE recomputes the bucket from full raw data
// each time, so late samples within the 30-min window are correctly reflected.
// Samples landing outside this window for an already-existing bucket are lost.
async function runRetention(db) {
  // 1. Upsert 5-min rollups from raw — recompute last 6 buckets each tick
  await db.query(`
    INSERT INTO fleet_host_metrics_5m (host_id, bucket, cpu_pct_avg, cpu_pct_max, ram_used_bytes)
    SELECT host_id, date_trunc('5 minutes', ts) AS bucket,
           avg(cpu_pct)::real, max(cpu_pct)::real, avg(ram_used_bytes)::bigint
    FROM fleet_host_metrics
    WHERE ts > now() - interval '30 minutes' AND ts < date_trunc('5 minutes', now())
    GROUP BY host_id, bucket
    ON CONFLICT (host_id, bucket) DO UPDATE SET
      cpu_pct_avg = EXCLUDED.cpu_pct_avg,
      cpu_pct_max = EXCLUDED.cpu_pct_max,
      ram_used_bytes = EXCLUDED.ram_used_bytes`);
  // 2. Cleanup
  await db.query(`DELETE FROM fleet_host_metrics WHERE ts < now() - interval '24 hours'`);
  await db.query(`DELETE FROM fleet_host_metrics_5m WHERE bucket < now() - interval '7 days'`);
}
```

Wiring in rag-api boot: run once on startup, then `setInterval(() => runRetention(ctx.db).catch(console.error), 5 * 60 * 1000)`.

**Acknowledged loss**: samples arriving > 30 min late for an already-flushed bucket are not rolled up. WS reconnects buffer a single tick — well within the 30-min window. Hub downtime > 30 min on a sample-rich host: rolled-up bucket may underrepresent during that gap. Raw data is still kept 24h, so the gap is recoverable by manual SQL.

## 12. Failure modes

| Condition | Daemon behaviour | Hub behaviour |
|-----------|------------------|---------------|
| `/proc/stat` unreadable (container) | Send `{cpu_pct:null, error:'proc_unavailable'}` | Store row, UI shows "unavailable" badge |
| `df` hangs > 2s | Skip disk, send rest | Disk array empty в payload |
| `~/.claude/mcp.json` missing | `mcp_servers:[]` (not null) | UI shows empty MCP tab |
| WS disconnect mid-tick | Buffer next tick locally (single tick) | No-op (gap in time-series visible in sparkline) |
| Inventory file corrupted JSON | Catch in parseMcpServers/parseSettings, return null | UI shows "—" |

## 13. Out-of-scope (v2)

- Per-process CPU/RAM breakdown (`top`-style)
- Network throughput per-interface in UI
- Alerts/thresholds + notifications
- Windows daemon support
- Historical query > 7d
- Aggregate fleet-wide metrics (e.g. "total CPU across all hosts")

## 14. Success criteria

1. Daemon на dev-машине шлёт `metrics` каждые 10s; hub видит INSERT в `fleet_host_metrics`.
2. После 1 минуты — 6 rows в таблице с CPU%/RAM. CPU% выглядит правдоподобно (1-90% range).
3. Daemon шлёт `inventory` на hello → fleet_hosts.metadata.inventory.skills непустой (≥1).
4. UI host detail показывает CPU/RAM sparkline за последний час (live update каждые 10s через WS).
5. Tab "MCP servers" показывает список серверов с enabled-badge.
6. После 24h+ — старые raw rows удалены, 5-min rollup доступен через `?downsampled=1`.
7. Daemon на macOS работает (CPU% через os.cpus, RAM через os.totalmem/freemem, нет /proc).
8. Container daemon (no /proc) → один row с error, UI показывает "metrics unavailable".

## 15. Open questions for user review

Один пункт — нужно ли settings.json в inventory выставлять в UI как JSON pretty-print (потенциально полезно, но добавляет noise), или скрыть за expand-toggle?

Решение по умолчанию: **expand-toggle**, не показываем по дефолту — settings всё-таки технический dump.
