# Fleet daemon: replace PTY/xterm.js terminal UI with structured chat-UI

**Date:** 2026-05-18
**Status:** Brainstormed, two architect-agent review passes folded in
**Supersedes:** None (tmux/mux feature already reverted in commits `fe8e1f3`, `41bf516`, `1d8091f`, `07f2ef9`)
**Epic:** new (to be filed)

---

## Goal

Replace the fleet web-SPA's terminal-emulator view (xterm.js + PTY-relay frames) with a chat-style UI that renders Claude Code's `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl` event stream as structured message bubbles. Outcome: fewer freeze bugs (no xterm cursor / ANSI parsing surprises), structured assistant / user / tool_use / tool_result rendering with model + token metadata, future-proof against terminal-width / colour issues.

## Non-goals

- Attach to locally-launched (non-fleet-spawned) claude sessions. Spawn-only.
- Cross-CLI generalisation. Only Claude Code is targeted; other backends (codex/opencode/hermes) keep current PTY relay.
- Build a transcript archiver. JSONL files on disk are authoritative; hub does not duplicate them.
- Eliminate xterm.js entirely. **xterm.js is kept as a "Raw terminal" tab permanently** because Claude Code 2.1.143's `--permission-prompt-tool` flag only works in `-p` headless mode, not interactive. The chat-UI is the default tab; the raw-terminal tab is the fallback for permission prompts and any ANSI-rendered UI moments Ink owns.

## Architecture (steady state, end of Phase 2)

```
┌───────────────────────────────────────────────────────────────────────┐
│  Browser SPA (agent-fleet/web/)                                       │
│                                                                        │
│   chat-view.js   (NEW) — DEFAULT tab                                  │
│   ├─ MessageBubble       (user / assistant text)                      │
│   ├─ ToolCallCard        (collapsible: name + args + tool_result)     │
│   ├─ SubagentBlock       (nested collapsible for isSidechain turns)   │
│   ├─ SystemNotice        (permission-mode change, errors, exits)      │
│   ├─ CompactBoundary     (visual divider on compact_boundary frame)   │
│   ├─ ThinkingBlock       (collapsed icon + token count, opt-in)       │
│   └─ Composer            (textbox + slash autocomplete + toolbar)     │
│                                                                        │
│   raw-terminal tab — existing xterm.js view, kept for                 │
│                      permission prompts and edge cases.               │
│   SPA only subscribes to `pty_data` while raw-terminal tab is active. │
└───────────────────────────────────────────────────────────────────────┘
                              ▲ WS frames                ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Hub (scripts/lib/fleet-routes.js)                                    │
│                                                                        │
│   New frame dispatch cases (claude_msg, compact_boundary,             │
│   session_lifecycle, slash_inventory, replay_request, replay_batch).  │
│   Existing pty_data / reconciliation / pty_gap relay kept intact.     │
└───────────────────────────────────────────────────────────────────────┘
                              ▲ WS frames
┌───────────────────────────────────────────────────────────────────────┐
│  Daemon (agent-fleet/daemon/src/)                                     │
│                                                                        │
│   pty-manager.js     spawn claude in node-pty; stdin in Phase 2 uses  │
│                      bracketed-paste wrap                              │
│   jsonl-path.js      (NEW) cwd → ~/.claude/projects/<enc>/<sid>.jsonl │
│   jsonl-tailer.js    (NEW) fs.watch + open-on-create + tail with      │
│                      byte-offset cursor → parse → emit claude_msg     │
│                      + compact_boundary + session_lifecycle frames     │
│   subagent-tailer.js (NEW) discovers <sid>/subagents/<sub>.jsonl      │
│                      sidecars, tails each, tags isSidechain=true      │
│   stdin-bridge.js    (NEW, Phase 2) send_text frame → bracketed-paste │
│                      wrap → pty.write                                  │
│   control-bridge.js  (NEW, Phase 2) control frame → \x03 / SIGTERM /  │
│                      \e\e mapping                                      │
│   session-store.js   extended: persists per-session byte-offset       │
│                      cursor across daemon restart                      │
└───────────────────────────────────────────────────────────────────────┘
```

## Frame schemas

### Daemon → viewer (via hub)

```js
// One per jsonl line of UI interest.
// IMPORTANT: pass-through by default. The `raw` field carries the full
// jsonl line so the SPA never silently drops fields. `extracted` is a
// convenience normalized view for the common case.
{
  type: "claude_msg",
  session_id: "<fleet uuid>",       // stable across compact
  jsonl_sid: "<claude session uuid>",
  seq: 12450,                        // byte-offset in jsonl (durable)
  ts: "2026-05-18T12:00:00.000Z",
  raw: { /* full parsed jsonl line, every field preserved */ },
  extracted: {
    role: "assistant" | "user" | "system",
    is_sidechain: false,             // true for Task-tool subagent turns
    parent_uuid: "<uuid>" | null,    // for tool_use → tool_result threading
    uuid: "<uuid>",
    // Assistant-only:
    model: "claude-opus-4-7",
    text_blocks: [{ type: "text", text: "..." }],
    tool_uses: [{ id, name, input }],
    thinking_blocks: [{ text: "..." }],
    usage: { input_tokens, output_tokens, cache_read,
             cache_creation_5m, cache_creation_1h },
    stop_reason: "end_turn" | "tool_use" | "stop_sequence" | "max_tokens"
                 | null,
    // User-only:
    tool_results: [{ tool_use_id, content, truncated_at?, is_error? }],
    text_in: "...",                  // top-level user text (if any)
    // System-only:
    subtype: "compact_boundary" | "hook_event" | null,
    text: "..."
  }
}

// Compact event — same jsonl, different shape. Spec'd separately
// so the SPA can render a clear visual boundary.
{
  type: "compact_boundary",
  session_id, jsonl_sid,
  seq, ts,
  metadata: { trigger, preTokens, postTokens, durationMs }
}

{
  type: "session_lifecycle",
  session_id,
  state: "spawn" | "ready" | "exit" | "crash",
  code?, signal?,
  jsonl_path?  // included on `ready`
}

// One-shot on first daemon connect or claude_version change.
{
  type: "slash_inventory",
  commands: [{ name, description }]
}

{
  type: "replay_batch",
  session_id,
  from_offset, to_offset,
  is_last: bool,
  lines: [ <claude_msg payloads, possibly compact_boundary too> ]
}
```

### Viewer → daemon (via hub)

```js
{ type: "send_text", session_id, text }
// Always bracketed-paste wrapped + \n appended on daemon side.

{ type: "control", session_id, action: "stop" | "cancel" | "interrupt" }
// stop      → SIGTERM (kill session)
// cancel    → write "\e\e" (Ink cancel)
// interrupt → write "\x03" (Ctrl-C)

{ type: "replay_request", session_id, from_offset: 0, max_messages: 500 }
// Pagination by message count, not bytes (avoids the case where one
// 4 MB tool_result blows the budget). Daemon scans jsonl backwards
// from current_tailer_offset, collects up to max_messages claude_msg
// payloads, emits replay_batch(es).
```

## Phased delivery

The original draft proposed Phase 3 (MCP-driven permission UX → drop xterm). Architect review confirmed `--permission-prompt-tool` is `-p`-only in Claude Code 2.1.143, so Phase 3 is **not a delivery phase**. It is moved to "Future work" pending upstream support. The spec's deliverable scope is **Phase 1 + Phase 2 only**.

### Phase 1 — Read-only chat (xterm.js kept as "Raw terminal" tab)

Daemon work:
- `agent-fleet/daemon/src/jsonl-path.js` (~40 LOC): pure function `encodeProjectDir(cwd)` — applies `/` → `-` with leading `-`, after `fs.realpathSync` resolution. Exposes `expectedJsonlPath(cwd, sessionId)`.
- `agent-fleet/daemon/src/jsonl-tailer.js` (~250 LOC): per-session `JsonlTailer` class.
  - On construction: `fs.watch` on the encoded project dir; ready state = `waiting_for_file`.
  - On file-create event matching `<sessionId>.jsonl`: open with `fs.createReadStream` from offset 0, switch to `tailing` state.
  - On EOF: register `fs.watch` on the file itself (or fall back to 1s polling on platforms without inotify) → resume read on change.
  - Each complete line → `parseJsonlLine(line, byteOffset)` → emit `claude_msg` or `compact_boundary` frame via supplied `emit` callback.
  - Tracks `currentOffset` (bytes), persisted to session-store every 5s and on graceful shutdown.
- `agent-fleet/daemon/src/subagent-tailer.js` (~120 LOC): watches `<sid>/subagents/` sidecar dir, spawns sub-tailers, tags `is_sidechain: true` on each emitted frame.
- `agent-fleet/daemon/src/parsers/jsonl-parser.js` (~180 LOC): pure function. Takes one parsed JSON line, returns `{type:"claude_msg", raw, extracted}` or `{type:"compact_boundary", metadata}` or `null` (pass over `permission-mode` no-op repeats — only emit on actual mode change).
- `session-store.js` extended: `getOffset(sid)`, `setOffset(sid, offset)`.

Hub work:
- `scripts/lib/fleet-routes.js`: dispatch cases for `replay_request`, broadcast `claude_msg`, `compact_boundary`, `session_lifecycle`, `slash_inventory` to viewers attached to the session.
- No DB schema changes. Hub does not persist any new content.

SPA work:
- `agent-fleet/web/chat-view.js` (~500 LOC): chat renderer.
- `agent-fleet/web/app.js`: add chat tab (default), keep xterm as "Raw terminal" tab. Tab-gated subscription: chat tab consumes `claude_msg` / `compact_boundary` and ignores `pty_data`; raw tab consumes `pty_data` and ignores `claude_msg`. On tab switch, no re-request; both tabs receive frames in parallel, the inactive one buffers up to 1000 frames then drops oldest.

Acceptance (Phase 1):
- Spawn session via Dispatch → chat tab populates with assistant / user / tool cards within 2s of first jsonl line written.
- Reload page → `replay_request {from_offset:0, max_messages:500}` returns full transcript (or last 500 messages on very long sessions); chat re-renders.
- Daemon restart → tailer resumes from persisted offset; no double-emission, no skipped lines (verified by unit test using fixture jsonl).
- `/compact` event → chat shows a horizontal CompactBoundary divider with token-delta info; assistant turns before and after are still both visible.
- Task tool spawns subagent → SubagentBlock appears under the originating assistant message, collapsible.

### Phase 2 — Interactive composer (bracketed paste)

Daemon work:
- `agent-fleet/daemon/src/stdin-bridge.js` (~60 LOC): `writePrompt(text)` wraps `\e[200~` + text + `\e[201~` + `\n`, calls `pty.write`. Bracketed-paste prevents Ink's line editor from submitting on embedded `\n`.
- `agent-fleet/daemon/src/control-bridge.js` (~50 LOC): maps `control` frame action → `pty.write("\x03")` / `pty.kill("SIGTERM")` / `pty.write("\e\e")`.
- `agent-fleet/daemon/src/busy-state.js` (~80 LOC): per-session state machine. Inputs = parsed jsonl lines. Outputs `busy: true | false`.
  - Rule: `busy = true` unless the most recent claude_msg satisfies BOTH `role:"assistant"` AND `stop_reason ∈ {"end_turn", "stop_sequence", "max_tokens"}` AND no subsequent user/tool_result line has been seen.
  - Emits `session_busy {session_id, busy}` frame on transitions only (no spam).
  - Initial state on new session = `busy: true` (claude is starting up).
- `agent-fleet/daemon/src/slash-inventory.js` (~70 LOC): on first daemon WS connect, runs `claude /help --print` once, parses, caches; emits `slash_inventory` frame to hub. Cached output keyed by `claude_version`; refresh if version changes. Fallback hardcoded list of ~12 common slash commands if exec fails.

Hub work:
- Forward `send_text` / `control` from viewer to the daemon owning the session.
- No new schema.

SPA work:
- Composer textbox in `chat-view.js`. Disabled when `busy=true` with banner "Claude is working — Stop / Interrupt to break in".
- Slash autocomplete: type `/` → dropdown shows entries from latest `slash_inventory`.
- Toolbar buttons: Stop / Cancel / Interrupt → `control` frame.
- Echo: viewer A sends `send_text` → daemon writes to PTY → Claude Code writes the user turn to jsonl → daemon emits `claude_msg {role:"user"}` → all viewers (including A) render it. No optimistic-echo before the jsonl confirms (avoids divergent state on send failures).

Acceptance (Phase 2):
- Multi-line markdown prompt with code fence pasted into composer → claude receives it as a single message.
- During tool execution, composer is disabled; clicking Stop kills session; Interrupt cancels current tool.
- Viewer A types → Viewer B sees the user turn appear synchronously (within Claude's jsonl write latency, typically <100ms).
- Slash dropdown surfaces all of claude's slash commands. Typing `/me` filters to `/memory` etc.
- Permission prompt scenarios (e.g. `Bash` without `--dangerously-skip-permissions`): chat tab shows a SystemNotice "Permission required — switch to Raw terminal to approve". xterm tab handles approval via Ink's normal `y/n`.

### Future (not in this spec) — MCP-driven permission UX

Blocked on Claude Code adding `--permission-prompt-tool` support to interactive mode, OR fleet adopting a `claude -p`-driven backend (would be a separate design). When that path opens, a follow-up spec can add the MCP server and drop xterm. Until then, the raw-terminal tab is the steady-state permission UX.

## Cross-phase invariants

- **seq = jsonl byte-offset.** Durable across daemon restart, deterministic replay. Viewer keeps `last_offset` per session; on reconnect sends `replay_request {from_offset: last_offset, max_messages: 500}`.
- **jsonl path discovery.** `jsonl-path.js#expectedJsonlPath(cwd, sessionId)` is computed from the same cwd value passed to `pty.spawn` (after symlink resolution). `fs.watch` on the parent project dir; the jsonl file is created by Claude Code only on first user message or hook event, so tailer starts in `waiting_for_file` state — a `replay_request` arriving before file create returns `replay_batch {lines:[], is_last:true}` (not an error).
- **No `session_rotated`.** `/compact` and `/clear` stay in the same jsonl. They emit `system / subtype:"compact_boundary"` events with `compactMetadata`. Daemon converts those into `compact_boundary` frames and keeps tailing the same file. Byte-offset cursor remains monotonic.
- **Replay/live cutover.** Single tailer owns the byte-offset cursor. On `replay_request`, the tailer pauses live emission, reads from `from_offset` to `currentOffset`, emits `replay_batch`(es) until `is_last:true`, then resumes live emission. A sequence guard rejects any incoming jsonl-line append that arrives during the replay window (those bytes are captured by the post-replay tail read, not double-emitted).
- **`permission-mode` filter.** The sample has ~1,368 `permission-mode` lines, almost all `default→default`. Daemon emits a frame only on actual mode change.
- **Multi-viewer send echo.** No client-side optimistic echo. The authoritative echo is the `claude_msg {role:"user"}` produced from jsonl after `pty.write` succeeds. Latency expected <100ms (jsonl flush + tailer roundtrip); spec allows up to 1s before showing a "send pending" indicator.
- **Sidechain rendering.** `extracted.is_sidechain:true` → SPA renders inside a nested SubagentBlock keyed by `extracted.parent_uuid`. The main thread shows a collapsed "Task subagent (N turns)" placeholder; expanding it reveals the subagent's chat in-line.
- **Size caps.** `tool_result.content` truncated at 16 KB inside `extracted`; the `raw` field always carries the full untruncated value (raw is what goes over the wire so size cap is on the entire frame body, not per-field). Replay paginated by message count (default 500) — "load older" button hits `replay_request {from_offset: oldest_visible_offset, max_messages: 500}`.

## File boundaries (estimated)

| File | Status | LOC | Purpose |
|---|---|---|---|
| `agent-fleet/daemon/src/jsonl-path.js` | NEW | ~40 | cwd → jsonl path encoder |
| `agent-fleet/daemon/src/jsonl-tailer.js` | NEW | ~250 | per-session tailer with offset cursor |
| `agent-fleet/daemon/src/subagent-tailer.js` | NEW | ~120 | sidecar subagent jsonl tailers |
| `agent-fleet/daemon/src/parsers/jsonl-parser.js` | NEW | ~180 | line → claude_msg / compact_boundary / null |
| `agent-fleet/daemon/src/stdin-bridge.js` | NEW (Phase 2) | ~60 | bracketed-paste stdin |
| `agent-fleet/daemon/src/control-bridge.js` | NEW (Phase 2) | ~50 | control frame → PTY signals |
| `agent-fleet/daemon/src/busy-state.js` | NEW (Phase 2) | ~80 | composer enable/disable derivation |
| `agent-fleet/daemon/src/slash-inventory.js` | NEW (Phase 2) | ~70 | `/help` parse + cache |
| `agent-fleet/daemon/src/session-store.js` | EDIT | +20 | persist offset cursor |
| `agent-fleet/daemon/src/ws-client.js` | EDIT | +60 | wire tailers + bridges |
| `agent-fleet/web/chat-view.js` | NEW | ~500 | chat renderer + cards + composer |
| `agent-fleet/web/app.js` | EDIT | +80 | new tab, tab-gated subscription |
| `scripts/lib/fleet-routes.js` | EDIT | +60 | dispatch new frames |

Net new LOC (both phases): ~1,500. No deletions in this spec's scope (xterm + PTY relay stay).

## Testing strategy

- **Unit (daemon):** Fixture jsonl files under `tests/fixtures/jsonl/`: `simple-session.jsonl`, `with-tool-uses.jsonl`, `with-subagent.jsonl`, `compact-mid-session.jsonl`, `large-tool-result.jsonl`. Parser tests assert correct `extracted` shape for each. Tailer tests cover: empty file, partial-line tail, offset cursor durability across simulated restart, compact_boundary emission, subagent sidecar discovery.
- **Unit (hub):** New frame types dispatch + broadcast; replay_request invokes daemon and forwards `replay_batch` to requesting viewer only.
- **E2E:** `tests/e2e/specs/chat-view.spec.js`.
  - Phase 1: spawn a session via Dispatch → assert at least one MessageBubble appears within 5s; reload page → assert chat content restored.
  - Phase 2: type multi-line composer prompt with code fence → assert single user-turn bubble appears (not many short ones); Stop button kills session.
- **Manual:** real session walk-through covering /compact, /clear, Task subagent, network drop + reconnect, very-long tool_result.

## Risks & open questions

- **Claude Code jsonl schema is undocumented and version-pinned.** Sample uses `version:"2.1.141"`. Future minor releases may add or rename fields. Mitigation: `raw` pass-through preserves everything; SPA's `extracted` consumer falls back to "unsupported" placeholder on unknown subtypes.
- **`fs.watch` reliability.** Linux inotify is solid; macOS FSEvents has known latency / coalescing quirks. Mitigation: fallback to 1s polling if `fs.watch` does not fire within 10s of an expected event (e.g. PTY produces output but no jsonl line emitted). Polling never replaces the watch — both run, deduped by offset.
- **`fs.watch` on a 25 MB file with active append.** Node's watcher fires on every write; we read incrementally from `currentOffset`. Expected fine but worth a benchmark in Phase 1 acceptance.
- **`claude /help --print` reliability.** If claude requires login interactivity or fails the first time, `slash_inventory` falls back to a hardcoded list with `staleness: true` flag in the frame; SPA shows a non-blocking warning.
- **Backwards compatibility with non-Claude backends.** The new frames are claude-specific. For codex/opencode/hermes sessions, daemon does not start a jsonl-tailer — those sessions remain xterm-only on the raw-terminal tab. The chat-view checks `extracted` presence and shows "This backend does not support chat view" placeholder when absent. Backend detection: daemon emits `session_lifecycle {state:"ready", chat_supported: bool}`.

## Open tasks (to file after spec approval)

- vt-EPIC: fleet chat-UI replacement (chat default, xterm fallback)
- vt-P1A: jsonl-path + jsonl-parser + jsonl-tailer + session-store offset cursor (Phase 1 daemon foundation)
- vt-P1B: chat-view + app.js tab wiring + new frame dispatchers in hub (Phase 1 hub + SPA)
- vt-P1C: subagent-tailer + SubagentBlock rendering (Phase 1 subagent support)
- vt-P1D: replay_request + replay_batch end-to-end with pagination (Phase 1 history)
- vt-P2A: stdin-bridge + bracketed-paste + control-bridge (Phase 2 daemon)
- vt-P2B: busy-state + composer disable + slash-inventory (Phase 2 UX)
- vt-FUTURE: MCP permission tool when upstream lands interactive support

Each P1*/P2* gets its own implementation plan via `superpowers:writing-plans`.
