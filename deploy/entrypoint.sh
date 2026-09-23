#!/bin/sh
# Starts as root only to hand the data directory to the unprivileged `node`
# user — volumes on platforms like Fly and Render are mounted root-owned —
# then drops privileges before Control Tower runs. Started as a non-root user
# (docker run --user …), it runs the command unchanged.
set -e
# `docker run <image> --config /app/config.yaml` (flags only, like LiteLLM's image): run the server with them.
case "${1:-}" in -*) set -- node dist/server.mjs "$@" ;; esac
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$CT_DATA_DIR"
  chown -R node:node "$CT_DATA_DIR"
  exec su-exec node "$@"
fi
exec "$@"
