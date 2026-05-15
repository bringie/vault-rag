#!/usr/bin/env bash
# fake-claude: mock the claude CLI for fleet-e2e.
# Modes:
#   --print <prompt>     → echoes the prompt to stdout, exits 0
#   --hang               → sleeps 60s
#   --fail               → exits 1
#   (no args)            → interactive: echoes each input line back, exits on 'quit'
set -euo pipefail

if [ "${1:-}" = "--print" ]; then
  shift
  echo "$@"
  exit 0
fi

if [ "${1:-}" = "--hang" ]; then
  sleep 60
  exit 0
fi

if [ "${1:-}" = "--fail" ]; then
  exit 1
fi

while IFS= read -r line; do
  if [ "$line" = "quit" ]; then exit 0; fi
  echo "echo: $line"
done
