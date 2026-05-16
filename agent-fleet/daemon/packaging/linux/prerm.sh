#!/bin/sh
set -e
SVC=agent-fleet-daemon.service
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop "$SVC" 2>/dev/null || true
  systemctl disable "$SVC" 2>/dev/null || true
fi
exit 0
