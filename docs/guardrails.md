# Guardrail services

[Inspect gates](airspace.md#how-inspection-works) come with built-in detectors for secrets, personal data and prompt injection, and can ask a model. They can also ask guardrail services you already use, or run yourself. Add one under **Guardrails**, then choose it in an inspect gate. Whatever the service flags gets the gate's action: masked, blocked, or flagged.

| Service | What it finds | Settings |
|---|---|---|
| **Presidio** | Personal data: names, emails, phone numbers, card, bank and ID numbers, locations and more. It says exactly where each is, so a *mask* gate replaces each with its type (`<EMAIL_ADDRESS>`) | Analyzer URL (run `mcr.microsoft.com/presidio-analyzer` yourself); language, entities to look for, minimum score |
| **Lakera Guard** | Prompt attacks, personal data, harmful content | API key; project ID |
| **Bedrock Guardrails** | Whatever your Amazon Bedrock guardrail is set up for: denied topics, content filters, word lists, PII and regex rules | Guardrail ID and version, region, AWS access key (the call is SigV4-signed) |
| **Azure AI Content Safety** | Hate, violence, sexual and self-harm content at or above a severity (default 4 of 7); prompt attacks, with **Prompt Shields** | Endpoint and key |
| **OpenAI moderation** | Harmful content, by OpenAI's moderation model | A connected OpenAI provider (its key is used); model (`omni-moderation-latest`) |
| **Your own URL** | Anything you decide | URL, and a signing secret |

**Try it** on the Guardrails page runs a service on a sample text and shows what it found, and what it would mask.

## In an inspect gate

In the gate editor, **Guardrail services** lists the services you have added. Choose one or more.

- **What they read:** the texts in what the agent sends (**Check** → *what agents send*) or gets back (*what comes back*): message contents, prompts, tool arguments and results. They never see keys, protocol fields, images or audio.
- **Order:** the gate's built-in detectors run first. A gate's services are then asked at the same time, before any model check.
- **Mask it:** works with services that say exactly what to mask: Presidio, and your own URL when it returns the masked texts. With other services, a mask gate withholds the content instead: the call is refused with `400 content_blocked`. When several services mask, each works on what the one before it masked.
- **Block:** the call is refused with `400 content_blocked`, naming the service and what it found. Nothing reaches the model or tool.
- **Flag only:** the call goes through, and the finding shows on the map, in Flights and in [alerts](alerts.md).
- **If a service can't be reached** (a 10 s limit), the content goes through, flagged as unreachable. Set the gate to block instead when that matters more than availability.
- **Streams:** on a reply that is already streaming, services can only flag, like the built-in detectors.

Each call to a service adds its response time to the call it checks. Put service gates on the paths that need them, not on every call.

In a policy file:

```yaml
gates:
  - name: Mask personal data before any model
    target: model
    effect: inspect
    config:
      services: [01K5ZP…]        # the service's id, from GET /admin/api/guardrail-services
      action: mask
      direction: input
      services_on_error: allow  # or block
```

## Your own URL

Control Tower POSTs:

```json
{ "type": "controltower.guardrail", "direction": "input", "texts": ["…", "…"], "agent": { "name": "support-bot", "agent_id": "support-bot", "team": "support" } }
```

If you set a secret, the request is signed `x-ct-signature: t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, like [alert webhooks](alerts.md#webhook-payload). Answer within 10 seconds with one of:

```json
{ "action": "allow" }
{ "action": "block", "reason": "Codenames stay inside", "findings": { "codename": 1 } }
{ "action": "mask", "texts": ["…masked…", "…"], "findings": { "codename": 1 } }
```

For `mask`, return one text for each text you were sent, in the same order.

## API

- `GET /admin/api/guardrail-services` lists services, with the gates that use each. Secrets are never returned.
- `POST /admin/api/guardrail-services` adds one: `{name, kind, config}`, where `kind` is `presidio`, `lakera`, `bedrock`, `azure`, `openai_moderation` or `webhook`.
- `PATCH /admin/api/guardrail-services/:id` changes one; secrets left out are kept.
- `DELETE /admin/api/guardrail-services/:id` removes one. This is refused while a gate still uses it.
- `POST /admin/api/guardrail-services/test` tries a service: `{id or kind + config, text, direction}`.

What `config` holds for each kind:

| `kind` | `config` |
|---|---|
| `presidio` | `analyzer_url` (required), `language` (`en`), `entities`, `score_threshold` |
| `lakera` | `api_key` (required), `project_id`, `url` (default `https://api.lakera.ai/v2/guard`) |
| `bedrock` | `guardrail_id`, `access_key_id`, `secret_access_key` (required), `guardrail_version` (`DRAFT`), `region` (`us-east-1`), `session_token`, `endpoint` |
| `azure` | `endpoint`, `api_key` (required), `severity_threshold` (4), `prompt_shields` |
| `openai_moderation` | `provider` (a connected OpenAI provider's slug) or `api_key`; `model` (`omni-moderation-latest`); with `api_key`, `url` (the API base, default `https://api.openai.com/v1`) |
| `webhook` | `url` (required), `secret`, `headers` |

`api_key`, `secret_access_key`, `session_token`, `secret` and `headers` are secrets: stored encrypted and never returned.
