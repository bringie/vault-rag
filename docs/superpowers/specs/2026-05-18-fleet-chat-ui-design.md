# Fleet daemon: replace PTY/xterm.js terminal UI with structured chat-UI

**Date:** 2026-05-18
**Status:** Brainstormed, reviewed by architect agent (Plan/Opus), revised to phased plan
**Supersedes:** None (tmux/mux feature already reverted in commits `fe8e1f3`, `41bf516`, `1d8091f`, `07f2ef9`)
**Epic:** new (see Open tasks below)

---

## Goal

Replace the fleet web-SPA's terminal-emulator view (xterm.js + PTY-relay frames) with a chat-style UI that renders Claude Code's `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl` event stream as structured message bubbles. Outcome: fewer freeze bugs (no xterm cursor / ANSI parsing surprises), structured assistant / user / tool_use / tool_result rendering with model + token metadata, future-proof against terminal-width / colour issues.

## Non-goals

- Attach to locally-launched (non-fleet-spawned) claude sessions. Spawn-only.
- Cross-CLI generalisation. Only Claude Code is targeted; other backends (codex/opencode/hermes) keep current PTY relay or get their own design later.
- Build a transcript archiver. JSONL files on disk are authoritative; hub does not duplicate them.

## Architecture (target state, end of Phase 3)

```
┌───────────────────────────────────────────────────────────────────────┐
│  Browser SPA (agent-fleet/web/)                                       │
│                                                                        │
│   chat-view.js  (NEW, replaces xterm wiring in app.js)                │
│   ├─ MessageBubble       (user / assistant text)                      │
│   ├─ ToolCallCard        (collapsible: name + args + tool_result)     │
│   ├─ PermissionPrompt    (Allow once / Allow always / Deny)           │
│   ├─ SystemNotice        (permission-mode change, errors, exits)      │
│   ├─ ThinkingBlock       (collapsed by default; opt-in expand)        │
│   └─ Composer            (textbox + slash autocomplete + toolbar)     │
└───────────────────────────────────────────────────────────────────────┘
                              ▲ WS frames                ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Hub (scripts/lib/fleet-routes.js)                                    │
│                                                                        │
│   New frame dispatcher cases (claude_msg, permission_request,         │
│   permission_resolved, session_rotated, session_lifecycle,            │
│   replay_request, replay_batch) — broadcast via existing bus.         │
│   Old PTY relay (pty_data / reconciliation / pty_gap) removed end of  │
│   Phase 3.                                                             │
└───────────────────────────────────────────────────────────────────────┘
                              ▲ WS frames
┌───────────────────────────────────────────────────────────────────────┐
│  Daemon (agent-fleet/daemon/src/)                                     │
│                                                                        │
│   pty-manager.js     spawn claude in node-pty; stdin = paste-mode     │
│                      wrapper; stdout/stderr ignored for UI            │
│   jsonl-tailer.js    (NEW) fs.watch project-dir → open jsonl on       │
│                      create → tail with byte-offset cursor → emit     │
│                      claude_msg frames                                 │
│   permission-mcp.js  (NEW, Phase 3) local MCP server bound to         │
│                      --permission-prompt-tool; routes per-tool        │
│                      approval through structured frames               │
│   stdin-bridge.js    (NEW) send_text frame → paste-mode wrap →        │
│                      pty.write                                         │
│   control-bridge.js  (NEW) control frame → \x03 / SIGTERM / \e\e      │
└───────────────────────────────────────────────────────────────────────┘
```

## Frame schemas

### Daemon → viewer (via hub)

```js
// One per jsonl line of UI interest.
// seq = byte-offset in jsonl (durable across daemon restart).
{
  type: "claude_msg",
  session_id: "<fleet uuid>",
  jsonl_sid: "<claude session uuid>",  // differs after /clear or compact
  seq: 12450,                           // jsonl byte-offset
  ts: "2026-05-18T12:00:00.000Z",
  role: "assistant" | "user" | "system",
  // Assistant fields:
  model: "claude-opus-4-7",
  content: [
    { type: "text", text: "..." },
    { type: "tool_use", id, name, input },
    { type: "thinking", text: "..." },     // gated UI render
  ],
  usage: { input_tokens, output_tokens, cache_read, cache_creation_5m },
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | null,
  // User fields:
  content: [
    { type: "text", text: "..." },
    { type: "tool_result", tool_use_id, content, truncated_at? },
  ],
  // System (mode change / error / lifecycle echo):
  text: "Permission mode set to plan",
}

// Per-tool approval, Phase 3 only.
{
  type: "permission_request",
  session_id, request_id,                  // idempotent
  tool: "Bash",
  args: { command: "rm -rf /tmp/foo" },
  options: ["allow_once", "allow_always", "deny"]
}

// Broadcast resolution so multi-viewer stays coherent.
{
  type: "permission_resolved",
  session_id, request_id,
  decision: "allow_once" | "allow_always" | "deny",
  by_viewer_id
}

// /clear or compact starts a new jsonl file in same project dir
// while PTY pid is unchanged.
{
  type: "session_rotated",
  session_id,                              // fleet sid stays stable
  old_jsonl_sid, new_jsonl_sid,
  pid
}

{
  type: "session_lifecycle",
  session_id,
  state: "spawn" | "ready" | "exit" | "crash",
  code?, signal?
}

{
  type: "replay_batch",
  session_id,
  from_offset, to_offset,
  is_last: bool,
  lines: [ <claude_msg payloads> ]
}
```

### Viewer → daemon (via hub)

```js
{ type: "send_text", session_id, text, as: "prompt" | "permission_reply" }
// "prompt"            → paste-mode wrap + \n     → PTY stdin
// "permission_reply"  → single char (y/n/...)    → PTY stdin (Phase 2 fallback)
//                       OR MCP response          (Phase 3)

{ type: "control", session_id, action: "stop" | "cancel" | "interrupt" }
// stop      → SIGTERM (kill session)
// cancel    → write "\e\e" (double ESC, Ink cancel)
// interrupt → write "\x03" (Ctrl-C, kill current tool)

{ type: "replay_request", session_id, from_offset: 0 }
```

## Phased delivery

Hard-found by architect review: **permission prompts are NOT in jsonl** — `permission-mode` events only record current-mode breadcrumbs, not per-tool "Allow Bash? [y/n]" prompts. Those are rendered by Ink on PTY stdout. Implementing Allow/Deny requires either ANSI parsing (rejected) or Claude's `--permission-prompt-tool` MCP hook (added in Phase 3). Phased plan keeps xterm.js alive until that hook is wired.

### Phase 1 — Read-only chat (xterm.js kept as secondary tab)

- Daemon: `jsonl-tailer.js`. Tail one jsonl per spawned session, emit `claude_msg` + `session_lifecycle` + `session_rotated` frames.
- Hub: dispatch new frames, broadcast via existing `viewersBySession` bus.
- SPA: `chat-view.js`. Chat tab default; "Raw terminal" toggle reveals existing xterm.
- No stdin path yet — keystrokes still go through existing PTY bridge to xterm tab.
- Acceptance: spawn a session, see assistant / user / tool cards live; reconnect replays full transcript; daemon restart restores correct cursor.

### Phase 2 — Interactive composer (bracketed paste)

- Daemon: `stdin-bridge.js`. `send_text {as:"prompt"}` wraps text in `\e[200~ … \e[201~ \n` and writes to PTY stdin.
- Daemon: busy-state derivation. Tracks last `claude_msg.stop_reason` per session — emits a `session_busy {session_id, busy: bool}` frame (or piggybacks on `session_lifecycle`).
- SPA: composer enabled when `busy=false`. Stop / Cancel / Interrupt toolbar buttons send `control`.
- SPA: slash-command autocomplete — list seeded by daemon on first connect via `slash_inventory` frame (one-shot `claude /help` or hardcoded with version stamp + drift warning).
- Permission prompts still routed via xterm tab (user presses y/n there). Banner in chat-view: "Awaiting approval — switch to Raw terminal".
- Acceptance: send multi-line markdown blob with code fence, claude receives it as single prompt; Stop / Interrupt work; busy-state correctly disables composer.

### Phase 3 — MCP permission tool, xterm dropped

- Daemon: `permission-mcp.js` — small local MCP server, registered in claude spawn via `--permission-prompt-tool=mcp__fleet-permission`.
- When claude wants to use a tool, MCP receives request → daemon emits `permission_request` → SPA renders inline card → user clicks → SPA sends `send_text {as:"permission_reply"}` → daemon MCP responds → claude proceeds. Daemon also broadcasts `permission_resolved` so other viewers update.
- xterm.js and PTY relay frames (`pty_data`, `reconciliation`, `pty_gap`) removed from daemon, hub, and SPA. Ring buffer, drop counters, replay machinery in `ws-client.js` deleted.
- Acceptance: spawn session, click Allow on a Bash tool-use card, claude runs the command, second viewer sees `permission_resolved`; full transcript still replays correctly on reconnect.

## Cross-phase invariants

- **seq = jsonl byte-offset.** Durable across daemon restart, deterministic replay. Viewer keeps `last_offset`; on reconnect sends `replay_request {from_offset: last_offset}`.
- **jsonl path discovery.** `fs.watch` on `~/.claude/projects/<enc(cwd)>/` (encoding: `/` → `-` with leading `-`, confirmed against `/root/.claude/projects/-root/`). Open + tail on file-create event; `tail -f` style polling forbidden.
- **session-id rotation.** When a new `<uuid>.jsonl` file appears in the project dir while a spawned session is still alive, daemon emits `session_rotated`, switches tailer to new file, viewers rebind. Old offsets become invalid but transcripts remain queryable via `/fleet/hosts/<id>/file?path=...`.
- **Replay/live cutover.** Single tailer owns the byte-offset cursor. `replay_request` causes a synchronous read from `from_offset` to `current_tailer_offset`, batched into 256 KB WS frames with `is_last` flag. After the last batch, live `claude_msg` frames resume seamlessly. No second reader.
- **Multi-viewer.** `permission_request` is broadcast; `permission_resolved` confirms; UI dedupes by `request_id`. `send_text {as:"prompt"}` is echoed back to all viewers as a `claude_msg {role:"user"}` synthesized from jsonl (Claude Code writes the user turn to jsonl shortly after stdin write).
- **Size caps.** `tool_result.content` truncated at 16 KB; tail replaced with `{type:"truncated", original_bytes, jsonl_offset}`. Full content available via existing `/fleet/hosts/<id>/file` proxy. Replay paginated at 5 MB total per request; "load older" button thereafter.

## File boundaries (estimated)

| New / changed file | LOC | Purpose |
|---|---|---|
| `agent-fleet/daemon/src/jsonl-tailer.js` | ~200 | fs.watch + open + tail + parse + emit |
| `agent-fleet/daemon/src/stdin-bridge.js` | ~50 | paste-mode wrap, write to PTY |
| `agent-fleet/daemon/src/control-bridge.js` | ~40 | stop / cancel / interrupt mapping |
| `agent-fleet/daemon/src/permission-mcp.js` | ~150 (Phase 3) | local MCP server for `--permission-prompt-tool` |
| `agent-fleet/daemon/src/ws-client.js` | -120 / +60 | wire new bridges, eventually drop PTY relay |
| `agent-fleet/web/chat-view.js` | ~400 | chat renderer + composer + cards |
| `agent-fleet/web/app.js` | -250 / +30 | drop xterm wiring (Phase 3), keep raw-tab toggle (Phase 1-2) |
| `scripts/lib/fleet-routes.js` | -40 / +80 | new frame dispatchers, drop pty_data after Phase 3 |
| `scripts/lib/fleet-db.js` | -30 (Phase 3) | drop fleet_events PTY content rows |

## Testing strategy

- **Unit (daemon):** mocked jsonl directory, fake events, verify tailer emits correct `claude_msg` schemas; byte-offset cursor across simulated restart; session_rotated on new file; truncation at 16 KB; paste-mode wrap round-trip; control mapping.
- **Unit (hub):** new frame types dispatch + broadcast; permission_resolved idempotent.
- **E2E:** Playwright spec `tests/e2e/specs/chat-view.spec.js`. Phase 1: spawn → assert message bubbles appear → reload → assert full replay. Phase 2: composer → multi-line input → assert claude receives single prompt; busy-state disables composer. Phase 3: tool-use card → click Allow → assert command runs and second viewer's UI updates.
- **Manual:** full session walk-through of /compact, /clear, mid-tool ESC, long tool_result, network drop + reconnect.

## Risks & open questions

- **Claude Code jsonl schema is undocumented and version-pinned.** Sample has `version:"2.1.141"`; future minor releases may change line shapes. Mitigation: daemon parser is permissive (unknown line types → `{type:"raw"}` passthrough); SPA degrades to "unsupported event" placeholder.
- **MCP permission tool reliability (Phase 3).** Unverified whether `--permission-prompt-tool` honours all tool callouts in 2.1.x. If unreliable, Phase 3 stays optional and Phase 2 ships as the steady state with xterm-for-permissions.
- **`thinking` blocks.** Default render: collapsed icon with token count. Opt-in expand via per-session toggle. Spec does not gate beyond that.
- **Slash-command list drift.** Daemon runs `claude /help` once on startup, caches output, refreshes if claude_version changes. Frame: `slash_inventory {commands: [{name, description}]}`. Falls back to a small hardcoded list if exec fails.

## Open tasks (to be filed)

- vt-NNN1 (epic): fleet chat-UI replacement
- vt-NNN2 (P1, Phase 1): jsonl-tailer + chat-view read-only
- vt-NNN3 (P1, Phase 2): stdin-bridge + bracketed paste + composer
- vt-NNN4 (P2, Phase 3): permission-mcp + drop xterm
- vt-NNN5 (P3): drop fleet_events PTY rows + ring buffer code after Phase 3 lands

These will be filed under the existing `vt-0385` epic (Fleet daemon hardening) or a new sibling epic once user approves this spec.
