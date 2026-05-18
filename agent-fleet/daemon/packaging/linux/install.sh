#!/usr/bin/env bash
# agent-fleet daemon installer for Linux (systemd-based distros).
# Usage:
#   curl -fsSL https://brain.itiswednesdaymydud.es/fleet/install.sh | sudo bash
#   AGENT_FLEET_TOKEN=xxx AGENT_FLEET_HUB=wss://... sudo ./install.sh
#
# What this does:
#   1. Downloads/uses the daemon tarball.
#   2. Installs to /opt/agent-fleet (src + package.json).
#   3. Runs `npm ci --omit=dev` to fetch node-pty + ws prebuilts for THIS host.
#   4. Creates 'agentfleet' system user.
#   5. Writes /etc/agent-fleet/daemon.env with prompted/env-supplied values.
#   6. Installs systemd unit, enables, starts.
#   7. Tails the journal for 5s to confirm '[daemon] connected'.

set -euo pipefail

TARBALL_URL="${AGENT_FLEET_TARBALL:-https://brain.itiswednesdaymydud.es/fleet/download/agent-fleet-daemon.tar.gz}"
INSTALL_DIR="/opt/agent-fleet"
CONF_DIR="/etc/agent-fleet"
STATE_DIR="/var/lib/agent-fleet"
SVC_USER="agentfleet"
UNIT_NAME="agent-fleet-daemon.service"

[[ $EUID -eq 0 ]] || { echo "must run as root (use sudo)"; exit 1; }
command -v systemctl >/dev/null || { echo "systemd required"; exit 1; }
command -v node >/dev/null || { echo "node ≥20 required — install nodejs first"; exit 1; }
command -v npm  >/dev/null || { echo "npm required — install npm first"; exit 1; }
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
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMP/daemon.tar.gz" -C "$INSTALL_DIR" --strip-components=1

echo "[install] installing node_modules (npm ci)"
( cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund )

echo "[install] creating system user $SVC_USER"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin \
    --home-dir "$STATE_DIR" "$SVC_USER"
fi
mkdir -p "$STATE_DIR"
chown -R "$SVC_USER":"$SVC_USER" "$STATE_DIR" "$INSTALL_DIR"

echo "[install] writing $CONF_DIR/daemon.env"
mkdir -p "$CONF_DIR"
if [[ ! -f "$CONF_DIR/daemon.env" ]]; then
  cp "$INSTALL_DIR/packaging/common/daemon.env.template" "$CONF_DIR/daemon.env"
fi

# Prompt for missing required values if not pre-set in env.
if [[ -z "${AGENT_FLEET_HUB:-}" ]] && ! grep -q '^AGENT_FLEET_HUB=wss' "$CONF_DIR/daemon.env"; then
  read -r -p "Hub URL (e.g. wss://brain.example.com/api/fleet/ws): " AGENT_FLEET_HUB
fi
if [[ -z "${AGENT_FLEET_TOKEN:-}" ]] && ! grep -q '^AGENT_FLEET_TOKEN=.\+' "$CONF_DIR/daemon.env"; then
  # vt-0389: MUST be the FLEET_ADMIN_TOKEN, not the regular API token.
  # The hub WS upgrade rejects regular-tier bearers with code 4001.
  echo "Bearer token = the hub's FLEET_ADMIN_TOKEN (not the regular API token)."
  echo "  Retrieve from vault: vt secrets get VAULT_RAG_FLEET_ADMIN_TOKEN"
  read -r -s -p "Bearer token: " AGENT_FLEET_TOKEN
  echo
fi

# vt-0123: sed interpolation broke for tokens containing `|`, `&`, `\`, or
# newline. Use perl literal-string replacement and write through a tempfile
# under umask 077 so the bearer token is never written at default 0644.
update_env_var() {
  local key="$1" val="$2"
  local tmp; tmp=$(mktemp)
  (
    umask 077
    KEY="$key" VAL="$val" SRC="$CONF_DIR/daemon.env" OUT="$tmp" \
    perl -e '
      use strict; use warnings;
      open(my $in, "<", $ENV{SRC}) or die "open: $!";
      local $/; my $body = <$in>; close $in;
      my $key = quotemeta $ENV{KEY};
      my $line = "$ENV{KEY}=$ENV{VAL}";
      if ($body =~ /^${key}=/m) { $body =~ s/^${key}=.*$/$line/m; }
      else { $body .= "\n" unless $body =~ /\n\z/; $body .= "$line\n"; }
      open(my $out, ">", $ENV{OUT}) or die "open out: $!";
      print $out $body; close $out;
    '
  )
  mv "$tmp" "$CONF_DIR/daemon.env"
}
if [[ -n "${AGENT_FLEET_HUB:-}" ]]; then
  update_env_var AGENT_FLEET_HUB "$AGENT_FLEET_HUB"
fi
if [[ -n "${AGENT_FLEET_TOKEN:-}" ]]; then
  update_env_var AGENT_FLEET_TOKEN "$AGENT_FLEET_TOKEN"
fi
# Set HOST_NAME default if not already set.
if ! grep -q '^AGENT_FLEET_HOST_NAME=' "$CONF_DIR/daemon.env"; then
  echo "AGENT_FLEET_HOST_NAME=$(hostname)" >> "$CONF_DIR/daemon.env"
fi
if ! grep -q '^AGENT_FLEET_STATE_DIR=' "$CONF_DIR/daemon.env"; then
  echo "AGENT_FLEET_STATE_DIR=$STATE_DIR" >> "$CONF_DIR/daemon.env"
fi
chmod 0640 "$CONF_DIR/daemon.env"
chown root:"$SVC_USER" "$CONF_DIR/daemon.env"

# vt-0144: optional --with-mcp flag → invoke bundled vault-rag-setup CLI to
# wire ~/.claude.json (or equivalent) of the OPERATOR user. Runs as that user
# so file ownership is right. All URLs/tokens are flag/env — no hardcoded
# domain so self-hosted fleets can install their own.
WITH_MCP=""
MCP_TOKEN_ARG="${AGENT_FLEET_MCP_TOKEN:-}"
MCP_URL_ARG="${AGENT_FLEET_MCP_URL:-}"
VAULT_NAME_ARG="${AGENT_FLEET_VAULT_NAME:-vault-rag}"
MCP_CONFIG_USER="${SUDO_USER:-${USER:-}}"
for arg in "$@"; do
  case "$arg" in
    --with-mcp)              WITH_MCP=1 ;;
    --mcp-token=*)           MCP_TOKEN_ARG="${arg#*=}" ;;
    --mcp-url=*)             MCP_URL_ARG="${arg#*=}" ;;
    --vault-name=*)          VAULT_NAME_ARG="${arg#*=}" ;;
    --mcp-config-for-user=*) MCP_CONFIG_USER="${arg#*=}" ;;
  esac
done

if [[ -n "$WITH_MCP" ]]; then
  if [[ -z "$MCP_CONFIG_USER" ]]; then
    echo "[install] --with-mcp requires SUDO_USER or --mcp-config-for-user=<name>" >&2
    exit 2
  fi
  USER_HOME=$(getent passwd "$MCP_CONFIG_USER" | cut -d: -f6)
  [[ -n "$USER_HOME" && -d "$USER_HOME" ]] || { echo "[install] no home for $MCP_CONFIG_USER" >&2; exit 2; }
  HUB_FOR_MCP=$(grep '^AGENT_FLEET_HUB=' "$CONF_DIR/daemon.env" | cut -d= -f2-)
  : "${MCP_URL_ARG:=${HUB_FOR_MCP%/api/fleet/ws*}/mcp}"
  MCP_URL_ARG="${MCP_URL_ARG#wss://}"
  MCP_URL_ARG="${MCP_URL_ARG#ws://}"
  MCP_URL_ARG="https://${MCP_URL_ARG#https://}"
  MCP_URL_ARG="${MCP_URL_ARG#https://https://}"
  if [[ -z "$MCP_TOKEN_ARG" ]]; then
    read -r -s -p "MCP token (X-Vault-Token): " MCP_TOKEN_ARG; echo
  fi
  echo "[install] configuring MCP for user $MCP_CONFIG_USER (home=$USER_HOME)"
  sudo -u "$MCP_CONFIG_USER" \
    HOME="$USER_HOME" \
    bash "$INSTALL_DIR/packaging/common/vault-rag-setup" \
      --hub "$HUB_FOR_MCP" \
      --mcp-token-stdin \
      --mcp-url "$MCP_URL_ARG" \
      --vault-name "$VAULT_NAME_ARG" \
      --mcp-config "$USER_HOME/.claude.json" \
      --mcp-only <<< "$MCP_TOKEN_ARG"
fi

echo "[install] installing systemd unit"
cp "$INSTALL_DIR/packaging/linux/$UNIT_NAME" "/etc/systemd/system/$UNIT_NAME"
systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"

echo "[install] tailing journal for 5s to confirm start…"
sleep 1
journalctl -u "$UNIT_NAME" -n 20 --no-pager || true
echo
echo "[install] done. Manage with:"
echo "    systemctl status $UNIT_NAME"
echo "    journalctl -u $UNIT_NAME -f"
echo "    sudo $INSTALL_DIR/packaging/linux/uninstall.sh"
