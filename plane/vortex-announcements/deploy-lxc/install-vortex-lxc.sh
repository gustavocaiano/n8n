#!/bin/sh
# Vortex announcements — native install for the n8n Proxmox LXC.
#
# Target: the community-script n8n LXC (n8n runs as a systemd service with
# EnvironmentFile=/opt/n8n.env; no docker compose). Installs the publisher
# sidecar and the nginx feed vhost as native services:
#
#   - /opt/vortex-publisher/server.mjs  + vortex-publisher.service (:8085)
#   - nginx on :80, default_server, vhost rendered from the repo template
#   - /etc/hosts alias  vortex-publisher -> 127.0.0.1  so the workflow's
#     http://vortex-publisher:8085/publish URL works unmodified
#   - /srv/feed -> /opt/vortex-data symlink so the template's alias path
#     (/srv/feed/public/latest.json) works unmodified
#   - VORTEX_* vars appended to /opt/n8n.env (tokens generated if missing)
#
# Usage:  scp -r plane/vortex-announcements root@<lxc>:/root/vortex-announcements
#         scp this script to the LXC, then as root:
#         sh install-vortex-lxc.sh /root/vortex-announcements
#
# Re-runnable. After changing VORTEX_FEED_READERS in /opt/n8n.env, re-run it
# (or: VORTEX_FEED_READERS="..." /usr/local/sbin/vortex-gen-readers && nginx -s reload).
#
# NOTE: restarts n8n at the end (brief webhook downtime) so it picks up the
# new VORTEX_* env vars for $env access.
set -eu

SRC=${1:-/root/vortex-announcements}
ENV_FILE=${ENV_FILE:-/opt/n8n.env}
DATA_DIR=${DATA_DIR:-/opt/vortex-data}
N8N_SVC=${N8N_SVC:-n8n.service}

fail() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail 'run as root'
[ -f "$SRC/publisher/server.mjs" ] || fail "missing $SRC/publisher/server.mjs — scp the vortex-announcements tree first"
[ -f "$SRC/nginx/templates/vortex-announcements.conf.template" ] || fail "missing template under $SRC"
[ -f "$SRC/nginx/entrypoint/25-vortex-readers.sh" ] || fail "missing reader script under $SRC"

NODE_BIN=${NODE_BIN:-$(command -v node || true)}
[ -n "$NODE_BIN" ] || fail 'node not found in PATH — is this the n8n LXC? (or set NODE_BIN=)'
command -v openssl >/dev/null || fail 'openssl not found'

# value of VAR from $ENV_FILE (last assignment, quotes stripped), or empty
get_env() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

echo '── 1/6 environment (/opt/n8n.env) ──'
touch "$ENV_FILE"
if [ -z "$(get_env VORTEX_PUBLISH_TOKEN)" ]; then
  printf '\n# ── Vortex announcements (added by install-vortex-lxc.sh) ──\nVORTEX_PUBLISH_TOKEN=%s\n' \
    "$(openssl rand -hex 32)" >> "$ENV_FILE"
  echo '  generated VORTEX_PUBLISH_TOKEN'
fi
if [ -z "$(get_env VORTEX_SIDECAR_TOKEN)" ]; then
  printf 'VORTEX_SIDECAR_TOKEN=%s\n' "$(openssl rand -hex 32)" >> "$ENV_FILE"
  echo '  generated VORTEX_SIDECAR_TOKEN'
fi
if ! grep -q '^VORTEX_FEED_READERS=' "$ENV_FILE"; then
  printf 'VORTEX_FEED_READERS=""\n' >> "$ENV_FILE"
  echo '  added VORTEX_FEED_READERS="" (PUBLIC feed) — set "user:pass ..." pairs to require auth'
fi
if ! grep -q '^VORTEX_FEED_AUTH_REALM=' "$ENV_FILE"; then
  printf 'VORTEX_FEED_AUTH_REALM="Vortex announcements"\n' >> "$ENV_FILE"
fi

echo '── 2/6 publisher sidecar (systemd) ──'
install -d /opt/vortex-publisher "$DATA_DIR"
install -m 644 "$SRC/publisher/server.mjs" /opt/vortex-publisher/server.mjs
cat > /etc/systemd/system/vortex-publisher.service <<EOF
[Unit]
Description=Vortex publisher sidecar (announcements feed writer)
After=network.target

[Service]
EnvironmentFile=$ENV_FILE
Environment=VORTEX_DATA_DIR=$DATA_DIR
ExecStart=$NODE_BIN /opt/vortex-publisher/server.mjs
Restart=always
RestartSec=2
# server.mjs chowns its data dir to uid 1000 and drops privileges itself.

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now vortex-publisher >/dev/null

# hosts alias so the workflow's http://vortex-publisher:8085 URL resolves
grep -q '[[:space:]]vortex-publisher\>' /etc/hosts || \
  printf '127.0.0.1 vortex-publisher\n' >> /etc/hosts

# wait for health
i=0
until curl -sf http://127.0.0.1:8085/healthz >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 20 ] && { systemctl status vortex-publisher --no-pager || true; fail 'sidecar did not become healthy'; }
  sleep 1
done
echo '  vortex-publisher healthy on :8085'

echo '── 3/6 feed directory symlink ──'
# template hardcodes alias /srv/feed/public/latest.json (container volume path)
[ -e /srv/feed ] || ln -s "$DATA_DIR" /srv/feed
echo "  /srv/feed -> $DATA_DIR"

echo '── 4/6 nginx feed vhost ──'
if ! command -v nginx >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx >/dev/null
fi
command -v curl >/dev/null || apt-get install -y -qq curl >/dev/null

# port 80 must be free or already nginx
if ss -ltn 2>/dev/null | grep -q ':80 '; then
  ss -ltnp 2>/dev/null | grep ':80 ' | grep -q nginx \
    || fail 'port 80 is occupied by something other than nginx'
fi

# reader map generator (writes /etc/nginx/conf.d/00-vortex-readers.conf —
# same include path on Debian nginx as in the container image)
install -m 755 "$SRC/nginx/entrypoint/25-vortex-readers.sh" /usr/local/sbin/vortex-gen-readers
VORTEX_FEED_READERS="$(get_env VORTEX_FEED_READERS)" /usr/local/sbin/vortex-gen-readers

# render the vhost: substitute the realm, everything else stays byte-identical
REALM="$(get_env VORTEX_FEED_AUTH_REALM)"
REALM=${REALM:-Vortex announcements}
case "$REALM" in *'|'*|*'"'*) fail 'VORTEX_FEED_AUTH_REALM must not contain | or " marks' ;; esac
sed -e "s|\${VORTEX_FEED_AUTH_REALM}|$REALM|g" \
  "$SRC/nginx/templates/vortex-announcements.conf.template" \
  > /etc/nginx/conf.d/vortex-announcements.conf

# Debian's default site also claims default_server on :80 — ours wins
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable --now nginx >/dev/null
systemctl reload nginx || systemctl restart nginx
echo '  nginx serving /vortex/latest.json on :80 (default_server)'

echo '── 5/6 n8n environment ──'
if ! systemctl cat "$N8N_SVC" >/dev/null 2>&1; then
  N8N_SVC=$(systemctl list-unit-files --type=service 2>/dev/null \
    | awk '{print $1}' | grep -ix '.\{0,8\}n8n.service' | head -1 || true)
  [ -n "$N8N_SVC" ] || fail "could not find the n8n systemd service (set N8N_SVC=...)"
fi
if ! systemctl cat "$N8N_SVC" | grep -q "^EnvironmentFile=$ENV_FILE"; then
  install -d "/etc/systemd/system/$N8N_SVC.d"
  printf '[Service]\nEnvironmentFile=%s\n' "$ENV_FILE" \
    > "/etc/systemd/system/$N8N_SVC.d/10-vortex-env.conf"
  systemctl daemon-reload
  echo "  added EnvironmentFile drop-in to $N8N_SVC"
fi
echo "  restarting $N8N_SVC (brief webhook downtime)…"
systemctl restart "$N8N_SVC"

echo '── 6/6 verification ──'
sleep 2
echo "  healthz : $(curl -s http://127.0.0.1:8085/healthz && echo)"
READERS="$(get_env VORTEX_FEED_READERS)"
if [ -n "$READERS" ]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/vortex/latest.json)
  FIRST=$(printf '%s' "$READERS" | awk '{print $1}')
  CODE_AUTH=$(curl -s -o /dev/null -w '%{http_code}' -u "$FIRST" http://127.0.0.1/vortex/latest.json)
  echo "  feed unauth : $CODE (expect 401)"
  echo "  feed authed : $CODE_AUTH (expect 200) as $FIRST"
  [ "$CODE" = 401 ] && [ "$CODE_AUTH" = 200 ] || fail 'feed auth check failed — inspect /etc/nginx/conf.d/'
else
  CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/vortex/latest.json)
  BODY=$(curl -s http://127.0.0.1/vortex/latest.json)
  echo "  feed public : $CODE (expect 200) body=$BODY"
  [ "$CODE" = 200 ] || fail 'public feed check failed'
fi

IP=$(hostname -I | awk '{print $1}')
cat <<EOF

Done. Remaining steps:

1. Proxy: on whatever fronts nodemation.nforensic.site, add a custom location
     /vortex  ->  http://$IP:80
   with NO path suffix (the public path /vortex/latest.json must pass through).
2. Activate the n8n workflow (UI toggle, or ask the assistant to publish it
   via MCP).
3. End-to-end test through https://nodemation.nforensic.site:
     feed GET (200/401 as configured), then publish -> replay -> conflict ->
     cancel per files/vortex-announcements/README.md §5.

Tokens live in $ENV_FILE (root-readable). To change readers later:
  edit VORTEX_FEED_READERS there, then re-run this script.
EOF
