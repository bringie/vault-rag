#!/bin/sh
# vt-0138: drop traffic from the public iface (ens3) to forgejo SSH on the
# vault-rag docker bridge. Idempotent.
#
# Install:
#   sudo install -m 0755 -o root -g root \
#     scripts/bin/firewall/vault-rag-firewall-apply.sh \
#     /usr/local/sbin/vault-rag-firewall-apply.sh
#   sudo install -m 0644 -o root -g root \
#     scripts/bin/firewall/vault-rag-firewall.service \
#     /etc/systemd/system/vault-rag-firewall.service
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now vault-rag-firewall.service
#
# Manual run:
#   sudo /usr/local/sbin/vault-rag-firewall-apply.sh
set -e
NET_ID=$(docker network inspect vault-rag-net --format "{{ .Id }}" 2>/dev/null | cut -c1-12)
if [ -z "$NET_ID" ]; then
  echo "vault-rag-net not found, skipping" >&2; exit 0
fi
BRIDGE="br-$NET_ID"
if /usr/sbin/nft list chain ip filter DOCKER-USER 2>/dev/null | grep -q "vt-0138"; then
  echo "rule already present"
  exit 0
fi
/usr/sbin/nft add rule ip filter DOCKER-USER iifname "ens3" oifname "$BRIDGE" tcp dport 22 drop comment \"vt-0138 block ext SSH to forgejo\"
echo "installed rule on $BRIDGE"
