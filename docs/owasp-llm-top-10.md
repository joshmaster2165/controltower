# OWASP Top 10 for LLM applications

This page maps each item of the OWASP Top 10 for LLM Applications to what Control Tower does about it: what ships, how to turn it on, and where it stops. It's written for a security review and for the team deciding which controls to enable.

Control Tower sits between your agents and the models, tool servers, HTTP APIs and other agents they call. It controls what passes through it: the request, the answer, which tools and models an agent may reach, and its own configuration and image. What a model does inside itself, and what your application does with an answer after the gateway returns it, stay with the provider and with you. Each section says where that line is. The short version:

| Item | Main Control Tower controls | Default |
|---|---|---|
| [LLM01 Prompt injection](#llm01-prompt-injection) | Inspect gates (pattern and model checks), guardrail services, inspection of tool results and resources | Off until you add a gate |
| [LLM02 Sensitive information disclosure](#llm02-sensitive-information-disclosure) | PII and secret detectors that mask or block, Presidio; no stored prompts; encrypted credentials | Structural protections on; detectors off |
| [LLM03 Excessive agency](#llm03-excessive-agency) | Per-key model and tool allowlists, hidden tools, gates, human approvals, argument conditions, delegation gates | Open until you restrict it |
| [LLM04 Supply chain](#llm04-supply-chain) | Signed images, SBOM and provenance, pinned dependencies, no local command execution | On |
| [LLM05 Data and model poisoning](#llm05-data-and-model-poisoning) | Model allowlists; inspecting retrieved content | Partly in scope |
| [LLM06 Unbounded consumption](#llm06-unbounded-consumption) | Budgets, rate and token limits, deployment limits, size caps, alerts | Off until set per key |
| [LLM07 Misinformation](#llm07-misinformation) | Routing to approved models; flagging | Mostly out of scope |
| [LLM08 Hidden context exposure](#llm08-hidden-context-exposure) | System-prompt extraction and secret detectors on answers | Off until you add a gate |
| [LLM09 Vector and embedding weaknesses](#llm09-vector-and-embedding-weaknesses) | Keys, limits and gates on embedding calls | Mostly out of scope |
| [LLM10 Improper output handling](#llm10-improper-output-handling) | Output inspection that masks or blocks | Off until you add a gate |

## LLM01 Prompt injection

**What ships:**
- [Inspect gates](airspace.md#how-inspection-works) with injection detectors: ignore-previous-instructions, role override, system-prompt extraction, chat-template markup, and instructions to send data elsewhere.
- An optional **model check**: a model you choose is asked whether the content contains instructions aimed at an AI.
- [Guardrail services](guardrails.md): Lakera Guard, Azure Prompt Shields, and your own URL.

Gates run on the prompt before it leaves and, just as important for agents, on **tool results and MCP resources before the agent reads them**. That's where indirect injection arrives.

**Turn it on:** add an inspect gate on the Airspace, direction *both* or *output*, with the injection detectors, and mask or block.

**Limits:** pattern detectors catch the known phrasings; a model check or a service catches more but costs a call. A streamed model reply is inspected after it has been delivered, so a match there is flagged, not blocked. Nothing stops a model from being influenced by what it's allowed to read; keep the tools an agent can reach narrow (see LLM03).

## LLM02 Sensitive information disclosure

**What ships:**
- Detectors for personal data (email, phone, card numbers with a Luhn check, US SSN, IBAN, IP address) and secrets (AWS, GitHub, Slack, Stripe, OpenAI, Anthropic, Google and Control Tower keys, private keys, JWTs, connection strings), which **mask or block**.
- [Presidio](guardrails.md) for many more kinds of personal data, masked exactly.

Protections that are always on:
- Prompts and answers are never stored.
- Flight events, [exports](exports.md) and the [audit log](audit.md) carry metadata only, with secrets redacted.
- Provider and tool-server credentials are encrypted at rest (AES-256-GCM).
- API keys and sessions are stored only as hashes.

**Turn it on:** an inspect gate with the PII and secret detectors, direction *both*, action *mask*.

**Limits:** detection is pattern- or service-based and won't catch everything; data the provider already holds, and what it does with it, are covered by your agreement with the provider.

## LLM03 Excessive agency

**What ships:**
- **Allowlists:** each [key](keys.md) is limited to the models and tools you allow (`allowed_models`, `allowed_mcp`). Tools a key may not use aren't even listed to the agent.
- **[Gates](airspace.md)** on any path, agent to model, tool, HTTP API or other agent:
  - *deny*;
  - *require approval*: the call is held until a person decides, and the approval covers only that exact call, its arguments and its prompt;
  - *allow with limits*;
  - argument conditions, such as `repo` must match `acme/*`.
- **Delegation gates** ([agents calling agents](agent-to-agent.md)) decide what an agent may do on behalf of another.
- **Route allowlists** for [HTTP APIs](http-apis.md).

**Turn it on:** give each agent its own key, restrict `allowed_mcp` and `allowed_models`, and put *require approval* gates on the destructive tools.

**Limits:** a new key can use every model and tool until restricted. An agent that calls a system directly, without going through Control Tower, isn't enforced; it shows as *observed* on the map if it reports its traffic (see [What is enforced](threat-model.md)).

## LLM04 Supply chain

**What ships:**
- [Signed images](install.md#verifying-the-image): Sigstore cosign, keyless and tied to the repository's workflow, with an SBOM and full build provenance, plus GitHub's build attestation. The Helm chart is signed too.
- CI installs from the frozen lockfile. Security-critical libraries are pinned (the SAML signature library, for example).
- Control Tower never runs local commands for tool servers: MCP servers are reached over HTTP only.
- The model price table is vendored data, not fetched at run time.

**Turn it on:** verify the image and chart signatures in your deployment pipeline, and pin the image by digest.

**Limits:** the models themselves and the tool servers you connect are your supply chain; Control Tower shows which ones each agent uses (the [Inventory](monitoring.md) lists every path).

## LLM05 Data and model poisoning

**What ships:** keys limited to approved models and providers (a poisoned or unapproved model can't be reached), and inspect gates on retrieved content (tool results, MCP resources) for injected instructions.

**Limits:** Control Tower doesn't train or fine-tune models, and doesn't manage your training data or vector stores. Poisoning of those is out of its reach.

## LLM06 Unbounded consumption

**What ships:**
- [Budgets](keys.md) per key, team, project and customer, hard or soft; budget alerts for keys, teams and projects.
- Requests and tokens per minute and concurrent calls per key.
- Each deployment's own limits, across every agent.
- Request bodies capped at 10 MB.
- Timeouts on every upstream.
- A cap on calls held for approval.
- Alerts on spend, errors and latency.

**Turn it on:** set a budget and rate limits on each key (or its team), and a budget alert.

**Limits:** limits are per Control Tower deployment; with several instances they're shared through Redis. Spend is estimated where a provider doesn't report usage, and the estimate is labelled.

## LLM07 Misinformation

**What ships:** routing to the models you approve, and flags on content you define as unacceptable (inspect gates with *flag*).

**Limits:** judging whether an answer is true is outside the gateway. Custom model-judge guardrails are planned; grounding and fact-checking stay with your application.

## LLM08 Hidden context exposure

**What ships:** a *system-prompt extraction* detector for requests that try to get a model to reveal its instructions, and secret detectors on answers, so a system prompt carrying a key doesn't leak it.

**Turn it on:** an inspect gate, direction *both*, with the injection and secret detectors.

**Limits:** a model can paraphrase its instructions in ways no pattern catches. Keep secrets out of system prompts; Control Tower injects provider credentials itself, so agents never need to hold them.

## LLM09 Vector and embedding weaknesses

**What ships:** embedding calls (`/v1/embeddings`) go through the same keys, limits, budgets and gates as any other call, so you control which agents embed what, and where.

**Limits:** Control Tower doesn't host or query vector stores; access control inside them, and poisoning of stored embeddings, stay with the store.

## LLM10 Improper output handling

**What ships:** inspect gates on answers and tool results that **mask or block** before the agent reads them (secrets, personal data, injected instructions), and guardrail services on output.

**Turn it on:** an inspect gate, direction *output* or *both*, action *mask* or *block*.

**Limits:** streamed model replies are checked after delivery (flagged, not blocked). Whatever your application does with an answer — rendering it as HTML, running it as code, passing it to a shell — needs its own validation there.

## Keeping this page current

Every claim here was checked against the code at the version in the [changelog](changelog.md) that added it. To check it against the version you run, see the linked pages; each describes what ships and its limits in detail.
