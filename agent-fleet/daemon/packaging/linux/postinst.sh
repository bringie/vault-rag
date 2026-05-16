#!/bin/sh
# deb/rpm post-install hook.
# - Creates 'agentfleet' system user if missing.
# - Runs `npm ci` to fetch deps for this host's arch.
# - daemon-reload + enable + (re)start.
# Does NOT prompt for token — operator edits /etc/agent-fleet/daemon.env first.

set -e

SVC=agent-fleet-daemon.service
USER_NAME=agentfleet
INSTALL_DIR=/opt/agent-fleet
STATE_DIR=/var/lib/agent-fleet

if ! id "$USER_NAME" >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin \
      --home-dir "$STATE_DIR" "$USER_NAME"
  else
    adduser --system --no-create-home --shell /usr/sbin/nologin \
      --home "$STATE_DIR" "$USER_NAME"
  fi
fi
mkdir -p "$STATE_DIR"
chown -R "$USER_NAME":"$USER_NAME" "$STATE_DIR"

if [ -d "$INSTALL_DIR" ]; then
  if command -v npm >/dev/null 2>&1; then
    ( cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund ) || \
      echo "[postinst] WARN: npm ci failed — run manually and then 'systemctl restart $SVC'"
  else
    echo "[postinst] WARN: npm not in PATH; install node + npm then run:"
    echo "   cd $INSTALL_DIR && npm ci --omit=dev && systemctl restart $SVC"
  fi
  chown -R "$USER_NAME":"$USER_NAME" "$INSTALL_DIR"
fi

chmod 0640 /etc/agent-fleet/daemon.env 2>/dev/null || true
chown root:"$USER_NAME" /etc/agent-fleet/daemon.env 2>/dev/null || true

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  if grep -q '^AGENT_FLEET_TOKEN=.\+' /etc/agent-fleet/daemon.env 2>/dev/null; then
    systemctl enable --now "$SVC"
    echo "[postinst] $SVC started"
  else
    systemctl enable "$SVC"
    echo "[postinst] $SVC enabled but NOT started — set AGENT_FLEET_TOKEN in /etc/agent-fleet/daemon.env then 'systemctl start $SVC'"
  fi
fi

exit 0
