# Control Tower documentation

Control Tower is a self-hosted AI gateway with a live map of every agentic data flow. Agents call models, MCP tool servers and HTTP APIs through it; you see every path on the map, put gates on the ones that matter, approve risky calls as they happen, and account for every call.

![The console: see every flow, trace an agent, draw a gate, approve the held call](media/controltower-demo.gif)

## Start here

1. [**Getting started**](getting-started.md) — from `docker run` to your own agent on the map, in five minutes.
2. [**Install**](install.md) — Docker, Compose, Render, Fly.io, Railway, any container platform, or from source; upgrades and backups.
3. [**Connect your agents**](connect-agents.md) — OpenAI SDKs, the OpenAI Agents SDK and Codex, Claude Code, LangChain, MCP clients, plain HTTP.

## Set up

- [**Providers and models**](providers-and-models.md) — connect OpenAI, Anthropic, Gemini, Bedrock, Vertex AI, Azure, Ollama…; models added on first use; aliases, load balancing and fallbacks.
- [**Keys, budgets and limits**](keys.md) — one key per agent, with allowed models and tools, rate limits and budgets.
- [**MCP tool servers**](mcp.md) — register tool servers; per-key tool visibility.
- [**HTTP APIs and observed traffic**](http-apis.md) — route REST APIs through the gateway, and map what doesn't go through it.

## Control

- [**The Airspace**](airspace.md) — reading the map, gates (block, require approval, inspect), simulation, approvals in the Tower, zones.
- [**Policy as code**](policy-as-code.md) — zones and gates as YAML, with a preview before anything changes.
- [**Alerts**](alerts.md) — console, Slack and webhooks; approving from Slack.
- [**Monitoring**](monitoring.md) — Flights, the Ledger, the data-flow inventory, Prometheus metrics.
- [**What is enforced**](threat-model.md) — the boundary, stated honestly.

## Reference

- [**Configuration**](configuration.md) — command-line flags, environment variables, the admin key.
- [**Config file**](config-file.md) — the LiteLLM-format `config.yaml`, field by field.
- [**Migrating from LiteLLM**](migrating-from-litellm.md) — LiteLLM's setup steps side by side, and how to move a running proxy.
- [**Demo mode**](demo.md) — a synthetic fleet to explore with.
- [**Architecture**](architecture.md) — how a request flows, what is stored, retention, limits.
- [**API reference**](api.md) — every gateway, admin and health endpoint.
- [**Troubleshooting**](troubleshooting.md) — errors agents see and how to fix them.
- [**Changelog**](changelog.md) — what changed in each release.

Screenshots in these pages are taken from a real server by `pnpm build && pnpm docs:screenshots`.
