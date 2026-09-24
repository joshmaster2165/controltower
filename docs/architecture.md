# Architecture

Control Tower is one Node.js process with one data directory. The same process runs the gateway agents call, the admin API and live updates the console uses, and serves the console itself.

```text
 agents                        Control Tower (one process)                        upstreams
 ──────                        ───────────────────────────                        ─────────
 OpenAI SDK   ─ /v1 ─────────┐                                               ┌──▶ OpenAI, Azure, Groq, Ollama…
 Claude Code  ─ /v1/messages ┤   auth → limits → route → gates → dispatch    ├──▶ Anthropic, Bedrock, Vertex AI, Gemini
 MCP client   ─ /mcp ────────┤        │           │        │         │       ├──▶ MCP tool servers
 any HTTP     ─ /http/<api> ─┘        │           │     approvals    stream  └──▶ REST APIs
                                      ▼           ▼        ▼         ▼
                                   flight events ──▶ SQLite ──▶ Ledger, Flights, Inventory
                                        │                         alerts ──▶ Slack, email, webhooks
                                        └──▶ WebSocket ──▶ the console (the live map)
```

## A request, step by step

Every call — a model call, an MCP tool call or an HTTP API call — goes through the same fixed sequence. The order is deliberate: nothing reaches a provider before the key, limits and gates have been checked.

1. **Authenticate.** The key is looked up by its hash in memory. Unknown, disabled or expired keys stop here (`401`).
2. **Admit.** The key's allowed models or tools, rate limit, token limit, concurrency limit and every budget that covers it (key, team, project) are checked. Budgets reserve the call's projected cost up front, so parallel calls can't overshoot.
3. **Route.** The model name resolves to an alias, a deployment, or a connected provider that serves it (adding it on first use). Tool calls resolve to a server and a tool.
4. **Gates.** The first matching access gate decides: allow, deny, or **hold** for approval. A held request waits inside the gateway — its connection stays open — until someone approves, denies, or the hold time ends and it becomes a ticket. Inspect gates then scan what is being sent.
5. **Dispatch.** The request goes to the provider in its own API format — translated only when the client and the provider speak different ones. On rate limits, server errors and timeouts it falls back to the next deployment, as long as nothing has been sent to the client yet.
6. **Stream back.** Responses are relayed as they arrive, byte for byte where no translation is needed. Usage is read from the provider's own figures (estimated and marked as such when a provider doesn't report it).
7. **Account.** The call is priced once, at the rate in force when it was routed, and budgets are settled.
8. **Record.** The flight's events go to the database, the live map and the alert rules.

The gateway adds only this bookkeeping on top of the provider's latency; `controltower_gateway_overhead_seconds` in [metrics](monitoring.md#prometheus-metrics) measures it.

## What is stored — and what isn't

| Stored | Not stored |
|---|---|
| Who called what, when, the outcome, tokens, cost and latency (*flights*) | Prompts, model responses, tool arguments or results, request or response bodies |
| Hourly and daily rollups of requests, tokens, spend and latency | Agents' keys (only a hash) |
| Providers, models, keys (hashed), zones, gates, alert rules and channels | Provider, tool-server and channel credentials in the clear — they are encrypted |
| Approval requests with a short, allow-listed preview of what is being approved | |

Credentials are encrypted with AES-256-GCM under the master key (`/data/master.key` or `CT_MASTER_KEY`), each bound to its row so a value can't be copied to another. Alerts and approval messages carry names, counts and the scope of a decision, never request contents.

## Data and retention

Everything lives in SQLite in the data directory (`controltower.db`, write-ahead logged). Events are written in batches every 50 ms, so recording never blocks a request. A retention job runs hourly:

| Data | Kept |
|---|---|
| Flights (one row per request) | 30 days — `CT_RETENTION_DAYS`, `0` keeps them forever |
| Flight event trails | 7 days — `CT_EVENT_RETENTION_DAYS` |
| Hourly rollups, observed traffic, the alert inbox, decided approvals | 90 days |
| Daily rollups (spend and usage history) | Forever |

Deletes run in chunks of 5,000 rows and yield between them, so live traffic doesn't wait. A team budget created today counts spend from flights that are still retained.

## The live map

Flight events are pushed to the console over a WebSocket, batched into one frame every 100 ms so a busy gateway doesn't flood the browser; the map draws them and keeps per-minute counts. When the map opens, it is seeded with the last minute of traffic from the database, so what is active shows as active immediately. Arrangements you make by dragging stations are saved on the server and shared by everyone.

## Scale and limits

- **One instance.** SQLite, in-memory rate limits and budget counters, and approval holds all live in one process. Run it as a single instance with a persistent volume; multi-instance deployment (Postgres and a shared limiter) is on the roadmap.
- **Holds** are bounded: at most 500 requests wait at once (`CT_MAX_HELD`), five per key; beyond that a request gets a ticket immediately.
- **Shutdown** is graceful: on `SIGTERM` the server stops accepting requests, turns held requests into tickets, lets streams finish for up to 15 s and flushes everything to disk.

See [What is enforced](threat-model.md) for the security boundary.
