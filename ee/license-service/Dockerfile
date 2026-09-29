# Control Tower Enterprise license service (Elastic License 2.0, see ../LICENSE). No dependencies: Node alone.
FROM node:24-alpine
WORKDIR /srv
COPY server.mjs ./server.mjs
COPY LICENSE ./LICENSE
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
