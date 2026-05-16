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
PLIST_TMP=""
cleanup() { rm -rf "$TMP"; [[ -n "$PLIST_TMP" && -e "$PLIST_TMP" ]] && rm -f "$PLIST_TMP"; }
trap cleanup EXIT INT TERM
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

# Update env file. vt-0123: sed interpolation broke for tokens containing `|`,
# `&`, `\`, or newline — and chmod after sed left a race window where the new
# .env was readable at default umask before being tightened. Now: perl
# does a literal-string replacement and writes to a tempfile under umask 077,
# then atomic-mv to destination.
update_env_var() {
  local key="$1" val="$2"
  local tmp; tmp=$(mktemp -t agent-fleet-env.XXXXXX)
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
  chmod 0600 "$CONF_DIR/daemon.env"
}
if [[ -n "${AGENT_FLEET_HUB:-}" ]]; then
  update_env_var AGENT_FLEET_HUB "$AGENT_FLEET_HUB"
fi
if [[ -n "${AGENT_FLEET_TOKEN:-}" ]]; then
  update_env_var AGENT_FLEET_TOKEN "$AGENT_FLEET_TOKEN"
fi

echo "[install] generating LaunchAgent plist"
# launchd doesn't read env files — inline values from daemon.env into the plist.
HUB=$(grep '^AGENT_FLEET_HUB=' "$CONF_DIR/daemon.env" | cut -d= -f2-)
TOKEN=$(grep '^AGENT_FLEET_TOKEN=' "$CONF_DIR/daemon.env" | cut -d= -f2-)

# vt-0123: render plist via perl (literal substitution + XML-escape) into a
# tempfile created under umask 077, then atomic-mv to destination. Previously
# `sed | > $PLIST_DST` followed by `chmod 0600` left a race window where the
# plist contained the bearer token at default 0644.
PLIST_TMP=$(mktemp -t agent-fleet-plist.XXXXXX)
(
  umask 077
  INSTALL_DIR_V="$INSTALL_DIR" \
  CONF_DIR_V="$CONF_DIR" \
  STATE_DIR_V="$STATE_DIR" \
  LOG_DIR_V="$LOG_DIR" \
  HUB_V="$HUB" \
  TOKEN_V="$TOKEN" \
  HOST_NAME_V="$HOST_NAME" \
  TPL="$INSTALL_DIR/packaging/macos/com.fleet.daemon.plist" \
  OUT="$PLIST_TMP" \
  perl -e '
    use strict; use warnings;
    my %sub = (
      "__INSTALL_DIR__" => $ENV{INSTALL_DIR_V},
      "__CONF_DIR__"    => $ENV{CONF_DIR_V},
      "__STATE_DIR__"   => $ENV{STATE_DIR_V},
      "__LOG_DIR__"     => $ENV{LOG_DIR_V},
      "__HUB__"         => $ENV{HUB_V},
      "__TOKEN__"       => $ENV{TOKEN_V},
      "__HOST_NAME__"   => $ENV{HOST_NAME_V},
    );
    open(my $in, "<", $ENV{TPL}) or die "open tpl: $!";
    local $/; my $body = <$in>; close $in;
    for my $k (keys %sub) {
      my $v = defined $sub{$k} ? $sub{$k} : "";
      $v =~ s/&/&amp;/g; $v =~ s/</&lt;/g; $v =~ s/>/&gt;/g;
      $body =~ s/\Q$k\E/$v/g;
    }
    open(my $out, ">", $ENV{OUT}) or die "open out: $!";
    print $out $body; close $out;
  '
)
mv "$PLIST_TMP" "$PLIST_DST"
chmod 0600 "$PLIST_DST"
PLIST_TMP=""

echo "[install] loading LaunchAgent"
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load -w "$PLIST_DST"

sleep 1
echo
echo "[install] done. Manage with:"
echo "    launchctl print gui/\$(id -u)/com.fleet.daemon"
echo "    tail -f $LOG_DIR/agent-fleet-daemon.{out,err}.log"
echo "    bash $INSTALL_DIR/packaging/macos/uninstall.sh"
