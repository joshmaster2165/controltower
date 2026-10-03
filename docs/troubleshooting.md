# Troubleshooting

Start with the flight. Model, HTTP API and A2A responses carry `x-ct-flight-id` (MCP responses, `/v1/models` and token counting don't; an MCP refusal carries `flight_id` in its text). Search for it under **Flights** to see which key made the call, where it was routed, which gate decided it and what the provider answered. Server logs are on stdout (`docker logs controltower`); `--detailed_debug` or `CT_LOG_LEVEL=debug` adds detail.

Asking for help? Attach a support bundle. It holds the version, settings by name, database state, health and the last day's error counts, and never includes keys, prompts or names: `docker exec controltower node dist/server.mjs --support-bundle > support-bundle.json`. See [SUPPORT.md](https://github.com/joshmaster2165/controltower/blob/main/SUPPORT.md).

## The agent gets an error

Every refusal has a code and a message meant to be read by the agent (or its model). On model calls and HTTP APIs, a key's rate-limit `429` also carries `retry-after`.

### Model calls

`/v1/…`, `/gemini/…` and `/bedrock/…`, in the error envelope of the API the client speaks.

| Code | Status | What it means | What to do |
|---|---|---|---|
| `invalid_api_key` | 401 | No key, or not one Control Tower knows | Send the agent's `ct_sk_…` key as `Authorization: Bearer` (OpenAI SDKs: `OPENAI_API_KEY`; Claude Code: `ANTHROPIC_AUTH_TOKEN`). A provider's own key (`sk-…` from OpenAI) won't work unless it was [brought over](keys.md#key-management-api) |
| `key_disabled`, `key_expired` | 401 | The key was disabled or has expired | **Keys** → enable it, or create a new one |
| `invalid_request` | 400 | The body isn't what the API expects: no `model`, no `messages` or `input`, a method the pass-through doesn't cover | The message names the field |
| `model_not_found` | 404 | No connected provider serves that name | Connect the provider that offers it, check the spelling, or pin it as `provider/model`. With `CT_AUTO_MODELS=0`, add the model under **Models** |
| `model_not_allowed` | 403 | The key's allowed models don't include it | Widen the key's allowed models, or use a model it allows |
| `customer_blocked` | 403 | The call's customer is blocked under **Ledger → Customers** | Unblock the customer, or send another one ([tags and customers](keys.md#tags-and-customers)) |
| `region_not_allowed` | 403 | The call asked for a region (`x-ct-region`) outside the key's `regions` | Ask for a region the key allows, or widen them ([regions](providers-and-models.md#keeping-data-in-a-region)) |
| `region_not_available` | 403 | No deployment of the model is in a region the key allows | Add a deployment in the region, or set the region on the model |
| `no_deployment_for_tags` | 403 | Every deployment of the model is [reserved for tags](providers-and-models.md#routing-by-tag) this call doesn't carry | Send a matching `x-ct-tags`, or tag a deployment `default` |
| `endpoint_not_supported` | 400 | The model's provider has no such endpoint here (images, audio, moderations or completions on a provider without them) | Use a model from an OpenAI or OpenAI-compatible provider |
| `context_window_exceeded` | 400 | By Control Tower's estimate, the prompt fits no deployment of the model | Shorten it, or give the model a [context-window fallback](providers-and-models.md#when-a-call-fails-retries-and-fallback-models) |
| `policy_denied` | 403 | A gate blocks this path. Also: an approver denied the call (*Denied by an approver*), or an approval ticket was sent with a different request (*scope mismatch*) | The message is the gate's reason (or its name) and the error carries `rule_id`; find the gate on the Airspace or in **Flights**. After a scope mismatch, send the original request with the ticket, or ask again |
| `approval_required` | 403 | Held for a human and nobody answered in time. `ct.status` is `pending` with a `ticket`, or `expired` | Approve it in the **Tower**, then retry the same call with `x-ct-approval: <ticket>` — see [Approvals](airspace.md#approvals-the-tower). A retry while the card is still open gets `approval_required` again, `pending` |
| `content_blocked` | 400 | An inspect gate found something it blocks — a secret, personal data, prompt injection | The message says which detector; remove it from the request, or change the gate's action to mask or flag |
| `rate_limit_exceeded`, `too_many_parallel_requests` | 429 | The key's rate or concurrency limit, or a gate's limit (the message names the gate) | Slow down, or raise the limit |
| `deployment_busy` | 429 | Every deployment of the model is at its own rate or concurrency limit | Retry shortly, or add deployments |
| `budget_exceeded` | 429 | A key, team, project or customer budget is used up | The message names the budget; raise it on the **Ledger** or wait for the period to reset |
| `delegation_required`, `delegation_loop`, `delegation_too_deep`, `delegation_invalid` | 403 | A call between agents: no valid delegation token, a loop, a chain over 8 agents, or a token that can't be renewed | See [Agents calling agents](agent-to-agent.md#troubleshooting) |
| `shutting_down` | 503 | The instance is restarting | Retry shortly (another instance, if you run several) |
| `provider_auth_error` | 502 | The **provider** rejected the stored credential (not the agent's key) | **Providers → Test connection**; update the credential |
| `provider_misconfigured` | 502 | The provider's stored settings are incomplete (Bedrock without access keys, Vertex without a project) | Complete them under **Providers** |
| `provider_model_not_found` | 502 | The provider says it has no such model, after any fallbacks | Check the deployment's upstream model name |
| `provider_rate_limited`, `provider_error`, `provider_overloaded`, `provider_timeout`, `provider_unreachable` | 429, 502, 502, 504, 502 | The provider failed, after any retries and fallbacks | Add a fallback with an [alias](providers-and-models.md#aliases-load-balancing-and-fallbacks); set up an [outage alert](alerts.md). `provider_unreachable` is a network error: check `HTTPS_PROXY` and DNS |
| `provider_stream_error` | — | The provider failed after the stream started; it arrives as an error event in the stream | Retry; see the flight for the provider's message |
| `provider_bad_request` | 400 | The provider rejected the request as invalid; it is not retried elsewhere | The message is the provider's; fix the request (a parameter or input the model doesn't accept) |
| `provider_context_window_exceeded`, `provider_content_policy` | 400 | The provider refused the prompt as too long, or refused its content | Add a *prompt too long* or *content refused* [fallback](providers-and-models.md#when-a-call-fails-retries-and-fallback-models) |
| `400` on `/v1/responses` mentioning `previous_response_id` | 400 | The model's provider has no Responses API, so Control Tower translates the call through Chat Completions and can't continue a stored response | Send the whole conversation in `input` (`store: false`), or use an OpenAI model. OpenAI built-in tools (web search, file search, computer use) are dropped for these providers |

### MCP tool calls

A refused tool call is a tool result with `isError: true`, so the model can read it. Its text ends with JSON: `ct_status`, `flight_id`, and details. The flight records the code in the second column.

| `ct_status` | Flight code | What it means | What to do |
|---|---|---|---|
| `denied` | `policy_denied`, `tool_not_allowed` (`reason: key_not_allowed`), `delegation_…` | A gate, the key's `allowed_mcp`, an approver's *deny*, a scope mismatch, or a delegation check | The text gives the reason. Widen `allowed_mcp`, or change the gate |
| `not_found` | `tool_not_found` | No registered server has that tool | Check the name (`server__tool` on `/mcp`) and **MCP servers** |
| `rate_limited` | `rate_limit_exceeded` | The key's or a gate's rate limit; `retry_after_ms` says how long | Slow down, or raise the limit |
| `pending`, `expired` | `approval_required` | Held for a human; `pending` carries a `ticket` | Once approved, repeat the call with `_meta.ct_approval` (or `x-ct-approval`) set to the ticket — see [MCP](mcp.md#gates-on-tools) |
| `content_blocked` | `content_blocked` | An inspect gate blocked the arguments or the result | Change what is sent, or the gate's action |
| `upstream_error` | `upstream_…` | The MCP server itself failed | Check the server under **MCP servers → Test** |

Some problems are JSON-RPC errors instead: `-32001` (HTTP 401) for a missing or unknown key, `-32004` (404) for an unknown server slug, `-32601` for a method that isn't there, `-32602` for a tool name without `server__`, `-32000` while restarting, `-32603` (`internal_error` in Flights) for anything unexpected. `GET /mcp` answers `405`: Control Tower doesn't open server-initiated streams, so use POST.

### HTTP APIs

`/http/<slug>/…` refusals are `{"error": {code, message, ct_status, flight_id}}` with the code in an `x-ct-status` header too.

| Code | Status | What it means | What to do |
|---|---|---|---|
| `missing_api_key`, `invalid_api_key`, `key_expired` | 401 | No Control Tower key, or an unknown, disabled or expired one | Send it as `x-ct-key` (or `Authorization: Bearer ct_sk_…`) |
| `api_not_found` | 404 | No enabled HTTP API has that slug | Check **HTTP APIs** |
| `path_not_allowed` | 400 | The path leaves the registered base URL (dot segments, encoded dots) | Use a path under the base URL |
| `tool_not_allowed` | 403 | The key's `allowed_mcp` doesn't cover `<slug>__<route>` | Widen `allowed_mcp` |
| `policy_denied` | 403 | A gate, an approver's *deny*, or a scope mismatch | As for model calls |
| `approval_required` | 403 | Held and not answered in time; the ticket is in the body and the `x-ct-approval-ticket` header | Once approved, repeat the request with `x-ct-approval: <ticket>` |
| `approval_pending` | 403 | A retry with a ticket nobody has decided yet; carries `retry-after` | Wait, then retry with the same ticket |
| `content_blocked` | 400, or 403 for a response | An inspect gate blocked the request or the response | Change what is sent, or the gate's action |
| `rate_limit_exceeded` | 429 | The key's or a gate's rate limit | Slow down, or raise the limit |
| `upstream_timeout`, `upstream_unreachable` | 504, 502 | The API didn't answer in time, or couldn't be reached | Check the API's base URL and timeout |
| `response_too_large` | 502 | The API answered with more than 10 MB | Ask for less (paging, filters) |
| `shutting_down` | 503 | The instance is restarting | Retry shortly |

### A2A agents

A2A refusals are JSON-RPC errors; the `reason` in `data` is the code in capitals: `AGENT_NOT_FOUND`, `TOOL_NOT_ALLOWED`, `POLICY_DENIED`, `APPROVAL_REQUIRED` (with a `ticket`), `APPROVAL_PENDING`, `CONTENT_BLOCKED`, `RATE_LIMIT_EXCEEDED`, `SHUTTING_DOWN`, the `DELEGATION_…` codes, `INVALID_WEBHOOK`, `INVALID_AGENT_RESPONSE`, `UNEXPECTED_STREAM`, `UPSTREAM_TIMEOUT`, `UPSTREAM_UNREACHABLE`. A stream that fails partway is recorded as `stream_error`, and a task the agent reports failed or rejected as `agent_task_failed` / `agent_task_rejected`. See [A2A troubleshooting](a2a.md#troubleshooting).

### The console and the admin API

| Code | Status | What it means | What to do |
|---|---|---|---|
| `setup_code` | 403 | First-run setup without the right setup code | Copy it from the server's log (`docker logs <container>`), or open the **Open** link printed there — see [First-run setup](configuration.md#first-run-setup) |
| `already_setup` | 409 | Setup has already been done | Sign in |
| `rate_limited` | 429 | Too many sign-in or setup attempts (`CT_LOGIN_RPM` a minute per email, `CT_LOGIN_IP_RPM` per address) | Wait a minute (`retry-after` says how long) |
| `unauthenticated` | 401 | No session, or it ended (7 days, or 12 hours unused) | Sign in again, or send the admin key as a bearer token |
| `csrf` | 403 | A change without the `x-ct-csrf` header | Send the token from `GET /admin/api/me` |
| `password_change_required` | 403 | Signed in with a one-time password | Choose your own password first |
| `forbidden` | 403 | Your role is approver or viewer | Ask an admin to change it under **People** |
| `internal_error` | 500 | Something unexpected; the message has the request id | Find the id in the server's log, and include it in an issue |

## Setup and deployment

**Streaming stops, or approvals time out, behind a proxy.** Reverse proxies buffer responses and cut long requests. Turn buffering off for Control Tower and allow at least the approval hold time (20 s by default) plus model latency — for nginx:

```nginx
location / {
  proxy_pass http://controltower:4000;
  proxy_buffering off;
  proxy_read_timeout 600s;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;     # the console's live updates use a WebSocket
  proxy_set_header Connection "upgrade";
}
```

**Everything is gone after an upgrade.** `/data` wasn't on a named volume, so the new container started with an empty one. Always run with `-v controltower-data:/data` (or a platform disk mounted at `/data`). See [Install](install.md#docker).

**"CT_MASTER_KEY differs from /data/master.key. Refusing to start".** Both are set and they disagree; stored credentials are encrypted with one of them. Keep the one your data was written with and remove the other.

**A console password is lost.** An admin resets it under **People** (a new one-time password). If the only admin lost theirs, reset it with the admin key: see [People and roles](people.md#if-the-only-admin-loses-their-password).

**The setup page asks for a setup code.** It is printed in the server's log at start, under *Setup code*, with an **Open** link that fills it in (`docker logs <container>`; on a platform, its deploy logs). It is there so that whoever reaches a new install first can't create its admin. See [First-run setup](configuration.md#first-run-setup).

**The master key is lost.** Stored provider, tool-server and channel credentials can't be decrypted. Start with a new key and enter those credentials again — keys, gates, zones and history are not encrypted and are kept.

**The container can't write `/data`.** The image fixes the ownership of a root-owned volume at startup. If your platform runs containers with a fixed non-root user and read-only ownership, make the volume writable by uid 1000 (`node`).

**Providers time out behind a corporate firewall.** Set `HTTPS_PROXY` (and `NO_PROXY` for internal hosts) so Control Tower's own calls go through your proxy — see [Install](install.md#behind-a-corporate-proxy).

**Port 4000 is taken.** Publish another host port (`-p 8080:4000`) or set `--port` / `CT_PORT` / `PORT`.

**`--config` or `--policy` stops startup.** The log says what's wrong: a file that can't be read or parsed, or a policy naming an agent, model or zone that doesn't exist. Nothing is half-applied; fix the file and restart.

## Console and map

**The console can't sign in with `admin` and the master key.** The account is created from the admin key only when the key is set — `CT_ADMIN_KEY` in the environment, or `master_key` in the config file — and the username is `UI_USERNAME` (default `admin`).

**Links in Slack, email or webhooks point at `localhost`.** Set `CT_PUBLIC_URL` to the address people use to reach the console (it's detected on Render, Fly.io and Railway).

**The map is empty.** Nothing has called the gateway yet — check the key's **Connect** panel, which turns green on the first request — or a filter is on (**All / Active / Gateway / Outside**). **Fit** brings every station into view.

**A line is dashed.** That traffic was reported by the agent's SDK or OpenTelemetry, not routed through the gateway, so gates can't stop it. **Bring it inside** on the station shows how to route it. See [What is enforced](threat-model.md).

**The demo won't start.** It refuses when your setup already uses one of its model or tool names, so demo traffic can never reach a real provider. The message lists the names.

## Alerts

**A channel shows *failing*.** The reason is under the channel on the **Alerts** page; **Send test** tries again.

- *Slack / webhook*: the URL was revoked or is unreachable from the server.
- *Email*: `Invalid login` — wrong username or password (Gmail and Microsoft 365 need an app password); a timeout — the port is blocked or wrong (587 with STARTTLS, 465 with *TLS from the start*); `554 No SMTP server` — set one on the channel or `CT_SMTP_URL`.

**An alert didn't fire.** Check the rule's trigger and condition (*N times within M minutes*), whether it's paused, and its cooldown: after firing, a rule waits and then sends one digest.

## Still stuck

Search the [issues](https://github.com/joshmaster2165/controltower/issues) or open one with the version (`controltower --version`), how you run it, and the flight id or log lines. Report security issues privately — see [SECURITY.md](https://github.com/joshmaster2165/controltower/blob/main/SECURITY.md).
