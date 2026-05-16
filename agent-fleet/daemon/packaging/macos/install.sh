#!/usr/bin/env bash
# agent-fleet daemon installer for macOS (LaunchAgent, per-user).
# Usage:
#   curl -fsSL https://brain.itiswednesdaymydud.es/fleet/install-macos.sh | bash
#   AGENT_FLEET_TOKEN=xxx AGENT_FLEET_HUB=wss://... ./install.sh

set -euo pipefail

TARBALL_URL="${AGENT_FLEET_TARBALL:-https://brain.itiswednesdaymydud.es/fleet/download/agent-fleet-daemon.tar.gz}"
INSTALL_DIR="${HOME}/Library/Application Support/agent-fleet"
CONF_DIR="${HOME}/Library/Application Support/agent-fleet/conf"
STATE_DIR="${HOME}/Library/Application Support/agent-fleet/state"
LOG_DIR="${HOME}/Library/Logs/agent-fleet"
PLIST_DST="${HOME}/Library/LaunchAgents/com.fleet.daemon.plist"

[[ $EUID -ne 0 ]] || { echo "do NOT run as root on macOS — LaunchAgent installs per-user"; exit 1; }
command -v node >/dev/null || { echo "node ≥20 required (brew install node)"; exit 1; }
command -v npm  >/dev/null || { echo "npm required"; exit 1; }
NODE_MAJ=$(node -p 'process.versions.node.split(".")[0]')
[[ "$NODE_MAJ" -ge 20 ]] || { echo "node ≥20 required (have $(node -v))"; exit 1; }

echo "[install] downloading daemon → $TARBALL_URL"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
if [[ "$TARBALL_URL" == file://* ]]; then
  cp "${TARBALL_URL#file://}" "$TMP/daemon.tar.gz"
else
  curl -fsSL "$TARBALL_URL" -o "$TMP/daemon.tar.gz"
fi

echo "[install] extracting → $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$CONF_DIR" "$STATE_DIR" "$LOG_DIR"
tar -xzf "$TMP/daemon.tar.gz" -C "$INSTALL_DIR" --strip-components=1

echo "[install] npm ci"
( cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund )

echo "[install] writing env"
if [[ ! -f "$CONF_DIR/daemon.env" ]]; then
  cp "$INSTALL_DIR/packaging/common/daemon.env.template" "$CONF_DIR/daemon.env"
fi

if [[ -z "${AGENT_FLEET_HUB:-}" ]] && ! grep -q '^AGENT_FLEET_HUB=wss' "$CONF_DIR/daemon.env"; then
  read -r -p "Hub URL: " AGENT_FLEET_HUB
fi
if [[ -z "${AGENT_FLEET_TOKEN:-}" ]] && ! grep -q '^AGENT_FLEET_TOKEN=.\+' "$CONF_DIR/daemon.env"; then
  read -r -s -p "Bearer token: " AGENT_FLEET_TOKEN
  echo
fi
HOST_NAME="${AGENT_FLEET_HOST_NAME:-$(hostname)}"

# Update env file (best-effort regex; daemon.env is tiny).
if [[ -n "${AGENT_FLEET_HUB:-}" ]]; then
  sed -i '' "s|^AGENT_FLEET_HUB=.*|AGENT_FLEET_HUB=${AGENT_FLEET_HUB}|" "$CONF_DIR/daemon.env"
fi
if [[ -n "${AGENT_FLEET_TOKEN:-}" ]]; then
  sed -i '' "s|^AGENT_FLEET_TOKEN=.*|AGENT_FLEET_TOKEN=${AGENT_FLEET_TOKEN}|" "$CONF_DIR/daemon.env"
fi

echo "[install] generating LaunchAgent plist"
# launchd doesn't read env files — inline values from daemon.env into the plist.
HUB=$(grep '^AGENT_FLEET_HUB=' "$CONF_DIR/daemon.env" | cut -d= -f2-)
TOKEN=$(grep '^AGENT_FLEET_TOKEN=' "$CONF_DIR/daemon.env" | cut -d= -f2-)

sed \
  -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
  -e "s|__CONF_DIR__|$CONF_DIR|g" \
  -e "s|__STATE_DIR__|$STATE_DIR|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  -e "s|__HUB__|$HUB|g" \
  -e "s|__TOKEN__|$TOKEN|g" \
  -e "s|__HOST_NAME__|$HOST_NAME|g" \
  "$INSTALL_DIR/packaging/macos/com.fleet.daemon.plist" > "$PLIST_DST"
chmod 0600 "$PLIST_DST"

echo "[install] loading LaunchAgent"
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load -w "$PLIST_DST"

sleep 1
echo
echo "[install] done. Manage with:"
echo "    launchctl print gui/\$(id -u)/com.fleet.daemon"
echo "    tail -f $LOG_DIR/agent-fleet-daemon.{out,err}.log"
echo "    bash $INSTALL_DIR/packaging/macos/uninstall.sh"
