<p align="center">
  <img src="ui/public/logo-wordmark.svg" alt="Control Tower" width="320"><br/>
  The self-hosted AI gateway that <em>shows</em> you where your agents go — and lets you stop them at the border.
</p>

---

**Mission:** map and document every agentic dataflow across your environment — which agents reach which models, MCP servers, tools and integrations — while enforcing permissions and security on those flows and monitoring usage and spend.

**Control Tower** is an open-source AI gateway with a live map of agent traffic. Point your agents at it like you would any OpenAI-compatible endpoint; every model call and every MCP tool call becomes a *flight* on the **Airspace**. Draw **zones** around systems, put **gates** on the boundaries, and require a human to approve a flight before it crosses. It is an enforcement point, not a dashboard: a gate that says *no* returns a 403 to the agent.

- **See it.** Agents, models, MCP servers and their tools on one interactive map. Every connection shows its state — active, idle, unused, holding, blocked — so it stays readable at hundreds of agents. Drag nodes to arrange the map (the arrangement is saved and shared), pan and zoom, and click any node to trace everything it connects to.
- **Draw the rules.** Lasso stations into a zone, click a boundary, pick *allow / deny / require approval / allow with limits*. YAML is the *output*, for review and Git.
- **Try before you enforce.** *Simulate* replays the last 24 hours of recorded traffic through a draft gate — "would block 37 requests from 4 agents, hold 12, stop $4.10 of spend" — and highlights the affected paths on the map. On an existing gate, *Impact* shows what it actually changed.
- **Stop it.** Approvals hold the agent's request at the gate; a human clicks approve in the **Tower** and the flight continues. Unanswered holds turn into a resumable ticket, never a silent timeout.
- **Inspect it.** *Inspect gates* scan what passes along a path — prompts, model replies, MCP tool arguments and tool results — for secrets, personal data, prompt injection or your own keywords, and mask it, block it, or flag it.
- **Hear about it.** Alerts on any gate (*blocked*, *held*, *masked*, *approval misused* …), provider outages and recoveries, failing or slow requests, budgets nearly or fully used, and a daily summary — every time or only when it repeats (e.g. 5× in 10 min). They land in the console inbox and can go to Slack or a signed webhook; a cooldown rolls bursts into one summary. Prometheus metrics at `/metrics`.
- **Count it.** Per-key, per-team, per-model spend and tokens with budgets and rate limits — the accounting you'd expect from an LLM gateway, with the map on top.

> Status: **v0.1 preview.** Working today: the OpenAI-compatible and Anthropic-native gateway (OpenAI, Azure, Anthropic, Google Gemini, Google Vertex AI, AWS Bedrock, Groq, Together, Mistral, DeepSeek, xAI, OpenRouter, Ollama, vLLM, any OpenAI-compatible URL), API keys with limits and budgets, cost accounting from a vendored price table, the live Airspace, zones and gates drawn on the map, human approvals with hold → ticket → grant, the MCP tool gateway, and demo mode. Not yet: embeddings, Flight Recorder replay/simulate, the Ledger page, Slack notifications. See the roadmap and [docs/threat-model.md](docs/threat-model.md).

## Quickstart

```bash
docker run -p 4000:4000 -v controltower-data:/data -e CT_DEMO=1 ghcr.io/controltower-ai/controltower
```

Open <http://localhost:4000>, set your admin password, and you're in. With `CT_DEMO=1` a synthetic fleet — six agents such as `support-triage` and `pr-reviewer`, calling Claude, GPT and Gemini models and Salesforce/GitHub tool servers — flies through the real pipeline so the Airspace is alive in seconds. Demo providers are stand-ins: nothing leaves your machine, but models are priced like the real ones. Clear it from the console when you connect real providers.

Then, in the browser:

1. **Providers** → add OpenAI / Anthropic / Azure / Gemini / Vertex AI / Bedrock / any OpenAI-compatible URL, paste credentials, *Test Connect*.
2. **Models** → add deployments (pricing is pre-mapped) and group them under an alias like `smart` with fallbacks.
3. **Playground** → send a message; watch the flight on the Airspace.
4. **Keys** → create a key per agent, with team/project labels, model allow-lists, rate limits and a budget.
5. Point any OpenAI SDK at `http://localhost:4000/v1` with that key. Claude Code and the Anthropic SDK can use `http://localhost:4000` with `x-api-key`.
6. **MCP servers** → register tool servers; point MCP clients at `http://localhost:4000/mcp` with the same key. Tools a key may not use are not listed.
7. **Airspace** → *Draw zone*, lasso some stations, click a zone label to add a gate: allow, deny, or require approval. Held flights show up in the **Tower**.

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:4000/v1", api_key="ct_sk_...")
client.chat.completions.create(model="smart", messages=[{"role": "user", "content": "hello tower"}])
```

## Run from source

Requires Node 24 and pnpm.

```bash
pnpm install
pnpm --filter @controltower/ui build      # builds the console into ui/dist
CT_DEMO=1 pnpm dev                        # http://localhost:4000
```

For UI development with hot reload run `pnpm dev:ui` in a second terminal and open <http://localhost:5173> (it proxies the API to :4000).

## Concepts

| Term | Meaning |
|---|---|
| **Airspace** | The live map. Stations are systems; regions are zones; traffic is animated. |
| **Station** | Agent (API key), model deployment, MCP server / tool, browser, integration, data store. |
| **Zone** | A region grouping stations, drawn by lasso. |
| **Lane** | An edge between stations. Solid = enforced by the gateway, dashed = observed only. |
| **Flight** | One request — an LLM call or a tool call. |
| **Gate** | A rule on a zone boundary: open, barrier, checkpoint (approval), toll (limits). |
| **Tower** | The approvals queue. |
| **Inspect gate** | A guardrail on a path: what to look for, which direction, and whether to mask, block or flag. Runs alongside access gates. |
| **Alert** | A notification rule on a gate: which outcomes, how often, where to send it. |
| **Ledger** | Cost, tokens, latency. |
| **Flight Recorder** | Replay and *simulate* — what would this rule have done to yesterday's traffic? |

## Document it

- **Export → Map image**: the whole map (every node, not just what's on screen) as a 2× PNG with a title strip — for architecture docs and security reviews.
- **Inventory** (nav) / **Export → Data-flow inventory**: every agent, model and MCP tool server, and every agent → model/tool path seen in the last 24 h / 7 d / 30 d, with requests, errors, blocked, held and spend — and, per path, what Control Tower does today: the access decision and the gate behind it, the inspect gates that scan it, and whether the agent's key even allows it. Printable, or download as Markdown (`/admin/api/export/dataflow?format=md`) or CSV (`?format=csv`).

## Simulate

In the gate composer, **Simulate on last 24 h** replays recorded flights through the current gates and through the gates with your draft added, and reports only the flights whose outcome changes: how many would be blocked, held for approval or let through, by which agents, to which targets, and the spend that blocked requests accounted for. On an existing gate, **Impact in the last 24 h** compares the gates without it to the gates with it; after changing its effect, **Simulate this change** shows the difference. Affected paths are drawn dashed on the map with their counts until the panel closes.

Limits, shown with each result: tool arguments and bodies are not stored, so argument conditions can't be replayed and inspect gates can't be simulated; held requests count as held, not guessed approved. The replay covers up to 200,000 recent flights and yields to live traffic as it runs. API: `POST /admin/api/policy/simulate`.

## Coming from LiteLLM

**Models → Import from LiteLLM**: paste (or upload) your proxy `config.yaml`, review what it becomes, press Import.

- `model_list` entries become providers (one per distinct endpoint + credential; `credential_list` names are kept) and deployments. Groups with several entries, `order` tiers and `fallbacks` become aliases — `order` maps to priority, `weight`/`rpm`/`tpm` to weight, and `routing_strategy` to weighted, fastest-first or cheapest-first. `input_cost_per_token`/`output_cost_per_token` become per-deployment pricing. `mcp_servers` with an HTTP URL become MCP servers.
- Providers: OpenAI, Azure OpenAI, Anthropic, Gemini, Vertex AI, Bedrock, Groq, Mistral, Together, Fireworks, DeepSeek, xAI, OpenRouter, Perplexity, Cerebras, DeepInfra, Ollama, vLLM, LM Studio and any `openai/` + `api_base` endpoint.
- Secrets: values in the file are used as-is; `os.environ/NAME` (and LiteLLM's default variables such as `OPENAI_API_KEY`) are read from Control Tower's environment; anything missing is asked for in the preview. `CT_*` variables are never read.
- Not imported, and listed in the preview: wildcard routes, `include` files, context-window and content-policy fallbacks, callbacks, guardrails, `general_settings` (Control Tower has its own admin, keys and database), and models stored only in LiteLLM's database. Keys live in LiteLLM's database, not the config — create new ones here.

## Inspect gates (guardrails)

Pick **Inspect** when adding a gate. A gate with no agent or destination covers everything and sits on the tower itself.

- **Detectors**: secrets and credentials (AWS, GitHub, Slack, Stripe, OpenAI, Anthropic and Google keys, JWTs, private keys, connection strings with passwords, Control Tower keys); personal data (email, phone, card numbers with a Luhn check, US SSN, IBAN with its checksum, IP address); prompt injection (ignore-your-instructions phrasing, role overrides, system-prompt extraction, chat-template markup, "send the credentials to…"); and your own keywords.
- **Direction**: what agents send (prompts, tool arguments), what comes back (model replies, tool results), or both. Scanning tool results is where indirect prompt injection and data leaks are caught before the model reads them.
- **Action**: *mask* replaces the match with a placeholder such as `[EMAIL]` or `[SECRET:AWS_KEY]`; *block* returns `400 content_blocked` with a message the agent can act on (for MCP, an `isError` tool result); *flag* lets it through and records it. Every match shows on the map and can trigger an alert (`blocked`, `masked`, `flagged`).
- **Honest limits**: detectors are pattern-based and catch well-formed, common cases, not deliberate evasion. Streamed model replies are checked after delivery, so on a stream a match is flagged, never masked or blocked. Findings record which detectors matched and how often — never the matched text.

## Alerts

Click a gate on the Airspace and choose **Add alert**, tick *Alert me* when creating a gate, or use the **Alerts** page (which also holds the inbox and the channels). An alert rule watches one of:

| Kind | Fires on |
|---|---|
| Gate | `blocked`, `held`, `approved`, `rejected` (by an approver), `unanswered` (hold or approval expired), `allowed`, `scope_mismatch` (an approval redeemed with different arguments — a security event), `masked` / `flagged` (inspect gates) |
| Provider outage | `outage`: N upstream timeouts, network errors or 5xx for one model or MCP server within a window (rate limits and 4xx don't count; each deployment has its own window) · `recovered`: the first success after an outage alert |
| Failed requests | `failed`: requests that still failed after fallbacks, optionally for chosen agents or models |
| Slow requests | `slow`: requests slower than a threshold (default 30 s) |
| Budget | `budget_warning` at a percentage (default 80%) and `budget_exceeded`, for every key, team and project budget — once per budget period |
| Daily summary | `daily`: requests, tokens, spend, blocked / held / masked counts, errors, top spenders, most-failing and slowest models, at a chosen UTC hour; skipped on days without traffic |

- **Condition**: every time, or *N times within M minutes*. After firing, the rule stays quiet for its cooldown and then sends one digest of what happened meanwhile.
- **Channels**: the console inbox (always, with a nav badge and live toasts), Slack incoming webhooks (also Mattermost / Rocket.Chat), and generic webhooks. Channel URLs and secrets are encrypted at rest and never returned by the API.
- **Webhook payload**: `POST` JSON `{ "type": "controltower.alert", "kind", "title", "trigger", "count", "subject": {kind, id, name}, "gate": {id, name, effect}, "agents": [{name, count}], "destinations": [...], "reason", "lines": [...], "flights": [ids], "console_url", ... }`. With a signing secret, `x-ct-signature: t=<unix>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`. Delivery retries twice on network errors, 408, 429 and 5xx.
- **Approvals from Slack**: a `held` alert about one request links straight to that approval card (`/#/tower/<approval id>`) — Slack gets a *Review & approve* button and a "Decision needed: Approve ONE call to … from …" line; webhooks get `approval: {id, scope, url}`. The link only opens the card: approving is always an authenticated action in the console, never a click on a URL (link unfurlers can't approve anything). If someone already decided, the card says who and when.
- Alerts carry names and counts only — never prompts, tool arguments or responses. Set `CT_PUBLIC_URL` so links in Slack and webhooks point at your console.

## Metrics

`GET /metrics` serves Prometheus text format. It names agents and shows spend, so it is never anonymous: set `CT_METRICS_TOKEN` and scrape with `Authorization: Bearer <token>` (a signed-in admin can also open it).

```yaml
scrape_configs:
  - job_name: controltower
    authorization: { credentials: <CT_METRICS_TOKEN> }
    static_configs: [{ targets: ['controltower:4000'] }]
```

Counters: `controltower_requests_total{agent,team,kind,model,provider,status}`, `controltower_tokens_total{agent,model,type}`, `controltower_spend_usd_total{agent,team,model}`, `controltower_upstream_failures_total{model,code}`, `controltower_fallbacks_total{model}`, `controltower_gate_decisions_total{gate,decision}`, `controltower_approvals_total{outcome}`. Histograms (5 ms … 600 s): `controltower_request_duration_seconds`, `controltower_time_to_first_token_seconds`, plus `controltower_gateway_overhead_seconds`. Gauges: requests in flight, held requests, event backlog, `controltower_deployment_state` (0 healthy, 1 cooling down), `controltower_mcp_server_up`, budget limit / spent / remaining per scope, build info and uptime. Labels are bounded: a model name the gateway doesn't know is reported as `other`, so clients can't create series at will.

## Traffic that doesn't go through Control Tower

Agents also call databases, SaaS APIs and internal services directly. Report those calls and they appear on the map as **dashed lines straight from the agent to the system — not through the tower** — and in the inventory under *Seen, not enforced*. A model provider called directly (OpenAI, Anthropic, Bedrock, …) is drawn **red**: that traffic is skipping the gateway, its gates and its budgets.

Authenticate with the agent's own Control Tower key.

```bash
curl -X POST http://localhost:4000/v1/observe \
  -H "Authorization: Bearer $CT_KEY" -H "content-type: application/json" \
  -d '{"events":[{"target":"https://api.stripe.com/v1/refunds","operation":"write"},{"target":"postgresql://orders-db:5432/orders","kind":"database","count":12}]}'
```

Or point any OpenTelemetry SDK at Control Tower — outbound (`CLIENT`/`PRODUCER`) spans become observed calls, using the standard HTTP, database, messaging, RPC and GenAI attributes; calls to Control Tower itself are ignored:

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4000/v1/traces
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer ct_sk_…"
```

Only a target name is kept: URLs lose their path and query string, connection strings lose their credentials (`postgresql://app:pw@db/orders` → `postgresql://db/orders`), and no payload is stored. OTLP protobuf is not accepted yet — use `http/json`.

## What is actually enforced

Control Tower only enforces traffic that goes through it. A lane is drawn **solid** only when the gateway is in the path for that hop (LLM calls and MCP tool calls routed through Control Tower). Anything learned by observation alone is drawn **dashed**, and a rule existing on an edge never makes it solid. An agent that edits its own `base_url` bypasses the LLM gateway; the MCP gateway's `tools/list` filtering is the stronger control, because a tool the agent cannot see needs no approval. Traffic reported through `/v1/observe` or OpenTelemetry is *seen*, never enforced, and is drawn dashed. An egress-proxy sidecar to close the `base_url` gap is on the roadmap. We would rather you know the boundary than believe in one that isn't there.

## Configuration

Everything is configured in the browser. Environment variables exist for operators:

| Variable | Default | Purpose |
|---|---|---|
| `CT_PORT` | `4000` | Listen port |
| `CT_DATA_DIR` | `./data` (`/data` in Docker) | SQLite database and the master key |
| `CT_MASTER_KEY` | generated | Base64 32-byte key encrypting provider credentials at rest. Back up `/data/master.key` if you let it generate one. |
| `CT_DEMO` | `0` | Seed stand-in Anthropic/OpenAI/Gemini providers and demo tool servers, and run a synthetic agent fleet |
| `CT_MODE` | `on` | `off` disables policy enforcement (kill switch) |
| `CT_METRICS_TOKEN` | — | Bearer token for Prometheus to scrape `/metrics` |
| `CT_PUBLIC_URL` | — | Public URL, used for links in alerts, signed approval links and the ingress probe |
| `CT_HOLD_BUDGET_MS` | `20000` | How long a request may wait at a gate for a human before becoming a ticket |
| `CT_MAX_HELD` | `500` | Max concurrently held requests per process |

## Roadmap

- **v0.1 — see it and stop it**: gateway (`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`, `/v1/messages`), OpenAI-compatible + Anthropic adapters, keys/limits/budgets, pricing and cost, live Airspace, zones + gates + approvals, MCP gateway, demo mode, Docker image.
- **v0.2 — understand it**: Flight Recorder replay and simulate, Ledger and cost overlay, allow-with-limits gates, YAML import/export, Slack/email approvals, SDK middleware and OTLP, Gemini/Bedrock/Vertex adapters, Prometheus.
- **v0.3 — trust it**: egress proxy sidecar, Playwright fixture for browser agents, Postgres + Redis multi-instance, audit export; enterprise: users/RBAC/SSO.

## Acknowledgements

Control Tower's gateway feature surface is modelled on what [LiteLLM](https://github.com/BerriAI/litellm) proved an LLM gateway needs. Its MIT-licensed model pricing table is vendored as data; see `THIRD_PARTY.md`.

## License

Apache-2.0 for everything outside `ee/`. See [LICENSE](LICENSE).
