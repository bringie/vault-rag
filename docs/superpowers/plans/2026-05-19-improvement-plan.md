---
type: plan
status: ready
epic: vt-0431
date: 2026-05-19
scope: agent-fleet batch vt-0430..0439
---

# Agent-Fleet Improvement Plan — 2026-05-19

Review of commits d98ae18..11a52fd (12 commits, vt-0430 through vt-0439).
Three lenses: ARCHITECTURE, INFORMATION SECURITY, LOGIC/EDGE CASES.

---

## 1. Findings

### ARCHITECTURE

```
[MED] ARCH  sql/032 — category is free-text with no FK; inconsistent spellings
            ('engineering' vs 'Engineering') silently split the folder tree.
            Fix: add fleet_agent_role_categories lookup table + FK, or at minimum
            a CHECK constraint with a normalise-to-lowercase trigger.

[MED] ARCH  sql/033-agency-agents-seed.sql — 2.5 MB inline SQL with no version
            stamp or checksum. Re-running the seed on a live DB that already has
            edits will be blocked by the ON CONFLICT lower(name) guard, but
            deletions or renames in the upstream catalog will never propagate.
            Fix: store source commit hash as a column (source_ref), add a seed
            version table, and document a git-diff → re-seed workflow.

[NIT] ARCH  fleet-db.js:listAgentRolesSummary — require('node:crypto') is called
            inside the function body on every invocation. Move to module-top-level
            (line 565 area). No correctness bug; minor allocation noise.

[NIT] ARCH  chat-view.js wrapping inventory — four distinct wrapping mechanisms
            exist (cv-msg, cv-chain, cv-tool, cv-tools-group-legacy?). After
            vt-0430 the cv-tools-group (per-turn <details>) was removed in favour
            of cv-chain. Verify no dead CSS selector `.cv-tools-group` remains in
            chat-view.css that now matches nothing (found: .cv-tool-group selector
            in chat-view.css — confirm it is used by the new chain path or remove).

[MED] ARCH  _systemDedup Set (chat-view.js:49,1142,1172) — cleared correctly in
            attach() and detach(). Edge: rapid successive attach() calls on the
            same mount point (session switch) are fine because attach() always
            allocates `new Set()`. No collision risk between sessions. VERIFIED OK.
```

### INFORMATION SECURITY

```
[CRIT] SEC  chat-view.js:116 — linkify builds `<a href="${url}">` by string
            interpolation. URL_RE anchors to https?:// so javascript:/data:/
            file: are excluded — BUT the regex does not strip HTML attribute
            special chars from the URL itself. An URL ending in `"` or containing
            `"` would break out of the href="..." attribute. Example:
              https://x.com/path?a=b"onclick=alert(1)//
            URL_RE accepts this (it stops at whitespace/backtick only, not `"`).
            esc() was already called on the full text before linkify runs, so any
            literal `"` in the source text is already `&quot;`. HOWEVER: the regex
            runs on the HTML-escaped string, so it ALSO matches and re-wraps URLs
            that were inside already-escaped attribute values (unlikely in normal
            chat but possible if the upstream content itself contained HTML).
            Fix: also URL-encode the matched URL via encodeURI before inserting
            into href, OR wrap the captured url through escapeHtml() inside the
            replacement callback. Low-exploitation-surface (requires crafted
            Claude output), but correctness matters.

[MED]  SEC  chat-view.js:116 — rel="noopener noreferrer" IS present. target=_blank
            IS present. VERIFIED OK.

[NIT]  SEC  chat-view.js:108/112 — sentinel collision: if the input text
            literally contains \x00FENCE0\x00 or \x00TICK0\x00, the restore pass
            will replace that text with the first stashed fence/tick body. Trivial
            to trigger only if Claude outputs NUL bytes in its text (unusual).
            Fix: use a collision-resistant sentinel, e.g.
            \x00FENCE\x00<uuid>\x00 or check that sentinels don't appear in html
            before stashing. Low real-world risk; worth a TODO comment.

[MED]  SEC  fleet/agent-roles.js:49 — category regex `/^[a-z0-9_-]*$/i` allows
            empty string ("" passes `*` quantifier). The API-layer check is:
              b.category !== undefined && b.category !== null && (... !/^[a-z0-9_-]*$/i.test(...))
            So `category: ""` is NOT rejected at the API boundary. fleet-db.js
            updateAgentRole (line 609) normalises null/blank to 'general', and
            createAgentRole defaults to 'general' (line 598). So empty string is
            harmlessly stored as 'general'. RISK: if the normalisation is ever
            removed, empty strings hit the DB. Fix: change regex to `^[a-z0-9_-]+$`
            (one or more) and treat "" as "omitted" (use 'general').

[MED]  SEC  sql/033-agency-agents-seed.sql:47428 — one prompt (Security Test
            Engineer role) contains literal SQL-injection test strings
            (`'; DROP TABLE users; --`). These are inside dollar-quoted prompt
            bodies and will be stored as plain text, NOT executed. Parameterised
            INSERT is used. The stored prompt text is returned to Claude as
            system_prompt at spawn time. A security-test-agent role whose prompt
            teaches SQL injection best practices is legitimate. RISK: if that role
            is applied to a session running against a DB-connected agent, the agent
            may exhibit test-injection behaviour. Document this in role description.

[NIT]  SEC  fleet/agent-roles.js — category input in the modal uses esc() before
            inserting into innerHTML (line 139 in agent-roles.js). VERIFIED OK.

[MED]  SEC  app.js:866 — spawn-group resolution compares
            `state.groups.find(g => g.name === groupNameInput)`.
            fleet_groups.name has a UNIQUE NOT NULL constraint (sql/007). So no
            two active groups share a name. VERIFIED OK for ambiguity concern.
            NEW ISSUE: state.groups is populated at loadGroups() time. If a group
            is created between the last loadGroups() and the spawn click, the
            operator sees "not found" but the group exists on the server. Fix: on
            "not found" alert, offer a "refresh groups and retry" button instead of
            hard-stopping.
```

### LOGIC / EDGE CASES

```
[MED]  LOGIC chat-view.js:616 — closesChain predicate:
             !(ex.tool_uses || []).length
             When ex.tool_uses is undefined, (undefined || []).length === 0 → true.
             When ex.tool_uses is [], [].length === 0 → true.
             Both correctly signal "no queued tool calls". VERIFIED OK.

[CRIT] LOGIC fleet-routes.js:1007-1011 — reconciliation sweep when mentionedIds
             is empty:
               id NOT IN (NULL)
             In SQL, `x NOT IN (NULL)` is always NULL (unknown), never TRUE.
             So the WHERE clause returns NO rows — orphaned sessions on a host
             whose daemon reports an EMPTY session list are NOT swept.
             Intent comment says "empty list means daemon has nothing" but that
             interpretation means a daemon that restarts with zero sessions leaves
             all DB orphans permanently until the periodic reaper fires.
             Fix:
               mentionedIds.size
                 ? [...mentionedIds].map(...).join(',')
                 : 'SELECT id FROM fleet_sessions WHERE FALSE'
             Or skip the sweep entirely when mentionedIds.size === 0 and rely on
             reapStuckSessions() (the reaper interval already handles this case
             correctly via ended_at < now() - 1h logic).

[MED]  LOGIC fleet-db.js:362-378 — reapStuckSessions vt-0439 branch:
             WHERE s.status = 'orphaned'
               AND (h.last_seen > now() - interval '5 minutes'
                    OR s.ended_at < now() - interval '1 hour')
             markSessionExited sets ended_at = now() when transitioning to
             'orphaned'. So a session orphaned 5 minutes ago has ended_at ~ now,
             which does NOT satisfy ended_at < 1h ago. The only way it gets
             promoted to 'exited' is if h.last_seen > now() - 5min (host is
             back online). This is correct — the reaper only promotes to exited
             when the host either came back (so the daemon would have reconciled)
             or has been gone for 1h+ (definitive). VERIFIED OK for happy path.
             EDGE: if ended_at was set by a prior orphaning pass (not the most
             recent one), a host that stays offline for exactly 59 min and then
             cycles back offline will not be swept by the age branch. Cosmetic,
             not a correctness issue.

[MED]  LOGIC fleet-routes.js:997-1022 — race window between daemon disconnect
             (markSessionExited → 'orphaned') and reconnect + reconciliation.
             Viewer that attaches between those two events sees status='orphaned'
             in the session list. On the next reconciliation frame (within seconds
             of daemon reconnect), the sweep or the alive-branch of the
             reconciliation loop will correct the status. Window is bounded by
             the daemon reconnect + reconciliation latency (typically < 5s).
             RISK: viewer refreshes mid-window and shows a "dead" session that
             is actually running. This is a UX concern (stale status badge), not
             a data-loss bug. Mitigated by the session list auto-refresh interval.

[NIT]  LOGIC agent-roles.js:59-61 — arOpenCats in localStorage persists stale
             category names. If a seed re-run changes a category slug (e.g.
             'game-development' → 'gamedev'), the stored Set retains the old
             name forever; the folder starts collapsed. Harmless; fix in a
             future cleanup pass: prune arOpenCats entries not in sortedCats
             after loadRoles().

[NIT]  LOGIC app.js — Ctrl+A check (chat-view.js:976-987) guards via
             `composer.contains(e.target)`. Edge: when the slash dropdown has
             focus (it's appended to `composer`), Ctrl+A fires the page-select
             path because the dropdown item is inside `composer` →
             `composer.contains(e.target)` returns TRUE → early return → native
             textarea Ctrl+A in the dropdown item context. Actually correct —
             that means the GUARD fires (early return) and the custom select-all
             does NOT run. VERIFIED OK.
```

---

## 2. Improvement Plan

### P1 — Fix NOT IN (NULL) reconciliation bug
**Effort:** S (< 1h)
**Risk if not done:** Daemon restarts with zero sessions leave all orphaned rows stuck until
the 3-minute periodic reaper. Operators see ghost sessions in the active list.
**Fix:** Change `'NULL'` fallback to `'SELECT id FROM fleet_sessions WHERE FALSE'` or short-circuit
the sweep when `mentionedIds.size === 0`.
**vt task:** `vt create -t bug -p 1 "reconcile sweep: NOT IN (NULL) never matches — skip or use FALSE subquery"`

### P2 — linkify href injection hardening
**Effort:** S (30 min)
**Risk if not done:** Crafted Claude output containing `"` in a URL context (post-HTML-escaping,
extremely low probability) could break out of the href attribute in a browser rendering an
un-sanitized innerHTML path. Defense-in-depth fix.
**Fix:** Wrap the URL capture in `encodeURI()` inside the replacement callback in `renderMarkdown`.
**vt task:** `vt create -t bug -p 2 "linkify: encodeURI href before inserting into innerHTML"`

### P3 — category FK / normalisation
**Effort:** M (migration + validation update)
**Risk if not done:** Free-text categories diverge silently ('Engineering' vs 'engineering'
creates two folder nodes). Hard to fix after thousands of roles are in prod.
**Fix:** Either (a) add a `fleet_agent_role_categories` table + FK, or (b) add a DB-level
CHECK constraint `category ~ '^[a-z0-9_-]+$'` and a BEFORE INSERT/UPDATE trigger that
lowercases. The category regex in fleet/agent-roles.js already passes /i but stores the
original case — server should normalise to lower before write.
**vt task:** `vt create -t task -p 2 "agent-roles category: normalise to lowercase + unique constraint"`

### P4 — Seed catalog versioning
**Effort:** M
**Risk if not done:** No way to apply upstream agency-agents catalog updates without a full
re-seed that overwrites operator edits. Source integrity is also unverified.
**Fix:** (a) Add `source_ref text` column to fleet_agent_roles. (b) Stamp each seeded row with
the git commit SHA from the header comment. (c) Write a `scripts/bin/reseed-agent-roles.sh`
that diffs by source_ref and applies only changed/added rows. (d) Document update cadence.
**vt task:** `vt create -t task -p 3 "seed catalog: source_ref column + incremental reseed script"`

### P5 — Category regex: require at least one char
**Effort:** S (10 min)
**Risk if not done:** `category: ""` slips past validation and relies on the DB-layer default
to save it as 'general'. If the normalisation is removed, empty strings hit the DB.
**Fix:** Change `*` to `+` in `^[a-z0-9_-]*$` in fleet/agent-roles.js (both POST and PATCH paths).
**vt task:** `vt create -t bug -p 3 "agent-roles: category regex allows empty string — use + quantifier"`

### P6 — Spawn-group stale-group UX
**Effort:** S
**Risk if not done:** Operator gets a hard "not found" error when a group was created after
the last poll cycle. Friction in operational flows.
**Fix:** On group-not-found in spawn handler, call `loadGroups()` and retry the lookup once
before alerting. If still not found, alert with clearer message.
**vt task:** `vt create -t task -p 4 "spawn: stale group list — auto-refresh on not-found before alerting"`

### P7 — arOpenCats stale key pruning
**Effort:** S (5 min)
**Risk if not done:** Renamed category slugs leave a Set entry that keeps the folder collapsed
on next load, confusing the operator.
**Fix:** After building `sortedCats` in loadRoles(), filter `openCats` to only include keys
in `sortedCats` before rendering.
**vt task:** `vt create -t bug -p 5 "agent-roles: prune stale arOpenCats entries after category rename"`

### P8 — Sentinel NUL-byte collision
**Effort:** S
**Risk if not done:** If Claude outputs `\x00FENCE0\x00` literally (e.g. in a test about
null bytes), renderMarkdown substitutes the wrong body. Low real-world probability.
**Fix:** Use a UUID-per-call sentinel: `\x00FENCE-${Math.random().toString(36)}-\x00`. Or
document the known limitation.
**vt task:** `vt create -t bug -p 5 "renderMarkdown: sentinel collision on literal NUL byte input"`

---

## 3. Test Coverage Gaps

Priority order (highest coverage ROI first):

1. **cv-chain open/close logic** — zero e2e specs cover the chain wrapper. Need tests for:
   - Multi-turn tool-use chain collapses to single cv-chain
   - Chain closes on terminal assistant turn
   - Mixed text + tool_use turns inside chain
   - Chain with `tool_uses: undefined` vs `tool_uses: []` (edge from finding above)

2. **linkify safety** — no test for URLs with embedded special chars, URLs inside fenced
   code blocks, or URLs adjacent to HTML-escaped entities.

3. **reconciliation sweep** — no integration test for the NOT IN path. Need a test that:
   - Creates orphaned sessions on a host
   - Sends a reconciliation frame with `sessions: []`
   - Asserts orphaned rows are swept (currently they would NOT be, due to NOT IN NULL bug)

4. **category validation** — agent-roles.spec.js does not cover:
   - Empty string category (should default to 'general')
   - Mixed-case category normalisation
   - Category filter query param

5. **reapStuckSessions vt-0439 branch** — the orphaned→exited promotion path has no test.

6. **_systemDedup across rapid attach() calls** — verify the Set is properly reset and
   two back-to-back `attach()` calls on the same mount don't share dedup state.

7. **seed idempotency** — no test verifying that running sql/033 twice does not produce
   duplicate rows or update existing operator-edited rows.

---

## 4. Verdict

**hotfix-then-ship**

The batch is solid overall — the WCAG AA theme fixes, chain-collapse UX, orphan reaper,
and category filtering are all well-executed. Two issues need to be fixed before the next
production deploy:

- **CRIT LOGIC**: The `NOT IN (NULL)` reconciliation bug silently fails the orphan sweep
  when a daemon reconnects with zero sessions. Fix is a 3-line change.
- **CRIT SEC**: The linkify href interpolation should apply `encodeURI()` as defense-in-depth;
  exploitation requires crafted Claude output but the fix is trivial.

The remaining MED/NIT findings are improvements to harden over the following sprint.
