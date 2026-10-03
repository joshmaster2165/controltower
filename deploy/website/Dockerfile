# Control Tower's landing page and docs (site/ with the built docs), served as static files.
# Deploy: node scripts/build-docs.mjs; copy this folder somewhere, `cp -RL site/. <there>/public/`, then from
# data/railway-test: railway up <there> --path-as-root --detach --no-gitignore -s website
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/
