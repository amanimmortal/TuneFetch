#!/bin/sh
set -eu

# Map the runtime UID/GID to PUID/PGID from the environment so that
# files written by the app (SQLite DB, mirrored music files) land with
# correct ownership on the Unraid host. Default matches the image
# user created in the Dockerfile.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# Re-create the tunefetch group/user with the requested IDs if they
# differ from the image defaults.
current_uid="$(id -u tunefetch 2>/dev/null || echo '')"
current_gid="$(getent group tunefetch | awk -F: '{print $3}' 2>/dev/null || echo '')"

if [ "$current_gid" != "$PGID" ]; then
  # delgroup then addgroup to avoid GID conflicts.
  delgroup tunefetch 2>/dev/null || true
  addgroup -g "$PGID" -S tunefetch
fi

if [ "$current_uid" != "$PUID" ]; then
  deluser tunefetch 2>/dev/null || true
  adduser -u "$PUID" -S -G tunefetch tunefetch
fi

# Make sure the data dir exists and is owned by the runtime user.
mkdir -p "${TUNEFETCH_DATA_DIR:-/app/data}"
chown -R tunefetch:tunefetch "${TUNEFETCH_DATA_DIR:-/app/data}"

exec su-exec tunefetch:tunefetch "$@"
