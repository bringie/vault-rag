---
type: spec
status: draft
epic: agent-fleet
date: 2026-05-16
---

# Agent-Fleet UI Overhaul — Design Spec

## 1. Goal

Преобразовать agent-fleet web UI:
- **Phase 1 (Foundation)**: persistent header+footer с title/nav/switchers, content-swap zone, 5 themes + 3 languages (EN/RU/ES) hot-switchable.
- **Phase 2 (UX fixes)**: editable groups, inherited tags display, prices restyle, archive rerun removal, cost groupBy=group, host detail tag UX.

## 2. Constraints / non-goals

- Vanilla JS, no frameworks (IIFE + globals pattern preserved)
- No external npm deps in browser layer
- Backwards-compatible URLs (`#/dashboard`, `#/archive`, etc.)
- xterm.js terminal theme — Phase 1 swap may require re-init; document the limitation if hot-swap doesn't work cleanly
- ~150 i18n strings, JSON dictionaries per locale ~5KB each

## 3. Architecture changes

### Before
```
<body>
  <div id="app">
    <header class="topbar">...</header>
    <main>...</main>
    <footer class="footbar">...</footer>
  </div>
  <div id="archive" hidden style="position:fixed inset:0">...</div>
  <div id="costview" hidden style="position:fixed inset:0">...</div>
  ...
</body>
```

### After
```
<body data-theme="dark" data-lang="en">
  <header class="topbar">
    <span id="app-title">DASHBOARD</span>
    <nav class="nav">[btns]</nav>
    <div class="switchers">[lang ▾] [theme ▾]</div>
  </header>
  <div class="subbar" id="page-actions"><!-- per-page action buttons --></div>
  <main id="content">
    <div id="page-dashboard" class="page">...</div>
    <div id="page-archive" class="page" hidden>...</div>
    <div id="page-groups" class="page" hidden>...</div>
    <div id="page-cost" class="page" hidden>...</div>
    <div id="page-prices" class="page" hidden>...</div>
    <div id="page-workflows" class="page" hidden>...</div>
    <div id="page-workflow-editor" class="page" hidden>...</div>
    <div id="page-workflow-run" class="page" hidden>...</div>
    <div id="page-session-detail" class="page" hidden>...</div>
  </main>
  <footer class="footbar"><span id="fleet-stats">...</span></footer>
  <!-- modals stay top-level -->
  <div id="group-detail-modal" hidden></div>
  <div id="price-modal" hidden></div>
</body>
```

Pages — no `position:fixed`. Layout = normal flow. `applyRoute()` toggles `hidden` on `.page` siblings + updates `#app-title` + populates `#page-actions`.

**Footer policy:** global `footbar` shows only **stable** fleet stats (`#fleet-stats`, version, daemon counts). Per-page bottom strips (archive pagination, workflow run status, session detail toolbar) stay **inside** the `.page` div as last child — that way each page brings its own bottom controls and the global footer remains static across navigation.

**Route → page-id mapping table.** Routes don't 1:1 map to page-ids (e.g. `#/sessions/<id>` is the session-detail page, `#/workflows/<id>` is the workflow-editor page). Explicit table:

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
```

Bookmarks стабильны (URL routes не меняются) — page-ids только внутренний DOM concern.

## 4. Phase 1 (foundation)

### 4.1 HTML restructure

`agent-fleet/web/index.html`:
- Move existing `topbar` out of `#app`, become body child
- Move existing `footbar` out of `#app`, become body child
- New `<div class="subbar" id="page-actions"></div>` between topbar and content
- Wrap existing dashboard markup as `<div id="page-dashboard" class="page">`
- Rename each overlay → `<div id="page-<route>" class="page" hidden>`
- Strip per-page headers that duplicate global title (close `× back` buttons go away — nav covers nav)
- Modals (`group-detail-modal`, `price-modal`, `editor`, `term-overlay`) stay as top-level body children

### 4.2 Routing API

`agent-fleet/web/app.js`:

```js
function setPage(name, opts = {}) {
  document.querySelectorAll('.page').forEach(p => p.hidden = p.id !== `page-${name}`);
  document.getElementById('app-title').textContent = opts.title || name.toUpperCase();
  const actions = document.getElementById('page-actions');
  actions.innerHTML = '';
  if (opts.actions) actions.appendChild(opts.actions);
}
```

`applyRoute()` → each branch calls `setPage('archive', { title: t('archive.title'), actions: makeArchiveActions() })`.

### 4.3 Themes

`agent-fleet/web/themes.css` (new) — single file with 5 theme blocks:

```css
:root, :root[data-theme="dark"] {
  --bg: #0a0a0c; --bg-warm: #0d0c0a; --panel: #14141a; --panel-2: #1c1c24;
  --line: #2a2832; --line-2: #3a3845;
  --text: #e8e6e1; --text-dim: #8a8580; --text-faint: #5a5550;
  --ok: #5cf08c; --warn: #ffb547; --danger: #ff4d5e; --accent: #6fd5ff; --magenta: #ff79c6;
  --term-bg: #0a0a0c; --term-fg: #e8e6e1;
}
:root[data-theme="light"] {
  --bg: #fafaf7; --bg-warm: #f0eee8; --panel: #ffffff; --panel-2: #f5f3ee;
  --line: #d0cdc4; --line-2: #b8b5ac;
  --text: #1a1815; --text-dim: #5a5550; --text-faint: #8a8580;
  --ok: #1f7f44; --warn: #b86f1d; --danger: #b8302e; --accent: #1d6fb8; --magenta: #9a3a8a;
  --term-bg: #0a0a0c; --term-fg: #e8e6e1;  /* terminal stays dark — readability */
}
:root[data-theme="solarized"] {
  /* WCAG AA: --text on --bg = 12.6:1 (#073642 on #fdf6e3), --text-dim = 7.5:1 */
  --bg: #fdf6e3; --bg-warm: #eee8d5; --panel: #fdf6e3; --panel-2: #eee8d5;
  --line: #cdb78d; --line-2: #93a1a1;
  --text: #073642; --text-dim: #586e75; --text-faint: #93a1a1;
  --ok: #859900; --warn: #b58900; --danger: #dc322f; --accent: #268bd2; --magenta: #d33682;
  --term-bg: #002b36; --term-fg: #93a1a1;
}
:root[data-theme="nord"] {
  --bg: #2e3440; --bg-warm: #3b4252; --panel: #3b4252; --panel-2: #434c5e;
  --line: #4c566a; --line-2: #5e6779;
  --text: #eceff4; --text-dim: #d8dee9; --text-faint: #8fbcbb;
  --ok: #a3be8c; --warn: #ebcb8b; --danger: #bf616a; --accent: #88c0d0; --magenta: #b48ead;
  --term-bg: #2e3440; --term-fg: #eceff4;
}
:root[data-theme="hi-contrast"] {
  --bg: #000000; --bg-warm: #0a0a0a; --panel: #111111; --panel-2: #1a1a1a;
  --line: #ffff00; --line-2: #ffff00;
  --text: #ffff00; --text-dim: #ffee44; --text-faint: #ccaa00;
  --ok: #00ff00; --warn: #ffaa00; --danger: #ff0033; --accent: #00ffff; --magenta: #ff66ff;
  --term-bg: #000000; --term-fg: #ffff00;
}
```

**Terminal ANSI palette per theme.** Current `new Terminal({...})` in app.js sets a full 16-color ANSI palette hard-coded for dark theme. Theme switch needs to update ALL 16 ANSI colors, not just background/foreground — otherwise red/green/yellow/blue text in claude output looks wrong on light/solarized/nord/hi-contrast themes.

Extend each theme block with terminal-specific vars:
```css
:root[data-theme="dark"] {
  --term-bg: #0a0a0c; --term-fg: #e8e6e1;
  --term-black: #16161e; --term-red: #ff4d5e; --term-green: #5cf08c; --term-yellow: #ffb547;
  --term-blue: #6fd5ff; --term-magenta: #ff79c6; --term-cyan: #88c0d0; --term-white: #c0c0c0;
  --term-br-black: #555555; --term-br-red: #ff8088; --term-br-green: #88ffaa; --term-br-yellow: #ffd07a;
  --term-br-blue: #aae6ff; --term-br-magenta: #ffaadd; --term-br-cyan: #aaeedd; --term-br-white: #ffffff;
}
/* light/solarized/nord/hi-contrast — same 16 keys, theme-appropriate values */
```

JS theme apply:
```js
function applyTheme(name) {
  document.documentElement.setAttribute('data-theme', name);
  localStorage.fleetTheme = name;
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
```

**xterm caveat (documented, accepted):** even with full palette swap, xterm.js 5+ canvas renderer caches rasterized cells per current colors. Theme change applies to NEXT rendered output, not retroactively for already-painted cells. UI hint: "theme applied — detach/reattach session for clean palette". This is the lesser-evil tradeoff vs full Terminal re-init (which loses scrollback).

Switcher: dropdown в header → `<select id="theme-select">` calls `applyTheme(value)` on change.

### 4.4 i18n hybrid

Files:
- `agent-fleet/web/i18n/en.json` (default, inline-loaded)
- `agent-fleet/web/i18n/ru.json`
- `agent-fleet/web/i18n/es.json`

JSON shape (flat keys with dots):
```json
{
  "nav.dashboard": "DASHBOARD",
  "nav.archive": "ARCHIVE",
  "nav.cost": "$ TRENDS",
  "nav.groups": "GROUPS",
  "nav.workflows": "WORKFLOWS",
  "nav.prices": "PRICES",
  "archive.title": "SESSION ARCHIVE",
  "archive.no_match": "{count} sessions match filter",
  "groups.add_label": "add label",
  ...
}
```

JS:

```js
let i18n = { lang: 'en', dict: {} };

async function loadLang(lang) {
  const res = await fetch(`/fleet/static/i18n/${lang}.json`);
  i18n.dict = await res.json();
  i18n.lang = lang;
  localStorage.fleetLang = lang;
  document.documentElement.setAttribute('data-lang', lang);
  applyI18n();
}

function t(key, vars) {
  let s = i18n.dict[key] || key;
  if (vars) for (const k in vars) s = s.replace(`{${k}}`, vars[k]);
  return s;
}

function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
}
```

HTML markup pattern:
```html
<button data-i18n="nav.archive">ARCHIVE</button>  <!-- fallback text for SSR/no-JS -->
<input data-i18n-placeholder="archive.search_placeholder" placeholder="search...">
```

Switcher: `<select id="lang-select"><option>en</option><option>ru</option><option>es</option></select>` → calls `loadLang(value)`.

**On boot:** `await loadLang(localStorage.fleetLang || 'en')` BEFORE first `applyI18n()` and before any page render — otherwise raw keys flash visible. Theme applies synchronously (CSS only) so no ordering concern there.

### 4.5 Dictionaries

Initial keys (~220-280 expected — realistic count from HTML audit):
- `nav.*` — 6 buttons
- `<page>.title` — 8 pages
- `<page>.*` — per-page labels, column headers, button text, empty states (~100 keys)
- `common.*` — save/cancel/edit/delete/close/loading/error/yes/no (~20 keys)
- `meta.*` — host metadata labels (os, arch, ram, cores, uptime, etc.) (~15)
- `status.*` — session statuses (running/pending/exited/killed/orphaned/idle) (~6)
- `error.*` — common error toasts (load_failed/save_failed/spawn_failed/auth_failed) (~10)
- `auth.*` — auth panel strings (engage/abort/unauthenticated/token-stored-note) (~6)
- `broadcast.*` — broadcast panel ("by tag instead") (~4)
- `workflow.node.*` — claude/branch/delay (~3)
- `prices.*` — pattern/priority/valid_from/input/output/cache_create/cache_read/flag (~10)
- `inventory.*` — Skills/MCP servers/Settings tab labels + table headers (~10)
- `session_detail.*` — transcript/timeline tab labels (~6)
- `cost.*` — group by/days/legend/overlaps-note (~8)

Will inventory exact list during Phase 1 step 3.

## 5. Phase 2 (UX fixes)

### 5.1 Host detail — tag inheritance

Current `agent-fleet/web/app.js renderHostDetail` shows tags + groups. Changes:
- **Remove**: `hd-group-select` dropdown (line ~639 — "add to group" select)
- **Add**: new chip-row "INHERITED" listing tags from each group member with `[from: groupname]` attribution

API: GET `/fleet/hosts/:id` already returns `inherited_labels` (since prior commit `f3c7dc4`). Render:

```js
// in renderHostDetail
const ih = $('hd-inherited');
const inherited = h.inherited_labels || {}; // {groupName: [labels...]}
ih.innerHTML = '';
for (const [grp, labels] of Object.entries(inherited)) {
  for (const l of labels) {
    const chip = document.createElement('span');
    chip.className = 'chip chip-inherited';
    chip.innerHTML = `${esc(l)} <span class="chip-source">[from: ${esc(grp)}]</span>`;
    ih.appendChild(chip);
  }
}
```

HTML: new `<section><h4>INHERITED</h4><div id="hd-inherited" class="chip-row"></div></section>` (read-only).

### 5.2 Editable groups

Current `openGroupDetail` allows label add/remove + host add/remove. Add:
- **Name** edit: `<input id="gd-name" value="...">` at top of modal body, onblur PATCH if changed (uniqueness check against state.groups before send)
- **Color** edit: `<input type="color" id="gd-color">` next to name
- **Description** edit: `<input id="gd-desc">` below

Server endpoint `PATCH /fleet/groups/:id` already supports name/description/color/labels (verified in fleet-routes.js handlePatchGroup). **Bug to fix in same task**: `handlePatchGroup` (fleet-routes.js:518-524) catches errors generically — `e.code === '23505'` (duplicate name) leaks raw pg error. Add explicit branch returning 409 `{error:'name already exists'}` matching `handleCreateGroup`'s pattern.

UI validation: name uniqueness — check `state.groups.some(g => g.name === val && g.id !== current.id)` → if conflict, show error message + don't submit.

### 5.3 Archive — remove rerun

`agent-fleet/web/app.js:842` has `<button data-rerun=...>↻</button>` cell. Delete that cell + the wire-up at line 848-849 + `rerunSession()` function at 863-870. Adjust column count in thead.

### 5.4 Cost trends — groupBy=group

UI `index.html`:
```html
<select id="cv-groupby">
  <option value="model">model</option>
  <option value="host">host</option>
  <option value="label">label</option>
  <option value="group">group</option>  <!-- NEW -->
</select>
```

Backend `scripts/lib/fleet-cost.js timeline()`:
- Add branch `if (groupBy === 'group' && vaultPg) return timelineByGroup(...)`
- New `timelineByGroup(tokmonPg, vaultPg, days)` — similar to `timelineByLabel`, но resolves session_id → fleet_sessions.host_id → LEFT JOIN fleet_host_groups → group names. Use **LEFT JOIN** so hosts without group memberships emit a row with dim=`(ungrouped)` bucket — explicit and observable, NOT silently dropped. One session ran on host in N groups → emit N rows (one per group). Double-counting accepted.

PK on `fleet_host_groups(host_id, group_id)` covers the join — no extra index needed.

UI footer note in cost view when groupBy=group: `<span class="lbl">overlaps: hosts in multiple groups counted in each</span>`.

### 5.5 Prices — restyle to match groups

Compare current prices page (`#page-prices` table) vs groups page. Differences to align:
- Use same `archive-table` class (already does)
- Same button style/spacing for actions column
- Same chip style for flagged/priority markers
- Same header bar pattern (title + actions on right)

Mostly CSS audit + small markup tweaks. ~30 LOC CSS delta.

## 6. File layout

| File | Purpose | Status |
|------|---------|--------|
| `agent-fleet/web/themes.css` | 5 theme variable blocks | new |
| `agent-fleet/web/i18n/en.json` | English dictionary (~150 keys) | new |
| `agent-fleet/web/i18n/ru.json` | Russian dictionary | new |
| `agent-fleet/web/i18n/es.json` | Spanish dictionary | new |
| `agent-fleet/web/i18n.js` | t() + loadLang() + applyI18n() | new (~50 LOC) |
| `agent-fleet/web/theme.js` | applyTheme() + switcher wire | new (~30 LOC) |
| `agent-fleet/web/index.html` | Restructure (extract topbar+footer, rename overlays) | modify (big) |
| `agent-fleet/web/app.js` | setPage() helper, applyRoute() refactor, host-detail tag inheritance, remove rerun, editable groups, cost groupBy | modify (~200 LOC) |
| `agent-fleet/web/app.css` | Drop position:fixed for pages, page styles, chip-inherited | modify (~50 LOC) |
| `agent-fleet/web/prices.js` | Style consistency tweaks | modify (~10 LOC) |
| `scripts/lib/fleet-cost.js` | timelineByGroup() function | modify (~40 LOC) |
| `scripts/lib/fleet-cost.test.js` | Test for groupBy=group | modify |
| `scripts/lib/fleet-routes.js` | Wire groupBy=group through to timeline | modify (~5 LOC) |
| `scripts/lib/fleet-static.js` | Serve `.json` mime + i18n directory | modify (~3 LOC) |

Realistic total ~1500 LOC new + ~600 modified ≈ **~2100 LOC**. i18n migration alone is ~250 keys × 3 langs = ~750 JSON entries + ~250 `data-i18n` HTML attribute touches + applyI18n call sites in 15+ render functions. HTML restructure essentially rewrites index.html (468 lines). Each theme block extended for full ANSI = 25 LOC × 5 = 125 LOC themes.css.

## 7. Phase ordering

**Phase 1 (foundation, low-visible-value but invasive):**
1. fleet-static.js: add `.json` mime
2. themes.css + theme.js + switcher in topbar; verify dark unchanged + light works
3. i18n.js + en.json (current strings) + applyI18n on boot
4. HTML restructure: topbar/footer to body, rename overlays to `.page` divs, drop position:fixed
5. applyRoute() refactor — setPage() API
6. Deploy → verify no regression

**Phase 2 (UX fixes, user-visible value):**
7. Remove archive rerun button
8. Host detail — drop add-to-group, add inherited row
9. Editable groups — name/color/description in modal
10. Prices restyle
11. Cost timelineByGroup (backend + UI)
12. Add ru.json + es.json (translation pass)
13. Add solarized + nord + hi-contrast themes
14. Deploy + e2e verify

Each phase deploys independently. Phase 2 can ship without 12-13 if translations not yet ready (default falls back to en).

## 8. Failure modes

| Scenario | Behaviour |
|----------|-----------|
| `/fleet/static/i18n/ru.json` 404 | t() returns key as fallback (e.g. "nav.archive"), warning in console |
| Theme name unknown in localStorage | Default to "dark" |
| Color picker outputs invalid hex | Server validates `/^#[0-9a-f]{6}$/i`, returns 422 on PATCH |
| Group name uniqueness conflict | Client-side check before PATCH; if server still rejects (race) → toast error |
| xterm theme switch on running session | Accept "partial repaint" — old cells keep old colors. Document. |
| Cost groupBy=group with no hosts in any group | Sessions appear in `(ungrouped)` bucket (LEFT JOIN), never silent drop |
| Theme/lang mismatch at boot (lang fetch in flight when render starts) | `await loadLang` before first paint — accept ~100ms boot delay |
| Stale `localStorage.fleetTheme = 'tactical'` (old name) | applyTheme validates name against allowed list; unknown → fallback 'dark' |
| Existing terminal session, user switches theme | Theme applies to next pty_data only; old cells keep old palette. UI hint shown |

## 9. Out-of-scope (v2)

- More than 3 languages
- Per-user theme/lang preferences (currently single global per browser)
- RTL support (Arabic, Hebrew)
- Translation management workflow (no Crowdin etc — manually editable JSON)
- Theme creator/customizer UI
- Settings page (theme/lang switchers live in header, no dedicated page)

## 10. Success criteria

1. Switching theme в dropdown — мгновенный visual update без перезагрузки страницы.
2. Switching lang в dropdown — все nav/page-headers/buttons обновляются (no reload).
3. Reload page — saved theme + lang restore from localStorage.
4. Все 8 страниц рендерятся корректно (no overflow, no position:fixed quirks).
5. Host detail: tags + groups + inherited rows показывают разделение направильно. Inherited tag показан с "[from: groupname]".
6. Group detail: edit name/color/labels works; rename triggers uniqueness check.
7. Archive: rerun button отсутствует.
8. Cost view: `groupBy=group` показывает stacked-bar по группам + note об overlaps.
9. Prices page: визуально match groups page (same table/chip style).
10. EN/RU/ES translations: смена языка корректно переводит все user-facing labels.

## 11. Open questions for user review

A. **Switcher placement**: lang+theme dropdowns в header right corner (рядом). OR в footer left side. Default: header right.

B. **Default theme**: dark (current). User can switch — saved in localStorage. OK?

C. **Translation completeness**: ship Phase 2 даже если ru.json / es.json неполные? Default: yes, fallback to en for missing keys. UI shows raw key only in dev mode.

D. **Switcher format**: native `<select>` или fancy dropdown? Native is accessible + 0 LOC; fancy is themeable. Default: native.
