# Providers and models

A **provider** is an account at a model API: its endpoint and credentials. A **deployment** is one model on one provider. An **alias** is a name agents ask for that routes across deployments, with fallbacks. Agents only ever send a model name.

## Connect a provider

**Providers** lists the catalogue: OpenAI, Azure OpenAI, Anthropic, Google Gemini, Google Vertex AI and AWS Bedrock; OpenAI-compatible APIs (Groq, Together, Fireworks, Mistral, DeepSeek, xAI, OpenRouter, Perplexity); and local servers (Ollama, vLLM, LM Studio, or any OpenAI-compatible URL). Other OpenAI-compatible APIs — Cerebras, DeepInfra, NVIDIA NIM, SambaNova — connect as **Custom OpenAI-compatible** with their base URL, or by name in a [config file](config-file.md).

![The provider catalogue](images/providers-catalog.png)

Pick one, paste its credentials and press **Connect & test**. Credentials are encrypted at rest with the master key (AES-256-GCM, bound to the row) and are never returned by the API or written to logs or events. The base URL is editable for proxies, regional endpoints and local servers.

![Connecting OpenAI](images/provider-openai-form.png)

| Provider | Credentials |
|---|---|
| OpenAI, Anthropic, Gemini, OpenAI-compatible | API key |
| Azure OpenAI | API key and resource URL (`https://<resource>.openai.azure.com`); the API version is editable |
| AWS Bedrock | Access key ID, secret access key and region (SigV4); an endpoint override for VPC endpoints |
| Google Vertex AI | Service-account JSON, project and location |
| Ollama, LM Studio, vLLM | Base URL only (an API key where the server needs one) |

A connected provider shows its health and the models it offers:

![A connected provider with the models it serves](images/provider-connected.png)

## Models are added on first use

You don't have to register every model. When a request names a model that no deployment or alias covers, Control Tower looks for a connected provider that serves it — by the provider's own model list, or by the price table — adds a deployment, prices it, and serves the request.

- `gpt-4.1-mini`, `claude-sonnet-4-5`, `llama3.2` … resolve to whichever connected provider offers them.
- `<provider-slug>/<model>` pins a provider: `openai/gpt-4.1-mini`, `groq/llama-3.3-70b-versatile`.
- A key's allowed-models globs are matched against the name the agent sends. A key limited to `gpt-4.1*` can ask for `gpt-4.1-mini` but not `openai/gpt-4.1-mini`; use `*gpt-4.1*` to allow both.
- A name nobody serves fails with `404 model_not_found` and says which provider to connect.
- Stand-in demo providers never adopt models, so demo traffic can't reach real providers.
- `CT_AUTO_MODELS=0` turns this off: every model must then be added under **Models**.

![Models: llama3.2, added on first use](images/models.png)

## Deployments

**Models → + Model** (or **+ Add model** on a provider) adds a deployment explicitly. Use it to:

- **rename** a model — the *public name* is what agents ask for (`vertex-gemini` → `gemini-2.5-pro` on Vertex AI);
- **override the price** (per million input / output tokens) for negotiated rates or models missing from the price table;
- **disable** a model without deleting it.

Prices come from a bundled table of about 1,800 models, refreshed with releases. Each request is priced once, at the rate in force when it was routed, and stored in integer nano-dollars. A model without a price is shown as *unpriced*; budgets still charge an input-side estimate for it, so an agent can't drain a budget through a provider that doesn't report usage.

## Aliases, load balancing and fallbacks

**Models → + Alias** gives agents one name — `fast`, `smart`, `default` — for several deployments.

![Models with aliases routing across providers](images/models-aliases.png)

| Strategy | Picks |
|---|---|
| **priority** | The first healthy deployment in the list; the rest are fallbacks in order |
| **weighted** | At random in proportion to weight among the deployments with the best priority, for spreading load across keys, regions or providers; the rest are fallbacks |
| **least latency** | The deployment with the lowest recent time to first token among those with the best priority; ones with no measurement yet go last. Later priorities stay fallbacks |
| **least cost** | The cheapest among those with the best priority, by the price of a typical call (input price × 3 plus output price, per million tokens); deployments without a known price go last. Later priorities stay fallbacks. Set with `routing_strategy: cost-based-routing` in a [config file](config-file.md) |

In the console, the order you click deployments in is the fallback order for **priority**; with the other strategies they all share the best priority. Through the API, give each target a `priority` (lower is tried first) and a `weight`.

- A request **falls back** to the next deployment on rate limits (429), server errors (5xx), timeouts and provider authentication failures — never on a policy decision or an ordinary 400 — and only if nothing has been sent to the client yet, up to three attempts (see *attempts in all* below).
- A deployment that fails is **cooled down** (2 s, doubling to 30 s) and skipped while others are healthy; the next success resets it.
- Aliases cross providers: an alias can fall back from OpenAI to Anthropic, and the request is translated.

## When a call fails: retries and fallback models

**Routing** on an alias (or on a deployment agents call by its own name) sets what happens when its deployments can't answer:

| Setting | |
|---|---|
| **Prompt too long → try** | Models with a larger context window. Deployments whose window the prompt can't fit are skipped before the call is made (the window comes from the price table, or from the deployment's own setting); when a provider refuses a prompt as too long, only candidates with a larger window are tried next, then these models |
| **Content refused → try** | Models to try when a provider refuses the content (a content filter or safety system). Other deployments of the same model are not tried: they would refuse it too |
| **Anything else → try** | Models to try once every deployment has failed otherwise — rate limited, down, timed out |
| **Retries on 429 / timeout / 5xx** | How many times to try the *same* deployment again, with a short backoff (250 ms, doubling up to 4 s), before moving on. Default 0 |
| **Attempts in all** | A cap on tries, fallback models aside (default 3) |

Fallback models are still subject to the key's allowed models and to your gates: a fallback that a gate would deny or hold is skipped. Each call is priced as the deployment that answered it. A request too long for every candidate, with no fallback, is refused before any call: `400 context_window_exceeded`.

## A deployment's own settings

**Routing** on a deployment also sets:

| Setting | |
|---|---|
| **Region** | Where the provider serves it (`eu-west-1`, `swedencentral`). Without one, the provider's region applies (Bedrock's, or a `region` set on the provider) |
| **Reserved for tags** | Requests carrying one of these tags are routed here, and requests without one aren't — unless one of the tags is `default` |
| **Context window** | For models the price table doesn't know |
| **Requests / minute, tokens / minute, at a time** | The deployment's own limits, across every agent. A call that would go over them goes to the next candidate instead; when none is left, it is refused with `429 deployment_busy` |
| **Wait for an answer** | How long to wait for the provider's first byte (default 60 s) |

### Keeping data in a region

A key's **allowed regions** (region globs: `eu-*`, `swedencentral`) keep its calls on deployments in those regions; a model with no deployment there is refused with `403 region_not_available`, never served elsewhere. A request can also ask for a region with an `x-ct-region` header — within the key's regions, or it is refused with `403 region_not_allowed`.

### Routing by tag

Requests carry tags in an `x-ct-tags` header (comma-separated) or `"ct": {"tags": [...]}` in the body. When some of an alias's deployments are reserved for a request's tag, the request goes to them — a `batch` tag to the deployment kept for batch work, say. Tags also break spend down in the Ledger; see [Keys](keys.md#tags-and-customers).

## Import a config file

**Models → Import config** takes a [`config.yaml`](config-file.md), shows what it becomes — providers, deployments, aliases from model groups and fallbacks, MCP servers — asks for any secret it can't resolve, and imports it once.

![Importing a config file: providers, models and fallbacks](images/config-import.png)

To keep the file as the source of truth instead, start the server with `--config`; see [Config file](config-file.md).

## API

The console uses `/admin/api/providers`, `/admin/api/deployments` and `/admin/api/aliases`. With the [admin key](configuration.md#admin-key), scripts can also use the model management endpoints: `GET /model/info`, `POST /model/new`, `POST /model/delete`.
