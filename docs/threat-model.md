# What Control Tower enforces — and what it only observes

Control Tower is an enforcement point for traffic that goes **through** it. This page says exactly where that boundary is, because an observability product that implies enforcement it does not have is worse than one that admits the gap.

## Enforced (the gateway is in the path)

| Hop | How it is enforced | Bypass |
|---|---|---|
| Agent → model via `/v1/chat/completions`, `/v1/messages`, `/v1/embeddings` | Policy runs before the upstream request is sent; a `deny` is a 403, a `require_approval` holds the request. | An agent that changes its own `base_url` never reaches the gateway. Treat the LLM gateway as a control against a *misbehaving model inside cooperative code*, not against a malicious developer with network access. |
| Agent → tool via `/mcp` or `/mcp/<server>` | `tools/list` is filtered before the model ever sees a tool (deny-by-invisibility); `tools/call` runs the same policy and hold path. | Same `base_url` caveat; an agent configured to talk to the upstream MCP server directly bypasses the gate. Keep upstream MCP credentials in Control Tower only. |
| Agent → REST API via `/http/<slug>/…` | Each request runs the same policy, hold and inspect path as a tool call (route and method are the target; `GET`/`HEAD` read, `POST`/`PUT`/`PATCH` write, `DELETE` destructive). The agent's Control Tower key is stripped and the API's stored credentials are added, so the agent never needs them. Paths are confined to the registered base URL: dot segments, encoded dots and backslashes are refused before anything is sent. | An agent that still holds the API's own credentials can call its host directly. Move those credentials into Control Tower and revoke the agent's copy. The admin chooses each base URL, so only register hosts agents should reach. |

## Observed only (drawn dashed on the Airspace)

- Calls reported through `/v1/observe` or OpenTelemetry spans rather than made through the gateway. They are mapped and documented, and each comes with steps to bring it inside.
- Browser-driven agents that are not wrapped by the Playwright fixture (planned for v0.3).

A rule existing on an edge never makes it solid. A lane is solid only when a gateway path is actually carrying that traffic.

## Approval semantics

- **At-most-once redemption.** A grant is single-use for writes by default. "A human said yes to exactly this action once" is the guarantee. Exactly-once *side effects* are not achievable — a tool call can succeed while the response is lost — and we do not claim them.
- **Scope binding.** Grants bind to the agent key, the target, the rule revision and a hash of the salient arguments. Redeeming with different arguments is a `scope_mismatch`, logged as a security event and shown red on the edge.
- **The card shows wire arguments, never the model's summary.** A model can describe a benign action and perform a different one; the approval UI renders what will actually be sent.
- **GET never approves.** Link unfurlers in Slack and mail clients fetch URLs; approval is always an authenticated POST from the console.
- **Tickets leak into transcripts.** The ticket is delivered in an error message the model reads, so it lands in conversation history. Tickets are bound to the key that requested them and expire with the approval request.

## Failure posture

- Enforcement is in-process, so there is no "policy service unavailable" mode for the gateway itself. If Control Tower is down, nothing routed through it works — fail-closed by construction.
- `CT_MODE=off` is a deliberate kill switch that disables policy evaluation (every decision becomes allow). It is shown as a banner in the console.
- On `SIGTERM`, every held request is converted into a ticket immediately; nothing is left to time out as a 502.

## Secrets

- Provider credentials, MCP auth and HTTP API credentials are encrypted at rest with AES-256-GCM under a master key (`CT_MASTER_KEY` or `/data/master.key`). Back the key up; without it the ciphertext is unreadable and providers must be re-connected.
- Credentials are decrypted into memory only, never attached to a flight or an event, and never included in error messages. Upstream error bodies are scrubbed for common key formats before storage.
- Control Tower API keys are stored as SHA-256 hashes. The `ct_sk_` prefix and CRC suffix make leaked keys detectable by secret scanners.
