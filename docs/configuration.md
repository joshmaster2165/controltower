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
  --version             print the version
  --help                this list
```

```bash
controltower --config config.yaml --port 4000                 # from source: pnpm start --config config.yaml
docker run -p 4000:4000 -e OPENAI_API_KEY ghcr.io/joshmaster2165/controltower --model openai/gpt-4.1-mini   # agents ask for openai/gpt-4.1-mini
```

`--num_workers` is accepted and ignored: Control Tower is one process; run more instances to scale.

## Admin key

Set `CT_ADMIN_KEY` — or `general_settings.master_key` in a [config file](config-file.md) — and it becomes:

1. the **admin API bearer**: `Authorization: Bearer <admin key>` works on every `/admin/api/*` route and on the `/key/*` and `/model/*` management routes;
2. an **all-access key for model and tool calls** (it appears on the map as `master-key` once used);
3. the **console password** for the user `admin` (change the name with `UI_USERNAME`, or the password alone with `UI_PASSWORD`). On a fresh install this account is created for you, so the first-run screen is skipped — useful for platform deploys and CI.

Rotating the variable rotates all three at the next start. Use a long random value (`sk-$(openssl rand -hex 32)`); the server warns about short ones.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CT_PORT` | `4000` | Listen port; falls back to `PORT` (set by most platforms). `--port` wins |
| `CT_HOST` | `0.0.0.0` | Listen address |
| `CT_DATA_DIR` | `./data` (`/data` in the image) | Database and master key |
| `CT_MASTER_KEY` | generated | Base64 32-byte key encrypting stored credentials. If unset, generated into `CT_DATA_DIR/master.key` — back it up |
| `CT_ADMIN_KEY` | — | [Admin key](#admin-key) |
| `UI_USERNAME`, `UI_PASSWORD` | `admin`, the admin key | Console sign-in created from the admin key |
| `CT_CONFIG` | — | [Config file](config-file.md) applied at every start. Also `CONFIG_FILE_PATH` or `--config` |
| `CT_POLICY` | — | [Policy file](policy-as-code.md#at-startup-gitops) applied at every start. Also `--policy` |
| `CT_POLICY_MODE` | `merge` | `replace` makes the policy match the file exactly |
| `CT_PUBLIC_URL` | detected | Public URL for links in alerts and approval messages. Detected on Render, Fly.io and Railway; otherwise `http://localhost:<port>` |
| `CT_DEMO` | `0` | `1` starts the demo fleet at boot (or use **Get started → Start the demo fleet**) |
| `CT_AUTO_MODELS` | `1` | Add a model the first time a connected provider is asked for it; `0` requires every model under **Models** |
| `CT_MODE` | `on` | `off` stops enforcing gates (everything is allowed and still recorded) — a kill switch |
| `CT_HOLD_BUDGET_MS` | `20000` | How long a request waits at an approval gate before becoming a ticket |
| `CT_MAX_HELD` | `500` | Most requests held at once; beyond it, requests get a ticket immediately |
| `CT_SMTP_URL` | — | Default SMTP server for email alert channels: `smtp://user:password@host:587` or `smtps://…:465` |
| `CT_SMTP_FROM` | the SMTP user | *From* address for those emails, e.g. `Control Tower <tower@example.com>` |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | — | Send Control Tower's own outbound calls — to providers, MCP servers, HTTP APIs and alert channels — through a proxy. See [Install](install.md#behind-a-corporate-proxy) |
| `CT_METRICS_TOKEN` | — | Bearer token for Prometheus to scrape `/metrics` |
| `CT_LOG_LEVEL` | `info` (`debug` from source) | `debug`, `info`, `warn` or `error`. `--detailed_debug` works too |
| `CT_RETENTION_DAYS` | `30` | Days to keep flights (one row per request); `0` keeps them forever. Daily spend and usage history is always kept |
| `CT_EVENT_RETENTION_DAYS` | `7` | Days to keep each flight's event trail |
| `CT_SESSION_TTL_MS` | 7 days | Console session lifetime |
| `CT_SHUTDOWN_GRACE_MS` | `15000` | How long streams may finish on shutdown |

Provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `AWS_ACCESS_KEY_ID`…) are read only by `--config`, `--model` and **Import config**; providers added in the console store their own credentials.

Variables other gateways use that don't apply here are reported at startup rather than silently ignored — for example `DATABASE_URL` (Control Tower uses SQLite in `CT_DATA_DIR`) and `STORE_MODEL_IN_DB` (models added in the console are always stored).
