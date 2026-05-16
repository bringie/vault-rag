---
date: 2026-05-16
status: draft
scope: agent-fleet daemon
type: design spec
epic: vt-0073
---

# Agent-Fleet Daemon: Cross-OS System Service + Pluggable Agent Backends

## 1. Goals

1. Run the agent-fleet daemon as a **proper system service** on each operator OS, so it auto-starts on boot, restarts on crash, and logs through the OS's native journal.
2. Move from a hard-coded Claude CLI assumption to a **pluggable agent backend layer**, so the same daemon can spawn OpenCode, Codex CLI, Hermes (via ollama/vllm wrapper), and locally-known proprietary CLIs (OpenClaw, NanoClaw — TBD by operator).
3. Keep the deploy path one-line: `curl <installer> | sh` (or analogous for Windows) on a fresh host.

## 2. Out of scope

- Packaging the hub (rag-api / vault-rag-postgres) as a service — that lives in docker-compose and stays there.
- Auto-updating daemon binaries from the hub — manual operator update for v1; auto-update is a follow-up.
- Sandboxing agents from each other — they all run as the daemon user; isolation is filesystem-level only.

## 3. System service layer (per OS)

| OS | Service framework | Unit file | Default user |
|----|-------------------|-----------|--------------|
| Linux (systemd) | systemd | `/etc/systemd/system/agent-fleet-daemon.service` | dedicated `agentfleet` user, fallback root with note |
| macOS | launchd | `~/Library/LaunchAgents/com.fleet.daemon.plist` (per-user) | console user |
| Windows | Windows Service via `node-windows` or `nssm` | `agent-fleet-daemon` service | LocalSystem (configurable) |

### 3.1 Linux systemd unit (template)

```ini
[Unit]
Description=Agent-Fleet Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agentfleet
WorkingDirectory=/opt/agent-fleet
ExecStart=/usr/bin/node /opt/agent-fleet/daemon/index.js
Restart=always
RestartSec=5
EnvironmentFile=/etc/agent-fleet/daemon.env
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agent-fleet-daemon

[Install]
WantedBy=multi-user.target
```

`/etc/agent-fleet/daemon.env` carries:

```
AGENT_FLEET_HUB_URL=wss://brain.itiswednesdaymydud.es/api/fleet/ws
AGENT_FLEET_BEARER=<bearer-from-vault>
AGENT_FLEET_HOST_NAME=<hostname>
AGENT_FLEET_CLAUDE_BIN=/usr/local/bin/claude  # legacy; use AGENT_FLEET_BACKENDS_PATH for new path
AGENT_FLEET_BACKENDS_PATH=/etc/agent-fleet/backends.json
```

### 3.2 macOS launchd plist (template)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.fleet.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/opt/agent-fleet/daemon/index.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/usr/local/var/log/agent-fleet-daemon.out.log</string>
  <key>StandardErrorPath</key><string>/usr/local/var/log/agent-fleet-daemon.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_FLEET_HUB_URL</key><string>wss://brain.itiswednesdaymydud.es/api/fleet/ws</string>
    <key>AGENT_FLEET_HOST_NAME</key><string>$HOSTNAME</string>
  </dict>
</dict></plist>
```

LaunchAgent (user-scope) avoids requesting root; user logs in → daemon runs.

### 3.3 Windows Service

Two viable routes:

- **node-windows package** — programmatic install via `node-windows daemonize`. Pure-JS, no extra binary, but spawns its own wrapper exe. Used by ~most npm CLI tools that ship a service.
- **nssm.exe** — Native Service Manager binary, more battle-tested. Bundle nssm.exe in the installer.

Decision: **node-windows for v1** (single tool chain), nssm fallback if reliability suffers.

```js
// install.js (Windows)
const Service = require('node-windows').Service;
const svc = new Service({
  name: 'Agent-Fleet Daemon',
  description: 'agent-fleet host daemon',
  script: 'C:\\Program Files\\agent-fleet\\daemon\\index.js',
  env: [
    { name: 'AGENT_FLEET_HUB_URL', value: '...' },
    { name: 'AGENT_FLEET_HOST_NAME', value: process.env.COMPUTERNAME },
  ],
});
svc.on('install', () => svc.start());
svc.install();
```

## 4. One-line installer

```bash
# Linux/macOS
curl -fsSL https://brain.itiswednesdaymydud.es/fleet/install.sh | sh

# Windows (PowerShell)
iwr -useb https://brain.itiswednesdaymydud.es/fleet/install.ps1 | iex
```

The script:

1. Detects OS + arch (`uname -srm` / `$env:OS`).
2. Pulls daemon tarball from hub (`/fleet/download/daemon-<os>-<arch>.tar.gz`).
3. Extracts to OS-appropriate prefix.
4. Prompts for `AGENT_FLEET_BEARER` interactively (read -s on POSIX, masked Read-Host on Windows).
5. Writes service file (systemd/launchd/Windows Service).
6. Enables + starts it.
7. Tails the journal for 5s to confirm `[daemon] welcome` received from hub.

The daemon tarball ships:

- `index.js` (entry) + `src/*.js`
- `node_modules/` pre-installed (no npm install on target host)
- `backends.json` template
- `install.sh` / `install.ps1` itself (re-runnable for upgrades)

Bundling node_modules sidesteps the npm-on-target dependency. Tarball ~15-25 MB.

## 5. Pluggable agent backends

### 5.1 Backend contract

Each backend is a JS module exporting:

```js
module.exports = {
  // Detection: probe whether the binary works on this host.
  // Returns version string or null.
  async detectVersion(env) { ... },

  // Build argv from generic spawn request (cwd, args, env, AND new fields).
  // Returns { argv: [...], env: {...}, stdin: '...' | null }.
  buildSpawnArgs(req) { ... },

  // Optional: parse output for token-cost telemetry.
  // Returns { input_tokens, output_tokens, model } or null.
  parseCostFrame(frame) { ... },

  // Metadata
  name: 'claude' | 'opencode' | 'codex' | 'aider' | 'hermes' | ...,
  bin_env: 'AGENT_FLEET_CLAUDE_BIN',     // env var holding bin path
  bin_default: '/usr/local/bin/claude',
};
```

The daemon loads `backends.json` at startup:

```json
{
  "backends": [
    { "name": "claude",   "module": "./backends/claude.js",   "bin": "/usr/local/bin/claude" },
    { "name": "opencode", "module": "./backends/opencode.js", "bin": "/usr/local/bin/opencode" },
    { "name": "codex",    "module": "./backends/codex.js",    "bin": "/usr/local/bin/codex" },
    { "name": "hermes",   "module": "./backends/hermes.js",   "bin": "/usr/local/bin/hermes-wrapper" },
    { "name": "openclaw", "module": "./backends/openclaw.js", "bin": "/usr/local/bin/openclaw",
      "wrapper": "./backends/openclaw-run.sh",
      "skills": ["chat", "browser", "shell"] },
    { "name": "nanoclaw", "module": "./backends/nanoclaw.js",
      "mode": "sidecar",
      "service_root": "/opt/nanoclaw-v2",
      "service_unit": "nanoclaw.service" }
  ],
  "default": "claude"
}
```

### 5.2 Spawn request schema (server → daemon)

```jsonc
{
  "type": "spawn_request",
  "session_id": "uuid",
  "cwd": "/home/user/proj",
  "agent": "opencode",          // NEW. Optional; falls back to backends.default.
  "args": [...],                // raw flags passthrough (per-backend interpretation)
  "prompt": "fix the bug...",   // NEW. Backend decides whether to put in argv or stdin.
  "model": "claude-opus-4-7",   // NEW. Backend maps to its model-id naming.
  "system_prompt": "...",       // NEW.
  "allowed_tools": "Bash,Edit", // NEW.
  "resume_session_id": null,    // NEW.
  "dangerous": false,
  "env": {...}
}
```

### 5.3 Per-backend argv mapping (illustrative)

| Generic field | claude | opencode | codex | hermes (wrapper) |
|---|---|---|---|---|
| `prompt` | `--print "$P"` if non-tty, else stdin | `-m "$P"` | `--prompt "$P"` | stdin to ollama run |
| `model` | `--model "$M"` | `--model "$M"` | `--model "$M"` | `--model "$M"` (translated to ollama tag) |
| `system_prompt` | `--append-system-prompt "$S"` | (in TOML config or `-s`) | `--system "$S"` | wrapper preamble |
| `allowed_tools` | `--allowed-tools "$T"` | (TOML config) | n/a | n/a |
| `resume_session_id` | `--resume "$R"` | `--resume "$R"` | n/a | n/a |
| `dangerous` | `--dangerously-skip-permissions` | `--auto-approve` | n/a | n/a |

Each backend module owns its own mapping — if a field is unsupported, it is silently dropped, with a `console.warn` from the daemon for visibility.

### 5.4 Hermes wrapper

Hermes models are not CLI tools — they are ollama/vllm-hosted models. The "hermes" backend ships a tiny shell wrapper:

```sh
#!/bin/sh
# hermes-wrapper: reads stdin, calls ollama, writes to stdout. Mimics
# a one-shot CLI to match the rest of the backends.
MODEL="${MODEL:-hermes-3-llama-3.1-8b}"
ollama run "$MODEL" "$(cat)"
```

(Or via vllm openai-compatible: a 30-line Node script using fetch.)

### 5.5 OpenClaw

- Project: https://openclaw.ai/ — personal AI agent framework, multi-OS (Mac/Win/Linux).
- Repo: https://github.com/openclaw/openclaw. Docs: https://docs.openclaw.ai/. Skills Hub: https://clawhub.ai.
- Install: `npm i -g openclaw` (or `curl -fsSL https://openclaw.ai/install.sh | bash`).
- Entry: `openclaw <subcommand>` (e.g. `openclaw onboard`). Supports Claude, OpenAI GPT, local models. Plugins via skills.
- **Argv mapping caveat:** OpenClaw is itself an orchestrator with its own skills runtime — it is closer in shape to a *meta-agent* than to a plain Claude-CLI replacement. The daemon contract in §5.1 still applies (we treat it as a process that consumes a prompt and emits output), but specific flag-mapping depends on what subcommand the operator wires up. Likely path: a dedicated `openclaw-run.sh` wrapper script in the backend module that takes generic env-vars (`PROMPT`, `MODEL`, etc.) and translates them into the right `openclaw <skill> [...]` invocation.
- Sub-task **I.1** below: prototype the wrapper, document the chosen skill subset.

### 5.6 NanoClaw

- Project: https://nanoclaw.dev/ — Docker-isolated agent with messaging-platform integrations (WhatsApp, Telegram, Slack, Discord, Teams).
- Repo: https://github.com/nanocoai/nanoclaw.
- Install: `git clone … && bash nanoclaw.sh`.
- Entry: NOT a one-shot CLI. NanoClaw runs as a long-lived service that listens on messaging channels and orchestrates Claude/Codex/local-LLM via Claude Agent SDK + skills (`/add-codex`, `/add-opencode`, `/add-ollama-provider`).
- **Integration model:** NanoClaw is not a fit for the standard "spawn → wait for exit → collect transcript" daemon path. Two viable options for fleet integration:
  - **(a) Side-car only:** the daemon's job is just to install + manage the NanoClaw service lifecycle. Spawn requests are no-ops for this backend; the operator interacts with NanoClaw through their messaging app. Fleet UI shows "service status" instead of "session transcript".
  - **(b) RPC bridge:** the operator stands up a small HTTP shim on the NanoClaw host that accepts our spawn payload and forwards it to NanoClaw as if it were an incoming WhatsApp message. Output streamed back through the bridge → daemon → fleet hub.
- Pick (a) for v1 (lower risk, less custom code). (b) is a follow-up if operators want unified UI.
- Sub-task **I.2** below.

## 6. Configuration management

- `daemon.env` (env vars): hub URL, bearer, host name, log level.
- `backends.json`: list of available backends + per-host overrides.
- Both files live under `/etc/agent-fleet/` (Linux), `/usr/local/etc/agent-fleet/` (macOS), `C:\ProgramData\agent-fleet\` (Windows).
- Hot-reload `backends.json` on `SIGHUP` (POSIX) or file-watcher (Windows). No daemon restart needed for backend updates.

## 7. Tarball + binary distribution

```
fleet/
  download/
    daemon-linux-x64.tar.gz
    daemon-linux-arm64.tar.gz
    daemon-darwin-arm64.tar.gz
    daemon-darwin-x64.tar.gz
    daemon-windows-x64.zip
  install.sh
  install.ps1
```

Build job: GitHub Actions (or local make target) cross-compiles `node_modules` for each arch (most are pure JS; native deps are `node-pty` which has prebuilts). Outputs to `agent-fleet/dist/`. Hub serves them from `/fleet/download/*`.

Updates: operator re-runs `install.sh` → it stops the service, replaces `/opt/agent-fleet/`, restarts service. No DB schema change required for the daemon side.

## 8. Sub-task decomposition

Each becomes a separate vt task under epic vt-0073:

| Sub-task | Scope | Effort |
|----------|-------|--------|
| **A. Backend contract + claude.js** | Refactor current daemon spawn path through the backend interface. Existing behaviour preserved; one backend registered (`claude`). | M |
| **B. backends/opencode.js + codex.js + hermes wrapper** | Three additional backends following the contract. | M |
| **C. Linux systemd packaging** | install.sh, daemon.service template, /etc/agent-fleet/daemon.env, tarball pipeline. | L |
| **D. macOS launchd packaging** | install.sh adaptation, LaunchAgent plist template, prefix /usr/local/opt/agent-fleet. | M |
| **E. Windows Service packaging** | install.ps1, node-windows wiring, ProgramData paths. | L |
| **F. Tarball CI + hub download routes** | GitHub Actions build matrix, GET /fleet/download/* on rag-api side. | M |
| **G. Spawn schema migration (server)** | Add agent/prompt/model/system_prompt/allowed_tools/resume_session_id to spawn_request frame; backwards-compat default. Update fleet-routes + frontend. | M |
| **H. Hot-reload backends.json (SIGHUP / watcher)** | Per host runtime backend updates. | S |
| **I.1 OpenClaw wrapper backend** | Backend module + `openclaw-run.sh` wrapper that maps generic spawn fields to `openclaw <skill> ...` invocation. Test against `openclaw onboard` → `openclaw chat` flow. | M |
| **I.2 NanoClaw side-car backend** | Lifecycle-only backend (install + start/stop NanoClaw service on the host). Spawn no-ops; status surfaced to fleet UI as "service: up/down". Optional (b) RPC bridge follow-up. | M |

Order: A → G → (B || C || D || E in parallel) → F → H → I.1 → I.2.

## 9. Risks / open questions

- **node-pty prebuilts** for Windows ARM64: not always available. May need to drop Win-ARM64 from v1 matrix.
- **macOS code signing**: launchd works without it but Gatekeeper may quarantine. Notarisation is a separate sub-task if needed.
- **Bearer rotation**: if the operator rotates the WS bearer, every host's `daemon.env` needs to be re-pushed. Could be solved later by pulling bearer from vault-rag secrets API on startup.
- **Per-backend log noise**: `console.warn` on dropped-field-per-backend will be spammy if a user submits a generic spawn with all fields against a backend that supports only `prompt`. Decision: warn once per backend per process startup, not per spawn.
- **OpenClaw/NanoClaw are orchestrators, not Claude clones**: both have their own runtime, skills, and (in NanoClaw's case) messaging-channel layer. Integration with the fleet daemon is therefore *adapter-shaped*, not drop-in. Mapping the daemon's generic spawn contract onto these is the bulk of sub-tasks I.1/I.2.

## 10. Implementation gate

This is a design spec only. Implementation starts after sub-tasks A–I are individually scoped and prioritised. Suggested first sprint: A + G (backend contract + spawn schema migration) — these unblock everything else.
