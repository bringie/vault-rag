---
type: plan
status: draft
epic: agent-fleet
spec: docs/superpowers/specs/2026-05-16-agent-fleet-daemon-metrics-design.md
date: 2026-05-16
---

# Agent-Fleet Daemon Metrics + Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement task-by-task. `subagent-driven-development` disabled per project CLAUDE.md.

**Goal:** Daemon собирает CPU%/RAM/disk каждые 10s + Claude inventory (skills, MCP servers, version, settings whitelist) на mtime-change/15min. Hub persists в `fleet_host_metrics` (raw 24h + 5-min rollup 7d) и fanout по WS. UI host detail page показывает live sparklines + tabs.

**Architecture:** Two WS frame types — `metrics` (high-freq lossy) и `inventory` (low-freq snapshot). Raw stored in time-series table, rollup via 5-min retention cron. UI subscribes via new `metrics_viewer` WS role.

**Tech Stack:** Node.js (CommonJS), `pg`, `ws`, `node:test`, vanilla browser SVG.

---

## File Layout

| File | Purpose | Status |
|------|---------|--------|
| `sql/011-fleet-host-metrics.sql` | Schema: raw + rollup | new |
| `agent-fleet/daemon/src/metrics-collector.js` | /proc + df + os.cpus | new (~120 LOC) |
| `agent-fleet/daemon/src/inventory-collector.js` | Skills + MCP + settings | new (~100 LOC) |
| `agent-fleet/daemon/test/metrics-collector.test.js` | Unit tests | new |
| `agent-fleet/daemon/test/inventory-collector.test.js` | Unit tests | new |
| `agent-fleet/daemon/src/ws-client.js` | Wire metrics+inventory intervals | modify (+~30 LOC) |
| `scripts/lib/fleet-db.js` | insertHostMetric, setHostInventory, readMetrics | modify (+~80 LOC) |
| `scripts/lib/fleet-db.test.js` | DB tests | modify |
| `scripts/lib/fleet-routes.js` | handleDaemonWs cases, REST, metrics_viewer role | modify (+~150 LOC) |
| `scripts/lib/fleet-routes.test.js` | Routes tests | modify |
| `scripts/lib/fleet-retention.js` | 5-min rollup + cleanup cron | new (~50 LOC) |
| `scripts/rag-api.js` | Wire retention setInterval | modify (+~5 LOC) |
| `agent-fleet/web/host-metrics.js` | Sparklines + tabs | new (~250 LOC) |
| `agent-fleet/web/index.html` | Tab containers | modify |
| `agent-fleet/web/app.js` | renderHostDetail extension | modify (+~15 LOC) |
| `agent-fleet/web/app.css` | Sparkline + bar styles | modify |

Total ~900 LOC.

---

## Conventions

- Tests: `VAULT_RAG_PG_PASS=testpass node --test scripts/lib/<file>.test.js` (hub) or `node --test agent-fleet/daemon/test/<file>.test.js` (daemon).
- Daemon code has zero deps beyond `ws`. Use only `node:fs`, `node:os`, `node:child_process`, `node:path`.
- Hub HTTP handlers take `{req, res, body, ctx}` + use `send/readBody/checkAuth`.
- Browser uses vanilla JS; load via `<script>` tag in `index.html`.
- After every backend change re-run that file's `.test.js`.
- Migration apply on prod: `ssh -p 977 root@brain 'docker exec -i vault-rag-postgres psql -U postgres -d vault_rag < /opt/vault-rag/sql/011-*.sql'`.

---

## Task 1: SQL migration 011

**Files:**
- Create: `sql/011-fleet-host-metrics.sql`

- [ ] **Step 1: Write migration**

Create `sql/011-fleet-host-metrics.sql`:

```sql
CREATE TABLE IF NOT EXISTS fleet_host_metrics (
  host_id        uuid NOT NULL REFERENCES fleet_hosts(id) ON DELETE CASCADE,
  ts             timestamptz NOT NULL DEFAULT now(),
  cpu_pct        real,
  ram_used_bytes bigint,
  ram_total_bytes bigint,
  disk           jsonb,
  net            jsonb,
  error          text
);

CREATE INDEX IF NOT EXISTS idx_fleet_host_metrics_host_ts
  ON fleet_host_metrics (host_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_fleet_host_metrics_ts_brin
  ON fleet_host_metrics USING brin (ts);

CREATE TABLE IF NOT EXISTS fleet_host_metrics_5m (
  host_id        uuid NOT NULL REFERENCES fleet_hosts(id) ON DELETE CASCADE,
  bucket         timestamptz NOT NULL,
  cpu_pct_avg    real,
  cpu_pct_max    real,
  ram_used_bytes bigint,
  PRIMARY KEY (host_id, bucket)
);

CREATE INDEX IF NOT EXISTS idx_fleet_host_metrics_5m_bucket
  ON fleet_host_metrics_5m (bucket DESC);
```

- [ ] **Step 2: Apply + verify**

Run: `docker exec -i fleet-test-pg psql -U postgres -d vault_rag < sql/011-fleet-host-metrics.sql`

Expected: `CREATE TABLE` x2, `CREATE INDEX` x3.

Verify: `docker exec fleet-test-pg psql -U postgres -d vault_rag -c "\d fleet_host_metrics" -c "\d fleet_host_metrics_5m"`

Expected: both tables listed.

- [ ] **Step 3: Commit**

```bash
git add sql/011-fleet-host-metrics.sql
git commit -m "feat: schema for fleet_host_metrics + rollup

Raw time-series (host_id, ts) for 24h retention with BRIN+btree indices.
5-min rollup table for 7d history. ON DELETE CASCADE removes metrics
when host is deleted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Daemon metrics collector

**Files:**
- Create: `agent-fleet/daemon/src/metrics-collector.js`
- Create: `agent-fleet/daemon/test/metrics-collector.test.js`

- [ ] **Step 1: Write failing test**

Create `agent-fleet/daemon/test/metrics-collector.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { collectMetrics, _internals } = require('../src/metrics-collector');

test('collectMetrics returns ts + numeric ram_total_bytes', async () => {
  const m = await collectMetrics();
  assert.ok(m.ts);
  assert.ok(typeof m.ram_total_bytes === 'number');
  assert.ok(m.ram_total_bytes > 0);
});

test('collectMetrics returns cpu_pct in [0,100] or null on error', async () => {
  const m = await collectMetrics();
  if (m.cpu_pct !== null) {
    assert.ok(m.cpu_pct >= 0 && m.cpu_pct <= 100, `cpu_pct=${m.cpu_pct} out of range`);
  }
});

test('collectMetrics returns disk array (may be empty)', async () => {
  const m = await collectMetrics();
  assert.ok(Array.isArray(m.disk));
  if (m.disk.length) {
    const d = m.disk[0];
    assert.ok(d.mount);
    assert.ok(typeof d.size_bytes === 'number');
    assert.ok(typeof d.used_bytes === 'number');
  }
});

test('cpu calculation clamps to [0,100]', () => {
  const { clampCpu } = _internals;
  assert.strictEqual(clampCpu(-5), 0);
  assert.strictEqual(clampCpu(150), 100);
  assert.strictEqual(clampCpu(42.7), 42.7);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent-fleet/daemon/test/metrics-collector.test.js`

Expected: `Cannot find module '../src/metrics-collector'`.

- [ ] **Step 3: Implement metrics-collector.js**

Create `agent-fleet/daemon/src/metrics-collector.js`:

```js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const { execSync } = require('node:child_process');

let prevNet = null;
let prevNetTs = null;

function clampCpu(pct) {
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

async function getCpuPct() {
  if (fs.existsSync('/proc/stat')) {
    const sample = () => {
      const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
      const [, ...vals] = line.split(/\s+/).map(Number);
      const idle = vals[3];  // idle only — iowait unreliable
      const total = vals.reduce((a, b) => a + b, 0);
      return { idle, total };
    };
    const a = sample();
    await new Promise(r => setTimeout(r, 200));
    const b = sample();
    const idleDiff = b.idle - a.idle;
    const totalDiff = b.total - a.total;
    if (!totalDiff) return 0;
    return clampCpu(100 * (1 - idleDiff / totalDiff));
  }
  // macOS / fallback
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
  return clampCpu(100 * (1 - idleDiff / totalDiff));
}

function getRamUsed() {
  if (fs.existsSync('/proc/meminfo')) {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const totalMatch = /MemTotal:\s+(\d+)/.exec(meminfo);
    const availMatch = /MemAvailable:\s+(\d+)/.exec(meminfo);
    if (totalMatch && availMatch) {
      const total = parseInt(totalMatch[1], 10) * 1024;
      const avail = parseInt(availMatch[1], 10) * 1024;
      return total - avail;
    }
  }
  return os.totalmem() - os.freemem();
}

function getDisk() {
  try {
    const out = execSync('df -kP', { encoding: 'utf8', timeout: 2000 });
    return out.trim().split('\n').slice(1).map(line => {
      const parts = line.split(/\s+/);
      const mount = parts[parts.length - 1];
      return {
        mount,
        size_bytes: +parts[1] * 1024,
        used_bytes: +parts[2] * 1024,
        avail_bytes: +parts[3] * 1024,
      };
    }).filter(d => d.mount && !d.mount.startsWith('/snap/') && !d.mount.startsWith('/dev')
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
      if (m[1] === 'lo' || m[1].startsWith('docker') || m[1].startsWith('veth') || m[1].startsWith('br-')) continue;
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
    return { ts, cpu_pct: null, ram_used_bytes: null, ram_total_bytes: os.totalmem(), disk: [], net: null, error: e.message };
  }
}

module.exports = { collectMetrics, _internals: { clampCpu, getCpuPct, getRamUsed, getDisk, getNet } };
```

- [ ] **Step 4: Run tests**

Run: `node --test agent-fleet/daemon/test/metrics-collector.test.js`

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent-fleet/daemon/src/metrics-collector.js agent-fleet/daemon/test/metrics-collector.test.js
git commit -m "feat(daemon): metrics-collector for cpu/ram/disk/net

/proc/stat + /proc/meminfo on Linux, os.cpus() delta + os.freemem
fallback on macOS. df -kP for disk (filter snap/dev/docker/containerd).
CPU% clamped [0,100], iowait excluded. Net rx/tx bps deltas.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Daemon inventory collector

**Files:**
- Create: `agent-fleet/daemon/src/inventory-collector.js`
- Create: `agent-fleet/daemon/test/inventory-collector.test.js`

- [ ] **Step 1: Write failing test**

Create `agent-fleet/daemon/test/inventory-collector.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { collectInventory, inventoryChanged, resetInventoryCache, _internals } = require('../src/inventory-collector');

test('collectInventory returns required keys', () => {
  const inv = collectInventory();
  assert.ok(inv.collected_at);
  assert.ok(Array.isArray(inv.skills));
  assert.ok(Array.isArray(inv.mcp_servers));
  assert.ok('claude_version' in inv);
  assert.ok('settings' in inv);
});

test('parseSettings respects strict allowlist (drops env/hooks/credentials)', () => {
  const { parseSettings } = _internals;
  // Use a tmp dir as fake home
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
  fs.mkdirSync(path.join(tmp, '.claude'));
  fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({
    model: 'claude-opus-4-7',
    permissionMode: 'acceptEdits',
    env: { GITLAB_TOKEN: 'SECRET', GRAFANA_TOKEN: 'SECRET2' },
    hooks: { onUserSubmit: 'curl https://internal/...' },
    permissions: { allow: ['Bash(curl :*)'] },
    autoUpdater: { enabled: true },
    enabledPlugins: { 'foo': true, 'bar': false },
  }));
  const out = parseSettings(tmp);
  assert.strictEqual(out.model, 'claude-opus-4-7');
  assert.strictEqual(out.permissionMode, 'acceptEdits');
  assert.deepStrictEqual(out.autoUpdater, { enabled: true });
  assert.deepStrictEqual(out.enabledPlugins, { 'foo': true, 'bar': false });
  assert.ok(!('env' in out), 'env must be excluded');
  assert.ok(!('hooks' in out), 'hooks must be excluded');
  assert.ok(!('permissions' in out), 'permissions must be excluded');
  fs.rmSync(tmp, { recursive: true });
});

test('parseSettings drops enabledPlugins if values not all booleans', () => {
  const { parseSettings } = _internals;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
  fs.mkdirSync(path.join(tmp, '.claude'));
  fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({
    enabledPlugins: { 'foo': { token: 'secret' } },  // not boolean
  }));
  const out = parseSettings(tmp);
  assert.ok(!('enabledPlugins' in out));
  fs.rmSync(tmp, { recursive: true });
});

test('parseMcpServers extracts names + enabled flag', () => {
  const { parseMcpServers } = _internals;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
  fs.mkdirSync(path.join(tmp, '.claude'));
  fs.writeFileSync(path.join(tmp, '.claude', 'mcp.json'), JSON.stringify({
    mcpServers: {
      'vault-rag': { command: 'node', args: ['/path/script.js'] },
      'broken':    { command: 'broken', disabled: true },
    },
  }));
  const out = parseMcpServers(tmp);
  assert.strictEqual(out.length, 2);
  const vr = out.find(s => s.name === 'vault-rag');
  assert.strictEqual(vr.enabled, true);
  assert.strictEqual(vr.command, 'node');
  const br = out.find(s => s.name === 'broken');
  assert.strictEqual(br.enabled, false);
  fs.rmSync(tmp, { recursive: true });
});

test('inventoryChanged + resetInventoryCache', () => {
  resetInventoryCache();
  // Initial call should be "changed" if files exist, but tests run in unknown env.
  // Just verify reset+second-call sequence.
  inventoryChanged();
  const second = inventoryChanged();
  assert.strictEqual(second, false, 'second call without mtime change must be false');
  resetInventoryCache();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent-fleet/daemon/test/inventory-collector.test.js`

Expected: `Cannot find module '../src/inventory-collector'`.

- [ ] **Step 3: Implement inventory-collector.js**

Create `agent-fleet/daemon/src/inventory-collector.js`:

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

let lastMtimes = {};

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
      if (lastMtimes[p] !== undefined) { lastMtimes[p] = undefined; changed = true; }
    }
  }
  return changed;
}

function resetInventoryCache() { lastMtimes = {}; }

function safeReaddir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
}

function scanSkills(home) {
  const root = path.join(home, '.claude', 'plugins', 'cache');
  if (!fs.existsSync(root)) return [];
  const skills = [];
  for (const mp of safeReaddir(root)) {
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
  return skills;
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
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 1500 }).trim();
  } catch { return null; }
}

// SECURITY POLICY: strict allowlist. Each value's shape validated.
// EXCLUDED keys (would leak secrets): env, hooks, permissions, credentials.
function parseSettings(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    const out = {};
    if (typeof raw.model === 'string')          out.model = raw.model;
    if (typeof raw.permissionMode === 'string') out.permissionMode = raw.permissionMode;
    if (raw.autoUpdater && typeof raw.autoUpdater === 'object' && typeof raw.autoUpdater.enabled === 'boolean') {
      out.autoUpdater = { enabled: raw.autoUpdater.enabled };
    }
    if (raw.enabledPlugins && typeof raw.enabledPlugins === 'object'
        && Object.values(raw.enabledPlugins).every(v => typeof v === 'boolean')) {
      out.enabledPlugins = raw.enabledPlugins;
    }
    return out;
  } catch { return null; }
}

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

module.exports = {
  collectInventory, inventoryChanged, resetInventoryCache,
  _internals: { scanSkills, parseMcpServers, detectClaudeVersion, parseSettings },
};
```

- [ ] **Step 4: Run tests**

Run: `node --test agent-fleet/daemon/test/inventory-collector.test.js`

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent-fleet/daemon/src/inventory-collector.js agent-fleet/daemon/test/inventory-collector.test.js
git commit -m "feat(daemon): inventory-collector for skills + MCP + settings

Scans ~/.claude/plugins/cache/* for skills (marketplace/plugin/version/skill).
Parses ~/.claude/mcp.json for MCP server names + enabled state.
Runs claude --version (execFileSync, no shell).
Settings.json: STRICT allowlist (model, permissionMode, autoUpdater, enabledPlugins)
with per-value type validation. env/hooks/permissions EXCLUDED.
mtime-gated on mcp.json + settings.json files (plugin tree relies on 15-min heartbeat).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire collectors into daemon WS client

**Files:**
- Modify: `agent-fleet/daemon/src/ws-client.js`

- [ ] **Step 1: Import collectors**

Find the existing requires near top of `agent-fleet/daemon/src/ws-client.js` (lines 1-10) and add:

```js
const { collectMetrics } = require('./metrics-collector');
const { collectInventory, resetInventoryCache } = require('./inventory-collector');
```

- [ ] **Step 2: Add intervals on each WS open**

Locate the `ws.on('open', ...)` (or where the hello frame is sent — `safeSend(ws, { type: 'hello', ... })`). After the hello-send, add:

```js
// Reset inventory cache so each new connection re-sends fresh inventory.
resetInventoryCache();
safeSend(ws, { type: 'inventory', ...collectInventory() });

const metricsTimer = setInterval(async () => {
  try {
    const m = await collectMetrics();
    safeSend(ws, { type: 'metrics', ...m });
  } catch {}
}, 10_000);

const invMtimeTimer = setInterval(() => {
  // require fresh module ref to access updated mtime state
  const { inventoryChanged, collectInventory: ci } = require('./inventory-collector');
  if (inventoryChanged()) safeSend(ws, { type: 'inventory', ...ci() });
}, 60_000);

const invHeartbeatTimer = setInterval(() => {
  safeSend(ws, { type: 'inventory', ...collectInventory() });
}, 900_000);

ws.on('close', () => {
  clearInterval(metricsTimer);
  clearInterval(invMtimeTimer);
  clearInterval(invHeartbeatTimer);
});
```

- [ ] **Step 3: Syntax check + run daemon tests**

Run:
```bash
node --check agent-fleet/daemon/src/ws-client.js
node --test agent-fleet/daemon/test/ws-client.test.js
```

Expected: syntax OK, existing ws-client tests still pass (we only added intervals after hello-send).

- [ ] **Step 4: Commit**

```bash
git add agent-fleet/daemon/src/ws-client.js
git commit -m "feat(daemon): periodic metrics + inventory push

10s metrics tick + 60s mtime-check + 15min inventory heartbeat.
Cleared on ws.close. resetInventoryCache + initial send on each
WS open so reconnects refresh hub's inventory snapshot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Hub fleet-db functions

**Files:**
- Modify: `scripts/lib/fleet-db.js`
- Modify: `scripts/lib/fleet-db.test.js`

- [ ] **Step 1: Write failing test**

Append to `scripts/lib/fleet-db.test.js`:

```js
test('insertHostMetric + readMetricsSince', async () => {
  await withClient(async (c) => {
    await reset(c);
    await c.query('TRUNCATE fleet_host_metrics, fleet_host_metrics_5m');
    const h = await fleetDb.upsertHost(c, { name: 'h-met' });
    await fleetDb.insertHostMetric(c, h.id, {
      ts: new Date().toISOString(),
      cpu_pct: 42.3, ram_used_bytes: 1024, ram_total_bytes: 4096,
      disk: [{ mount: '/', size_bytes: 100, used_bytes: 50, avail_bytes: 50 }],
      net: { rx_bps: 1000, tx_bps: 500 },
    });
    const rows = await fleetDb.readMetricsSince(c, h.id, '1 hour');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].cpu_pct, 42.3);
    assert.deepStrictEqual(rows[0].disk[0].mount, '/');
  });
});

test('setHostInventory merges into metadata.inventory', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'h-inv' });
    await fleetDb.setHostInventory(c, h.id, {
      collected_at: new Date().toISOString(),
      skills: [{ plugin: 'p1', version: '1.0', name: 's1' }],
      mcp_servers: [{ name: 'vault-rag', enabled: true, command: 'node', args: [] }],
      claude_version: '1.5.2',
      settings: { model: 'claude-opus-4-7' },
    });
    const after = await fleetDb.getHost(c, h.id);
    assert.strictEqual(after.metadata.inventory.skills[0].name, 's1');
    assert.strictEqual(after.metadata.inventory.mcp_servers[0].name, 'vault-rag');
  });
});

test('readMetricsRollupSince returns 5-min buckets', async () => {
  await withClient(async (c) => {
    await reset(c);
    await c.query('TRUNCATE fleet_host_metrics_5m');
    const h = await fleetDb.upsertHost(c, { name: 'h-roll' });
    await c.query(`
      INSERT INTO fleet_host_metrics_5m (host_id, bucket, cpu_pct_avg, cpu_pct_max, ram_used_bytes)
      VALUES ($1, now() - interval '10 minutes', 25, 40, 1024),
             ($1, now() - interval '5 minutes',  30, 50, 2048)`, [h.id]);
    const rows = await fleetDb.readMetricsRollupSince(c, h.id, '1 hour');
    assert.strictEqual(rows.length, 2);
    assert.ok(rows[0].cpu_pct_avg !== null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `VAULT_RAG_PG_PASS=testpass node --test --test-name-pattern='insertHostMetric|setHostInventory|readMetricsRollup' scripts/lib/fleet-db.test.js`

Expected: 3 tests fail with `fleetDb.insertHostMetric is not a function`.

- [ ] **Step 3: Implement functions**

Append to `scripts/lib/fleet-db.js` (before `module.exports`):

```js
async function insertHostMetric(c, hostId, m) {
  await c.query(
    `INSERT INTO fleet_host_metrics (host_id, ts, cpu_pct, ram_used_bytes, ram_total_bytes, disk, net, error)
     VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [
      hostId,
      m.ts || null,
      m.cpu_pct == null ? null : Number(m.cpu_pct),
      m.ram_used_bytes == null ? null : Number(m.ram_used_bytes),
      m.ram_total_bytes == null ? null : Number(m.ram_total_bytes),
      m.disk ? JSON.stringify(m.disk) : null,
      m.net ? JSON.stringify(m.net) : null,
      m.error || null,
    ]);
}

async function setHostLatestMetrics(c, hostId, m) {
  await c.query(
    `UPDATE fleet_hosts
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('latest_metrics', $2::jsonb)
     WHERE id = $1`,
    [hostId, JSON.stringify({
      ts: m.ts, cpu_pct: m.cpu_pct, ram_used_bytes: m.ram_used_bytes, ram_total_bytes: m.ram_total_bytes,
    })]);
}

async function setHostInventory(c, hostId, inv) {
  await c.query(
    `UPDATE fleet_hosts
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('inventory', $2::jsonb)
     WHERE id = $1`,
    [hostId, JSON.stringify(inv)]);
}

async function readMetricsSince(c, hostId, interval) {
  const { rows } = await c.query(
    `SELECT ts, cpu_pct, ram_used_bytes, ram_total_bytes, disk, net, error
     FROM fleet_host_metrics
     WHERE host_id = $1 AND ts > now() - $2::interval
     ORDER BY ts ASC`,
    [hostId, interval]);
  return rows;
}

async function readMetricsRollupSince(c, hostId, interval) {
  const { rows } = await c.query(
    `SELECT bucket, cpu_pct_avg, cpu_pct_max, ram_used_bytes
     FROM fleet_host_metrics_5m
     WHERE host_id = $1 AND bucket > now() - $2::interval
     ORDER BY bucket ASC`,
    [hostId, interval]);
  return rows;
}
```

Add the 5 new names to `module.exports`:

```js
  insertHostMetric, setHostLatestMetrics, setHostInventory, readMetricsSince, readMetricsRollupSince,
```

- [ ] **Step 4: Run tests**

Run: `VAULT_RAG_PG_PASS=testpass node --test scripts/lib/fleet-db.test.js`

Expected: 21/21 pass (18 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fleet-db.js scripts/lib/fleet-db.test.js
git commit -m "feat: fleet-db functions for host metrics + inventory

insertHostMetric / setHostLatestMetrics / setHostInventory:
INSERT raw + UPDATE metadata jsonb_build_object || merge.
readMetricsSince / readMetricsRollupSince: time-range queries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Hub WS ingestion + REST + WS role

**Files:**
- Modify: `scripts/lib/fleet-routes.js`
- Modify: `scripts/lib/fleet-routes.test.js`

- [ ] **Step 1: Add WS frame handlers**

In `scripts/lib/fleet-routes.js` find `handleDaemonWs` and locate the `ws.on('message', ...)` handler with the existing `if (f.type === '...')` chain. After existing handlers (after the file_data/file_err/reconciliation cases), add:

```js
if (f.type === 'metrics') {
  try {
    await fleetDb.insertHostMetric(ctx.db, host.id, f);
    await fleetDb.setHostLatestMetrics(ctx.db, host.id, f);
    ctx.bus.broadcastHostMetrics(host.id, { type: 'metrics', host_id: host.id, ...f });
  } catch (e) { console.error('[fleet-routes] metrics ingest:', e.message); }
  return;
}
if (f.type === 'inventory') {
  try {
    await fleetDb.setHostInventory(ctx.db, host.id, f);
    ctx.bus.broadcastHostMetrics(host.id, { type: 'inventory', host_id: host.id, ...f });
  } catch (e) { console.error('[fleet-routes] inventory ingest:', e.message); }
  return;
}
```

- [ ] **Step 2: Add bus methods**

In `makeBus()` (around line 41), add a new map after `workflowViewers`:

```js
const metricsViewersByHost = new Map();  // host_id -> Set<ws>
```

And add methods inside the returned object (after `broadcastWorkflow`):

```js
addMetricsViewer(hostId, ws) {
  let set = metricsViewersByHost.get(hostId);
  if (!set) { set = new Set(); metricsViewersByHost.set(hostId, set); }
  set.add(ws);
  ws.on('close', () => { set.delete(ws); if (!set.size) metricsViewersByHost.delete(hostId); });
},
broadcastHostMetrics(hostId, frame) {
  const set = metricsViewersByHost.get(hostId);
  if (!set) return;
  const payload = JSON.stringify(frame);
  for (const v of set) { try { v.send(payload); } catch {} }
},
```

- [ ] **Step 3: Add WS role handler**

After `handleWorkflowViewerWs`, add:

```js
async function handleMetricsViewerWs(ws, params, ctx) {
  const hostId = params.get('host_id');
  if (!hostId) return ws.close(4002, 'host_id required');
  try {
    const h = await fleetDb.getHost(ctx.db, hostId);
    if (!h) return ws.close(4004, 'host not found');
    // Initial snapshot from metadata
    const meta = h.metadata || {};
    if (meta.latest_metrics) ws.send(JSON.stringify({ type: 'metrics', host_id: hostId, ...meta.latest_metrics }));
    if (meta.inventory)      ws.send(JSON.stringify({ type: 'inventory', host_id: hostId, ...meta.inventory }));
  } catch (e) { console.error('[fleet-routes] metrics_viewer init:', e.message); }
  ctx.bus.addMetricsViewer(hostId, ws);
}
```

- [ ] **Step 4: Register WS role in both upgrade handlers**

In `attach()` (legacy upgrade handler ~line 877), find the role checks and extend:

```js
if (role !== 'daemon' && role !== 'viewer' && role !== 'workflow_viewer' && role !== 'metrics_viewer') {
  return ws.close(4003, 'invalid role');
}
if (role === 'daemon')                handleDaemonWs(ws, u.searchParams, ctx);
else if (role === 'workflow_viewer')  handleWorkflowViewerWs(ws, u.searchParams, ctx);
else if (role === 'metrics_viewer')   handleMetricsViewerWs(ws, u.searchParams, ctx);
else                                  handleViewerWs(ws, u.searchParams, ctx);
```

Apply the same change in `attachUpgrade()` (~line 930).

- [ ] **Step 5: Add REST handlers**

Insert before `dispatchHttp` (near other handlers, perhaps after `handleHostFilePut`):

```js
async function handleHostMetrics({ req, res, ctx }) {
  const m = req.url.split('?')[0].match(new RegExp(`^/fleet/hosts/(${SID_RE})/metrics$`, 'i'));
  if (!m) return send(res, 404, { error: 'bad path' });
  const hostId = m[1];
  const u = new URL(req.url, 'http://x');
  const since = u.searchParams.get('since') || '1h';
  const allowedIntervals = { '15m': '15 minutes', '1h': '1 hour', '6h': '6 hours', '24h': '24 hours', '7d': '7 days' };
  const interval = allowedIntervals[since];
  if (!interval) return send(res, 422, { error: `invalid since (allowed: ${Object.keys(allowedIntervals).join(',')})` });
  const downsampled = u.searchParams.get('downsampled') === '1';
  const rows = downsampled
    ? await fleetDb.readMetricsRollupSince(ctx.db, hostId, interval)
    : await fleetDb.readMetricsSince(ctx.db, hostId, interval);
  send(res, 200, rows);
}

async function handleHostInventory({ req, res, ctx }) {
  const m = req.url.split('?')[0].match(new RegExp(`^/fleet/hosts/(${SID_RE})/inventory$`, 'i'));
  if (!m) return send(res, 404, { error: 'bad path' });
  const h = await fleetDb.getHost(ctx.db, m[1]);
  if (!h) return send(res, 404, { error: 'host not found' });
  send(res, 200, (h.metadata && h.metadata.inventory) || {});
}
```

- [ ] **Step 6: Register routes**

In `dispatchHttp`, after the hosts/file routes block, add:

```js
if (method === 'GET' && new RegExp(`^/fleet/hosts/${SID_RE}/metrics$`, 'i').test(path))    return handleHostMetrics({ req, res, ctx });
if (method === 'GET' && new RegExp(`^/fleet/hosts/${SID_RE}/inventory$`, 'i').test(path))  return handleHostInventory({ req, res, ctx });
```

- [ ] **Step 7: Write tests**

Append to `scripts/lib/fleet-routes.test.js`:

```js
test('GET /fleet/hosts/:id/metrics returns time-series rows', async () => {
  const { server, pg, close } = await startWithDb();
  const h = await pg.query(`INSERT INTO fleet_hosts (name) VALUES ('htm') RETURNING id`);
  const hostId = h.rows[0].id;
  await pg.query(`INSERT INTO fleet_host_metrics (host_id, ts, cpu_pct, ram_used_bytes, ram_total_bytes)
                  VALUES ($1, now(), 25, 1024, 4096)`, [hostId]);
  const r = await reqJson(server, 'GET', `/fleet/hosts/${hostId}/metrics?since=1h`, { token: 'T' });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.strictEqual(r.body.length, 1);
  assert.strictEqual(r.body[0].cpu_pct, 25);
  await close();
});

test('GET /fleet/hosts/:id/metrics rejects invalid since param', async () => {
  const { server, pg, close } = await startWithDb();
  const h = await pg.query(`INSERT INTO fleet_hosts (name) VALUES ('htm2') RETURNING id`);
  const r = await reqJson(server, 'GET', `/fleet/hosts/${h.rows[0].id}/metrics?since=999d`, { token: 'T' });
  assert.equal(r.status, 422);
  await close();
});

test('GET /fleet/hosts/:id/inventory returns empty object if not set', async () => {
  const { server, pg, close } = await startWithDb();
  const h = await pg.query(`INSERT INTO fleet_hosts (name) VALUES ('hti') RETURNING id`);
  const r = await reqJson(server, 'GET', `/fleet/hosts/${h.rows[0].id}/inventory`, { token: 'T' });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.body, {});
  await close();
});

test('WS role metrics_viewer accepts host_id and streams', async () => {
  const { server, pg, close } = await startWithDb();
  const h = await pg.query(`INSERT INTO fleet_hosts (name) VALUES ('mvs') RETURNING id`);
  const hostId = h.rows[0].id;
  await pg.query(
    `UPDATE fleet_hosts SET metadata = jsonb_build_object('latest_metrics', $2::jsonb) WHERE id=$1`,
    [hostId, JSON.stringify({ ts: new Date().toISOString(), cpu_pct: 17, ram_used_bytes: 100, ram_total_bytes: 4096 })],
  );
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=metrics_viewer&host_id=${hostId}`,
    { headers: { authorization: 'Bearer T' } });
  const frame = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 1000);
    ws.on('message', (b) => { clearTimeout(t); resolve(JSON.parse(b.toString())); });
    ws.on('error', reject);
  });
  assert.strictEqual(frame.type, 'metrics');
  assert.strictEqual(frame.cpu_pct, 17);
  ws.close();
  await close();
});
```

- [ ] **Step 8: Run tests**

Run: `VAULT_RAG_PG_PASS=testpass node --test scripts/lib/fleet-routes.test.js`

Expected: 40 pass (36 existing + 4 new).

- [ ] **Step 9: Commit**

```bash
git add scripts/lib/fleet-routes.js scripts/lib/fleet-routes.test.js
git commit -m "feat: hub metrics+inventory ingest + REST + metrics_viewer role

handleDaemonWs cases for type:metrics and type:inventory:
INSERT raw row + UPDATE metadata.latest_metrics/inventory + broadcast.

REST: GET /fleet/hosts/:id/metrics?since=...&downsampled=,
      GET /fleet/hosts/:id/inventory.
WS role: metrics_viewer&host_id=X — initial snapshot from metadata
+ live stream from bus.broadcastHostMetrics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Retention cron

**Files:**
- Create: `scripts/lib/fleet-retention.js`
- Modify: `scripts/rag-api.js`

- [ ] **Step 1: Write retention module**

Create `scripts/lib/fleet-retention.js`:

```js
'use strict';
// fleet-retention: 5-min rollup + 24h raw/7d rollup cleanup.

async function runRetention(db) {
  // 1. Upsert rollups for last 6 buckets (30-min lookback covers late samples).
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

function startRetention(db, intervalMs = 5 * 60 * 1000) {
  // Run once at boot, then every 5 min.
  runRetention(db).catch(e => console.error('[retention] boot:', e.message));
  const t = setInterval(() => {
    runRetention(db).catch(e => console.error('[retention] tick:', e.message));
  }, intervalMs);
  t.unref?.();
  return t;
}

module.exports = { runRetention, startRetention };
```

- [ ] **Step 2: Wire into rag-api boot**

Find in `scripts/rag-api.js` the block where `fleetCtx.db = pg` is assigned (~line 372). After the existing `orphanRunningSessions` call, add:

```js
const { startRetention } = require('./lib/fleet-retention');
startRetention(pg);
console.log('[rag-api] fleet metrics retention started');
```

- [ ] **Step 3: Smoke test locally**

Run local hub briefly:

```bash
VAULT_RAG_PG_HOST=127.0.0.1 VAULT_RAG_PG_PORT=55433 VAULT_RAG_PG_PASS=testpass VAULT_RAG_PG_DB=vault_rag VAULT_RAG_API_TOKEN=Tsmoke RAG_PORT=18099 node scripts/rag-api.js >/tmp/rag.log 2>&1 &
sleep 3
grep -F 'fleet metrics retention started' /tmp/rag.log
pkill -f scripts/rag-api.js
```

Expected: the grep finds the log line.

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/fleet-retention.js scripts/rag-api.js
git commit -m "feat: fleet-retention 5-min rollup + cleanup

runRetention(db) — upsert rollup for last 6 buckets (30-min lookback
covers late samples), DELETE raw > 24h, DELETE rollup > 7d.
startRetention runs once at boot then setInterval 5 min.
Wired in rag-api after pg pool bound.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: UI — sparklines + tabs

**Files:**
- Create: `agent-fleet/web/host-metrics.js`
- Modify: `agent-fleet/web/index.html`
- Modify: `agent-fleet/web/app.js`
- Modify: `agent-fleet/web/app.css`

- [ ] **Step 1: Add tab UI to host detail in index.html**

Find existing host-detail panel in `agent-fleet/web/index.html` (search for `id="hd-display"` or the wrapper class `host-detail`). At the end of that panel (before its closing tag), add:

```html
<div id="hm-live" class="hm-live"></div>
<div id="hm-sparklines">
  <div class="hm-chart">
    <div class="hm-chart-title">CPU %</div>
    <svg id="hm-cpu-svg" width="100%" height="60" viewBox="0 0 360 60" preserveAspectRatio="none"></svg>
  </div>
  <div class="hm-chart">
    <div class="hm-chart-title">RAM %</div>
    <svg id="hm-ram-svg" width="100%" height="60" viewBox="0 0 360 60" preserveAspectRatio="none"></svg>
  </div>
</div>
<div id="hm-disk"></div>
<div class="hm-tabs">
  <button class="hm-tab active" data-tab="skills">Skills</button>
  <button class="hm-tab" data-tab="mcp">MCP servers</button>
  <button class="hm-tab" data-tab="settings">Settings</button>
</div>
<div id="hm-tab-content"></div>
```

Add script tag before app.js:

```html
<script src="/fleet/static/host-metrics.js"></script>
```

- [ ] **Step 2: Create host-metrics.js**

Create `agent-fleet/web/host-metrics.js`:

```js
'use strict';
// host-metrics: sparklines + tabs for host detail panel.
// Global: window.startHostMetrics(hostId), window.stopHostMetrics().
(function () {
  function token() { return localStorage.fleetToken || ''; }
  let activeWs = null;
  let activeHost = null;

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }
  function hb(b) {
    if (b == null) return '—';
    if (b > 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GiB';
    if (b > 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' MiB';
    if (b > 1024)      return (b / 1024).toFixed(1) + ' KiB';
    return b + ' B';
  }
  function bps(n) {
    if (n == null) return '—';
    if (n > 1e6) return (n / 1e6).toFixed(1) + ' MB/s';
    if (n > 1e3) return (n / 1e3).toFixed(1) + ' KB/s';
    return n + ' B/s';
  }

  // Rolling buffer of last 360 metrics samples (one hour at 10s cadence)
  const cpuBuf = []; const ramBuf = [];
  const MAX = 360;

  async function api(path) {
    const res = await fetch('/fleet' + path, { headers: { authorization: 'Bearer ' + token() } });
    if (!res.ok) throw new Error('' + res.status);
    return res.json();
  }

  async function startHostMetrics(hostId) {
    stopHostMetrics();
    activeHost = hostId;
    cpuBuf.length = 0; ramBuf.length = 0;
    // Initial backfill
    try {
      const rows = await api(`/hosts/${hostId}/metrics?since=1h`);
      for (const r of rows) {
        cpuBuf.push(r.cpu_pct == null ? null : r.cpu_pct);
        if (r.ram_total_bytes) ramBuf.push(100 * r.ram_used_bytes / r.ram_total_bytes);
        else                   ramBuf.push(null);
      }
      while (cpuBuf.length > MAX) cpuBuf.shift();
      while (ramBuf.length > MAX) ramBuf.shift();
      renderSparklines();
    } catch (e) { /* host may have no data yet */ }

    // Inventory
    try {
      const inv = await api(`/hosts/${hostId}/inventory`);
      renderTabs(inv);
    } catch {}

    // Live WS
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/fleet/ws?role=metrics_viewer&host_id=${hostId}`;
    activeWs = new WebSocket(url, [`bearer.${token()}`]);
    activeWs.onmessage = (ev) => {
      let f;
      try { f = JSON.parse(ev.data); } catch { return; }
      if (f.type === 'metrics') {
        renderLive(f);
        cpuBuf.push(f.cpu_pct == null ? null : f.cpu_pct);
        if (f.ram_total_bytes) ramBuf.push(100 * f.ram_used_bytes / f.ram_total_bytes);
        else                   ramBuf.push(null);
        while (cpuBuf.length > MAX) cpuBuf.shift();
        while (ramBuf.length > MAX) ramBuf.shift();
        renderSparklines();
      } else if (f.type === 'inventory') {
        renderTabs(f);
      }
    };
    activeWs.onerror = () => {};
  }

  function stopHostMetrics() {
    if (activeWs) { try { activeWs.close(); } catch {} activeWs = null; }
    activeHost = null;
  }

  function renderLive(m) {
    const ramPct = m.ram_total_bytes ? Math.round(100 * m.ram_used_bytes / m.ram_total_bytes) : null;
    const live = document.getElementById('hm-live');
    if (!live) return;
    live.innerHTML = `
      <span>CPU <strong>${m.cpu_pct == null ? '—' : m.cpu_pct.toFixed(1) + '%'}</strong></span>
      <span>RAM <strong>${ramPct == null ? '—' : ramPct + '%'}</strong> (${hb(m.ram_used_bytes)}/${hb(m.ram_total_bytes)})</span>
      ${m.net ? `<span>NET ↓${bps(m.net.rx_bps)} ↑${bps(m.net.tx_bps)}</span>` : ''}
      ${m.error ? `<span style="color:var(--warn)">⚠ ${esc(m.error)}</span>` : ''}
    `;
    renderDisk(m.disk);
  }

  function renderDisk(disk) {
    const el = document.getElementById('hm-disk');
    if (!el || !disk) return;
    el.innerHTML = '<table class="hm-disk-table"><thead><tr><th>mount</th><th>used / size</th><th></th></tr></thead><tbody>'
      + disk.map(d => {
          const pct = d.size_bytes ? Math.round(100 * d.used_bytes / d.size_bytes) : 0;
          return `<tr><td>${esc(d.mount)}</td><td>${hb(d.used_bytes)} / ${hb(d.size_bytes)}</td>
                  <td><div class="hm-bar"><div style="width:${pct}%"></div></div></td></tr>`;
        }).join('')
      + '</tbody></table>';
  }

  function renderSparklines() {
    drawSpark('hm-cpu-svg', cpuBuf, 100);
    drawSpark('hm-ram-svg', ramBuf, 100);
  }

  function drawSpark(id, buf, scaleMax) {
    const svg = document.getElementById(id);
    if (!svg) return;
    const W = 360, H = 60;
    if (!buf.length) { svg.innerHTML = ''; return; }
    const pts = buf.map((v, i) => {
      if (v == null) return null;
      const x = W * i / (MAX - 1);
      const y = H - (Math.min(scaleMax, Math.max(0, v)) / scaleMax) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    // Break the line on null gaps
    const segments = [];
    let cur = [];
    for (const p of pts) {
      if (p) cur.push(p);
      else if (cur.length) { segments.push(cur); cur = []; }
    }
    if (cur.length) segments.push(cur);
    svg.innerHTML = segments.map(s =>
      `<polyline fill="none" stroke="var(--accent)" stroke-width="1.5" points="${s.join(' ')}"/>`).join('');
  }

  function renderTabs(inv) {
    const tabContent = document.getElementById('hm-tab-content');
    if (!tabContent) return;
    document.querySelectorAll('.hm-tab').forEach(t => {
      t.onclick = () => {
        document.querySelectorAll('.hm-tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        renderTabBody(t.dataset.tab, inv);
      };
    });
    const active = document.querySelector('.hm-tab.active')?.dataset.tab || 'skills';
    renderTabBody(active, inv);
  }

  function renderTabBody(tab, inv) {
    const el = document.getElementById('hm-tab-content');
    if (tab === 'skills') {
      const sk = (inv.skills || []);
      el.innerHTML = sk.length
        ? '<table class="hm-tab-table"><thead><tr><th>plugin</th><th>version</th><th>skill</th></tr></thead><tbody>'
          + sk.map(s => `<tr><td>${esc(s.plugin)}</td><td>${esc(s.version)}</td><td>${esc(s.name)}</td></tr>`).join('')
          + '</tbody></table>'
        : '<p style="color:var(--text-dim)">no skills detected</p>';
    } else if (tab === 'mcp') {
      const mc = (inv.mcp_servers || []);
      el.innerHTML = mc.length
        ? '<table class="hm-tab-table"><thead><tr><th>name</th><th>enabled</th><th>command</th></tr></thead><tbody>'
          + mc.map(s => `<tr><td>${esc(s.name)}</td>
            <td>${s.enabled ? '<span style="color:var(--ok)">✓</span>' : '<span style="color:var(--danger)">✗</span>'}</td>
            <td>${esc(s.command || '')}</td></tr>`).join('')
          + '</tbody></table>'
        : '<p style="color:var(--text-dim)">no MCP servers configured</p>';
    } else if (tab === 'settings') {
      el.innerHTML = `<details><summary>show settings JSON (whitelisted fields only)</summary>
        <pre style="background:var(--bg); padding:.7em; overflow:auto">${esc(JSON.stringify(inv.settings || {}, null, 2))}</pre>
        <p style="color:var(--text-dim); font-size:11px">claude_version: ${esc(inv.claude_version || '—')}</p>
        </details>`;
    }
  }

  window.startHostMetrics = startHostMetrics;
  window.stopHostMetrics = stopHostMetrics;
})();
```

- [ ] **Step 3: Wire from app.js**

In `agent-fleet/web/app.js` find `renderHostDetail` (~line 537) and at the very end add:

```js
    if (window.startHostMetrics) window.startHostMetrics(h.id);
```

And in `openHostDetail` (or wherever switching away), ensure `window.stopHostMetrics?.()` is called. The simplest place: at the top of `renderHostDetail` (before populating), call:

```js
    if (window.stopHostMetrics) window.stopHostMetrics();
```

- [ ] **Step 4: CSS**

Append to `agent-fleet/web/app.css`:

```css
.hm-live { display: flex; gap: 1.4em; padding: .6em 0; flex-wrap: wrap; font-family: var(--font-mono); }
.hm-live strong { color: var(--accent); }
.hm-chart { margin: .4em 0; }
.hm-chart-title { font-size: 11px; color: var(--text-dim); text-transform: uppercase; margin-bottom: .2em; }
.hm-chart svg { background: var(--bg); border: 1px solid var(--line); display: block; }
.hm-disk-table, .hm-tab-table { width: 100%; border-collapse: collapse; margin-top: .6em; font-family: var(--font-mono); font-size: .85em; }
.hm-disk-table td, .hm-disk-table th, .hm-tab-table td, .hm-tab-table th { padding: .4em .6em; border-bottom: 1px solid var(--line); text-align: left; }
.hm-tab-table th, .hm-disk-table th { color: var(--text-dim); font-size: .75em; text-transform: uppercase; }
.hm-bar { background: var(--panel-2); height: 8px; border-radius: 4px; overflow: hidden; min-width: 80px; }
.hm-bar > div { background: var(--accent); height: 100%; }
.hm-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--line); margin-top: 1em; }
.hm-tab { background: transparent; border: 0; padding: .5em 1em; color: var(--text-dim);
          cursor: pointer; font-family: var(--font-mono); font-size: .85em; border-bottom: 2px solid transparent; }
.hm-tab.active { color: var(--text); border-bottom-color: var(--accent); }
.hm-tab:hover { color: var(--text); }
```

- [ ] **Step 5: Syntax check**

Run:
```bash
node --check agent-fleet/web/host-metrics.js
node --check agent-fleet/web/app.js
```

Expected: silent OK.

- [ ] **Step 6: Local smoke (with running daemon)**

Start a local hub and daemon in two terminals:

Terminal 1 (hub):
```bash
VAULT_RAG_PG_HOST=127.0.0.1 VAULT_RAG_PG_PORT=55433 VAULT_RAG_PG_PASS=testpass VAULT_RAG_PG_DB=vault_rag VAULT_RAG_API_TOKEN=Tsmoke RAG_PORT=18099 node scripts/rag-api.js
```

Terminal 2 (daemon):
```bash
AGENT_FLEET_HUB_URL=ws://127.0.0.1:18099/fleet/ws AGENT_FLEET_TOKEN=Tsmoke AGENT_FLEET_HOST_NAME=smoke-host node agent-fleet/daemon/bin/daemon.js
```

Wait 20-30 seconds, then in a third terminal:
```bash
TOKEN=Tsmoke
HOST_ID=$(curl -s http://127.0.0.1:18099/fleet/hosts -H "Authorization: Bearer $TOKEN" | jq -r '.[] | select(.name=="smoke-host") | .id')
echo "HOST=$HOST_ID"
curl -s "http://127.0.0.1:18099/fleet/hosts/$HOST_ID/metrics?since=1h" -H "Authorization: Bearer $TOKEN" | jq 'length, .[0]'
curl -s "http://127.0.0.1:18099/fleet/hosts/$HOST_ID/inventory" -H "Authorization: Bearer $TOKEN" | jq '{skills_count: (.skills // [] | length), mcp_count: (.mcp_servers // [] | length), version: .claude_version}'
```

Expected:
- metrics: array length ≥ 2 (after 20s × 10s cadence)
- inventory: at least claude_version filled, skills/mcp counts may be 0 if you don't have plugins installed

Kill both processes when done.

- [ ] **Step 7: Commit**

```bash
git add agent-fleet/web/host-metrics.js agent-fleet/web/index.html agent-fleet/web/app.js agent-fleet/web/app.css
git commit -m "feat: UI host metrics sparklines + skills/MCP/settings tabs

CPU% and RAM% sparklines (1h × 10s = 360 points) with null-gap handling.
Live CPU/RAM/net row, disk usage bars, 3 tabs (skills, MCP, settings).
metrics_viewer WS for live; REST backfill for initial 1h.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Deploy to brain prod

- [ ] **Step 1: Push**

```bash
git push
```

- [ ] **Step 2: Pull on prod + apply migration + restart**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es 'cd /opt/vault-rag && git pull --ff-only origin main && docker exec -i vault-rag-postgres psql -U postgres -d vault_rag < /opt/vault-rag/sql/011-fleet-host-metrics.sql && docker restart vault-rag-api'
```

Expected: `Fast-forward`, `CREATE TABLE` x2, `CREATE INDEX` x3, `vault-rag-api`.

- [ ] **Step 3: Verify retention started in logs**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es 'docker logs --tail=20 vault-rag-api 2>&1 | grep -E "retention|listening"'
```

Expected: `fleet metrics retention started`.

- [ ] **Step 4: Restart daemon on ai-host**

Daemon currently runs via nohup. SSH to ai-host and restart:

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es 'pkill -f agent-fleet/daemon/bin/daemon.js; cd /opt/vault-rag && AGENT_FLEET_HUB_URL=... AGENT_FLEET_TOKEN=... nohup node agent-fleet/daemon/bin/daemon.js > /var/log/agent-fleet-daemon.log 2>&1 &'
```

If daemon location differs — check existing process (`ps aux | grep daemon.js`) for exact env+path used.

- [ ] **Step 5: Verify metrics ingest on prod**

Wait 60 seconds, then:

```bash
TOKEN=$(grep VAULT_RAG_API_TOKEN .env | cut -d= -f2)
HOST_ID=$(curl -s https://brain.itiswednesdaymydud.es/fleet/hosts -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')
curl -s "https://brain.itiswednesdaymydud.es/fleet/hosts/$HOST_ID/metrics?since=1h" -H "Authorization: Bearer $TOKEN" | jq 'length'
curl -s "https://brain.itiswednesdaymydud.es/fleet/hosts/$HOST_ID/inventory" -H "Authorization: Bearer $TOKEN" | jq '{has_skills: (.skills // [] | length > 0), version: .claude_version}'
```

Expected: metrics array length ≥ 5 (after ~60s × 10s), inventory has version filled.

- [ ] **Step 6: Verify UI**

Open `https://brain.itiswednesdaymydud.es/fleet/`, hard-refresh. Click on the `ai` host card → host detail panel shows live CPU/RAM line + sparklines start filling. Click Skills tab → see plugins; MCP → see configured servers; Settings → expand to see whitelisted JSON.

- [ ] **Step 7: Close vt + verify push state**

```bash
scripts/bin/vt close <task-id> --reason "daemon metrics + inventory shipped: schema 011 + collectors + hub ingest + REST + WS + UI; deployed brain prod"
git status  # MUST show 'up to date with origin'
```

---

## Self-Review

**Spec coverage:**
- §3 Architecture (two streams, embedded hub) — Tasks 4 + 6.
- §4 Schema — Task 1.
- §5 Daemon collectors — Tasks 2 + 3.
- §5 Daemon wiring — Task 4.
- §6 Hub ingestion — Task 6.
- §7 REST API — Task 6.
- §8 WS protocol (metrics_viewer + bus lifecycle) — Task 6.
- §9 UI (sparklines + tabs) — Task 8.
- §11 Retention — Task 7.
- §12 Failure modes — covered by null-safe collectors (Tasks 2-3) and try/catch in ingest (Task 6).
- §14 Success criteria — verification steps in Tasks 4, 6, 8, 9.
- §15 Settings expand-toggle — Task 8 step 2 uses `<details><summary>`.

**Placeholder scan:** No TBD/TODO. All commands concrete.

**Type consistency:**
- `collectMetrics()` return shape `{ts, cpu_pct, ram_used_bytes, ram_total_bytes, disk[], net, error?}` consistent across daemon module, hub ingest, DB, REST, UI.
- `collectInventory()` shape `{collected_at, skills[], mcp_servers[], claude_version, settings}` consistent.
- WS frame: `{type, host_id, ...payload}` — type=metrics or type=inventory.
- DB function names match across files: `insertHostMetric`, `setHostInventory`, `setHostLatestMetrics`, `readMetricsSince`, `readMetricsRollupSince`.

One thing fixed inline: §11 SQL spec used `interval '6 minutes'` lookback — plan uses `interval '30 minutes'` per the validated spec (matches updated §11 with watermark fix).

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-16-agent-fleet-daemon-metrics-implementation.md`.

Per project CLAUDE.md, `subagent-driven-development` is disabled. Default: `superpowers:executing-plans` inline batched.

After saving, validate plan via subagent (paralleling the workflow we used for #4 pricing), then begin execution.
