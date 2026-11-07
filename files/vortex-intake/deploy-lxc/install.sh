#!/bin/sh
# Run inside the n8n community-script Proxmox LXC; no Docker or package upgrades.
# --check is read-only. --apply backs up, installs and starts the private adapter.
# n8n is NEVER restarted here: verify the adapter first, then restart n8n explicitly.
set -eu
umask 077
MODE=${1:---check}
SRC=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE=${ENV_FILE:-/opt/n8n.env}
fail() { echo "ERROR: $*" >&2; exit 1; }
case "$MODE" in --check|--apply) ;; *) fail 'usage: install.sh [--check|--apply]' ;; esac
[ "$(id -u)" = 0 ] || fail 'run as root inside the n8n LXC'
for cmd in node systemctl getent curl python3 tar install useradd ss systemd-analyze; do
  command -v "$cmd" >/dev/null || fail "missing command: $cmd"
done
[ -x /usr/bin/node ] || fail 'expected /usr/bin/node (no runtime upgrade is performed)'
/usr/bin/node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1); require("node:sqlite")' 2>/dev/null \
  || fail 'Node >=24 with node:sqlite is required'
systemctl is-active --quiet n8n.service || fail 'n8n.service must already be running'
systemctl show n8n.service -p EnvironmentFiles --value | grep -F "$ENV_FILE " >/dev/null \
  || fail 'n8n.service must already use the selected environment file'
[ -f "$ENV_FILE" ] || fail 'missing n8n environment file'
node "$SRC/deploy-lxc/configure.mjs" --check "$ENV_FILE"
if getent ahostsv4 vortex-intake >/dev/null; then
  [ "$(getent ahostsv4 vortex-intake | awk '{print $1}' | sort -u)" = 127.0.0.1 ] \
    || fail 'vortex-intake already resolves elsewhere; do not create a second adapter'
fi
# Never take over an existing listener that is not our service.
if [ -n "$(ss -H -ltn 'sport = :8086')" ]; then
  systemctl is-active --quiet vortex-intake.service || fail 'port 8086 has an unmanaged adapter'
fi
systemd-analyze verify "$SRC/deploy-lxc/vortex-intake.service"
[ "$MODE" = --apply ] || { echo 'Preflight OK; no files or services changed'; exit 0; }

BACKUP=$(mktemp -d /var/backups/vortex-intake-XXXXXXXX)
echo "Backup: $BACKUP"
# Store only existing files, including the original n8n env for disaster recovery.
# Do not print it or automatically restore unrelated later n8n configuration.
python3 - "$BACKUP" "$ENV_FILE" <<'PY'
from pathlib import Path
import sys
paths = [sys.argv[2], '/etc/hosts', '/etc/vortex-intake', '/opt/vortex-intake',
         '/etc/systemd/system/vortex-intake.service',
         '/etc/systemd/system/n8n.service.d/30-vortex-intake.conf']
Path(sys.argv[1], 'files.txt').write_text(''.join(p.lstrip('/') + '\n' for p in paths if Path(p).exists()))
PY
tar -C / -czf "$BACKUP/config-code.tgz" -T "$BACKUP/files.txt"
(systemctl is-active vortex-intake.service || true) > "$BACKUP/was-active"
(systemctl is-enabled vortex-intake.service || true) > "$BACKUP/was-enabled" 2>/dev/null
# Drain before a consistent SQLite/WAL + private logs backup; never reset state.
if systemctl is-active --quiet vortex-intake.service; then systemctl stop vortex-intake.service; fi
if [ -d /var/lib/vortex-intake ]; then
  tar -C /var/lib -czf "$BACKUP/data.tgz" vortex-intake
fi
# Any failure now leaves the workflow untouched; use the backup/runbook to recover.
getent passwd vortex-intake >/dev/null || useradd --system --user-group --home-dir /var/lib/vortex-intake --no-create-home --shell /usr/sbin/nologin vortex-intake
install -d -m 755 /opt/vortex-intake
install -d -m 700 /etc/vortex-intake
install -d -m 700 -o vortex-intake -g vortex-intake /var/lib/vortex-intake
install -m 644 "$SRC"/adapter/*.mjs /opt/vortex-intake/
node "$SRC/deploy-lxc/configure.mjs" --apply "$ENV_FILE"
install -m 644 "$SRC/deploy-lxc/vortex-intake.service" /etc/systemd/system/vortex-intake.service
install -d -m 755 /etc/systemd/system/n8n.service.d
printf '[Service]\nEnvironmentFile=/etc/vortex-intake/token.env\n' > /etc/systemd/system/n8n.service.d/30-vortex-intake.conf
chmod 644 /etc/systemd/system/n8n.service.d/30-vortex-intake.conf
if ! getent ahostsv4 vortex-intake >/dev/null; then
  printf '\n127.0.0.1 vortex-intake # vortex feedback private adapter\n' >> /etc/hosts
fi
systemctl daemon-reload
systemctl enable vortex-intake.service >/dev/null
systemctl restart vortex-intake.service
i=0
until curl --max-time 2 -sf http://127.0.0.1:8086/healthz >/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 15 ] || fail "adapter not healthy; consult journalctl -u vortex-intake and backup $BACKUP"
  sleep 1
done
echo 'Adapter healthy on 127.0.0.1:8086; n8n and its published workflow unchanged.'
echo 'Next: verify Plane access, then systemctl restart n8n.service to load the token.'
echo "Rollback instructions: $SRC/deploy-lxc/README.md; backup: $BACKUP"
