# Claude Code integrations for vault-rag

Two drop-in scripts that turn Claude Code's hooks into a vault-rag client:

| Script | Purpose |
|--------|---------|
| `precompact-snapshot.py` | PreCompact hook. Dumps the full transcript to `05-sessions/` in the vault before Claude Code summarizes (and discards) it. Lossless recovery point. |
| `cost-statusline.sh` | Statusline that shows `ctx N% (used/max)` alongside cost and burn rate. Lets you see how full the context window is and `/clear` proactively before auto-compact fires. |

Both are independent: install one, both, or neither.

## Why

- **PreCompact**: auto-compact replaces conversation history with a lossy summary. Tool calls, exact code snippets, error messages - all collapsed. With this hook, the raw turns are persisted to the vault under `05-sessions/<ts>-precompact-<sid>.md` *before* the summary happens, so `vt search` (or a manual fetch) can retrieve them later.
- **Statusline**: Claude Code does not show context usage by default. You only learn the window is full when auto-compact triggers. This script reads the transcript JSONL, sums the latest assistant turn's `input_tokens + cache_creation + cache_read`, and shows a percentage. Threshold colors: green <70%, yellow 70-85%, red >85%.

## Install

```bash
# 1. Copy the scripts somewhere stable, e.g. ~/.claude/scripts/
mkdir -p ~/.claude/scripts
cp precompact-snapshot.py ~/.claude/scripts/
cp cost-statusline.sh ~/.claude/scripts/
chmod +x ~/.claude/scripts/precompact-snapshot.py ~/.claude/scripts/cost-statusline.sh

# 2. Make sure VAULT_RAG_API_URL and VAULT_RAG_API_TOKEN are reachable.
#    Either via Claude Code's settings.json `env` block, OR via a .env file
#    at $VAULT_ENV_FILE (default: ~/.vault-rag.env):
cat > ~/.vault-rag.env <<EOF
VAULT_RAG_API_URL=https://your-domain
VAULT_RAG_API_TOKEN=your-bearer-token
EOF
chmod 600 ~/.vault-rag.env
```

Then register them in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "python3 /root/.claude/scripts/precompact-snapshot.py" }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "bash /root/.claude/scripts/cost-statusline.sh"
  }
}
```

Adjust the paths if you installed under a different `$HOME`.

## How `precompact-snapshot.py` works

- Triggered by Claude Code's `PreCompact` hook (manual `/compact` and auto-compact both fire).
- Reads JSON from stdin: `{ session_id, transcript_path, trigger }`.
- Parses the transcript JSONL line by line, rendering each turn as markdown:
  - `[thinking]` blocks (truncated to 1.5k chars each)
  - `[tool_use: <name>]` with input as a fenced JSON block
  - `[tool_result <id>]` with the result body
  - Plain text content
- Truncates to 120k chars via head + tail (most recent turns are the most useful right before compact).
- POSTs to `<VAULT_RAG_API_URL>/api/put` with `mode=create`, `reindex=false`. Reindexing 30k+ token snapshots is slow and rarely worth it for emergency recovery; if you want them searchable, flip `reindex` to `true` in the script and accept the longer hook latency.
- Writes a per-line log to `$VAULT_PRECOMPACT_LOG` (default `~/.claude/precompact-snapshot.log`) so you can audit what was captured.
- Catches every exception and exits 0 so a vault outage never blocks compact.

The vault path lands at `05-sessions/<UTC-ts>-precompact-<short-session-id>.md`. `05-sessions/` is on the default `WRITABLE_PREFIXES` allowlist of `rag-api.js`, so no `agent_id` is needed.

## How `cost-statusline.sh` works

- Reads JSON from stdin: `{ model.id, transcript_path, cost.total_cost_usd, cost.total_duration_ms }`.
- Picks the context window size from the model id (`*1m*` or `*opus-4-7*` -> 1M, anything else -> 200k). Adjust the `case` if you use other long-context models.
- Tails the transcript JSONL to find the latest assistant message with `usage`, then computes `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` as the current context fill.
- Prepends the caveman badge if you have the caveman plugin installed (via `find /root/.claude/plugins/cache/caveman ... caveman-statusline.sh`); otherwise that segment is empty.
- Final output looks like: `[CAVEMAN:ULTRA] [OPU] ctx 47% (470k/1000k) $2.34 ~$0.47/min`

## Customizing

- **Skip the caveman lookup** if you don't use the plugin: delete the `CAVEMAN_SCRIPT=$(find ...)` block in `cost-statusline.sh`.
- **Change context window per model**: edit the `case "$MODEL_ID"` block.
- **Change PreCompact body cap**: edit `MAX_BODY_CHARS` (default 120000) in `precompact-snapshot.py`. Smaller = faster, less detail.
- **Index PreCompact dumps**: flip `"reindex": False` to `True` and accept ~60s of POST latency per snapshot.

## Caveats

- These scripts are tuned for a single-user Linux box with `python3` and `jq` installed (the bash one needs `jq` and `bc`). Windows / WSL untested.
- The PreCompact hook script writes to `05-sessions/` without an `agent_id`. If your `rag-api.js` deployment locks `WRITABLE_PREFIXES` down further, pass `agent_id` in the payload and the API will remap to `agents/<id>/...`.
- The statusline script tails the transcript JSONL with `tac`. On macOS, replace `tac` with `tail -r` or install `coreutils`.
