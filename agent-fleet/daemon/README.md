# @bringie/agent-fleet-daemon

Per-host daemon for agent-fleet. Connects out to a central hub over WebSocket; spawns Claude Code sessions on demand in a PTY; streams I/O.

## Install

```
npx @bringie/agent-fleet-daemon \
  --hub wss://brain.example.com/api/fleet/ws \
  --token "$VAULT_RAG_API_TOKEN" \
  --host-name $(hostname)
```

## Flags / env

| Flag | Env | Description |
|---|---|---|
| `--hub <url>` | `AGENT_FLEET_HUB` | hub WebSocket URL |
| `--token <t>` | `AGENT_FLEET_TOKEN` (or `VAULT_RAG_API_TOKEN`) | Bearer token |
| `--host-name <n>` | `AGENT_FLEET_HOST_NAME` | logical host name (default: hostname) |
| `--caps a,b,c` | — | capabilities tags |
| `--state-dir <p>` | — | state directory (default: `~/.agent-fleet`) |
| `--claude-bin <p>` | `AGENT_FLEET_CLAUDE_BIN` | claude binary (default: `claude`) |

## State

`~/.agent-fleet/`:
- `config.json` — host_id assigned by hub on first connect
- `sessions.json` — running session index for restart recovery

## Local dev

```
cd agent-fleet/daemon
npm install
npm test
```
