Name:           agent-fleet-daemon
Version:        @@VERSION@@
Release:        1%{?dist}
Summary:        agent-fleet per-host daemon
License:        MIT
URL:            https://github.com/bringie/vault-rag
Source0:        %{name}-%{version}.tar.gz
BuildArch:      noarch
Requires:       nodejs >= 20
Requires:       npm
Requires:       systemd

%description
Connects this host to an agent-fleet hub over WebSocket.
Spawns and streams Claude / Codex / OpenCode CLI sessions on demand.

%prep
%setup -q

%install
mkdir -p %{buildroot}/opt/agent-fleet
cp -r bin src package.json package-lock.json README.md %{buildroot}/opt/agent-fleet/
cp -r packaging %{buildroot}/opt/agent-fleet/

mkdir -p %{buildroot}/usr/lib/systemd/system
install -m 0644 packaging/linux/agent-fleet-daemon.service %{buildroot}/usr/lib/systemd/system/

mkdir -p %{buildroot}/etc/agent-fleet
install -m 0640 packaging/common/daemon.env.template %{buildroot}/etc/agent-fleet/daemon.env

%files
%dir /opt/agent-fleet
/opt/agent-fleet/*
/usr/lib/systemd/system/agent-fleet-daemon.service
%config(noreplace) /etc/agent-fleet/daemon.env

%post
USER_NAME=agentfleet
STATE_DIR=/var/lib/agent-fleet
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /sbin/nologin \
    --home-dir "$STATE_DIR" "$USER_NAME"
fi
mkdir -p "$STATE_DIR"
chown -R "$USER_NAME":"$USER_NAME" "$STATE_DIR" /opt/agent-fleet
chown root:"$USER_NAME" /etc/agent-fleet/daemon.env 2>/dev/null || true
chmod 0640 /etc/agent-fleet/daemon.env 2>/dev/null || true
if command -v npm >/dev/null 2>&1; then
  ( cd /opt/agent-fleet && npm ci --omit=dev --no-audit --no-fund ) || \
    echo "[postinst] WARN: npm ci failed — install manually"
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable agent-fleet-daemon.service >/dev/null 2>&1 || true
  if grep -q '^AGENT_FLEET_TOKEN=.\+' /etc/agent-fleet/daemon.env 2>/dev/null; then
    systemctl start agent-fleet-daemon.service || true
  fi
fi

%preun
if [ $1 -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
  systemctl stop agent-fleet-daemon.service 2>/dev/null || true
  systemctl disable agent-fleet-daemon.service 2>/dev/null || true
fi

%postun
if [ $1 -ge 1 ] && command -v systemctl >/dev/null 2>&1; then
  systemctl try-restart agent-fleet-daemon.service 2>/dev/null || true
fi

%changelog
* Fri May 16 2026 bringie <dev@usedesk.com> - @@VERSION@@-1
- Initial RPM packaging.
