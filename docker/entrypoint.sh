#!/bin/sh
set -eu

# Map the runtime UID/GID to PUID/PGID from the environment so that
# files written by the app (SQLite DB, mirrored music files) land with
# correct ownership on the Unraid host.
#
# su-exec accepts numeric UID:GID directly, so we skip the addgroup/adduser
# dance entirely. This avoids failures when the requested IDs are already
# claimed by host-mapped groups (e.g. GID 100 = "users" on Unraid).
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
# UMASK controls permissions on files/dirs the app creates (e.g. mirrored music).
# Unraid users should set UMASK=000 so that all shares can read the copied files.
UMASK="${UMASK:-}"

# Make sure the data dir exists and is owned by the runtime user.
mkdir -p "${TUNEFETCH_DATA_DIR:-/app/data}"
chown -R "${PUID}:${PGID}" "${TUNEFETCH_DATA_DIR:-/app/data}"

# Apply umask before dropping privileges so file/dir creation inherits it.
if [ -n "$UMASK" ]; then
    umask "$UMASK"
fi

exec su-exec "${PUID}:${PGID}" "$@"
