#!/usr/bin/env bash
# agent-fleet openclaw backend wrapper.
# Reads prompt from stdin, runs `openclaw <skill>`, streams stdout.
# Env in:
#   OPENCLAW_SKILL          — subcommand (default: chat)
#   OPENCLAW_MODEL          — optional, forwarded as --model where supported
#   OPENCLAW_SYSTEM_PROMPT  — optional, forwarded as --system
#   OPENCLAW_ALLOWED_TOOLS  — optional, forwarded as --allowed-tools

set -euo pipefail
SKILL="${OPENCLAW_SKILL:-chat}"
BIN="${OPENCLAW_BIN:-openclaw}"

# Pass --version through transparently for detection probes.
if [[ "${1:-}" == "--version" ]]; then
  exec "$BIN" --version
fi

extra=()
[[ -n "${OPENCLAW_MODEL:-}"          ]] && extra+=(--model         "$OPENCLAW_MODEL")
[[ -n "${OPENCLAW_SYSTEM_PROMPT:-}"  ]] && extra+=(--system        "$OPENCLAW_SYSTEM_PROMPT")
[[ -n "${OPENCLAW_ALLOWED_TOOLS:-}"  ]] && extra+=(--allowed-tools "$OPENCLAW_ALLOWED_TOOLS")

PROMPT=$(cat)
# Most openclaw skills accept prompt as the trailing positional arg.
exec "$BIN" "$SKILL" "${extra[@]}" "$@" "$PROMPT"
