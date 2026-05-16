#!/usr/bin/env bash
# Build daemon distribution artifacts:
#   dist/agent-fleet-daemon.tar.gz                                   — universal source tarball
#   dist/agent-fleet-daemon_<v>_amd64.deb                            — Debian/Ubuntu
#   dist/agent-fleet-daemon-<v>-1.x86_64.rpm                         — Fedora/RHEL
#
# Tarball is arch-independent (npm ci runs on the target host).
# .deb / .rpm declare dependency on nodejs ≥ 20 + npm; post-install hook
# runs the same install.sh path.
#
# Usage: bash agent-fleet/daemon/packaging/build.sh [--tarball|--deb|--rpm|--all]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"            # …/agent-fleet/daemon
PKG="$ROOT/packaging"
DIST="$ROOT/dist"
VERSION=$(node -p "require('$ROOT/package.json').version")

WHAT="${1:---all}"
mkdir -p "$DIST"

build_tarball() {
  echo "[build] tarball v$VERSION"
  local STAGE
  STAGE=$(mktemp -d)
  trap 'rm -rf "$STAGE"' RETURN
  mkdir -p "$STAGE/agent-fleet-daemon"
  cp -r "$ROOT/bin" "$ROOT/src" "$ROOT/package.json" "$ROOT/package-lock.json" \
        "$ROOT/README.md" "$STAGE/agent-fleet-daemon/"
  cp -r "$PKG" "$STAGE/agent-fleet-daemon/packaging"
  # NOTE: NOT bundling node_modules — target host runs `npm ci`. Avoids
  # cross-arch native-binary issues for node-pty.
  ( cd "$STAGE" && tar -czf "$DIST/agent-fleet-daemon.tar.gz" agent-fleet-daemon )
  echo "[build] → $DIST/agent-fleet-daemon.tar.gz ($(stat -c%s "$DIST/agent-fleet-daemon.tar.gz" 2>/dev/null || stat -f%z "$DIST/agent-fleet-daemon.tar.gz") bytes)"
}

build_deb() {
  command -v dpkg-deb >/dev/null || { echo "dpkg-deb not found — skip deb"; return; }
  echo "[build] deb v$VERSION"
  local STAGE
  STAGE=$(mktemp -d)
  trap 'rm -rf "$STAGE"' RETURN
  local PKGNAME="agent-fleet-daemon_${VERSION}_amd64"
  local ROOT_FS="$STAGE/$PKGNAME"

  mkdir -p "$ROOT_FS/opt/agent-fleet" \
           "$ROOT_FS/etc/agent-fleet" \
           "$ROOT_FS/etc/systemd/system" \
           "$ROOT_FS/DEBIAN"

  cp -r "$ROOT/bin" "$ROOT/src" "$ROOT/package.json" "$ROOT/package-lock.json" \
        "$ROOT/README.md" "$ROOT_FS/opt/agent-fleet/"
  cp -r "$PKG" "$ROOT_FS/opt/agent-fleet/packaging"
  cp "$PKG/common/daemon.env.template" "$ROOT_FS/etc/agent-fleet/daemon.env"
  cp "$PKG/linux/agent-fleet-daemon.service" "$ROOT_FS/etc/systemd/system/agent-fleet-daemon.service"

  cat > "$ROOT_FS/DEBIAN/control" <<EOF
Package: agent-fleet-daemon
Version: ${VERSION}
Section: admin
Priority: optional
Architecture: amd64
Depends: nodejs (>= 20), npm
Maintainer: bringie <dev@usedesk.com>
Description: agent-fleet per-host daemon
 Connects this host to an agent-fleet hub over WebSocket. Spawns and
 streams Claude / Codex / OpenCode CLI sessions on demand.
EOF

  cp "$PKG/linux/postinst.sh" "$ROOT_FS/DEBIAN/postinst"
  cp "$PKG/linux/prerm.sh"    "$ROOT_FS/DEBIAN/prerm"
  chmod 0755 "$ROOT_FS/DEBIAN/postinst" "$ROOT_FS/DEBIAN/prerm"

  ( cd "$STAGE" && dpkg-deb --build --root-owner-group "$PKGNAME" )
  mv "$STAGE/${PKGNAME}.deb" "$DIST/"
  echo "[build] → $DIST/${PKGNAME}.deb"
}

build_rpm() {
  command -v rpmbuild >/dev/null || { echo "rpmbuild not found — skip rpm"; return; }
  echo "[build] rpm v$VERSION"
  local BUILD
  BUILD=$(mktemp -d)
  trap 'rm -rf "$BUILD"' RETURN
  mkdir -p "$BUILD"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

  # Source tarball — rpmbuild expects a tarball at $sources matching Source0.
  local SRCSTAGE
  SRCSTAGE=$(mktemp -d)
  mkdir -p "$SRCSTAGE/agent-fleet-daemon-${VERSION}"
  cp -r "$ROOT/bin" "$ROOT/src" "$ROOT/package.json" "$ROOT/package-lock.json" \
        "$ROOT/README.md" "$SRCSTAGE/agent-fleet-daemon-${VERSION}/"
  cp -r "$PKG" "$SRCSTAGE/agent-fleet-daemon-${VERSION}/packaging"
  ( cd "$SRCSTAGE" && tar -czf "$BUILD/SOURCES/agent-fleet-daemon-${VERSION}.tar.gz" "agent-fleet-daemon-${VERSION}" )
  rm -rf "$SRCSTAGE"

  sed "s|@@VERSION@@|${VERSION}|g" "$PKG/linux/agent-fleet-daemon.spec" \
    > "$BUILD/SPECS/agent-fleet-daemon.spec"

  rpmbuild --define "_topdir $BUILD" -bb "$BUILD/SPECS/agent-fleet-daemon.spec"
  # spec is BuildArch: noarch → output lands in RPMS/noarch.
  cp "$BUILD"/RPMS/noarch/agent-fleet-daemon-${VERSION}-*.noarch.rpm "$DIST/"
  echo "[build] → $DIST/$(basename "$BUILD"/RPMS/noarch/agent-fleet-daemon-${VERSION}-*.noarch.rpm)"
}

case "$WHAT" in
  --tarball) build_tarball ;;
  --deb)     build_tarball; build_deb ;;
  --rpm)     build_tarball; build_rpm ;;
  --all|*)   build_tarball; build_deb; build_rpm ;;
esac
echo "[build] done — artifacts in $DIST"
