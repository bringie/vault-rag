---
type: plan
status: draft
epic: agent-fleet
spec: docs/superpowers/specs/2026-05-16-agent-fleet-ui-overhaul-design.md
date: 2026-05-16
---

# Agent-Fleet UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans`. `subagent-driven-development` disabled per project CLAUDE.md.

**Goal:** Persistent header+footer с hot-switchable themes (5) и i18n (EN/RU/ES); content-swap zone вместо position:fixed overlays; UX fixes — editable groups, inherited tags, archive rerun removal, cost groupBy=group, prices restyle.

**Architecture:** Single body-level topbar (title-left + nav + lang/theme switchers right) + footbar (stable stats). Все pages = `.page` siblings в `#content`. Themes via `[data-theme]` + CSS vars (full ANSI palette per theme for xterm). i18n hybrid: HTML `data-i18n` + JS `t(key)`, JSON dictionaries lazy-loaded.

**Tech Stack:** Vanilla JS (IIFE), CSS vars, native `<select>` switchers, no npm deps.

---

## File Layout

| File | Purpose | Status |
|------|---------|--------|
| `agent-fleet/web/themes.css` | 5 theme blocks (dark+light+solarized+nord+hi-contrast) with full ANSI palette | new |
| `agent-fleet/web/i18n.js` | t() + loadLang() + applyI18n() | new (~60 LOC) |
| `agent-fleet/web/i18n/en.json` | English ~250 keys | new |
| `agent-fleet/web/i18n/ru.json` | Russian translations | new |
| `agent-fleet/web/i18n/es.json` | Spanish translations | new |
| `agent-fleet/web/theme.js` | applyTheme() + boot from localStorage | new (~40 LOC) |
| `agent-fleet/web/index.html` | Major restructure | modify (big) |
| `agent-fleet/web/app.js` | setPage(), routeToPage(), applyRoute refactor, host-detail tag inheritance, remove rerun, editable groups | modify (~250 LOC delta) |
| `agent-fleet/web/app.css` | Drop position:fixed, page layout fixes, chip-inherited, switcher styles | modify (~80 LOC) |
| `agent-fleet/web/prices.js` | Style consistency tweaks | modify (~20 LOC) |
| `scripts/lib/fleet-static.js` | .json MIME | modify (1 LOC) |
| `scripts/lib/fleet-cost.js` | timelineByGroup() | modify (~50 LOC) |
| `scripts/lib/fleet-cost.test.js` | groupBy=group test | modify |
| `scripts/lib/fleet-routes.js` | handlePatchGroup 23505 catch + groupBy=group wire | modify (~15 LOC) |
| `scripts/lib/fleet-routes.test.js` | Tests for above | modify |

---

## Conventions

- Tests: `VAULT_RAG_PG_PASS=testpass node --test scripts/lib/<file>.test.js`
- Frontend: manual smoke (hard-refresh in browser)
- After each Phase 1 task — verify "no regression" smoke
- Deploy: `git push` → `ssh -p 977 root@brain.itiswednesdaymydud.es 'cd /opt/vault-rag && git pull && docker restart vault-rag-api'`
- Hard-refresh hint: tell user Ctrl+Shift+R after deploy

---

# PHASE 1 — Foundation

## Task 1: .json MIME for i18n

**Files:**
- Modify: `scripts/lib/fleet-static.js`

- [ ] **Step 1: Add MIME entry**

Edit `scripts/lib/fleet-static.js` MIME table (around line 7):

```js
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.woff2': 'font/woff2',
};
```

- [ ] **Step 2: Smoke test**

Create test file `agent-fleet/web/test.json` with content `{"ok":true}`, then:

```bash
VAULT_RAG_PG_HOST=127.0.0.1 VAULT_RAG_PG_PORT=55433 VAULT_RAG_PG_PASS=testpass VAULT_RAG_PG_DB=vault_rag VAULT_RAG_API_TOKEN=T RAG_PORT=18099 node scripts/rag-api.js >/tmp/r.log 2>&1 &
sleep 2
curl -sI http://127.0.0.1:18099/fleet/static/test.json | grep -i content-type
pkill -f scripts/rag-api.js
rm agent-fleet/web/test.json
```

Expected: `content-type: application/json; charset=utf-8`.

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/fleet-static.js
git commit -m "feat: serve .json MIME for i18n dictionaries

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Themes infrastructure (5 themes, hot-switch)

**Files:**
- Create: `agent-fleet/web/themes.css`
- Create: `agent-fleet/web/theme.js`
- Modify: `agent-fleet/web/index.html` (link CSS + switcher in topbar + load script)
- Modify: `agent-fleet/web/app.css` (move :root vars out, keep them as fallback for dark)

- [ ] **Step 1: Create themes.css with 5 blocks + ANSI palette**

Create `agent-fleet/web/themes.css`:

```css
/* dark (default) — current tactical look */
:root, :root[data-theme="dark"] {
  --bg: #0a0a0c; --bg-warm: #0d0c0a; --panel: #14141a; --panel-2: #1c1c24;
  --line: #2a2832; --line-2: #3a3845;
  --text: #e8e6e1; --text-dim: #8a8580; --text-faint: #5a5550;
  --ok: #5cf08c; --ok-glow: rgba(92,240,140,.4);
  --warn: #ffb547; --warn-glow: rgba(255,181,71,.4);
  --danger: #ff4d5e; --danger-glow: rgba(255,77,94,.4);
  --accent: #6fd5ff; --magenta: #ff79c6;
  --term-bg: #0a0a0c; --term-fg: #e8e6e1;
  --term-black: #16161e; --term-red: #ff4d5e; --term-green: #5cf08c; --term-yellow: #ffb547;
  --term-blue: #6fd5ff; --term-magenta: #ff79c6; --term-cyan: #88c0d0; --term-white: #c0c0c0;
  --term-br-black: #555555; --term-br-red: #ff8088; --term-br-green: #88ffaa; --term-br-yellow: #ffd07a;
  --term-br-blue: #aae6ff; --term-br-magenta: #ffaadd; --term-br-cyan: #aaeedd; --term-br-white: #ffffff;
}
:root[data-theme="light"] {
  --bg: #fafaf7; --bg-warm: #f0eee8; --panel: #ffffff; --panel-2: #f5f3ee;
  --line: #d0cdc4; --line-2: #b8b5ac;
  --text: #1a1815; --text-dim: #5a5550; --text-faint: #8a8580;
  --ok: #1f7f44; --ok-glow: rgba(31,127,68,.3);
  --warn: #b86f1d; --warn-glow: rgba(184,111,29,.3);
  --danger: #b8302e; --danger-glow: rgba(184,48,46,.3);
  --accent: #1d6fb8; --magenta: #9a3a8a;
  --term-bg: #0a0a0c; --term-fg: #e8e6e1;
  --term-black: #16161e; --term-red: #ff4d5e; --term-green: #5cf08c; --term-yellow: #ffb547;
  --term-blue: #6fd5ff; --term-magenta: #ff79c6; --term-cyan: #88c0d0; --term-white: #c0c0c0;
  --term-br-black: #555555; --term-br-red: #ff8088; --term-br-green: #88ffaa; --term-br-yellow: #ffd07a;
  --term-br-blue: #aae6ff; --term-br-magenta: #ffaadd; --term-br-cyan: #aaeedd; --term-br-white: #ffffff;
}
:root[data-theme="solarized"] {
  --bg: #fdf6e3; --bg-warm: #eee8d5; --panel: #fdf6e3; --panel-2: #eee8d5;
  --line: #cdb78d; --line-2: #93a1a1;
  --text: #073642; --text-dim: #586e75; --text-faint: #93a1a1;
  --ok: #859900; --ok-glow: rgba(133,153,0,.3);
  --warn: #b58900; --warn-glow: rgba(181,137,0,.3);
  --danger: #dc322f; --danger-glow: rgba(220,50,47,.3);
  --accent: #268bd2; --magenta: #d33682;
  --term-bg: #002b36; --term-fg: #93a1a1;
  --term-black: #073642; --term-red: #dc322f; --term-green: #859900; --term-yellow: #b58900;
  --term-blue: #268bd2; --term-magenta: #d33682; --term-cyan: #2aa198; --term-white: #eee8d5;
  --term-br-black: #002b36; --term-br-red: #cb4b16; --term-br-green: #586e75; --term-br-yellow: #657b83;
  --term-br-blue: #839496; --term-br-magenta: #6c71c4; --term-br-cyan: #93a1a1; --term-br-white: #fdf6e3;
}
:root[data-theme="nord"] {
  --bg: #2e3440; --bg-warm: #3b4252; --panel: #3b4252; --panel-2: #434c5e;
  --line: #4c566a; --line-2: #5e6779;
  --text: #eceff4; --text-dim: #d8dee9; --text-faint: #8fbcbb;
  --ok: #a3be8c; --ok-glow: rgba(163,190,140,.4);
  --warn: #ebcb8b; --warn-glow: rgba(235,203,139,.4);
  --danger: #bf616a; --danger-glow: rgba(191,97,106,.4);
  --accent: #88c0d0; --magenta: #b48ead;
  --term-bg: #2e3440; --term-fg: #eceff4;
  --term-black: #3b4252; --term-red: #bf616a; --term-green: #a3be8c; --term-yellow: #ebcb8b;
  --term-blue: #81a1c1; --term-magenta: #b48ead; --term-cyan: #88c0d0; --term-white: #e5e9f0;
  --term-br-black: #4c566a; --term-br-red: #bf616a; --term-br-green: #a3be8c; --term-br-yellow: #ebcb8b;
  --term-br-blue: #81a1c1; --term-br-magenta: #b48ead; --term-br-cyan: #8fbcbb; --term-br-white: #eceff4;
}
:root[data-theme="hi-contrast"] {
  --bg: #000000; --bg-warm: #0a0a0a; --panel: #111111; --panel-2: #1a1a1a;
  --line: #ffff00; --line-2: #ffff00;
  --text: #ffff00; --text-dim: #ffee44; --text-faint: #ccaa00;
  --ok: #00ff00; --ok-glow: rgba(0,255,0,.5);
  --warn: #ffaa00; --warn-glow: rgba(255,170,0,.5);
  --danger: #ff0033; --danger-glow: rgba(255,0,51,.5);
  --accent: #00ffff; --magenta: #ff66ff;
  --term-bg: #000000; --term-fg: #ffff00;
  --term-black: #000000; --term-red: #ff0033; --term-green: #00ff00; --term-yellow: #ffaa00;
  --term-blue: #00ffff; --term-magenta: #ff66ff; --term-cyan: #00ffaa; --term-white: #ffffff;
  --term-br-black: #444444; --term-br-red: #ff5566; --term-br-green: #66ff66; --term-br-yellow: #ffdd44;
  --term-br-blue: #66ffff; --term-br-magenta: #ff99ff; --term-br-cyan: #66ffcc; --term-br-white: #ffffff;
}
```

- [ ] **Step 2: Remove old :root vars from app.css**

In `agent-fleet/web/app.css` (line 5-26), remove the `:root { --bg:...; }` block — themes.css now owns all theming. Keep everything else.

- [ ] **Step 3: Create theme.js**

Create `agent-fleet/web/theme.js`:

```js
'use strict';
(function () {
  const VALID = ['dark', 'light', 'solarized', 'nord', 'hi-contrast'];

  function applyTheme(name) {
    if (!VALID.includes(name)) name = 'dark';
    document.documentElement.setAttribute('data-theme', name);
    localStorage.fleetTheme = name;
    // Update xterm palette if instantiated
    if (window.term && window.term.options) {
      const style = getComputedStyle(document.documentElement);
      const v = (k) => style.getPropertyValue(k).trim();
      window.term.options.theme = {
        background: v('--term-bg'), foreground: v('--term-fg'),
        black: v('--term-black'), red: v('--term-red'), green: v('--term-green'), yellow: v('--term-yellow'),
        blue: v('--term-blue'), magenta: v('--term-magenta'), cyan: v('--term-cyan'), white: v('--term-white'),
        brightBlack: v('--term-br-black'), brightRed: v('--term-br-red'), brightGreen: v('--term-br-green'),
        brightYellow: v('--term-br-yellow'), brightBlue: v('--term-br-blue'),
        brightMagenta: v('--term-br-magenta'), brightCyan: v('--term-br-cyan'), brightWhite: v('--term-br-white'),
      };
    }
  }

  function bootTheme() {
    const saved = localStorage.fleetTheme || 'dark';
    applyTheme(saved);
  }

  // Wire <select id="theme-select"> when DOM ready
  function wireSwitcher() {
    const sel = document.getElementById('theme-select');
    if (!sel) return;
    sel.value = localStorage.fleetTheme || 'dark';
    sel.addEventListener('change', () => applyTheme(sel.value));
  }

  bootTheme();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireSwitcher);
  } else { wireSwitcher(); }

  window.fleetTheme = { apply: applyTheme, valid: VALID };
})();
```

- [ ] **Step 4: Add theme switcher to topbar in index.html**

Find `<div class="controls">` block (around line 49). Add right before `<button id="reload">`:

```html
<select id="theme-select" class="switcher" title="theme">
  <option value="dark">dark</option>
  <option value="light">light</option>
  <option value="solarized">solarized</option>
  <option value="nord">nord</option>
  <option value="hi-contrast">hi-contrast</option>
</select>
```

Add CSS links + script in `<head>` (find existing `<link rel="stylesheet" href="/fleet/static/app.css">`):

```html
<link rel="stylesheet" href="/fleet/static/themes.css">
<link rel="stylesheet" href="/fleet/static/app.css">
```

Add `<script src="/fleet/static/theme.js"></script>` before `<script src="/fleet/static/app.js"></script>`.

- [ ] **Step 5: CSS for switcher**

Append to `agent-fleet/web/app.css`:

```css
.switcher {
  background: var(--panel); color: var(--text); border: 1px solid var(--line);
  font-family: var(--font-mono); font-size: .85em; padding: .25em .4em;
  margin: 0 .3em; cursor: pointer;
}
.switcher:hover { border-color: var(--accent); }
```

- [ ] **Step 6: Smoke**

Start hub, open `http://127.0.0.1:18099/fleet/`, switch theme dropdown to each of 5 values. Expected: bg/text/borders update instantly on every switch. Refresh — selection persists.

- [ ] **Step 7: Commit**

```bash
git add agent-fleet/web/themes.css agent-fleet/web/theme.js agent-fleet/web/index.html agent-fleet/web/app.css
git commit -m "feat: 5 themes (dark/light/solarized/nord/hi-contrast) with hot-switch

CSS vars moved from app.css :root to themes.css with [data-theme=X] blocks.
Each theme defines full 16-color ANSI palette for xterm. applyTheme()
updates xterm.options.theme on switch (next pty_data; cached cells
remain old palette — accepted caveat).
Native <select> switcher in topbar. localStorage.fleetTheme persists.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: i18n infrastructure + en.json

**Files:**
- Create: `agent-fleet/web/i18n.js`
- Create: `agent-fleet/web/i18n/en.json`
- Modify: `agent-fleet/web/index.html` (lang switcher + boot)

- [ ] **Step 1: Create i18n.js**

Create `agent-fleet/web/i18n.js`:

```js
'use strict';
(function () {
  const VALID = ['en', 'ru', 'es'];
  const state = { lang: 'en', dict: {} };

  async function loadLang(lang) {
    if (!VALID.includes(lang)) lang = 'en';
    try {
      const res = await fetch(`/fleet/static/i18n/${lang}.json`);
      if (!res.ok) throw new Error('' + res.status);
      state.dict = await res.json();
      state.lang = lang;
      localStorage.fleetLang = lang;
      document.documentElement.setAttribute('data-lang', lang);
      applyI18n();
    } catch (e) {
      console.warn(`[i18n] load ${lang} failed: ${e.message}; falling back to keys`);
    }
  }

  function t(key, vars) {
    let s = state.dict[key] || key;
    if (vars) for (const k in vars) s = s.replace(`{${k}}`, String(vars[k]));
    return s;
  }

  function applyI18n(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const k = el.dataset.i18n;
      if (k) el.textContent = t(k);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const k = el.dataset.i18nPlaceholder;
      if (k) el.placeholder = t(k);
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      const k = el.dataset.i18nTitle;
      if (k) el.title = t(k);
    });
  }

  function wireSwitcher() {
    const sel = document.getElementById('lang-select');
    if (!sel) return;
    sel.value = state.lang;
    sel.addEventListener('change', () => loadLang(sel.value));
  }

  window.fleetI18n = { t, loadLang, applyI18n, current: () => state.lang, wireSwitcher };
})();
```

- [ ] **Step 2: Create en.json with current UI strings**

Create `agent-fleet/web/i18n/en.json`. This is the master inventory (~250 keys). Start with the high-traffic ones; remaining can be added incrementally.

```json
{
  "nav.dashboard": "⊞ dashboard",
  "nav.archive": "📜 archive",
  "nav.cost": "$ trends",
  "nav.groups": "⌘ groups",
  "nav.workflows": "⎇ workflows",
  "nav.prices": "$ prices",
  "nav.refresh": "refresh",
  "nav.abort": "ABORT",

  "topbar.brand": "AGENT::FLEET",
  "topbar.brand_sub": "CONTROL.PLANE",
  "topbar.hosts": "HOSTS",
  "topbar.online": "ONLINE",
  "topbar.active": "ACTIVE",
  "topbar.uptime": "UPTIME",
  "topbar.spend7d": "7D SPEND",

  "footer.version": "FLEET v0.1.0 / proto=v0.1",

  "page.dashboard": "DASHBOARD",
  "page.archive": "SESSION ARCHIVE",
  "page.cost": "COST TRENDS",
  "page.groups": "GROUPS",
  "page.workflows": "WORKFLOWS",
  "page.prices": "MODEL PRICES",
  "page.workflow_editor": "WORKFLOW EDITOR",
  "page.workflow_run": "WORKFLOW RUN",
  "page.session_detail": "SESSION",

  "common.save": "save",
  "common.cancel": "cancel",
  "common.edit": "edit",
  "common.delete": "delete",
  "common.close": "× close",
  "common.back": "× back",
  "common.loading": "loading…",
  "common.saved": "Saved.",
  "common.error": "Error",
  "common.new": "+ new",
  "common.add": "+ add",
  "common.yes": "yes",
  "common.no": "no",
  "common.all": "all",
  "common.empty": "—",

  "status.idle": "idle",
  "status.running": "running",
  "status.pending": "pending",
  "status.exited": "exited",
  "status.killed": "killed",
  "status.orphaned": "orphaned",
  "status.done": "done",
  "status.failed": "failed",
  "status.cancelled": "cancelled",

  "host.meta.os": "os",
  "host.meta.arch": "arch",
  "host.meta.status": "status",
  "host.meta.daemon": "daemon",
  "host.meta.claude": "claude",
  "host.meta.node": "node",
  "host.meta.cpu": "cpu",
  "host.meta.cores": "cores",
  "host.meta.ram": "ram",
  "host.meta.uptime": "uptime",
  "host.meta.last_seen": "last_seen",
  "host.meta.hostname": "hostname",
  "host.tags.section": "LABELS / TAGS",
  "host.tags.add_placeholder": "add label (press enter)",
  "host.groups.section": "GROUPS",
  "host.inherited.section": "INHERITED",
  "host.inherited.from": "from: {group}",
  "host.sessions.section": "RECENT SESSIONS",
  "host.metrics.section": "METRICS",
  "host.inventory.section": "INVENTORY",
  "host.edit_md": "edit CLAUDE.md",
  "host.edit_json": "edit settings.json",

  "archive.title": "SESSION ARCHIVE",
  "archive.new": "+ new workflow",
  "archive.search_placeholder": "search label/notes/cwd",
  "archive.host": "host",
  "archive.status": "status",
  "archive.since": "since",
  "archive.until": "until",
  "archive.apply": "apply",
  "archive.reset": "reset",
  "archive.prev": "‹ prev",
  "archive.next": "next ›",
  "archive.no_match": "no sessions match",

  "groups.title": "GROUPS",
  "groups.new": "+ new group",
  "groups.name": "name",
  "groups.description": "description",
  "groups.labels": "labels",
  "groups.color": "color",
  "groups.hosts": "hosts",
  "groups.add_label": "new label…",
  "groups.add_host": "+ add host",
  "groups.remove_host": "remove",
  "groups.empty": "no groups yet — create one",
  "groups.detail_title": "GROUP //",
  "groups.section_labels": "LABELS (теги наследуются всеми хостами группы)",
  "groups.section_hosts": "HOSTS",
  "groups.delete_confirm": "delete this group? hosts stay, just the group is removed.",
  "groups.name_exists": "name already exists",

  "cost.title": "COST TRENDS",
  "cost.group_by": "group by",
  "cost.days": "days",
  "cost.legend.model": "model",
  "cost.legend.host": "host",
  "cost.legend.label": "label",
  "cost.legend.group": "group",
  "cost.overlap_note": "overlaps: hosts in multiple groups counted in each",
  "cost.ungrouped": "(ungrouped)",

  "prices.title": "MODEL PRICES",
  "prices.new": "+ new pattern",
  "prices.show_history": "show history",
  "prices.pattern": "pattern",
  "prices.priority": "priority",
  "prices.valid_from": "valid from",
  "prices.input": "input $/Mtok",
  "prices.output": "output $/Mtok",
  "prices.cache_create": "cache create",
  "prices.cache_read": "cache read",
  "prices.flag": "flag",
  "prices.fallback_badge": "⚠ fallback",
  "prices.new_rule": "NEW PRICING RULE",
  "prices.new_snapshot": "NEW SNAPSHOT //",
  "prices.note_pattern": "Pattern uses Postgres LIKE: % = any chars, _ = single. Examples: claude-opus-%, gpt-4o%, %",
  "prices.note_snapshot": "Saving creates a NEW row with valid_from=now. Old row stays for history.",
  "prices.save_snapshot": "save (new snapshot)",
  "prices.empty": "no pricing rules",
  "prices.delete_confirm": "soft-delete this price row?",

  "workflows.title": "WORKFLOWS",
  "workflows.new": "+ new workflow",
  "workflows.name": "name",
  "workflows.nodes": "nodes",
  "workflows.updated": "updated",
  "workflows.actions": "actions",
  "workflows.run": "run",
  "workflows.edit": "edit",
  "workflows.delete": "delete",
  "workflows.empty": "No workflows yet. Click + new workflow.",
  "workflows.delete_confirm": "Delete workflow?",
  "workflows.editor": "EDITOR",
  "workflows.add_claude": "+ claude",
  "workflows.add_branch": "+ branch",
  "workflows.add_delay": "+ delay",
  "workflows.save": "save",
  "workflows.run_btn": "run",
  "workflows.back": "back",
  "workflows.select_node": "Select a node…",
  "workflows.node_type_claude": "claude",
  "workflows.node_type_branch": "branch",
  "workflows.node_type_delay": "delay",
  "workflows.run_status": "status",
  "workflows.run_cancel": "cancel",
  "workflows.run_rerun": "re-run",
  "workflows.click_node": "Click a node for details.",

  "workflow.field.target": "target",
  "workflow.field.group": "group",
  "workflow.field.host": "host_name",
  "workflow.field.capability": "capability",
  "workflow.field.prompt": "prompt (supports {{n1.output}} {{inputs.x}})",
  "workflow.field.timeout": "timeout_s",
  "workflow.field.headless": "headless",
  "workflow.field.condition": "condition (JS expr; vars: nX.output, nX.exit_code, inputs.X)",
  "workflow.field.condition_hint": "Two outgoing edges required: one labelled \"then\", one labelled \"else\".",
  "workflow.field.seconds": "seconds",

  "inventory.tabs.skills": "Skills",
  "inventory.tabs.mcp": "MCP servers",
  "inventory.tabs.settings": "Settings",
  "inventory.skills.plugin": "plugin",
  "inventory.skills.version": "version",
  "inventory.skills.skill": "skill",
  "inventory.skills.empty": "no skills detected",
  "inventory.mcp.name": "name",
  "inventory.mcp.enabled": "enabled",
  "inventory.mcp.command": "command",
  "inventory.mcp.empty": "no MCP servers configured",
  "inventory.settings.show": "show settings JSON (whitelisted fields only)",
  "inventory.settings.version": "claude_version",

  "auth.title": "UNAUTHENTICATED",
  "auth.engage": "ENGAGE →",
  "auth.token_placeholder": "fleet auth token",
  "auth.note": "// token stored locally; ABORT clears it",

  "error.load_failed": "load failed",
  "error.save_failed": "save failed",
  "error.spawn_failed": "spawn failed",
  "error.auth_failed": "auth failed",
  "error.host_not_found": "host not found",
  "error.session_not_found": "session not found"
}
```

(Other keys added during Task 6/Phase 2 migration as encountered.)

- [ ] **Step 3: Add lang switcher + script in index.html**

In topbar `<div class="controls">` near theme switcher:

```html
<select id="lang-select" class="switcher" title="language">
  <option value="en">EN</option>
  <option value="ru">RU</option>
  <option value="es">ES</option>
</select>
```

In `<head>` add `<script src="/fleet/static/i18n.js"></script>` before theme.js.

- [ ] **Step 4: Wire i18n boot into app.js**

In `agent-fleet/web/app.js` find `boot()` function (line ~1041). Make it async, await loadLang before applyRoute:

```js
async function boot() {
  readToken();
  if (!state.token) { showAuth(); return; }
  showApp();
  // i18n boot — must await so first paint has correct strings
  await window.fleetI18n.loadLang(localStorage.fleetLang || 'en');
  window.fleetI18n.wireSwitcher();
  wireSpawn();
  // ... rest stays
}
```

- [ ] **Step 5: Smoke test**

Start hub, refresh page. Switch lang to RU (no ru.json yet → expect keys as text or warning in console). Switch back to EN — labels restore. Refresh — preference persists.

- [ ] **Step 6: Commit**

```bash
git add agent-fleet/web/i18n.js agent-fleet/web/i18n/en.json agent-fleet/web/index.html agent-fleet/web/app.js
git commit -m "feat: i18n infrastructure + en.json baseline

t(key, vars) + applyI18n(root) + loadLang(lang). Hybrid: HTML uses
data-i18n attrs (walked on each lang change), JS uses t() for dynamic.
en.json baseline with ~120 keys (nav, common, status, host meta,
archive/groups/cost/prices/workflows/inventory/auth/errors).
Boot awaits loadLang before applyRoute to avoid raw-key flash.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: HTML restructure — extract topbar+footer, rename overlays

**Files:**
- Modify: `agent-fleet/web/index.html`
- Modify: `agent-fleet/web/app.css`

- [ ] **Step 1: Restructure body in index.html**

Major edit. Current structure:
```
<body>
  <div id="auth">...</div>
  <div id="app" hidden>
    <header class="topbar">...</header>
    <main class="grid">...</main>
    <footer class="footbar">...</footer>
  </div>
  <div id="archive" hidden style="position:fixed">...</div>
  <div id="costview" hidden style="position:fixed">...</div>
  ...modals...
</body>
```

New structure:
```
<body>
  <div id="auth">...</div>
  <div id="app" hidden>
    <header class="topbar">...(unchanged content)...</header>
    <div class="subbar">
      <span id="app-title" data-i18n="page.dashboard">DASHBOARD</span>
      <span style="flex:1"></span>
      <div id="page-actions"></div>
    </div>
    <main id="content">
      <div id="page-dashboard" class="page">
        <!-- original main.grid content moves here -->
      </div>
      <div id="page-archive" class="page" hidden>...</div>
      <div id="page-cost" class="page" hidden>...</div>
      <div id="page-groups" class="page" hidden>...</div>
      <div id="page-prices" class="page" hidden>...</div>
      <div id="page-workflows" class="page" hidden>...</div>
      <div id="page-workflow-editor" class="page" hidden>...</div>
      <div id="page-workflow-run" class="page" hidden>...</div>
      <div id="page-session-detail" class="page" hidden>...</div>
    </main>
    <footer class="footbar">...(unchanged content)...</footer>
  </div>
  <!-- modals stay top-level -->
  <div id="group-detail-modal" hidden></div>
  <div id="price-modal" hidden></div>
  <div id="editor" hidden>...</div>
</body>
```

For each existing overlay (`#archive`, `#costview`, `#groupsview`, `#pricesview`, `#workflowsview`, `#workfloweditor`, `#workflowrunviewer`, `#sdetail`):

1. Move the `<div>` inside `<main id="content">`
2. Rename id to standardized `page-<route>` form:
   - `archive` → `page-archive`
   - `costview` → `page-cost`
   - `groupsview` → `page-groups`
   - `pricesview` → `page-prices`
   - `workflowsview` → `page-workflows`
   - `workfloweditor` → `page-workflow-editor`
   - `workflowrunviewer` → `page-workflow-run`
   - `sdetail` → `page-session-detail`
3. Add `class="page"` to each
4. Remove per-page header bars that duplicate global title (e.g. `<header class="archive-head"><div><span class="display">GROUPS</span>...</div>...</header>`) — but KEEP per-page action buttons (move them to subbar via app.js setPage)
5. Keep per-page bottom strips inside the .page div (archive pagination, etc.)

**For dashboard:** wrap existing `<main class="grid">...</main>` content in `<div id="page-dashboard" class="page">` (the existing `<main class="grid">` becomes inner sibling under the new wrapper).

- [ ] **Step 2: CSS adjustments**

In `agent-fleet/web/app.css`:

a) Drop the `position:fixed inset:0 z-index:80` rules. Find and DELETE:
```css
#archive, #sdetail, #costview { position: fixed; inset: 0; z-index: 80; ... }
#groupsview, #workflowsview, #workfloweditor, #workflowrunviewer, #pricesview { position: fixed; ... }
```

Replace with:
```css
.page { display: block; }
.page[hidden] { display: none !important; }
#content { flex: 1; display: flex; flex-direction: column; overflow: auto; min-height: 0; }
.subbar {
  display: flex; align-items: center; gap: 1em;
  padding: .6em 1.2em; background: var(--bg-warm);
  border-bottom: 1px solid var(--line);
  font-family: var(--font-display); font-size: 1em;
}
#app-title { color: var(--text); text-transform: uppercase; letter-spacing: 0.06em; }
#app { display: flex; flex-direction: column; height: 100vh; }
#app .topbar, #app .footbar, #app .subbar { flex: 0 0 auto; }
```

b) `#group-detail-modal`, `#price-modal`, `#editor` still need `position:fixed` (they're modal overlays, not pages) — leave those rules alone.

- [ ] **Step 3: Smoke**

Start hub, refresh. Each page should render in-flow (no fixed positioning quirks). Navigate via top nav buttons. Each page swap should show subbar updating title.

Without `setPage()` wired yet (Task 5), nav buttons still toggle visibility through old code paths — accept temporary mismatched titles until Task 5.

- [ ] **Step 4: Commit**

```bash
git add agent-fleet/web/index.html agent-fleet/web/app.css
git commit -m "refactor: extract topbar+footer + content swap zone

Page overlays renamed page-<route>, moved under <main id=content>.
Drop position:fixed — pages now flow children, layout = flexbox column.
Per-page headers removed (subbar shows global title); per-page bottom
strips (archive pagination etc) stay inside .page div.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: applyRoute refactor — setPage() + routeToPage()

**Files:**
- Modify: `agent-fleet/web/app.js`

- [ ] **Step 1: Add setPage() helper**

In `agent-fleet/web/app.js` near `applyRoute` (~line 729), add helpers:

```js
function routeToPage(r) {
  if (r.name === 'workflows' && !r.arg)            return 'workflows';
  if (r.name === 'workflows' && r.arg)             return 'workflow-editor';
  if (r.name === 'workflow-runs' && r.arg)         return 'workflow-run';
  if (r.name === 'sessions' && r.arg)              return 'session-detail';
  if (r.name === 'cost')                           return 'cost';
  if (r.name === 'groups')                         return 'groups';
  if (r.name === 'archive')                        return 'archive';
  if (r.name === 'prices')                         return 'prices';
  return 'dashboard';
}

function setPage(pageId, opts) {
  opts = opts || {};
  // hide all .page siblings, show only the one matching pageId
  document.querySelectorAll('.page').forEach(p => p.hidden = p.id !== `page-${pageId}`);
  const titleEl = $('app-title');
  if (titleEl) {
    if (opts.titleKey && window.fleetI18n) titleEl.textContent = window.fleetI18n.t(opts.titleKey);
    else if (opts.title) titleEl.textContent = opts.title;
    else                  titleEl.textContent = pageId.toUpperCase();
  }
  const actions = $('page-actions');
  if (actions) {
    actions.innerHTML = '';
    if (opts.actions) {
      if (typeof opts.actions === 'string') actions.innerHTML = opts.actions;
      else actions.appendChild(opts.actions);
    }
  }
  // Re-apply i18n on freshly-visible page
  if (window.fleetI18n) window.fleetI18n.applyI18n();
}
```

- [ ] **Step 2: Refactor applyRoute() to use setPage**

Replace the existing `applyRoute()` body:

```js
function applyRoute() {
  const r = currentRoute();
  const page = routeToPage(r);
  const setNav = (active) => {
    $('nav-dashboard').classList.toggle('active-nav', active === 'dashboard');
    $('nav-archive').classList.toggle('active-nav', active === 'archive');
    $('nav-cost').classList.toggle('active-nav', active === 'cost');
    const wn = $('nav-workflows'); if (wn) wn.classList.toggle('active-nav', active === 'workflows');
    const pn = $('nav-prices'); if (pn) pn.classList.toggle('active-nav', active === 'prices');
    const gn = $('nav-groups'); if (gn) gn.classList.toggle('active-nav', active === 'groups');
  };
  if (r.name === 'archive') {
    setNav('archive'); setPage('archive', { titleKey: 'page.archive' });
    openArchive();
    return;
  }
  if (r.name === 'sessions' && r.arg) {
    setNav('archive'); setPage('session-detail', { titleKey: 'page.session_detail' });
    openSessionDetail(r.arg);
    return;
  }
  if (r.name === 'cost') {
    setNav('cost'); setPage('cost', { titleKey: 'page.cost' });
    openCostView();
    return;
  }
  if (r.name === 'groups') {
    setNav('groups'); setPage('groups', { titleKey: 'page.groups' });
    openGroupsView();
    return;
  }
  if (r.name === 'workflows' && !r.arg) {
    setNav('workflows'); setPage('workflows', { titleKey: 'page.workflows' });
    if (window.openWorkflowsList) window.openWorkflowsList();
    return;
  }
  if (r.name === 'workflows' && r.arg) {
    setNav('workflows'); setPage('workflow-editor', { titleKey: 'page.workflow_editor' });
    if (window.openWorkflowEditor) window.openWorkflowEditor(r.arg);
    return;
  }
  if (r.name === 'workflow-runs' && r.arg) {
    setNav('workflows'); setPage('workflow-run', { titleKey: 'page.workflow_run' });
    if (window.openWorkflowRunViewer) window.openWorkflowRunViewer(r.arg);
    return;
  }
  if (r.name === 'prices') {
    setNav('prices'); setPage('prices', { titleKey: 'page.prices' });
    if (window.openPricesView) window.openPricesView();
    return;
  }
  // dashboard default
  setNav('dashboard'); setPage('dashboard', { titleKey: 'page.dashboard' });
}
```

- [ ] **Step 3: Add data-i18n to topbar HTML**

Open `agent-fleet/web/index.html`. For each label in topbar and nav:

```html
<span class="display" data-i18n="topbar.brand">AGENT::FLEET</span>
<span class="brand-sub" data-i18n="topbar.brand_sub">CONTROL.PLANE</span>
...
<span class="lbl" data-i18n="topbar.hosts">HOSTS</span>
...
<button id="nav-dashboard" class="btn-ghost active-nav" data-i18n="nav.dashboard">⊞ dashboard</button>
<button id="nav-archive" class="btn-ghost" data-i18n="nav.archive">📜 archive</button>
<button id="nav-cost" class="btn-ghost" data-i18n="nav.cost">$ trends</button>
<button id="nav-groups" class="btn-ghost" data-i18n="nav.groups">⌘ groups</button>
<button id="nav-workflows" class="btn-ghost" data-i18n="nav.workflows">⎇ workflows</button>
<button id="nav-prices" class="btn-ghost" data-i18n="nav.prices">$ prices</button>
<button id="reload" class="btn-icon" data-i18n-title="nav.refresh" title="refresh">⟳</button>
<button id="logout" class="btn-ghost" data-i18n="nav.abort">ABORT</button>
```

- [ ] **Step 4: Smoke**

Refresh page. Navigate via all nav buttons. Subbar title should change for each. Switch language EN → RU (still missing translations but no crash; falls back to keys). Switch back to EN.

- [ ] **Step 5: Commit**

```bash
git add agent-fleet/web/app.js agent-fleet/web/index.html
git commit -m "refactor: applyRoute uses setPage + routeToPage table

routeToPage maps route name+arg to page-id (e.g. sessions/<id> →
session-detail). setPage hides all .page siblings, updates app-title,
populates page-actions slot, re-applies i18n on swap.
nav buttons + topbar labels get data-i18n.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Phase 1 deploy + verify

- [ ] **Step 1: Push**

```bash
git push
```

- [ ] **Step 2: Pull on prod + restart**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es 'cd /opt/vault-rag && git pull --ff-only origin main && docker restart vault-rag-api'
```

- [ ] **Step 3: Manual smoke on prod**

Open `https://brain.itiswednesdaymydud.es/fleet/`, hard-refresh.

Verify each:
- Topbar visible + persistent across all routes
- Footer visible + stable across all routes
- Theme dropdown switches all 5 themes instantly
- Lang dropdown shows EN/RU/ES (RU/ES still untranslated, falls back to keys)
- localStorage persists theme + lang on reload
- Nav buttons navigate; subbar title updates
- Every existing page still renders (dashboard / archive / cost / groups / workflows / prices)
- No `position:fixed` visual quirks

---

# PHASE 2 — UX fixes

## Task 7: Archive — remove rerun button

**Files:**
- Modify: `agent-fleet/web/app.js`

- [ ] **Step 1: Find and remove**

In `agent-fleet/web/app.js`:

a) Find archive row template (around line 842) and remove the rerun cell:

```js
// before:
<td><button class="btn-ghost" data-rerun="${s.id}" style="font-size:.75em; padding:.2em .6em">↻</button></td>

// after: cell removed
```

b) Find and remove the click wire (around line 848):

```js
// remove these lines:
body.querySelectorAll('button[data-rerun]').forEach(b => {
  b.onclick = (e) => { e.stopPropagation(); rerunSession(b.dataset.rerun); };
});
```

c) Remove `rerunSession()` function (around lines 863-875). Delete the whole function.

d) Adjust `<thead>` of archive table — drop the "actions" `<th>` if it existed only for rerun. Verify no other action lived there.

- [ ] **Step 2: Smoke**

Refresh archive page — rows should render without ↻ button.

- [ ] **Step 3: Commit**

```bash
git add agent-fleet/web/app.js
git commit -m "ux: drop rerun button from session archive rows

User requested removal — feature wasn't useful in practice.
Detail page still allows attach-to-session inspection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Host detail — inherited tags, remove add-to-group

**Files:**
- Modify: `agent-fleet/web/index.html`
- Modify: `agent-fleet/web/app.js`

- [ ] **Step 1: Add INHERITED section + remove add-to-group select**

In `agent-fleet/web/index.html` host-detail panel (around line 138-150), find the GROUPS section:

```html
<section class="hd-section">
  <h4 data-i18n="host.groups.section">GROUPS</h4>
  <div id="hd-groups" class="chip-row"></div>
  <div class="chip-input">
    <select id="hd-group-select"><option value="">-- add to group --</option></select>
  </div>
</section>
```

Replace with:

```html
<section class="hd-section">
  <h4 data-i18n="host.groups.section">GROUPS</h4>
  <div id="hd-groups" class="chip-row"></div>
</section>
<section class="hd-section">
  <h4 data-i18n="host.inherited.section">INHERITED</h4>
  <div id="hd-inherited" class="chip-row chip-row-readonly"></div>
</section>
```

(`<select id="hd-group-select">` removed entirely — group membership management now lives in the GROUPS page detail modal.)

- [ ] **Step 2: Render inherited in app.js**

In `agent-fleet/web/app.js renderHostDetail` (right after `renderHostGroups(h);`), add:

```js
// inherited tags from groups
const ihEl = $('hd-inherited');
ihEl.innerHTML = '';
const inherited = h.inherited_labels || {};
let count = 0;
for (const [groupName, labels] of Object.entries(inherited)) {
  for (const l of (labels || [])) {
    count++;
    const chip = document.createElement('span');
    chip.className = 'chip chip-inherited';
    const fromText = window.fleetI18n
      ? window.fleetI18n.t('host.inherited.from', { group: groupName })
      : `from: ${groupName}`;
    chip.innerHTML = `${esc(l)} <span class="chip-source">[${esc(fromText)}]</span>`;
    ihEl.appendChild(chip);
  }
}
if (!count) {
  ihEl.innerHTML = `<span style="color:var(--text-faint); font-size:.85em">${esc(window.fleetI18n ? window.fleetI18n.t('common.empty') : '—')}</span>`;
}
```

- [ ] **Step 3: Remove renderHostGroups select-population code**

In `renderHostGroups` (around line 621), find the `select` population block:

```js
const sel = $('hd-group-select');
// ... (the whole block populating <option>s)
sel.onchange = async () => { ... };
```

Delete that entire block (sel is gone). Keep the chip rendering for current group memberships (read-only display of which groups this host is in).

- [ ] **Step 4: CSS**

Append to `agent-fleet/web/app.css`:

```css
.chip-inherited { background: var(--panel-2); border-style: dashed; cursor: default; }
.chip-source { color: var(--text-faint); font-size: .85em; margin-left: .3em; }
.chip-row-readonly { opacity: 0.9; }
```

- [ ] **Step 5: Smoke**

Open host detail on a host that's in groups with labels. Verify INHERITED section shows tags with `[from: groupname]`. add-to-group select absent.

- [ ] **Step 6: Commit**

```bash
git add agent-fleet/web/index.html agent-fleet/web/app.js agent-fleet/web/app.css
git commit -m "ux: host detail — inherited tags display + drop add-to-group

INHERITED section lists tags from each member group with
[from: groupname] attribution (read-only). add-to-group select
removed from host detail — group membership editing now lives
in Groups page modal exclusively.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Editable groups — name + color + description

**Files:**
- Modify: `scripts/lib/fleet-routes.js`
- Modify: `agent-fleet/web/app.js`
- Modify: `scripts/lib/fleet-routes.test.js`

- [ ] **Step 1: Add 23505 catch in handlePatchGroup**

In `scripts/lib/fleet-routes.js` `handlePatchGroup` (around line 502-524), wrap pg call:

```js
async function handlePatchGroup({ req, res, body, ctx }) {
  const id = pathMatch(req.url, '/fleet/groups');
  if (!body) return send(res, 422, { error: 'body required' });
  const patch = {};
  if ('name' in body)        patch.name = body.name;
  if ('description' in body) patch.description = body.description;
  if ('color' in body)       patch.color = body.color;
  if ('labels' in body) {
    if (!Array.isArray(body.labels)) return send(res, 422, { error: 'labels must be array of strings' });
    patch.labels = body.labels;
  }
  try {
    const g = await fleetDb.updateGroup(ctx.db, id, patch);
    if (!g) return send(res, 404, { error: 'not found' });
    send(res, 200, g);
  } catch (e) {
    if (e.code === '23505') return send(res, 409, { error: 'name already exists' });
    send(res, 400, { error: e.message });
  }
}
```

- [ ] **Step 2: Write failing test for 23505**

Append to `scripts/lib/fleet-routes.test.js`:

```js
test('PATCH /fleet/groups/:id rejects duplicate name with 409', async () => {
  const { server, pg, close } = await startWithDb();
  await pg.query(`TRUNCATE fleet_groups CASCADE`);
  const a = await pg.query(`INSERT INTO fleet_groups (name) VALUES ('alpha') RETURNING id`);
  await pg.query(`INSERT INTO fleet_groups (name) VALUES ('beta')`);
  // try to rename alpha to beta — should 409
  const r = await reqJson(server, 'PATCH', `/fleet/groups/${a.rows[0].id}`, {
    token: 'T', body: { name: 'beta' },
  });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already exists/);
  await close();
});
```

- [ ] **Step 3: Run test**

```bash
VAULT_RAG_PG_PASS=testpass node --test --test-name-pattern='duplicate' scripts/lib/fleet-routes.test.js
```

Expected: 1 test passes.

- [ ] **Step 4: Add editable inputs to group detail modal**

In `agent-fleet/web/app.js` `openGroupDetail` function — the modal template HTML. Find the `.gd-frame` block. Add a new editable header section between `.gd-head` and `.gd-body`:

Replace this block:
```js
modal.innerHTML = `
  <div class="gd-frame">
    <div class="gd-head">
      <span class="display" style="font-size:1.1em">GROUP // ${esc(g.name)}</span>
```

With this:
```js
modal.innerHTML = `
  <div class="gd-frame">
    <div class="gd-head">
      <span class="display" style="font-size:1.1em">GROUP //</span>
      <input id="gd-name" class="gd-name-input" value="${esc(g.name)}" maxlength="64">
      <input id="gd-color" type="color" value="${esc(g.color || '#888888')}" title="color">
```

(Keep the existing close button and `flex:1` separator after.)

Below the labels chip-row section in `.gd-body`, insert a description field:

```html
<section style="margin-top:1em">
  <label class="lbl" data-i18n="groups.description">DESCRIPTION</label>
  <input id="gd-desc" value="${esc(g.description || '')}" style="width:100%">
</section>
```

Wire onblur events:

```js
$('gd-name').onblur = async () => {
  const v = $('gd-name').value.trim();
  if (!v || v === g.name) return;
  // client-side uniqueness check
  if (state.groups.some(other => other.name === v && other.id !== g.id)) {
    alert(window.fleetI18n ? window.fleetI18n.t('groups.name_exists') : 'name already exists');
    $('gd-name').value = g.name;
    return;
  }
  try {
    await api('PATCH', '/groups/' + g.id, { name: v });
    g.name = v;
    loadGroups();
  } catch (e) {
    alert(e.message);
    $('gd-name').value = g.name;
  }
};
$('gd-color').onchange = async () => {
  const v = $('gd-color').value;
  await api('PATCH', '/groups/' + g.id, { color: v });
  g.color = v;
  loadGroups();
};
$('gd-desc').onblur = async () => {
  const v = $('gd-desc').value.trim();
  if (v === (g.description || '')) return;
  await api('PATCH', '/groups/' + g.id, { description: v || null });
  g.description = v;
  loadGroups();
};
```

- [ ] **Step 5: CSS for inputs**

Append to `agent-fleet/web/app.css`:

```css
.gd-name-input {
  background: var(--bg); color: var(--text); border: 1px solid var(--line);
  font-family: var(--font-display); font-size: 1.1em;
  padding: .25em .5em; min-width: 200px; flex: 1;
}
#gd-color { width: 32px; height: 32px; padding: 0; border: 1px solid var(--line); cursor: pointer; }
```

- [ ] **Step 6: Smoke**

Open Groups → click any group → edit name (verify uniqueness check rejects duplicate) → edit color → edit description. Reload page — values persist.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/fleet-routes.js scripts/lib/fleet-routes.test.js agent-fleet/web/app.js agent-fleet/web/app.css
git commit -m "feat: editable groups (name/color/description) + 23505 catch

handlePatchGroup returns 409 on duplicate-name (was leaking raw pg
error). Modal adds name input + color picker + description input.
Client-side uniqueness check before PATCH avoids round-trip on
obvious conflicts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Prices page — visual consistency with groups

**Files:**
- Modify: `agent-fleet/web/prices.js`
- Modify: `agent-fleet/web/app.css`

- [ ] **Step 1: Audit differences**

Compare:
- Groups table (`#grp-rows` in `#page-groups`): uses `archive-table` class, `archive-head` for header bar, chip-row for tags
- Prices table (`#px-rows` in `#page-prices`): uses `archive-table` class (same), `archive-head` (same), but action buttons styled differently

Differences identified to align:
- Action buttons in prices use `font-size:.75em` inline → make consistent with groups' usage
- Prices "flagged" badge uses inline `style="color:var(--warn)"` → use chip class
- Pricing rule actions match groups action style

- [ ] **Step 2: Apply consistency tweaks**

In `agent-fleet/web/prices.js` `loadPrices` — change the row template's flagged column and actions:

```js
// before:
<td>${r.flagged ? '<span style="color:var(--warn)">⚠ fallback</span>' : ''}</td>

// after:
<td>${r.flagged ? '<span class="chip chip-warn">⚠ fallback</span>' : ''}</td>
```

```js
// before:
<button class="btn-ghost" data-edit="${r.id}" style="font-size:.75em">edit</button>

// after (matching groups action style):
<button class="btn-ghost btn-row" data-edit="${r.id}">edit</button>
```

Same for the delete button.

- [ ] **Step 3: CSS additions**

Append to `agent-fleet/web/app.css`:

```css
.chip-warn { background: var(--warn-glow); color: var(--warn); border: 1px solid var(--warn); }
.btn-row { font-size: .75em; padding: .2em .6em; }
```

- [ ] **Step 4: Smoke**

Open Prices page. Verify: row actions match style of Groups page action buttons. Flagged row shows chip instead of inline span.

- [ ] **Step 5: Commit**

```bash
git add agent-fleet/web/prices.js agent-fleet/web/app.css
git commit -m "ux: prices page visual alignment with groups page

Use chip-warn class for flagged badge (consistent with groups chip
style). btn-row utility class for row action buttons (consistent
font-size + padding across pages).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Cost groupBy=group

**Files:**
- Modify: `scripts/lib/fleet-cost.js`
- Modify: `scripts/lib/fleet-cost.test.js`
- Modify: `scripts/lib/fleet-routes.js`
- Modify: `agent-fleet/web/index.html`
- Modify: `agent-fleet/web/app.js`

- [ ] **Step 1: Write failing test for timelineByGroup**

Append to `scripts/lib/fleet-cost.test.js`:

```js
test('timeline groupBy=group splits cost by host group with (ungrouped) bucket', async () => {
  await withBoth(async (tok, vault) => {
    await resetEvents(tok);
    await seedPrices(vault);
    await vault.query(`TRUNCATE fleet_hosts, fleet_groups, fleet_host_groups, fleet_sessions CASCADE`);

    const h1 = await vault.query(`INSERT INTO fleet_hosts (name) VALUES ('h1') RETURNING id`);
    const h2 = await vault.query(`INSERT INTO fleet_hosts (name) VALUES ('h2') RETURNING id`);
    const g1 = await vault.query(`INSERT INTO fleet_groups (name) VALUES ('backend') RETURNING id`);
    await vault.query(`INSERT INTO fleet_host_groups (host_id, group_id) VALUES ($1, $2)`, [h1.rows[0].id, g1.rows[0].id]);

    const s1 = await vault.query(`INSERT INTO fleet_sessions (host_id, cwd) VALUES ($1, '/') RETURNING id`, [h1.rows[0].id]);
    const s2 = await vault.query(`INSERT INTO fleet_sessions (host_id, cwd) VALUES ($1, '/') RETURNING id`, [h2.rows[0].id]);

    await seed(tok, 'h1-host-name', new Date(), 'claude-opus-4-7', 1_000_000, 100_000);  // 22.5
    await seed(tok, 'h2-host-name', new Date(), 'claude-opus-4-7', 1_000_000, 100_000);  // 22.5

    // tokmon.events.session_id matches fleet_sessions.id for grouping. Update seed rows:
    await tok.query(`UPDATE events SET session_id = $1::text WHERE host_id = 'h1-host-name'`, [s1.rows[0].id]);
    await tok.query(`UPDATE events SET session_id = $1::text WHERE host_id = 'h2-host-name'`, [s2.rows[0].id]);

    const rows = await fleetCost.timeline(tok, vault, [], 7, 'group');
    const backend = rows.find(r => r.dim === 'backend');
    const ungrouped = rows.find(r => r.dim === '(ungrouped)');
    assert.ok(backend, 'backend group bucket exists');
    assert.ok(ungrouped, 'ungrouped bucket exists for h2');
    assert.ok(Math.abs(backend.usd - 22.5) < 0.01, `backend usd=${backend.usd}`);
    assert.ok(Math.abs(ungrouped.usd - 22.5) < 0.01, `ungrouped usd=${ungrouped.usd}`);
  });
});
```

- [ ] **Step 2: Run test to verify fail**

```bash
VAULT_RAG_PG_PASS=testpass node --test --test-name-pattern='groupBy=group' scripts/lib/fleet-cost.test.js
```

Expected: FAIL ("Cannot read property 'dim' of undefined" — function returns model-grouped rows).

- [ ] **Step 3: Implement timelineByGroup**

In `scripts/lib/fleet-cost.js`, after `timelineByLabel` function add:

```js
async function timelineByGroup(tokmonPg, vaultPg, days = 7) {
  const { rows: ev } = await tokmonPg.query(
    `SELECT date_trunc('day', ts) AS day, session_id, model,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_5m) AS cache_creation_5m, SUM(cache_read) AS cache_read,
            COUNT(*) AS msgs
     FROM events
     WHERE ts > now() - ($1 || ' days')::interval
     GROUP BY day, session_id, model`, [String(days)]);
  if (!ev.length) return [];
  const sessionIds = Array.from(new Set(ev.map(r => r.session_id).filter(x => /^[0-9a-f-]{36}$/i.test(x))));
  // Map session_id -> [group names] (LEFT JOIN so ungrouped hosts surface)
  const groupsBySession = new Map();
  if (sessionIds.length) {
    const { rows: ss } = await vaultPg.query(
      `SELECT s.id::text AS session_id, COALESCE(g.name, '(ungrouped)') AS group_name
       FROM fleet_sessions s
       LEFT JOIN fleet_host_groups hg ON hg.host_id = s.host_id
       LEFT JOIN fleet_groups g ON g.id = hg.group_id
       WHERE s.id::text = ANY($1)`, [sessionIds]);
    for (const r of ss) {
      if (!groupsBySession.has(r.session_id)) groupsBySession.set(r.session_id, []);
      groupsBySession.get(r.session_id).push(r.group_name);
    }
  }
  // One session in N groups → emit N rows (double-count, documented).
  const grouped = new Map();
  for (const r of ev) {
    const groups = groupsBySession.get(r.session_id) || ['(ungrouped)'];
    for (const gName of groups) {
      const key = `${r.day.toISOString()}|${gName}|${r.model}`;
      let g = grouped.get(key);
      if (!g) {
        g = { day: r.day, dim: gName, model: r.model, msgs: 0, input_tokens: 0, output_tokens: 0, cache_creation_5m: 0, cache_read: 0 };
        grouped.set(key, g);
      }
      g.msgs += Number(r.msgs);
      g.input_tokens += Number(r.input_tokens);
      g.output_tokens += Number(r.output_tokens);
      g.cache_creation_5m += Number(r.cache_creation_5m);
      g.cache_read += Number(r.cache_read);
    }
  }
  const out = [];
  for (const g of grouped.values()) out.push({ ...g, usd: await rowCost(g, g.day, vaultPg) });
  return out.sort((a, b) => a.day - b.day);
}
```

Then in `timeline()` add the branch:

```js
async function timeline(tokmonPg, vaultPg, hostNames, days = 7, groupBy = 'model') {
  if (groupBy === 'label' && vaultPg) return timelineByLabel(tokmonPg, vaultPg, days);
  if (groupBy === 'group' && vaultPg) return timelineByGroup(tokmonPg, vaultPg, days);
  // ... rest unchanged
```

- [ ] **Step 4: Run test**

```bash
VAULT_RAG_PG_PASS=testpass node --test scripts/lib/fleet-cost.test.js
```

Expected: 5 tests pass (4 existing + 1 new).

- [ ] **Step 5: Add UI option**

In `agent-fleet/web/index.html` cost view (`#page-cost`), find `<select id="cv-groupby">`:

```html
<select id="cv-groupby" style="margin-left:.4em">
  <option value="model" selected>model</option>
  <option value="host">host</option>
  <option value="label">label</option>
</select>
```

Replace with:

```html
<select id="cv-groupby" style="margin-left:.4em">
  <option value="model" selected data-i18n="cost.legend.model">model</option>
  <option value="host" data-i18n="cost.legend.host">host</option>
  <option value="label" data-i18n="cost.legend.label">label</option>
  <option value="group" data-i18n="cost.legend.group">group</option>
</select>
```

In `openCostView` / cost rendering code (find where the summary appears), add overlap note when `groupBy === 'group'`:

```js
if (groupBy === 'group') {
  const note = document.createElement('div');
  note.className = 'lbl';
  note.style.marginTop = '.5em';
  note.style.color = 'var(--warn)';
  note.textContent = window.fleetI18n ? window.fleetI18n.t('cost.overlap_note')
    : 'overlaps: hosts in multiple groups counted in each';
  $('cv-summary').appendChild(note);
}
```

- [ ] **Step 6: Smoke**

Open cost page → switch groupBy to "group". Verify legend shows group names; "(ungrouped)" bucket appears for hosts without groups; overlap warning appears.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/fleet-cost.js scripts/lib/fleet-cost.test.js agent-fleet/web/index.html agent-fleet/web/app.js
git commit -m "feat: cost timeline groupBy=group with (ungrouped) bucket

LEFT JOIN fleet_sessions → fleet_host_groups → fleet_groups so
hosts without group memberships surface as (ungrouped) bucket
(no silent drop). One session in N groups emits N rows
(double-count, surfaced via overlap note in UI).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: RU + ES dictionaries + final deploy

**Files:**
- Create: `agent-fleet/web/i18n/ru.json`
- Create: `agent-fleet/web/i18n/es.json`

- [ ] **Step 1: Create ru.json**

Create `agent-fleet/web/i18n/ru.json` — mirror structure of en.json, translated values. Same keys as `en.json` from Task 3 — translate each. Skip if you only want EN at first deployment; en.json fallback works.

For Phase 2 minimum-viable, translate the high-traffic keys:

```json
{
  "nav.dashboard": "⊞ dashboard",
  "nav.archive": "📜 архив",
  "nav.cost": "$ тренды",
  "nav.groups": "⌘ группы",
  "nav.workflows": "⎇ workflow",
  "nav.prices": "$ цены",
  "nav.abort": "ВЫХОД",
  "page.dashboard": "ПУЛЬТ",
  "page.archive": "АРХИВ СЕССИЙ",
  "page.cost": "ТРЕНДЫ СТОИМОСТИ",
  "page.groups": "ГРУППЫ",
  "page.workflows": "WORKFLOW",
  "page.prices": "ЦЕНЫ МОДЕЛЕЙ",
  "common.save": "сохранить",
  "common.cancel": "отмена",
  "common.edit": "ред.",
  "common.delete": "удалить",
  "common.close": "× закрыть",
  "common.loading": "загрузка…",
  "common.saved": "Сохранено.",
  "common.error": "Ошибка",
  "common.empty": "—",
  "host.tags.section": "ТЕГИ",
  "host.groups.section": "ГРУППЫ",
  "host.inherited.section": "УНАСЛЕДОВАНО",
  "host.inherited.from": "из: {group}",
  "host.metrics.section": "МЕТРИКИ",
  "host.inventory.section": "ИНВЕНТАРЬ",
  "groups.new": "+ новая группа",
  "groups.delete_confirm": "удалить группу? хосты остаются, удаляется только группа.",
  "groups.name_exists": "имя уже существует",
  "cost.group_by": "группировать по",
  "cost.overlap_note": "пересечения: хосты в нескольких группах учитываются в каждой",
  "cost.ungrouped": "(без группы)",
  "prices.new": "+ новый паттерн",
  "prices.show_history": "показать историю",
  "prices.empty": "правил ценообразования нет",
  "error.load_failed": "ошибка загрузки",
  "error.save_failed": "ошибка сохранения"
}
```

- [ ] **Step 2: Create es.json**

Same key set, Spanish values:

```json
{
  "nav.dashboard": "⊞ panel",
  "nav.archive": "📜 archivo",
  "nav.cost": "$ tendencias",
  "nav.groups": "⌘ grupos",
  "nav.workflows": "⎇ flujos",
  "nav.prices": "$ precios",
  "nav.abort": "SALIR",
  "page.dashboard": "PANEL",
  "page.archive": "ARCHIVO DE SESIONES",
  "page.cost": "TENDENCIAS DE COSTE",
  "page.groups": "GRUPOS",
  "page.workflows": "FLUJOS DE TRABAJO",
  "page.prices": "PRECIOS DE MODELOS",
  "common.save": "guardar",
  "common.cancel": "cancelar",
  "common.edit": "editar",
  "common.delete": "eliminar",
  "common.close": "× cerrar",
  "common.loading": "cargando…",
  "common.saved": "Guardado.",
  "common.error": "Error",
  "common.empty": "—",
  "host.tags.section": "ETIQUETAS",
  "host.groups.section": "GRUPOS",
  "host.inherited.section": "HEREDADO",
  "host.inherited.from": "de: {group}",
  "host.metrics.section": "MÉTRICAS",
  "host.inventory.section": "INVENTARIO",
  "groups.new": "+ nuevo grupo",
  "groups.delete_confirm": "¿eliminar este grupo? los hosts permanecen, solo se elimina el grupo.",
  "groups.name_exists": "el nombre ya existe",
  "cost.group_by": "agrupar por",
  "cost.overlap_note": "solapamientos: hosts en varios grupos contados en cada uno",
  "cost.ungrouped": "(sin grupo)",
  "prices.new": "+ nuevo patrón",
  "prices.show_history": "mostrar historial",
  "prices.empty": "no hay reglas de precios",
  "error.load_failed": "error de carga",
  "error.save_failed": "error al guardar"
}
```

- [ ] **Step 3: Smoke each language**

Refresh page. Switch lang → RU → all nav buttons и titles translate. Switch → ES → same. Switch → EN → restored.

- [ ] **Step 4: Final deploy**

```bash
git add agent-fleet/web/i18n/ru.json agent-fleet/web/i18n/es.json
git commit -m "feat: RU + ES translations (high-traffic keys)

ru.json + es.json — translations for nav, page titles, common
actions, group/cost/prices/host labels, errors. Missing keys
fall back to the key itself (acceptable for low-traffic strings;
fill in as encountered).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es 'cd /opt/vault-rag && git pull --ff-only origin main && docker restart vault-rag-api'
```

- [ ] **Step 5: Prod e2e**

Open `https://brain.itiswednesdaymydud.es/fleet/`, hard-refresh:

1. Theme dropdown — switch through all 5 themes; no visual breakage on any page.
2. Lang dropdown — switch EN/RU/ES; major labels translate.
3. Host detail — see INHERITED section with `[from: groupname]`; no add-to-group select.
4. Groups page — click group → edit name (try duplicate to see error) → edit color → edit description.
5. Archive — rerun button absent.
6. Cost page — switch groupBy to "group" → see group breakdown + overlap note + `(ungrouped)` bucket.
7. Prices page — visual style matches groups (chips, button styling).

- [ ] **Step 6: Close vt + verify state**

```bash
scripts/bin/vt close vt-0072 --reason "UI overhaul shipped: persistent header/footer, 5 themes hot-switch, EN/RU/ES i18n, editable groups (name/color/desc), inherited tags display, archive rerun removed, cost groupBy=group, prices style alignment. Deployed to brain prod."
git status   # MUST show 'up to date with origin'
```

---

## Self-Review

**Spec coverage:**
- §3 Architecture (persistent header/footer, content swap) — Tasks 4, 5
- §4.1 HTML restructure — Task 4
- §4.2 Routing API (setPage + routeToPage) — Task 5
- §4.3 Themes + ANSI palette — Task 2
- §4.4-4.5 i18n hybrid + key inventory — Task 3
- §5.1 Inherited tags + remove add-to-group — Task 8
- §5.2 Editable groups (name/color) + 23505 catch — Task 9
- §5.3 Archive rerun removal — Task 7
- §5.4 Cost groupBy=group with (ungrouped) — Task 11
- §5.5 Prices restyle — Task 10
- §8 Failure modes — covered via fallback chains in i18n/theme code
- §10 Success criteria — verified in Task 6 + Task 12 step 5

**Placeholder scan:** searched for TBD/TODO — none. Each task has complete code blocks. Test code included where needed.

**Type consistency:**
- `routeToPage(r)` → string consistent across spec + plan
- `setPage(pageId, opts)` signature consistent
- `applyTheme(name)` / `loadLang(lang)` / `t(key, vars)` signatures consistent
- `inherited_labels` shape `{groupName: [labels]}` consistent in spec §5.1 + plan Task 8

Task 11 introduces `timelineByGroup` — consistent with existing `timelineByLabel` pattern.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-16-agent-fleet-ui-overhaul-implementation.md`.

Per project CLAUDE.md, `subagent-driven-development` disabled. Execution mode: `superpowers:executing-plans` inline batched, with sub-agent validation between Phase 1 and Phase 2.
