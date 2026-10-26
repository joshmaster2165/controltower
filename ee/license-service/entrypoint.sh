#!/bin/sh
# Starts as root only to hand the trials folder (a volume, mounted root-owned) to the unprivileged `node` user,
# then runs the service as `node`.
set -e
if [ "$(id -u)" = "0" ]; then
  if [ -n "$DATA_DIR" ]; then mkdir -p "$DATA_DIR" && chown -R node:node "$DATA_DIR"; fi
  exec su-exec node "$@"
fi
exec "$@"
