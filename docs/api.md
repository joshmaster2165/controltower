# API reference

Control Tower serves three APIs on one port:

- the **gateway**, which agents call with their own key;
- the **admin API**, which the console uses and you can script;
- **health and metrics** endpoints for your platform.

## Authentication

| Caller | Credential | Header |
|---|---|---|
| Agents (gateway) | The agent's key, `ct_sk_…` | `Authorization: Bearer`, `x-api-key` or `api-key`; `x-ct-key` for HTTP APIs |
| Scripts (admin API) | The [admin key](configuration.md#admin-key) | `Authorization: Bearer <admin key>` |
| The console (admin API) | A session cookie from `POST /admin/api/login` | cookie plus `x-ct-csrf: <token from /admin/api/me>` on writes |
| Prometheus | `CT_METRICS_TOKEN` | `Authorization: Bearer` |

```bash
export CT=http://localhost:4000
export ADMIN="Authorization: Bearer $CT_ADMIN_KEY"
curl -s $CT/admin/api/keys -H "$ADMIN"
```

Errors are JSON: `{"error": {"code": "…", "message": "…"}}` (the gateway uses the envelope of the API the client speaks). Every gateway response carries `x-ct-flight-id`.

## Gateway

| Method | Path | |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI Chat Completions, streaming or not — to any provider (translated where needed) |
| POST | `/v1/responses` | OpenAI Responses API (Agents SDK, Codex) — OpenAI-wire providers |
| POST | `/v1/embeddings` | Embeddings |
| GET | `/v1/models`, `/v1/models/:id` | The models this key may use |
| POST | `/v1/messages` | Anthropic Messages API (Claude Code, Anthropic SDKs) |
| POST | `/v1/messages/count_tokens` | Token counting — exact from Anthropic, estimated elsewhere |
| POST | `/openai/deployments/:model/chat/completions`, `…/embeddings` | Azure OpenAI style |
| POST, GET, DELETE | `/mcp`, `/mcp/:slug` | MCP (Streamable HTTP): every server, or one |
| any | `/http/:slug/*` | A [registered HTTP API](http-apis.md) |
| POST | `/v1/observe` | Report calls made outside the gateway |
| POST | `/v1/traces` | OpenTelemetry traces (OTLP/HTTP JSON) |

The OpenAI routes also answer without `/v1`. Requests held for approval can be retried with `x-ct-approval: <ticket>`.

## Admin API

All paths are under `/admin/api`.

### Session

| Method | Path | |
|---|---|---|
| GET | `/status` | Version, whether setup is complete |
| POST | `/setup` | First run: create the admin (`{email, password}`) |
| POST | `/login`, `/logout` | Console session |
| GET | `/me` | The signed-in admin and the CSRF token |

### Providers, models, aliases

| Method | Path | |
|---|---|---|
| GET | `/catalog` | Provider catalogue and credential fields |
| GET, POST | `/providers` | List, connect (`{catalog_id, name?, slug?, base_url?, credentials}`) |
| PATCH, DELETE | `/providers/:id` | Update, remove |
| POST | `/providers/:id/test` | Test the connection |
| GET | `/providers/:id/models` | Models the provider offers |
| GET, POST | `/deployments` | List, add (`{provider_id, upstream_model, public_name?, pricing_override?}`) |
| PATCH, DELETE | `/deployments/:id` | Update (enable, rename, price), remove |
| GET, POST | `/aliases` | List, add (`{name, strategy, targets: [{deployment_id, priority, weight}]}`) |
| PUT, DELETE | `/aliases/:id` | Replace, remove |
| GET | `/pricing` | The price table |

### Keys and budgets

| Method | Path | |
|---|---|---|
| GET, POST | `/keys` | List, create — see [fields](keys.md#more-controls-api). The secret is returned once |
| PATCH, DELETE | `/keys/:id` | Update limits, budget, expiry, enable / disable; delete |
| GET | `/budgets` | Every budget with spend, and the known teams and projects |
| PUT, DELETE | `/budgets/:type/:id` | Set or remove a `key`, `team` or `project` budget (`{limit_usd, period, hard}`) |

### Tool servers

| Method | Path | |
|---|---|---|
| GET, POST | `/mcp/servers` | List, register (`{name, slug, url, auth?: {type: "bearer", token} \| {type: "headers", headers}}`) |
| PATCH, DELETE | `/mcp/servers/:id` | Update, remove |
| POST | `/mcp/servers/:id/test` | Connect and refresh the tool list |
| GET, POST | `/http/apis` | List, register an HTTP API |
| PATCH, DELETE | `/http/apis/:id` | Update, remove |
| POST | `/http/apis/:id/test` | Check it is reachable |

### Policy and approvals

| Method | Path | |
|---|---|---|
| GET | `/policy` | Zones, gates, enforcement state and approval stats |
| POST, PATCH, DELETE | `/zones`, `/zones/:id` | Zones |
| POST, PATCH, DELETE | `/rules`, `/rules/:id` | Gates |
| POST | `/policy/simulate` | Replay recent traffic through a draft gate |
| GET | `/policy/export` | [Policy as YAML](policy-as-code.md) (`?format=json` for JSON) |
| POST | `/policy/import` | Preview or apply a policy file (`{yaml, mode, apply}`) |
| GET | `/guardrails/detectors` | Detectors available to inspect gates |
| GET | `/approvals`, `/approvals/:id` | Approval requests (`?status=pending`) |
| POST | `/approvals/:id/decide` | `{action: "approve" \| "deny", note?}` |
| GET | `/grants` | Grants issued by approvals |
| POST | `/grants/:id/revoke` | Revoke one before it is used |

### Alerts

| Method | Path | |
|---|---|---|
| GET, POST | `/alert-rules` | List, create |
| PATCH, DELETE | `/alert-rules/:id` | Update, remove |
| GET, POST | `/alert-channels` | List, create (`slack`, `webhook`, `email`) |
| PATCH, DELETE | `/alert-channels/:id` | Update, remove |
| POST | `/alert-channels/:id/test` | Send a test message |
| GET | `/alerts` | The inbox |
| POST | `/alerts/read` | Mark alerts read |

### Traffic, spend and the map

| Method | Path | |
|---|---|---|
| GET | `/flights` | Recent flights (`?limit`, `before`, `status`, `key_id`, `kind`) |
| GET | `/flights/:id` | One flight with its events |
| GET | `/events/recent` | The latest flight events |
| GET | `/replay` | Flights in a window, compact, for replay (`?from`, `to` in epoch ms) |
| GET | `/ledger/summary` | Spend, requests and tokens by key and model (`?window=1h\|24h\|7d\|30d`) |
| GET | `/topology` | Everything on the map: keys, models, servers, views, connections per agent and team (gzipped when accepted) |
| GET, PUT | `/airspace/layout` | The saved arrangement of the map |
| GET, POST | `/airspace/views` | [Views](airspace.md#views-one-part-of-the-organization-at-a-time): `{name, teams, color?}` |
| PATCH, DELETE | `/airspace/views/:id` | Change or remove a view |
| GET | `/export/dataflow` | The data-flow inventory (`?format=md\|csv`, `hours`) |
| GET (WebSocket) | `/admin/ws` | Live traffic for the console: a `tick` each second (totals, calls per path, gate hits) and `events` for held, denied and failed flights |

### Setup helpers

| Method | Path | |
|---|---|---|
| POST | `/import/config/plan`, `/import/config/apply` | Import a [config file](config-file.md) once |
| POST, DELETE | `/demo` | Start or stop the demo fleet |
| POST | `/playground/chat` | Send a request from the console's playground |

## Key and model management API

With the admin key: `POST /key/generate`, `GET /key/info`, `POST /key/update`, `GET /key/list`, `POST /key/delete`, `POST /key/block`, `POST /key/unblock`, `POST /key/regenerate` (also `/key/:key/regenerate`), `GET /model/info` (also `/v1/model/info`), `POST /model/new`, `POST /model/delete`. See [Keys](keys.md#key-management-api).

## Health and metrics

| Method | Path | |
|---|---|---|
| GET | `/healthz`, `/health/liveliness`, `/health/liveness` | Liveness |
| GET | `/readyz`, `/health/readiness` | Readiness |
| GET | `/health` | Every connected provider checked (admin or agent key) |
| GET | `/metrics` | Prometheus — see [Monitoring](monitoring.md#prometheus-metrics) |
