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
| Prometheus | `CT_METRICS_TOKEN` (or any console session, or the admin key) | `Authorization: Bearer` |

```bash
export CT=http://localhost:4000
export ADMIN="Authorization: Bearer $CT_ADMIN_KEY"
curl -s $CT/admin/api/keys -H "$ADMIN"
```

Errors are JSON: `{"error": {"code": "…", "message": "…"}}` (the gateway uses the envelope of the API the client speaks). An unexpected failure is `500 internal_error`, with a message that gives the request id to look up in the server's log. Model, HTTP API and A2A responses carry `x-ct-flight-id`; MCP responses, `/v1/models` and `/v1/messages/count_tokens` don't. Every code is listed in [Troubleshooting](troubleshooting.md#the-agent-gets-an-error).

## Gateway

| Method | Path | |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI Chat Completions, streaming or not — to any provider (translated where needed) |
| POST | `/v1/responses` | OpenAI Responses API (Agents SDK, Codex) — to any provider (translated through Chat Completions where needed) |
| POST | `/v1/embeddings` | Embeddings |
| POST | `/v1/images/generations`, `/v1/images/edits`, `/v1/images/variations` | Images ([model APIs](model-apis.md)); edits and variations as multipart uploads |
| POST | `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/audio/translations` | Speech and transcription; transcriptions as multipart uploads |
| POST | `/v1/moderations`, `/v1/rerank` (`/v2/rerank`), `/v1/completions` | Moderation, rerank, legacy completions |
| POST | `/gemini/{version}/models/{model}:{method}` | [Gemini's own API](model-apis.md#geminis-own-api) (key as `x-goog-api-key` or `?key=`) |
| POST | `/bedrock/model/{modelId}/{operation}` | [Bedrock's runtime API](model-apis.md#bedrocks-runtime-api): `converse`, `converse-stream`, `invoke`, `invoke-with-response-stream` |
| GET | `/v1/models`, `/v1/models/:id` | The models this key may use |
| POST | `/v1/messages` | Anthropic Messages API (Claude Code, Anthropic SDKs) |
| POST | `/v1/messages/count_tokens` | Token counting — exact from Anthropic, estimated elsewhere |
| POST | `/openai/deployments/:model/chat/completions`, `…/embeddings` | Azure OpenAI style |
| POST, DELETE | `/mcp`, `/mcp/:slug` | MCP (Streamable HTTP): every server, or one. `GET` answers `405`: Control Tower doesn't open server-initiated streams |
| any | `/http/:slug/*` | A [registered HTTP API](http-apis.md) |
| GET | `/a2a` | The [A2A agents](a2a.md) this key may reach |
| GET | `/a2a/:slug/.well-known/agent-card.json` | An A2A agent's card, pointing at Control Tower |
| POST | `/a2a/:slug` | A2A JSON-RPC: `SendMessage`, `GetTask`, … (1.0) or `message/send`, … (0.3) |
| POST | `/v1/delegation/renew` | Renew a delegation token (`x-ct-delegation` header or `{"token"}`) for the agent it was issued to: `{token, expires_at}` — see [Agents calling agents](agent-to-agent.md#long-tasks-renew-the-token) |
| POST | `/v1/observe` | Report calls made outside the gateway |
| POST | `/v1/traces` | OpenTelemetry traces (OTLP/HTTP JSON) |

The OpenAI routes also answer without `/v1`. Requests may carry `x-ct-tags`, `x-ct-customer`, `x-ct-region` and `x-ct-cache` ([tags and customers](keys.md#tags-and-customers), [caching](providers-and-models.md#caching-answers)), a W3C `traceparent` (Control Tower's [spans](exports.md#spans-in-your-agents-traces) join the agent's trace), `x-ct-delegation` ([agents calling agents](agent-to-agent.md)) and `x-ct-session`.

Requests held for approval are retried with `x-ct-approval: <ticket>` (MCP also takes `params._meta.ct_approval`, A2A `params.metadata.ct_approval`); the HTTP gateway also returns the ticket in an `x-ct-approval-ticket` header. On model calls, `x-ct-session` (or the request's `user` or `metadata.user_id`) names the agent's session: a duplicate retry within 5 seconds with the same ticket and session goes through on the same approval instead of asking for a new one. See [Approvals](airspace.md#approvals-the-tower).

## Admin API

All paths are under `/admin/api`. Approvers and viewers may read any of them (except `/users` and `/audit`); only admins change anything, except that approvers decide approvals and everyone may change their own password.

### Session

| Method | Path | |
|---|---|---|
| GET | `/status` | `{setup_complete}` without a session; signed in (or with the admin key), also the version and more |
| POST | `/setup` | First run: create the admin (`{email, password, setup_code}`). `403 setup_code` without the [setup code](configuration.md#first-run-setup) from the server's log, `409 already_setup` once done; 10 attempts a minute per address |
| POST | `/login` | Start a console session (`{email, password}`); `CT_LOGIN_RPM` attempts a minute per email, twice that per address (`429 rate_limited`) |
| POST | `/logout` | End it |
| GET | `/me` | The signed-in person, their `role` and the CSRF token |
| POST | `/me/password` | Change your own password (`{current, password}`) |
| GET, POST | `/users` | People who sign in, and their roles (admins only); add one — see [People and roles](people.md) |
| PATCH, DELETE | `/users/:id` | Change a role, reset a password (a new one-time password), remove |
| GET | `/audit`, `/audit/export`, `/audit/verify` | The [audit log](audit.md) (admins only): browse with filters, download as CSV or JSON Lines, check its hash chain |

### Providers, models, aliases

| Method | Path | |
|---|---|---|
| GET | `/catalog` | Provider catalogue and credential fields |
| GET, POST | `/providers` | List, connect (`{catalog_id, name?, slug?, base_url?, credentials}`) |
| PATCH, DELETE | `/providers/:id` | Update, remove |
| POST | `/providers/:id/test` | Test the connection |
| GET | `/providers/:id/models` | Models the provider offers |
| GET, POST | `/deployments` | List, add (`{provider_id, upstream_model, public_name?, pricing_override?, caps?}`) |
| POST | `/deployments/check`, `/deployments/:id/check` | [Health-check](providers-and-models.md#health-checks) every model now, or one with a real one-token call |
| DELETE | `/cache` | Forget every [cached answer](providers-and-models.md#caching-answers) |
| PATCH, DELETE | `/deployments/:id` | Update (enable, rename, price, `caps`: region, tags, context, rpm, tpm, max_parallel, headers_timeout_ms, `health_probe` (health-check with a real one-token call), `mode` (`embedding` for an embeddings model), and for a deployment called by name `fallbacks`, `retry`, `cache`; `null` clears one), remove |
| GET, POST | `/aliases` | List, add (`{name, strategy, targets: [{deployment_id, priority, weight}], config?}`); `config`: `{fallbacks: {context_window, content_policy, default}, retry: {rate_limited, timeout, server_error, unreachable, max_attempts}, cache: {ttl_s, shared}}` — see [retries and fallback models](providers-and-models.md#when-a-call-fails-retries-and-fallback-models) |
| PUT, DELETE | `/aliases/:id` | Replace, remove |
| GET | `/pricing` | The price table |

### Keys and budgets

| Method | Path | |
|---|---|---|
| GET, POST | `/keys` | List, create — see [fields](keys.md#more-controls-api). The secret is returned once |
| PATCH, DELETE | `/keys/:id` | Update limits, budget, expiry, enable / disable; delete |
| POST | `/keys/bulk` | Disable or delete many keys: `{action: "disable" \| "delete", ids: [...]}` (up to 5,000; Control Tower's own keys are skipped) |
| GET, PUT | `/keys/retire-policy` | [Retire keys unused for](keys.md#agents-that-come-and-go) N days: `{idle_days: 0 \| 7 \| 30 \| 90}` (`0` is never); a PUT retires what is already idle and lists it |
| GET | `/budgets` | Every budget with spend, and the known teams and projects |
| PUT, DELETE | `/budgets/:type/:id` | Set or remove a `key`, `team`, `project` or `customer` budget (`{limit_usd, period, hard}`) |
| GET | `/customers?window=24h\|7d\|30d` | End customers with their requests, agents, spend and budget ([tags and customers](keys.md#tags-and-customers)) |
| PUT, DELETE | `/customers/:id` | Name, block or unblock a customer (`{name?, blocked?, note?}`); forget it |
| GET | `/ledger/tags?window=…` | Spend by the tags requests carried |

### Tool servers

| Method | Path | |
|---|---|---|
| GET, POST | `/mcp/servers` | List, register (`{name, slug, url, auth?: {type: "bearer", token} \| {type: "headers", headers}}`) |
| PATCH, DELETE | `/mcp/servers/:id` | Update, remove |
| POST | `/mcp/servers/:id/test` | Connect and refresh the tool list |
| GET, POST | `/http/apis` | List, register an [HTTP API](http-apis.md) (`{name, slug?, base_url, auth?: {type: "bearer", token} \| {type: "header", header, token}, agent_id?}`) |
| PATCH, DELETE | `/http/apis/:id` | Update, remove |
| POST | `/http/apis/:id/test` | Check it is reachable |
| GET, POST | `/a2a/agents` | List, register an A2A agent (`{name, slug?, url, auth?, agent_id?}`; `url` is its card or base URL) |
| PATCH, DELETE | `/a2a/agents/:id` | Update, remove |
| POST | `/a2a/agents/:id/test` | Read its card again |

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
| GET | `/approval-windows` | Open [approval windows](airspace.md#approve-the-next-n-calls), with calls and time left |
| POST | `/grants/:id/revoke` | Revoke a grant before it is used, or end a window (admins only) |

### Exports

| Method | Path | |
|---|---|---|
| GET, POST | `/exports` | List destinations with delivery counts; add one (`{name, kind: otlp \| datadog \| splunk \| s3 \| webhook, config}`) — see [Exporting flights](exports.md) |
| PATCH, DELETE | `/exports/:id` | Rename, pause (`enabled`), change settings (secrets left out are kept); remove |
| POST | `/exports/test` | Send an example record: `{id}` for a saved destination, or `{kind, config}` |
| POST | `/exports/:id/flush` | Send what is waiting now |

### Guardrail services

| Method | Path | |
|---|---|---|
| GET, POST | `/guardrail-services` | List (with the gates using each), add (`{name, kind, config}`) — see [Guardrail services](guardrails.md#api) |
| PATCH, DELETE | `/guardrail-services/:id` | Change (secrets left out are kept), turn off, remove (refused while a gate uses it) |
| POST | `/guardrail-services/test` | Try a service on a text |

### Alerts

| Method | Path | |
|---|---|---|
| GET, POST | `/alert-rules` | List, create — see [the body](alerts.md#api) |
| PATCH, DELETE | `/alert-rules/:id` | Update, remove |
| GET, POST | `/alert-channels` | List, create (`slack`, `webhook`, `email`) |
| PATCH, DELETE | `/alert-channels/:id` | Update, remove |
| POST | `/alert-channels/:id/test` | Send a test message |
| GET | `/alerts` | The inbox |
| POST | `/alerts/read` | Mark alerts read |

### Traffic, spend and the map

| Method | Path | |
|---|---|---|
| GET | `/flights` | Recent flights (`?limit`, `before`, `status`, `key_id`, `kind`; `for=<agent id>`: calls made on behalf of that agent anywhere up the chain; `trace=<flight id>`: every call in the same chain, from the call that started it to everything it led to). Each flight has `parent_flight_id` (the call that led to it) and `has_children` |
| GET | `/flights/:id` | One flight with its events |
| GET | `/events/recent` | The latest flight events |
| GET | `/replay` | Flights in a window, compact, for replay (`?from`, `to` in epoch ms) |
| GET | `/ledger/summary` | Spend, requests and tokens by key and model (`?window=1h\|24h\|7d\|30d`) |
| GET | `/topology` | Everything on the map: keys, models, servers, views, connections per agent and team (gzipped when accepted) |
| GET, PUT | `/airspace/layout` | The saved arrangement of the map |
| GET | `/airspace/agent-link?from=&to=&since=` | The calls behind an arc between two agents: `from` and `to` are comma-separated key ids, `since` epoch ms (default: 7 days). The caller's calls to the servers that front the callee, what each led to, and what the callee did on the caller's behalf |
| GET, POST | `/airspace/views` | [Views](airspace.md#views-one-part-of-the-organization-at-a-time): `{name, teams, color?}` |
| PATCH, DELETE | `/airspace/views/:id` | Change or remove a view |
| GET | `/export/dataflow` | The data-flow inventory (`?format=md\|csv`, `hours`) |
| GET (WebSocket) | `/admin/ws` | Live traffic for the console: a `tick` each second (totals, calls per path, gate hits) and `events` for held, denied and failed flights. Needs a session; a browser from another origin is refused (close code `4403`) |

### Setup helpers

| Method | Path | |
|---|---|---|
| POST | `/import/config/plan`, `/import/config/apply` | Import a [config file](config-file.md) once |
| POST, DELETE | `/demo` | Start or stop the demo fleet |
| POST | `/playground/chat` | Send a request from the console's playground |

## Key and model management API

With the admin key: `POST /key/generate`, `GET /key/info`, `POST /key/update`, `GET /key/list`, `POST /key/delete`, `POST /key/block`, `POST /key/unblock`, `POST /key/regenerate` (also `/key/:key/regenerate`), `GET /model/info` (also `/v1/model/info`), `POST /model/new`, `POST /model/delete`. See [Keys](keys.md#key-management-api).

`POST /model/new` takes one entry in the form of a [config file](config-file.md#model_list)'s `model_list`: `{model_name, params: {model: "<provider>/<model>", api_key?, api_base?, …}, model_info?}`. Credentials it leaves out are read from the usual environment variables; it reuses a provider with the same endpoint and credentials, and returns the new model's `model_id`. `POST /model/delete` takes `{id}`.

## Health and metrics

| Method | Path | |
|---|---|---|
| GET | `/healthz`, `/health/liveliness`, `/health/liveness` | Liveness |
| GET | `/readyz`, `/health/readiness` | Readiness. `/readyz` answers `{ok, shutting_down}`, and with the admin key also the event backlog, database and provider counts |
| GET | `/health` | Every connected provider checked (admin or agent key) |
| GET | `/metrics` | Prometheus: `CT_METRICS_TOKEN`, any console session or the admin key — see [Monitoring](monitoring.md#prometheus-metrics) |
| GET | `/ui` | Redirects to the console |
