#!/bin/sh
# Vortex publisher sidecar — container entrypoint.
# Runs as root (stock node image); prepares the feed volume, then hands off
# to server.mjs, which drops privileges to uid 1000 before serving.
set -eu

mkdir -p /data/public /data/work

# First boot: the named volume is root-owned; the server runs as uid 1000.
chown -R 1000:1000 /data

exec node /app/server.mjs
