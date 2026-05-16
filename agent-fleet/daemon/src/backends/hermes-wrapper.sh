#!/usr/bin/env bash
# agent-fleet hermes backend wrapper.
# Reads prompt from stdin, runs `ollama run $MODEL "$PROMPT"`, streams stdout.
# Wire via backends.json:
#   { "name": "hermes", "module": "./hermes.js", "bin": "/opt/agent-fleet/src/backends/hermes-wrapper.sh" }
#
# Env in:
#   MODEL          — ollama model tag (default: hermes-3-llama-3.1-8b)
# Stdin:
#   either a plain prompt, or the framed form from hermes.js:
#     <<SYSTEM>>
#     <system text>
#     <<USER>>
#     <user prompt>
#   When framing is present, system text is forwarded via `ollama run --system`.

set -euo pipefail
MODEL="${MODEL:-hermes-3-llama-3.1-8b}"
RAW=$(cat)

if ! command -v ollama >/dev/null 2>&1; then
  echo "[hermes-wrapper] ollama not on PATH" >&2
  exit 127
fi

# vt-0121: parse <<SYSTEM>>/<<USER>> framing. Without parsing the markers
# leak verbatim into the model context (was a design no-op).
if printf '%s' "$RAW" | grep -q '^<<SYSTEM>>$'; then
  SYS=$(printf '%s' "$RAW" | awk '/^<<SYSTEM>>$/{f=1;next} /^<<USER>>$/{f=0;next} f')
  USR=$(printf '%s' "$RAW" | awk '/^<<USER>>$/{f=1;next} f')
  exec ollama run --system "$SYS" "$MODEL" "$USR"
fi

exec ollama run "$MODEL" "$RAW"
