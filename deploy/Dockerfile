# syntax=docker/dockerfile:1.7
# Control Tower — single-container image. Build from the repo root:
#   docker build -f deploy/Dockerfile -t controltower .
# Multi-arch:
#   docker buildx build --platform linux/amd64,linux/arm64 -f deploy/Dockerfile -t ghcr.io/<org>/controltower:latest --push .

# ---------- build ----------
FROM node:24-alpine AS build
RUN corepack enable && apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY ui/package.json ui/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY shared ./shared
COPY server ./server
COPY ui ./ui
RUN pnpm --filter @controltower/ui build && pnpm --filter @controltower/server build
# Plain node_modules with only the runtime native dependency (the server bundle externalises it).
RUN mkdir -p /out && cd /out && npm init -y >/dev/null \
 && npm install --no-audit --no-fund --omit=dev $(node -p "'better-sqlite3@' + require('/app/server/node_modules/better-sqlite3/package.json').version")

# ---------- runtime ----------
FROM node:24-alpine
RUN apk add --no-cache tini
WORKDIR /app
COPY --from=build /app/server/dist ./dist
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /app/ui/dist ./ui
COPY --from=build /app/server/package.json ./package.json
COPY LICENSE ./LICENSE
ENV NODE_ENV=production \
    CT_PORT=4000 \
    CT_HOST=0.0.0.0 \
    CT_DATA_DIR=/data \
    CT_UI_DIR=/app/ui
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CT_PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.mjs"]
