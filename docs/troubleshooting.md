# Troubleshooting

Start with the flight. Every gateway response carries `x-ct-flight-id`; search for it under **Flights** to see which key made the call, where it was routed, which gate decided it and what the provider answered. Server logs are on stdout (`docker logs controltower`); `--detailed_debug` or `CT_LOG_LEVEL=debug` adds detail.

## The agent gets an error

| Status and `code` | What it means | What to do |
|---|---|---|
| `401 invalid_api_key` | No key, or not one Control Tower knows | Send the agent's `ct_sk_…` key as `Authorization: Bearer` (OpenAI SDKs: `OPENAI_API_KEY`; Claude Code: `ANTHROPIC_AUTH_TOKEN`). A provider's own key (`sk-…` from OpenAI) won't work unless it was [brought over](keys.md#key-management-api) |
| `401 key_disabled`, `401 key_expired` | The key was disabled or has expired | **Keys** → enable it, or create a new one |
| `404 model_not_found` | No connected provider serves that name | Connect the provider that offers it, check the spelling, or pin it as `provider/model`. With `CT_AUTO_MODELS=0`, add the model under **Models** |
| `403 model_not_allowed` | The key's allowed models don't include it | Widen the key's allowed models, or use a model it allows |
| `403 policy_denied` | A gate blocks this path | The message is the gate's reason (or its name) and the error carries `rule_id`; find the gate on the Airspace or in **Flights** and change or remove it |
| `403 approval_required` | Held for a human and nobody answered in time | Approve it in the **Tower**, then retry the same call with `x-ct-approval: <ticket>` from the error |
| `400 content_blocked` | An inspect gate found something it blocks — a secret, personal data, prompt injection | The message says which detector; remove it from the request, or change the gate's action to mask or flag |
| `429 rate_limit_exceeded`, `too_many_parallel_requests` | The key's rate or concurrency limit | Slow down, or raise the key's limits |
| `429 budget_exceeded` | A key, team or project budget is used up | The message names the budget; raise it on the **Ledger** or wait for the period to reset |
| `502 provider_auth_error` | The **provider** rejected the stored credential (not the agent's key) | **Providers → Test connection**; update the credential |
| `429 provider_rate_limited`, `502 provider_error`, `504 provider_timeout` | The provider failed, after any fallbacks | Add a fallback with an [alias](providers-and-models.md#aliases-load-balancing-and-fallbacks); set up an [outage alert](alerts.md) |
| `400 provider_bad_request` | The provider rejected the request as invalid; it is not retried elsewhere | The message is the provider's; fix the request (a parameter or input the model doesn't accept) |
| `400` on `/v1/responses` mentioning `previous_response_id` | The model's provider has no Responses API, so Control Tower translates the call through Chat Completions and can't continue a stored response | Send the whole conversation in `input` (`store: false`), or use an OpenAI model. OpenAI built-in tools (web search, file search, computer use) are dropped for these providers |

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
