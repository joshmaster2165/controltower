# Control Tower Enterprise license service (Elastic License 2.0, see ../LICENSE). No dependencies: Node alone.
FROM node:24-alpine
RUN apk add --no-cache su-exec
WORKDIR /srv
COPY server.mjs trials.mjs LICENSE ./
COPY entrypoint.sh /usr/local/bin/license-entrypoint
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Starts as root to hand DATA_DIR (the trials volume) to `node`, then runs as `node`.
ENTRYPOINT ["license-entrypoint"]
CMD ["node", "server.mjs"]
