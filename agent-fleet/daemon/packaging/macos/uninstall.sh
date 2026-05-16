#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HOME}/Library/Application Support/agent-fleet"
LOG_DIR="${HOME}/Library/Logs/agent-fleet"
PLIST_DST="${HOME}/Library/LaunchAgents/com.fleet.daemon.plist"
PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

[[ $EUID -ne 0 ]] || { echo "do NOT run as root"; exit 1; }

echo "[uninstall] unloading LaunchAgent"
launchctl unload "$PLIST_DST" 2>/dev/null || true
rm -f "$PLIST_DST"

echo "[uninstall] removing $INSTALL_DIR"
rm -rf "$INSTALL_DIR" "$LOG_DIR"

if [[ $PURGE -eq 1 ]]; then
  echo "[uninstall] --purge: also removed conf (already inside INSTALL_DIR)"
fi
echo "[uninstall] done"
