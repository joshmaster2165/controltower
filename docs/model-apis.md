# Images, audio and providers' own APIs

Chat isn't the only thing agents ask models for. Control Tower also passes through images, speech, transcription, moderation, rerank and legacy completions, and each provider's own API for agents built on Google's and AWS's SDKs. Each call is a flight like any other: the agent's key, limits and budgets apply, gates see it, and it shows on the map, in **Flights** and in the Ledger, billed on what it made.

## OpenAI-style endpoints

Point the agent's OpenAI SDK at Control Tower as you would for chat (`base_url=https://<control-tower>/v1`, with a Control Tower key). These endpoints are forwarded to OpenAI, Azure OpenAI and OpenAI-compatible providers:

| Endpoint | Billed on |
|---|---|
| `POST /v1/images/generations` | Each image, by its quality and size; token-priced models (`gpt-image-1`) by their text, image and output tokens |
| `POST /v1/images/edits`, `/v1/images/variations` | The same. The upload is passed on byte for byte |
| `POST /v1/audio/speech` | Characters spoken, or tokens where the model reports them (`stream_format: "sse"`). The audio streams back as it arrives |
| `POST /v1/audio/transcriptions`, `/v1/audio/translations` | Seconds of audio, or audio tokens, as the provider reports them |
| `POST /v1/moderations` | Tokens (free at OpenAI). `model` defaults to `omni-moderation-latest` |
| `POST /v1/rerank` (also `/v2/rerank` for Cohere's SDK) | Searches, or tokens where the provider reports them |
| `POST /v1/completions` | Tokens, like chat; streams |

```python
from openai import OpenAI
client = OpenAI(base_url="https://controltower.example.com/v1", api_key="ct_sk_…")
client.images.generate(model="gpt-image-1", prompt="a control tower at dusk")
client.audio.transcriptions.create(model="whisper-1", file=open("call.mp3", "rb"))
```

- Models are [added on first use](providers-and-models.md#models-are-added-on-first-use) like chat models, and `<provider>/<model>` pins a provider.
- A model served by a provider without the endpoint (Anthropic has no image endpoint) is refused with `400 endpoint_not_supported`.
- Rerank providers that serve it at another path (Cohere: `https://api.cohere.com/v2/rerank`) connect as **Custom OpenAI-compatible**; set `rerank_path` in the provider's extra settings if the path differs from `rerank`.
- Prices come from the bundled price table. A model it doesn't know shows as *unpriced* until you set a price on its deployment: `per_image`, `per_pixel`, `per_character`, `per_second`, `per_query`, or token prices (`input`, `output`, `image_input`, `image_output`, `audio_input`, `audio_output`, in USD per million).

## Gemini's own API

Agents built on Google's Gen AI SDK (and the Gemini CLI) call Gemini's API directly. Point the SDK's base URL at `/gemini` and give it a Control Tower key:

```python
from google import genai
client = genai.Client(api_key="ct_sk_…", http_options={"base_url": "https://controltower.example.com/gemini"})
client.models.generate_content(model="gemini-2.5-flash", contents="Hello")
```

`models/{model}:{method}` calls go through for `generateContent`, `streamGenerateContent` (with or without `?alt=sse`), `countTokens`, `embedContent`, `batchEmbedContents` and `predict`, to a connected Gemini or Vertex AI provider. The key may come as `x-goog-api-key` or `?key=`; either way it is replaced with the provider's credentials and never reaches Google.

## Bedrock's runtime API

Agents built on the AWS SDKs call Bedrock's runtime directly. Give the SDK Control Tower's `/bedrock` as its endpoint and a Control Tower key as its Bedrock API key; Control Tower signs each call with the provider's AWS credentials:

```python
import os, boto3
os.environ["AWS_BEARER_TOKEN_BEDROCK"] = "ct_sk_…"
bedrock = boto3.client("bedrock-runtime", region_name="us-east-1", endpoint_url="https://controltower.example.com/bedrock")
bedrock.converse(modelId="anthropic.claude-3-5-haiku-20241022-v1:0", messages=[{"role": "user", "content": [{"text": "Hello"}]}])
```

`Converse`, `ConverseStream`, `InvokeModel` and `InvokeModelWithResponseStream` go through to a connected Bedrock provider. Model ids and inference profiles (`us.anthropic.…`) are added on first use. Tokens are read from the answer, from Bedrock's token-count headers, or from the stream's closing metrics.

## Gates and inspection

Gates see these calls as model calls, with an `endpoint` argument, so a gate can single them out:

```yaml
gates:
  - name: No image generation for support agents
    from: Support agents
    target: model
    match: { args: [{ path: endpoint, op: eq, value: images/generations }] }
    effect: deny
```

Endpoints are named as in the table above; providers' own APIs are `gemini:<method>` and `bedrock:<operation>` (`gemini:generateContent`, `bedrock:converse`). Inspect gates read what the agent sends: the prompt, text to speak, text to moderate, the query and documents to rank, Gemini's `contents` and Bedrock's `messages`. They also read JSON answers (transcripts, rankings), but not image or audio data.
