# Config file

Control Tower reads LiteLLM's proxy `config.yaml`. Start the server with it and the file is the source of truth for what it declares:

```bash
controltower --config config.yaml                 # or CT_CONFIG=config.yaml, or CONFIG_FILE_PATH
docker run -v $(pwd)/config.yaml:/app/config.yaml -p 4000:4000 ghcr.io/joshmaster2165/controltower --config /app/config.yaml
```

- The file is applied at **every start**: edits and removals take effect on restart, and nothing is duplicated.
- Rows it creates keep stable ids, so the map, history and gates keep pointing at the same models across restarts.
- Providers, models, keys and gates added in the console or through the API are separate and are left alone. Models declared in the file can't be deleted through the API — remove them from the file.
- A file that can't be read or parsed stops startup with the reason. A provider whose key isn't in the environment is skipped with a warning, and the server still starts.

Prefer a one-off import you can then edit in the console? Use **Models → Import from LiteLLM** with the same file.

## Example

```yaml
model_list:
  # One model on one provider
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY

  # Two entries with the same name: load-balanced, with fallback
  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-sonnet-4-5
      api_key: os.environ/ANTHROPIC_API_KEY
      order: 1
  - model_name: claude-sonnet
    litellm_params:
      model: bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0
      aws_region_name: us-east-1
      order: 2

  # A local model, priced by you
  - model_name: local-llama
    litellm_params:
      model: ollama/llama3.2
      api_base: http://localhost:11434
    model_info:
      input_cost_per_token: 0
      output_cost_per_token: 0

  # Embeddings
  - model_name: text-embedding
    litellm_params:
      model: openai/text-embedding-3-small
      api_key: os.environ/OPENAI_API_KEY
    model_info:
      mode: embedding

  # Every Groq model, added the first time it is requested
  - model_name: "groq/*"
    litellm_params:
      model: "groq/*"
      api_key: os.environ/GROQ_API_KEY

router_settings:
  routing_strategy: simple-shuffle

litellm_settings:
  fallbacks: [{ "gpt-4o": ["claude-sonnet"] }]

mcp_servers:
  github:
    url: https://api.githubcopilot.com/mcp/
    transport: http
    auth_type: bearer_token
    auth_value: os.environ/GITHUB_TOKEN

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  alerting: ["slack"]                      # needs SLACK_WEBHOOK_URL
  alert_types: ["llm_exceptions", "budget_alerts", "daily_reports"]
```

## `model_list`

Each entry becomes a provider (one per distinct endpoint and credential) and a deployment.

| Field | Becomes |
|---|---|
| `model_name` | The name agents ask for |
| `litellm_params.model` | `<provider>/<model>` — the provider and the upstream model |
| `api_key`, `api_base`, `api_version` | Provider credentials and endpoint. `os.environ/NAME` reads the environment; LiteLLM's default variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `AWS_*` …) are used when a key is left out |
| `aws_access_key_id`, `aws_secret_access_key`, `aws_region_name`, `aws_bedrock_runtime_endpoint` | AWS Bedrock credentials |
| `vertex_project`, `vertex_location`, `vertex_credentials` | Google Vertex AI |
| `litellm_credential_name` | A named entry in `credential_list` |
| `order` | Priority within a model group (lower first) |
| `weight`, `rpm`, `tpm` | Weight within a model group |
| `model_info.input_cost_per_token`, `output_cost_per_token` | A price override (per token, as in LiteLLM) |
| `model_info.mode: embedding` | An embeddings model |

Several entries with the same `model_name` become an **alias** that routes across them; `router_settings.routing_strategy` picks how (`simple-shuffle` → weighted, `latency-based-routing` → fastest first, `cost-based-routing` → cheapest first; anything else → in order). `litellm_settings.fallbacks` adds fallback targets to an alias.

**Providers**: `openai`, `azure`, `azure_ai`, `anthropic`, `gemini`, `vertex_ai`, `bedrock`, `groq`, `mistral`, `together_ai`, `fireworks_ai`, `deepseek`, `xai`, `openrouter`, `perplexity`, `cerebras`, `deepinfra`, `nvidia_nim`, `sambanova`, `ollama`, `ollama_chat`, `hosted_vllm`, `lm_studio`, `litellm_proxy`, and `openai/` with any `api_base` (any OpenAI-compatible server).

**Wildcards**: `model_name: "openai/*"` with `model: "openai/*"` connects the provider and adds each model the first time it is requested. `model_name: "*"` does that for every provider whose key is set in the environment.

## `mcp_servers`

```yaml
mcp_servers:
  files:
    url: http://files-mcp:3001/mcp
    transport: http                  # Streamable HTTP
    auth_type: bearer_token          # bearer_token | api_key (x-api-key) | basic
    auth_value: os.environ/FILES_MCP_TOKEN
    static_headers: { X-Team: support }
```

Each entry becomes an [MCP server](mcp.md) whose tools agents reach at `/mcp` as `files__<tool>`. Servers with only a `command` (stdio) are skipped with a warning.

## `general_settings`

| Field | Becomes |
|---|---|
| `master_key` | The [admin key](configuration.md#admin-key), unless `CT_ADMIN_KEY` / `LITELLM_MASTER_KEY` is set |
| `alerting: ["slack"]` | A Slack alert channel from `SLACK_WEBHOOK_URL` |
| `alert_types` | [Alert rules](alerts.md#from-a-litellm-config); without it: failed requests, slow requests, budgets and outages |

Settings Control Tower handles itself — `database_url`, `custom_auth`, JWT auth, `ui_access_mode`, `disable_spend_logs` — are listed as ignored in the startup log.

## Not supported

`include` files, context-window and content-policy fallbacks, callbacks (`success_callback` …), guardrails in the config (use [inspect gates](airspace.md#put-a-gate-on-a-path)), and models stored only in LiteLLM's database. Keys live in LiteLLM's database, not in the config; recreate them with `/key/generate` — see [Migrating from LiteLLM](migrating-from-litellm.md#keys).

## `--model` quick start

```bash
OPENAI_API_KEY=sk-… controltower --model openai/gpt-4.1-mini
```

Serves one model with credentials from the environment, like `litellm --model`.
