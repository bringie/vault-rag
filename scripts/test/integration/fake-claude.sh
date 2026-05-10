#!/usr/bin/env bash
set -euo pipefail
prompt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p) prompt="$2"; shift 2 ;;
    *)  shift ;;
  esac
done

mode="${FAKE_CLAUDE_MODE:-normal}"
case "$mode" in
  timeout)    sleep 90 ;;
  auth_fail)  echo "Please run claude login" >&2 ; exit 2 ;;
  garbage)    echo "not json at all" ;;
  low_conf)
    cat <<EOF
{"result":"{\"target_folder\":\"06-resources\",\"tags\":[\"x\"],\"summary\":\"low\",\"type\":\"note\",\"confidence\":0.5}"}
EOF
    ;;
  normal|*)
    folder="01-knowledge"
    [[ "$prompt" == *"smoke"* || "$prompt" == *"log"* ]] && folder="05-logs"
    cat <<EOF
{"result":"{\"target_folder\":\"$folder\",\"tags\":[\"auto\",\"test\"],\"summary\":\"fake\",\"type\":\"note\",\"confidence\":0.9}"}
EOF
    ;;
esac
