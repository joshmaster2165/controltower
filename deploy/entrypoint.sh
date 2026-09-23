#!/bin/sh
# Starts as root only to hand the data directory to the unprivileged `node`
# user — volumes on platforms like Fly and Render are mounted root-owned —
# then drops privileges before Control Tower runs. Started as a non-root user
# (docker run --user …), it runs the command unchanged.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$CT_DATA_DIR"
  chown -R node:node "$CT_DATA_DIR"
  exec su-exec node "$@"
fi
exec "$@"
