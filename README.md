<p align="center">
  <img src="ui/public/logo-wordmark.svg" alt="Control Tower" width="320"><br/>
  The self-hosted AI gateway that <em>shows</em> you where your agents go — and lets you stop them at the border.
</p>

---

**Control Tower** is an open-source AI gateway with a live, animated map of agent traffic. Point your agents at it like you would any OpenAI-compatible endpoint; every model call and every MCP tool call becomes a *flight* on the **Airspace**. Draw **zones** around systems, put **gates** on the boundaries, and require a human to approve a flight before it crosses. It is an enforcement point, not a dashboard: a gate that says *no* returns a 403 to the agent.

- **See it.** Agents, models, MCP servers and integrations as stations; requests as particles travelling the lanes; cost, tokens and latency as visual weight.
- **Draw the rules.** Lasso stations into a zone, click a boundary, pick *allow / deny / require approval / allow with limits*. YAML is the *output*, for review and Git.
- **Stop it.** Approvals hold the agent's request at the gate; a human clicks approve in the **Tower** and the flight continues. Unanswered holds turn into a resumable ticket, never a silent timeout.
- **Count it.** Per-key, per-team, per-model spend and tokens with budgets and rate limits — the accounting you'd expect from an LLM gateway, with the map on top.

> Status: **v0.1 preview.** Working today: the OpenAI-compatible and Anthropic-native gateway (OpenAI, Azure, Anthropic, Google Gemini, Google Vertex AI, AWS Bedrock, Groq, Together, Mistral, DeepSeek, xAI, OpenRouter, Ollama, vLLM, any OpenAI-compatible URL), API keys with limits and budgets, cost accounting from a vendored price table, the live Airspace, zones and gates drawn on the map, human approvals with hold → ticket → grant, the MCP tool gateway, and demo mode. Not yet: embeddings, Flight Recorder replay/simulate, the Ledger page, Slack notifications. See the roadmap and [docs/threat-model.md](docs/threat-model.md).

## Quickstart

```bash
docker run -p 4000:4000 -v controltower-data:/data -e CT_DEMO=1 ghcr.io/controltower-ai/controltower
```

Open <http://localhost:4000>, set your admin password, and you're in. With `CT_DEMO=1` a synthetic agent fleet flies through the real pipeline so the Airspace is alive in seconds; clear it from the console when you connect real providers.

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
| **Ledger** | Cost, tokens, latency. |
| **Flight Recorder** | Replay and *simulate* — what would this rule have done to yesterday's traffic? |

## What is actually enforced

Control Tower only enforces traffic that goes through it. A lane is drawn **solid** only when the gateway is in the path for that hop (LLM calls and MCP tool calls routed through Control Tower). Anything learned by observation alone is drawn **dashed**, and a rule existing on an edge never makes it solid. An agent that edits its own `base_url` bypasses the LLM gateway; the MCP gateway's `tools/list` filtering is the stronger control, because a tool the agent cannot see needs no approval. An egress-proxy sidecar to close the `base_url` gap is on the roadmap. We would rather you know the boundary than believe in one that isn't there.

## Configuration

Everything is configured in the browser. Environment variables exist for operators:

| Variable | Default | Purpose |
|---|---|---|
| `CT_PORT` | `4000` | Listen port |
| `CT_DATA_DIR` | `./data` (`/data` in Docker) | SQLite database and the master key |
| `CT_MASTER_KEY` | generated | Base64 32-byte key encrypting provider credentials at rest. Back up `/data/master.key` if you let it generate one. |
| `CT_DEMO` | `0` | Seed a mock provider and run a synthetic agent fleet |
| `CT_MODE` | `on` | `off` disables policy enforcement (kill switch) |
| `CT_PUBLIC_URL` | — | Public URL, used for signed approval links and the ingress probe |
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
