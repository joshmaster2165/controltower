# Migrating from LiteLLM

Control Tower follows LiteLLM's proxy setup closely: the same `config.yaml`, the same flags, the same master key, the same client settings and the same key and model APIs. `e2e/litellm-parity.spec.ts` runs LiteLLM's documented steps against a real Control Tower with the official OpenAI, Anthropic and MCP SDKs on every commit.

What you gain is the map, gates on paths, human approvals, inspect gates and a data-flow inventory — for MCP tools and HTTP APIs as well as models.

## Step by step, side by side

| LiteLLM docs | Control Tower |
|---|---|
| **Quick start** — `litellm --model gpt-4o` | `controltower --model openai/gpt-4o` (from source: `pnpm start --model …`) |
| **Docker** — `docker run -v ./config.yaml:/app/config.yaml ghcr.io/berriai/litellm --config /app/config.yaml` | `docker run -v ./config.yaml:/app/config.yaml -p 4000:4000 ghcr.io/joshmaster2165/controltower --config /app/config.yaml` |
| **Config** — `model_list`, `litellm_params`, `os.environ/…`, `router_settings`, `litellm_settings.fallbacks`, `mcp_servers`, `general_settings` | Same file. Applied at every start as the source of truth. See [Config file](config-file.md) |
| **Master key** — `LITELLM_MASTER_KEY` or `general_settings.master_key` | Same. It is the admin API bearer, an all-access key and the console password for `admin`. `CT_ADMIN_KEY` is the native name. See [Configuration](configuration.md#admin-key) |
| **Virtual keys** — `POST /key/generate` | Same request and response, plus `/key/info`, `/key/update`, `/key/list`, `/key/delete`, `/key/block`, `/key/unblock`, `/key/regenerate` |
| **Model management** — `/model/info`, `/model/new`, `/model/delete` | Same. Models from the config file can't be deleted through the API |
| **Admin UI** — `/ui`, sign in with `UI_USERNAME` / `UI_PASSWORD` or the master key | `/ui` redirects to the console; sign in as `admin` with the master key. `UI_USERNAME` and `UI_PASSWORD` work |
| **Clients** — `base_url="http://0.0.0.0:4000"` | Works with and without `/v1` |
| **Headers** — `Authorization: Bearer`, `x-litellm-api-key`, Azure `api-key` | All accepted |
| **Claude Code** — `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | Same, including `/v1/messages/count_tokens` |
| **Health** — `/health/liveliness`, `/health/readiness`, `/health` | Same paths and response shapes |
| **Load balancing and fallbacks** — model groups, `order`, `weight`, `routing_strategy`, `fallbacks` | Become aliases with priority, weights and strategy. See [Providers and models](providers-and-models.md#aliases-load-balancing-and-fallbacks) |
| **Wildcards** — `openai/*`, `*` | Same: models are added the first time they are requested |
| **Budgets and rate limits** — `max_budget`, `budget_duration`, `rpm_limit`, `tpm_limit`, `max_parallel_requests` | Same fields on `/key/generate`. See [Keys](keys.md) |
| **MCP gateway** — `mcp_servers` with `auth_type`, `auth_value`, `static_headers`; `object_permission.mcp_servers` on keys | Same. Tools are namespaced `server__tool` at `/mcp`. See [MCP](mcp.md) |
| **Alerting** — `alerting: ["slack"]`, `alert_types`, `SLACK_WEBHOOK_URL` | Same, mapped to [alert rules](alerts.md#from-a-litellm-config) |
| **Prometheus** — `/metrics` | `/metrics` with a token; metric names differ (`controltower_*`). See [Monitoring](monitoring.md#prometheus-metrics) |
| **Logging** — `--detailed_debug`, `LITELLM_LOG=DEBUG` | Same |

## Move a running proxy

1. **Start Control Tower with your config.** Same file, same environment variables:

   ```bash
   docker run -d -p 4000:4000 -v controltower-data:/data \
     -v $(pwd)/config.yaml:/app/config.yaml \
     -e LITELLM_MASTER_KEY -e OPENAI_API_KEY -e ANTHROPIC_API_KEY \
     ghcr.io/joshmaster2165/controltower --config /app/config.yaml
   ```

   The startup log says what the file became and lists anything skipped.

2. **Bring your keys.** <a id="keys"></a>LiteLLM stores virtual keys hashed in its database, so they can't be read out. If you have the key values (your agents do), recreate them with the same value, so agents keep working unchanged:

   ```bash
   curl -X POST http://localhost:4000/key/generate \
     -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H "Content-Type: application/json" \
     -d '{"key": "sk-the-existing-key", "key_alias": "support-bot", "models": ["gpt-4o"], "max_budget": 50, "budget_duration": "30d"}'
   ```

   Otherwise generate new keys and hand them out; each key becomes one agent on the map.

3. **Point clients at Control Tower.** Change the host in `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`; nothing else changes.

4. **Look at the map.** Every agent, model and MCP tool it uses is on the [Airspace](airspace.md). Put gates on the paths that matter, [simulate them](airspace.md#simulate-before-you-enforce) against real traffic first, and export the result as [policy YAML](policy-as-code.md).

## What differs

- **Storage:** SQLite in `/data`, no Postgres. `DATABASE_URL`, `LITELLM_SALT_KEY` and `STORE_MODEL_IN_DB` aren't needed; the server says so if they're set. Credentials are encrypted with `/data/master.key` — back it up.
- **One process:** `--num_workers` does nothing; run more instances behind a load balancer if needed.
- **Not implemented yet:** `/spend/*`, team / user / organization endpoints, callbacks and guardrails from the config (use [inspect gates](airspace.md#put-a-gate-on-a-path)), `include` files, context-window and content-policy fallbacks, and LiteLLM's Prometheus metric names.
- **Keys** are `ct_sk_…` when Control Tower generates them; existing `sk-…` values are accepted when you bring them.
