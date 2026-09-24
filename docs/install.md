# Install

Control Tower is one process with one data directory: a SQLite database (`controltower.db`) and `master.key`, which encrypts the provider credentials you store. Run it however you run containers.

## Docker

```bash
docker run -d --name controltower \
  -p 4000:4000 \
  -v controltower-data:/data \
  ghcr.io/joshmaster2165/controltower:0.1.3
```

- **Tags:** `latest` is the newest release, `0.1.3` pins one, `main` follows the main branch.
- **Architectures:** `linux/amd64` and `linux/arm64`.
- **Data:** keep `/data` on a named volume (or a platform disk). Without one, Docker gives each new container an empty anonymous volume, so an upgrade starts from scratch. On platforms that ignore the image's `VOLUME`, the server warns at startup that `/data` is not on a volume.
- **Port:** 4000, or `PORT` / `CT_PORT` / `--port`.
- The container runs as a non-root user. If a platform mounts `/data` owned by root, the entrypoint fixes the ownership before dropping privileges.

Flags go after the image name, as with LiteLLM's image:

```bash
docker run -p 4000:4000 -v controltower-data:/data \
  -v $(pwd)/config.yaml:/app/config.yaml \
  -e LITELLM_MASTER_KEY=sk-1234 -e OPENAI_API_KEY=sk-… \
  ghcr.io/joshmaster2165/controltower --config /app/config.yaml --detailed_debug
```

See [Config file](config-file.md) for what the file can contain, and [Configuration](configuration.md) for every flag and environment variable.

## Docker Compose

```bash
docker compose -f deploy/docker-compose.yml up -d
```

[`deploy/docker-compose.yml`](../deploy/docker-compose.yml) runs the published image with a named volume and a restart policy. Uncomment `CT_DEMO`, `CT_PUBLIC_URL` or `CT_MASTER_KEY` as needed.

## Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/joshmaster2165/controltower)

[`render.yaml`](../render.yaml) deploys the published image on a Starter instance with a 1 GB disk mounted at `/data` (Render disks need a paid instance). Links in alerts use the `onrender.com` URL automatically.

## Fly.io

With [`flyctl`](https://fly.io/docs/flyctl/install/):

```bash
fly launch --config deploy/fly.toml --copy-config --no-deploy   # pick an app name and region
fly volumes create controltower_data --size 1
fly deploy --config deploy/fly.toml
```

[`deploy/fly.toml`](../deploy/fly.toml) mounts the volume at `/data` and health-checks `/healthz`.

## Railway

Railway runs the published image directly; the only extra step is a volume, so the database and master key survive redeploys.

1. In [Railway](https://railway.com/new), create a project and choose **Docker Image** as the source: `ghcr.io/joshmaster2165/controltower:latest` (or pin `:0.1.3`).
2. Right-click the service → **Attach Volume**, mount path **`/data`**. Railway mounts volumes as root; the image fixes the ownership at startup and still runs as a non-root user.
3. **Settings → Networking → Generate Domain.** Railway sets `PORT` and the image listens on it.
4. Optional: **Settings → Deploy → Healthcheck Path** `/healthz`.
5. Open the domain and create the admin account — or set `CT_ADMIN_KEY` under **Variables** first to skip that step and sign in as `admin`.

Links in alerts and approval messages use the Railway domain automatically (`RAILWAY_PUBLIC_DOMAIN`); set `CT_PUBLIC_URL` if you add a custom domain. To run from a LiteLLM-style config, build a small image `FROM ghcr.io/joshmaster2165/controltower` that copies in your `config.yaml`, set `CT_CONFIG` to its path, and put the provider keys in **Variables**.

## Any container platform

Use `ghcr.io/joshmaster2165/controltower`, mount a volume at `/data`, and send traffic to port 4000, or to the `PORT` the platform sets. Set `CT_PUBLIC_URL` to the public address so links in alerts and approval messages point at your console (detected automatically on Render, Fly.io and Railway).

Health checks:

| Path | Use |
|---|---|
| `/healthz`, `/health/liveliness`, `/health/liveness` | Liveness: the process is up |
| `/readyz`, `/health/readiness` | Readiness: accepting traffic (503 while shutting down) |
| `/health` | Checks every connected provider; needs the admin key or an agent key |

On `SIGTERM` the server stops accepting requests, turns every request waiting for approval into a ticket the agent can retry, lets streams finish (up to 15 s), then flushes and exits.

## From source

Needs Node 24 and pnpm.

```bash
git clone https://github.com/joshmaster2165/controltower && cd controltower
pnpm install
pnpm build                          # console, server bundle
pnpm start                          # http://localhost:4000
pnpm start --config config.yaml     # same flags as the container
```

For development: `CT_DEMO=1 pnpm dev` runs the server with reload, and `pnpm dev:ui` serves the console with hot reload on <http://localhost:5173>.

## Upgrading

Pull the new image and restart with the same volume. Database migrations run at startup, forward only. Take a copy of `/data` first if you want to be able to roll back.

```bash
docker pull ghcr.io/joshmaster2165/controltower:latest
docker rm -f controltower && docker run -d --name controltower -p 4000:4000 -v controltower-data:/data ghcr.io/joshmaster2165/controltower:latest
```

## Backups

Back up the whole data directory: `controltower.db` (and its `-wal` / `-shm` files while running) and `master.key`. Without `master.key`, the stored provider and tool-server credentials cannot be decrypted. Alternatively, supply the key yourself with `CT_MASTER_KEY` (base64, 32 bytes) and keep it in your secret store.
