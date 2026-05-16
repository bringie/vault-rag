#!/usr/bin/env bash
# agent-fleet hermes backend wrapper.
# Reads prompt from stdin, runs `ollama run $MODEL "$PROMPT"`, streams stdout.
# Wire via backends.json:
#   { "name": "hermes", "module": "./hermes.js", "bin": "/opt/agent-fleet/src/backends/hermes-wrapper.sh" }
#
# Env in:
#   MODEL          — ollama model tag (default: hermes-3-llama-3.1-8b)
# Stdin:
#   the prompt (with optional <<SYSTEM>> ... <<USER>> framing from hermes.js)

set -euo pipefail
MODEL="${MODEL:-hermes-3-llama-3.1-8b}"
PROMPT=$(cat)

if ! command -v ollama >/dev/null 2>&1; then
  echo "[hermes-wrapper] ollama not on PATH" >&2
  exit 127
fi

# `ollama run` streams to stdout — exactly what the PTY captures.
exec ollama run "$MODEL" "$PROMPT"
