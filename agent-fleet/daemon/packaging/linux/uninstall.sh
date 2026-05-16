#!/usr/bin/env bash
# Removes agent-fleet daemon installed via install.sh, .deb, or .rpm.
# By default keeps /etc/agent-fleet/daemon.env + /var/lib/agent-fleet/.
# Pass --purge to remove those too.

set -euo pipefail

INSTALL_DIR="/opt/agent-fleet"
CONF_DIR="/etc/agent-fleet"
STATE_DIR="/var/lib/agent-fleet"
UNIT_NAME="agent-fleet-daemon.service"
SVC_USER="agentfleet"
PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

[[ $EUID -eq 0 ]] || { echo "must run as root"; exit 1; }

echo "[uninstall] stopping + disabling service"
systemctl stop "$UNIT_NAME" 2>/dev/null || true
systemctl disable "$UNIT_NAME" 2>/dev/null || true
rm -f "/etc/systemd/system/$UNIT_NAME"
systemctl daemon-reload

echo "[uninstall] removing $INSTALL_DIR"
rm -rf "$INSTALL_DIR"

if [[ $PURGE -eq 1 ]]; then
  echo "[uninstall] --purge: removing $CONF_DIR + $STATE_DIR + user $SVC_USER"
  rm -rf "$CONF_DIR" "$STATE_DIR"
  userdel "$SVC_USER" 2>/dev/null || true
else
  echo "[uninstall] kept $CONF_DIR (--purge to remove)"
fi
echo "[uninstall] done"
