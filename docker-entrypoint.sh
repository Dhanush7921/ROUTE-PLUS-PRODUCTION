#!/bin/sh
# Make the database directory usable, then run the app as the non-root user.
#
# Why this exists: the image creates /data and gives it to `routeplus` at BUILD
# time, but a platform volume (Railway, Fly, a plain docker -v mount) is
# attached at RUN time and its own ownership replaces that. A non-root process
# then cannot write and ROUTE+ stops with DB_NOT_WRITABLE. So: if we start as
# root, fix the directory and drop privileges; if we are already unprivileged,
# just run. If no privilege-dropping tool is present we still start — the app
# refusing to write is a worse outcome than running as the user we were given.
set -e

DB="${ROUTE_PLUS_DB:-/data/routeplus.sqlite}"
DIR=$(dirname "$DB")
mkdir -p "$DIR" 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  chown -R routeplus:routeplus "$DIR" 2>/dev/null || true
  if command -v su-exec >/dev/null 2>&1; then exec su-exec routeplus "$@"; fi
  if command -v gosu    >/dev/null 2>&1; then exec gosu    routeplus "$@"; fi
  if command -v setpriv >/dev/null 2>&1 && id routeplus >/dev/null 2>&1; then
    exec setpriv --reuid=routeplus --regid=routeplus --init-groups "$@"
  fi
fi

exec "$@"
