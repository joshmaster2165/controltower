# Changelog

Every release is on [GitHub Releases](https://github.com/joshmaster2165/controltower/releases) and as a container image, `ghcr.io/joshmaster2165/controltower:<version>`. Control Tower is in preview: minor versions may change APIs, and each release notes what to watch for.

## Unreleased

- **Agent loops stop at the first repeat:** a call to an agent already earlier in the chain (A → B → A) is refused with `delegation_loop` and recorded, instead of going round until the chain is 8 agents deep.
- **Arcs on the Airspace open the calls behind them:** click an arc between two agents to see each call, what it led to, and a trace into Flights.
- **Airspace top bar:** counters, actions and map controls share one left edge and wrap as groups on narrow screens.
- **A2A agents:** Control Tower stands in front of [remote agents that speak A2A](a2a.md) (1.0 and 0.3, JSON-RPC). Register one by its Agent Card; callers use the card Control Tower publishes at `/a2a/<slug>/.well-known/agent-card.json` and their own key. Every message and task call is a flight, on the map as a destination with a row per method, and open to gates (`<slug>__SendMessage`), approvals and inspect gates; the agent is sent a delegation token so its own calls count as made on the caller's behalf. The key's **Connect** panel has an **A2A agents** tab. Tested with the official A2A JavaScript SDK on both sides, including its 0.3 compatibility client.
- **Agent groups:** keys that share an [agent ID](keys.md#many-copies-of-one-agent) are one station on the map with a ×N count, and a gate or zone on it covers every copy (`match.groups`, `group:` members in policy files). The key form has an **Agent ID** field.
- **Agents calling agents:** a tool server or HTTP API can [front an agent](agent-to-agent.md); calls to it carry a signed delegation token the called agent passes on, so its calls are recorded — and can be gated — as made on the caller's behalf (`match.on_behalf_of`). Keys can be limited to acting on behalf of others. Flights show whom a call was for; the Airspace draws an arc from caller to callee.
- **Codex and the Agents SDK on any model:** `/v1/responses` calls for models without a Responses API — Claude, Gemini, Bedrock, Vertex AI — are translated through Chat Completions and back, streamed or not, including tool calls and Codex's free-form tools. They used to be refused.
- **Client setup guides:** step-by-step pages with screenshots for [Claude Code](client-claude-code.md), [Claude Desktop](client-claude-desktop.md), [Codex in the ChatGPT desktop app](client-codex-desktop.md) and the [Codex CLI](client-codex-cli.md). The key's **Connect** panel has **Claude Desktop** and **Codex** tabs with the settings filled in.
- `/v1/models` answers in both the OpenAI and the Anthropic list shape, for Anthropic clients such as Claude Desktop's model picker.
- Fixed: a newly created key's Connect panel showed the previous key's "Connected" status.
- Fixed: Codex in the ChatGPT desktop app lost its MCP tools on models reached through translation (Claude, Gemini, Bedrock, Vertex AI). Codex now sends each MCP server's tools as a group (a `namespace` tool); they are passed to the model as `<namespace>__<tool>` and its calls go back in Codex's shape.
- **Matrix:** [every agent against every destination](airspace.md#matrix-every-agent-against-every-destination) — volume, live connections and which ones no gate can stop — with a click on any cell to gate that path.
- **Flows:** line thickness on the Airspace is volume — calls per minute on live lines, the last day's calls on idle ones — so where traffic goes reads at a glance at any fleet size. Live lines no longer pulse; the map redraws only when something changes (about 5 times a second under load, was every frame).
- **Attention:** [what needs a person](airspace.md#what-needs-attention) on the map — holds, blocks, direct provider calls, failing destinations, destructive tools with no gate, new connections and traffic spikes — plus the busiest stations, with everything else dimmed. Control Tower now records each connection's first and last use (kept 90 days after last use).
- **Views:** [named parts of the organization](airspace.md#views-one-part-of-the-organization-at-a-time) — Engineering, Marketing — each with a map, counters and approvals of its own, listed under Airspace. API: `/admin/api/airspace/views`.
- **Lighter map data:** the topology the map loads is summed per agent and team, drops unused per-key rows and is gzipped: 1.3 MB → 55 KB on the wire at 1,500 agents. The last minute of traffic it seeds the map with is now complete at any rate (it was capped at 2,000 calls).
- **Teams view and search:** with a large fleet the Airspace starts with [one station per team](airspace.md#large-fleets-teams-agents-and-search); open a team to see its agents, or switch to **Agents**. **Find** (or <kbd>/</kbd>) jumps to any team, agent, key, model, tool server or tool. Gates on a team (`match.teams`) cover every key in it; zones take `team:` members.
- **Large fleets:** the Airspace stays live with 1,500 agents at 300 requests a second. The console's live updates are a summary a second plus the full events of held, denied and failed flights — about 4 KB/s per open console at 300 calls a second (was 350 KB/s, and the browser fell behind) — and the map lays out large fleets without stalling. `pnpm load:fleet` drives a fleet against your own server and reports gateway overhead and map performance; see [Monitoring](monitoring.md#load-testing).
- **Outbound proxy:** `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` route Control Tower's own calls to providers, MCP servers, HTTP APIs and alert channels through a corporate proxy.
- **Chains of calls in Flights:** each call records the call that led to it (`parent_flight_id`). Click an agent in a *for …* chain to see everything done for it, or **trace** to see one chain in call order, from the call that started it. API: `GET /admin/api/flights?for=<agent id>` and `?trace=<flight id>`; see [Agents calling agents](agent-to-agent.md#step-4-see-it).
- Refused delegated calls (`delegation_required`, `delegation_too_deep`) are recorded as rejected flights with their chain. A token an ordinary key presents that doesn't hold (expired, issued to another agent) is ignored, and the flight is flagged *delegation token ignored*.
- Fixed: gates that list `tools` apply only to tool calls, and gates that list `models` only to model calls, even with target `any`. Such gates used to hold every model call too.
- Fixed: weighted aliases pick only among the deployments with the best priority, so fallbacks are only tried when those fail. Config files with `settings.fallbacks` used to send half the traffic to the fallbacks.
- Fixed: least-cost aliases (`cost-based-routing`) order deployments by the price of a typical call, unknown prices last. They used to keep the listed order.
- Fixed: a model first used pinned (`openai/gpt-4.1-mini`) now also answers to its bare name (`gpt-4.1-mini`).
- Fixed: without `CT_PUBLIC_URL`, the approval link in a held call's error uses the port the server listens on; it always said 4000.
- Fixed: `/v1/models` answers `401 key_expired` or `key_disabled` like every other route, not `invalid_api_key`.
- Fixed: the policy JSON export (`?format=json`, `{doc, warnings}`) can be imported as it is.
- **A2A hardening:** approvals for A2A calls work (the approval is bound to the message, so a retry is no longer a scope mismatch); streams end when the client leaves or the agent goes silent; replies are capped at 10 MB and cards at 1 MB; an agent's credentials are only sent to the origin that serves its card; without an **Agent ID** an A2A agent is a destination only and gets no delegation token.
- The sign-in page shows an animated air-traffic scene (still with reduced motion), and the empty Airspace says what to do without covering the hub's label.

## 0.1.4 — 25 September 2026

- **Flight Recorder:** [replay](airspace.md#flight-recorder-replay-past-traffic) the last hour, day or week on the map at up to 10,000×.
- **Data retention:** flights are kept 30 days (`CT_RETENTION_DAYS`), event trails 7 days; daily spend history is kept.
- Docs: [Architecture](architecture.md), [API reference](api.md), [Troubleshooting](troubleshooting.md).

## 0.1.3 — 24 September 2026

**Fix**
- The demo approver decides only demo agents' requests. It used to auto-decide every held request while the demo fleet ran — including a real agent held by a real gate. Upgrade if you run the demo beside a real setup.

**New**
- [Email approvals](alerts.md#approving-by-email): an Email alert channel; held requests arrive as *[Approval needed]* emails with a **Review & approve** button that opens the request in the console.
- [Team and project budgets](keys.md#team-and-project-budgets) on the Ledger, counting what was already spent this period.
- [`--policy`](policy-as-code.md#at-startup-gitops): apply a policy file at every start (merge, or replace with `CT_POLICY_MODE=replace`).
- This documentation site, and a [Railway](install.md#railway) deploy guide.

**Improved**
- Traffic from just before the map opened shows as active; native controls follow the console's light theme; several overflow and overlap fixes; a warning when `/data` isn't on a volume.

## 0.1.2 — 24 September 2026

**Security**
- One key check everywhere: the MCP gateway accepted expired keys, and model listing, key info and token counting accepted blocked or expired ones.

**New**
- [OpenAI Responses API](connect-agents.md#openai-agents-sdk-and-codex-responses-api) (`/v1/responses`) through the full pipeline — the OpenAI Agents SDK and Codex work with `OPENAI_BASE_URL`.
- [Policy as code](policy-as-code.md): export zones and gates as YAML, import with a preview.
- [Config file](config-file.md) applied at every start with `--config`, the [admin key](configuration.md#admin-key), the [key](keys.md#key-management-api) and model management APIs, SDKs pointed at the bare origin, Azure-style routes, health probes, `count_tokens`, wildcard models, MCP auth and Slack alerting from the config.

**Improved**
- A recording of the console in the README; username sign-in; built-in keys stay off the map until used.

## 0.1.1 — 23 September 2026

- **Five-minute setup:** a *Get started* guide, models added on first use, a Connect panel per key with a live "connected" check, clear startup output.
- **Demo on a switch** from the console, refusing to start when your setup uses its names.
- **Run it anywhere:** Render and Fly.io configurations; the image honours `PORT` and fixes root-owned volumes.
- **HTTP gateway** for plain REST APIs at `/http/<slug>`.

## 0.1.0 — 23 September 2026

The first public preview: the OpenAI-compatible and Anthropic gateway with the major providers, the MCP tool gateway, the live Airspace, gates (allow, deny, approval, limits, inspect), approvals with hold → ticket → grant (also from Slack), inspect gates for secrets, personal data and prompt injection, simulation against recorded traffic, observed traffic via `/v1/observe` and OpenTelemetry, the data-flow inventory, cost and budgets, alerts, Prometheus metrics, and demo mode.
