# Configuration

Most of Control Tower is configured in the browser. Command-line flags and environment variables exist for operators.

## Command-line flags

```text
controltower [options]            (docker: pass the same options after the image name)

  --config, -c <file>   load a config.yaml at startup
  --model, -m <p/model> serve one model with credentials from the environment
  --policy <file>       apply a policy YAML (zones and gates) at startup
  --port, -p <n>        listen port (default 4000)
  --host <addr>         listen address (default 0.0.0.0)
  --detailed_debug      verbose logs (also --debug)
  --copy-to-postgres <url>  copy this install's SQLite data into an empty Postgres database, then exit
                        (with no URL: uses CT_DATABASE_URL)
  --support-bundle [file]  write a report for whoever helps you — version, settings by name,
                        database, health, error counts; no keys, prompts or names — then exit
  --version, -v         print the version
  --help, -h            this list
```

```bash
controltower --config config.yaml --port 4000                 # from source: pnpm start --config config.yaml
docker run -p 4000:4000 -e OPENAI_API_KEY ghcr.io/joshmaster2165/controltower --model openai/gpt-4.1-mini   # agents ask for openai/gpt-4.1-mini
```

`--num_workers` is accepted and ignored: Control Tower is one process; to scale, run [several instances](scaling.md) on a shared Postgres and Redis.

## Admin key

Set `CT_ADMIN_KEY` — or `general_settings.master_key` in a [config file](config-file.md) — and it becomes:

1. the **admin API bearer**: `Authorization: Bearer <admin key>` works on every `/admin/api/*` route and on the `/key/*` and `/model/*` management routes;
2. an **all-access key for model and tool calls** (it appears on the map as `master-key` once used);
3. the **console password** for the user `admin` (change the name with `UI_USERNAME`, or the password alone with `UI_PASSWORD`). On a fresh install this account is created for you, so the first-run screen is skipped — useful for platform deploys and CI.

Rotating the variable rotates all three at the next start; when the console password changes with it, sessions signed in with the old one end. Use a long random value (`sk-$(openssl rand -hex 32)`); the server warns about short ones.

## First-run setup

Until an admin exists, the server prints a **setup code** in its startup log, and an **Open** link that carries it (`http://localhost:4000/?setup=K7QM-4XTP-9HRD`). The setup page asks for the code and the link fills it in. Without the right code, setup is refused (`403 setup_code`), so someone who reaches a new install before you can't claim it. With Docker, `docker logs <container>` shows it.

- The code is derived from the master key, so every instance sharing a database prints the same one. `CT_SETUP_TOKEN` sets it yourself, for scripts that call `POST /admin/api/setup` (it is still printed in the log).
- Setup attempts are limited to 10 a minute per address (`429 rate_limited`).
- Only one setup can succeed. Afterwards `POST /admin/api/setup` answers `409 already_setup`, and the page is a sign-in.
- With `CT_ADMIN_KEY` set, a fresh install gets its admin sign-in from the key and has no setup page ([above](#admin-key)).

## Console sign-in and sessions

- **Sign-in attempts** are limited to `CT_LOGIN_RPM` a minute per email (default 10), and twice that per address. Over it, `429 rate_limited` with `retry-after`. With [Redis](scaling.md), the count is shared across instances.
- **Sessions** end after `CT_SESSION_TTL_MS` (7 days), or sooner after `CT_SESSION_IDLE_MS` without use (12 hours). The database keeps only a hash of each session cookie.
- **Cookies** are `HttpOnly`, `SameSite=Lax`, and `Secure` when the console is reached over HTTPS: `CT_PUBLIC_URL` starts with `https://`, or the request came in over HTTPS (directly, or through a proxy that sets `X-Forwarded-Proto`).
- **Security headers:** the console, the admin API and the gateway send `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, and `Strict-Transport-Security` over HTTPS. Console pages add a Content Security Policy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. Responses relayed from [HTTP APIs](http-apis.md) (`/http/…`) keep their own headers.
- **Live updates:** the console's WebSocket (`/admin/ws`) refuses a browser from another origin (close code `4403`). Behind a proxy that rewrites `Host`, set `CT_PUBLIC_URL` or pass `X-Forwarded-Host`.
- **Errors:** an unexpected server error answers `500 internal_error` with the request id; the details are in the server's log, not the response.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CT_PORT` | `4000` | Listen port; falls back to `PORT` (set by most platforms). `--port` wins |
| `CT_HOST` | `0.0.0.0` | Listen address |
| `CT_DATA_DIR` | `./data` (`/data` in the image) | Database (SQLite) and master key |
| `CT_DATABASE_URL` | — | Postgres instead of SQLite (`postgres://…`): needed to [run several instances](scaling.md) |
| `CT_REDIS_URL` | — | Redis, to keep several instances on one Postgres database in step (rate limits, caches, live console) |
| `CT_INSTANCE_ID` | generated | This instance's name when several share a database |
| `CT_INSTANCE_TIMEOUT_MS` | `90000` | How long an instance may go without saying it is alive before the others treat it as stopped and close out its unfinished calls |
| `CT_DB_POOL` | `20` | Postgres connections per instance |
| `CT_MASTER_KEY` | generated | Base64 32-byte key encrypting stored credentials. If unset, generated into `CT_DATA_DIR/master.key` — back it up |
| `CT_ADMIN_KEY` | — | [Admin key](#admin-key) |
| `UI_USERNAME`, `UI_PASSWORD` | `admin`, the admin key | Console sign-in created from the admin key |
| `CT_SETUP_TOKEN` | derived from the master key | The [setup code](#first-run-setup) the first-run page asks for |
| `CT_LOGIN_RPM` | `10` | [Sign-in attempts](#console-sign-in-and-sessions) a minute per email; twice that per address |
| `CT_CONFIG` | — | [Config file](config-file.md) applied at every start. Also `CONFIG_FILE_PATH` or `--config` |
| `CT_POLICY` | — | [Policy file](policy-as-code.md#at-startup-gitops) applied at every start. Also `--policy` |
| `CT_POLICY_MODE` | `merge` | `replace` makes the policy match the file exactly |
| `CT_PUBLIC_URL` | detected | Public URL for links in alerts and approval messages. Detected on Render, Fly.io and Railway; otherwise `http://localhost:<port>` |
| `CT_DEMO` | `0` | `1` starts the demo fleet at boot (or use **Get started → Start the demo fleet**) |
| `CT_AUTO_MODELS` | `1` | Add a model the first time a connected provider is asked for it; `0` requires every model under **Models** |
| `CT_MODE` | `on` | `off` stops enforcing gates (everything is allowed and still recorded) — a kill switch |
| `CT_HOLD_BUDGET_MS` | `20000` | How long a request waits at an approval gate before becoming a ticket |
| `CT_A2A_PUSH_RELAY` | `on` | `off` lets A2A agents send push notifications straight to the caller's webhook instead of through Control Tower |
| `CT_PUSH_ALLOW_PRIVATE` | — | `1` lets relayed push notifications go to private, loopback and link-local addresses |
| `CT_MAX_HELD` | `500` | Most requests held at once; beyond it, requests get a ticket immediately |
| `CT_MODEL_HEALTH_INTERVAL_S` | `300` | How often models are [health-checked](providers-and-models.md#health-checks) in the background; `0` turns it off |
| `CT_SMTP_URL` | — | Default SMTP server for email alert channels: `smtp://user:password@host:587` or `smtps://…:465` |
| `CT_SMTP_FROM` | the SMTP user | *From* address for those emails, e.g. `Control Tower <tower@example.com>` |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | — | Send Control Tower's own outbound calls — to providers, MCP servers, HTTP APIs and alert channels — through a proxy. See [Install](install.md#behind-a-corporate-proxy) |
| `CT_METRICS_TOKEN` | — | Bearer token for Prometheus to scrape `/metrics` |
| `CT_LOG_LEVEL` | `info` (`debug` from source) | `debug`, `info`, `warn` or `error`. `--detailed_debug` works too |
| `CT_RETENTION_DAYS` | `30` | Days to keep flights (one row per request); `0` keeps them forever. Daily spend and usage history is always kept |
| `CT_EVENT_RETENTION_DAYS` | `7` | Days to keep each flight's event trail |
| `CT_LICENSE_KEY` | unset | A [Control Tower Enterprise](enterprise.md) license key. Set here, it can't be changed in the console |
| `CT_AUDIT_RETENTION_DAYS` | `365` | Days to keep the [audit log](audit.md) (`0` = forever). The oldest events go first, so the rest still verifies |
| `CT_SESSION_TTL_MS` | 7 days | Console session lifetime |
| `CT_SESSION_IDLE_MS` | 12 hours | A console session unused this long ends |
| `CT_UI_DIR` | `/app/ui` in the image | Serve the console from this directory (the built UI) |
| `CT_IN_CONTAINER` | `1` in the image | Tells the server it runs in a container, so it warns when `CT_DATA_DIR` is not on a volume |
| `CT_SHUTDOWN_GRACE_MS` | `15000` | How long streams may finish on shutdown |

Provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `AWS_ACCESS_KEY_ID`…) are read only by `--config`, `--model` and **Import config**; providers added in the console store their own credentials.

Variables other gateways use that don't apply here are reported at startup rather than silently ignored — for example `DATABASE_URL` (Control Tower uses SQLite in `CT_DATA_DIR`, or Postgres from `CT_DATABASE_URL`) and `STORE_MODEL_IN_DB` (models added in the console are always stored).
