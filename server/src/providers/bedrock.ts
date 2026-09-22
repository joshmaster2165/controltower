import { SignatureV4 } from '@smithy/signature-v4';
import { Hash } from '@smithy/hash-node';
import { EventStreamCodec } from '@smithy/eventstream-codec';
import { fromUtf8, toUtf8 } from '@smithy/util-utf8';
import type { HttpRequest } from '@smithy/types';
import type { Usage } from '@controltower/shared';
import { normalizeHttpError, type AdapterResult, type ProviderAdapter, type SendOptions, type UpstreamCtx, type UpstreamEvent } from './adapter.js';
import { readBodyText, sendUpstream } from './http.js';
import type { ProviderRecord } from '../registry.js';

/**
 * AWS Bedrock via the Converse / ConverseStream API, which is uniform across
 * Anthropic, Amazon Nova, Meta, Mistral and Cohere models. SigV4 signing via
 * @smithy/signature-v4; the binary event-stream response is decoded with
 * @smithy/eventstream-codec. OpenAI-native to the pipeline.
 *
 * creds: { access_key_id, secret_access_key, session_token? , region }
 * extra: { endpoint? }  — override for tests / VPC endpoints
 */
type Json = Record<string, unknown>;

interface OaMessage {
  role: string;
  content?: string | Json[] | null;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function safeJson(s: string): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

function blocksFromContent(content: OaMessage['content']): Json[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  const out: Json[] = [];
  for (const p of content) {
    if (p.type === 'text' && typeof p.text === 'string') out.push({ text: p.text });
    else if (p.type === 'image_url') {
      const url = (p.image_url as { url?: string } | undefined)?.url ?? '';
      const m = /^data:image\/(\w+);base64,(.+)$/.exec(url);
      if (m) out.push({ image: { format: m[1] === 'jpg' ? 'jpeg' : m[1], source: { bytes: m[2] } } });
    }
  }
  return out;
}

export function oaRequestToConverse(body: Json): Json {
  const msgs = (body.messages as OaMessage[] | undefined) ?? [];
  const system: Json[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: Json[] }> = [];
  const push = (role: 'user' | 'assistant', blocks: Json[]) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of msgs) {
    if (m.role === 'system' || m.role === 'developer') {
      const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n') : '';
      if (text) system.push({ text });
    } else if (m.role === 'user') push('user', blocksFromContent(m.content));
    else if (m.role === 'assistant') {
      const blocks = blocksFromContent(m.content);
      for (const tc of m.tool_calls ?? []) blocks.push({ toolUse: { toolUseId: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) } });
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      push('user', [{ toolResult: { toolUseId: m.tool_call_id ?? '', content: [{ text }] } }]);
    }
  }
  if (messages.length === 0 || messages[0]!.role !== 'user') messages.unshift({ role: 'user', content: [{ text: '(continue)' }] });
  const inference: Json = {};
  const maxOut = typeof body.max_tokens === 'number' ? body.max_tokens : typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined;
  if (maxOut) inference.maxTokens = maxOut;
  if (typeof body.temperature === 'number') inference.temperature = body.temperature;
  if (typeof body.top_p === 'number') inference.topP = body.top_p;
  if (typeof body.stop === 'string') inference.stopSequences = [body.stop];
  else if (Array.isArray(body.stop)) inference.stopSequences = body.stop;
  const out: Json = { messages };
  if (system.length) out.system = system;
  if (Object.keys(inference).length) out.inferenceConfig = inference;
  const tools = (body.tools as Array<{ function?: { name: string; description?: string; parameters?: Json } }> | undefined) ?? [];
  const tc = body.tool_choice;
  if (tools.length && tc !== 'none') {
    const cfg: Json = { tools: tools.filter((t) => t.function).map((t) => ({ toolSpec: { name: t.function!.name, description: t.function!.description || undefined, inputSchema: { json: t.function!.parameters ?? { type: 'object', properties: {} } } } })) };
    if (tc === 'required') cfg.toolChoice = { any: {} };
    else if (tc && typeof tc === 'object' && (tc as { function?: { name?: string } }).function?.name) cfg.toolChoice = { tool: { name: (tc as { function: { name: string } }).function.name } };
    out.toolConfig = cfg;
  }
  return out;
}

function stopToFinish(r: string | undefined, hadTool: boolean): string {
  if (hadTool || r === 'tool_use') return 'tool_calls';
  if (r === 'max_tokens') return 'length';
  if (r === 'content_filtered' || r === 'guardrail_intervened') return 'content_filter';
  return 'stop';
}

export function converseUsageToOa(u: Json | undefined): Json | undefined {
  if (!u) return undefined;
  const input = (u.inputTokens as number) ?? 0;
  const output = (u.outputTokens as number) ?? 0;
  const cacheRead = (u.cacheReadInputTokens as number) ?? 0;
  const cacheWrite = (u.cacheWriteInputTokens as number) ?? 0;
  return { prompt_tokens: input + cacheRead + cacheWrite, completion_tokens: output, total_tokens: input + cacheRead + cacheWrite + output, prompt_tokens_details: { cached_tokens: cacheRead }, ct_cache_write_tokens: cacheWrite };
}

function usageFromOa(u: Json | undefined): Usage | undefined {
  if (!u) return undefined;
  const cached = ((u.prompt_tokens_details as Json | undefined)?.cached_tokens as number) ?? 0;
  const cw = (u.ct_cache_write_tokens as number) ?? 0;
  return { input: Math.max(0, ((u.prompt_tokens as number) ?? 0) - cached - cw), output: (u.completion_tokens as number) ?? 0, cacheRead: cached, cacheWrite: cw };
}

export function converseResponseToOa(res: Json, model: string): Json {
  const msg = ((res.output as Json | undefined)?.message as Json | undefined) ?? {};
  const content = (msg.content as Json[] | undefined) ?? [];
  let text = '';
  const toolCalls: Json[] = [];
  for (const b of content) {
    if (typeof b.text === 'string') text += b.text;
    if (b.toolUse) {
      const t = b.toolUse as { toolUseId: string; name: string; input: unknown };
      toolCalls.push({ id: t.toolUseId, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } });
    }
  }
  const message: Json = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: stopToFinish(res.stopReason as string | undefined, toolCalls.length > 0) }],
    usage: converseUsageToOa(res.usage as Json | undefined),
  };
}

/** Stateful ConverseStream event → OpenAI chunk translator. */
export class ConverseToOaStream {
  private id = `chatcmpl-${Date.now().toString(36)}`;
  private created = Math.floor(Date.now() / 1000);
  private sentRole = false;
  private toolByBlock = new Map<number, number>();
  private nextTool = 0;
  private finish: string | undefined;
  usage: Json | undefined;

  constructor(private readonly model: string) {}

  private chunk(delta: Json, finish: string | null = null): { text: string; parsed: Json } {
    const parsed = { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish }] };
    return { text: `data: ${JSON.stringify(parsed)}\n\n`, parsed };
  }

  feed(type: string, ev: Json): { frames: Array<{ text: string; parsed: Json; usageOnly?: boolean }>; hasContent: boolean } {
    const frames: Array<{ text: string; parsed: Json; usageOnly?: boolean }> = [];
    let hasContent = false;
    switch (type) {
      case 'messageStart':
        frames.push(this.chunk({ role: 'assistant', content: '' }));
        this.sentRole = true;
        break;
      case 'contentBlockStart': {
        const start = (ev.start as Json | undefined)?.toolUse as { toolUseId: string; name: string } | undefined;
        if (start) {
          const idx = this.nextTool++;
          this.toolByBlock.set(ev.contentBlockIndex as number, idx);
          frames.push(this.chunk({ tool_calls: [{ index: idx, id: start.toolUseId, type: 'function', function: { name: start.name, arguments: '' } }] }));
          hasContent = true;
        }
        break;
      }
      case 'contentBlockDelta': {
        const d = ev.delta as { text?: string; toolUse?: { input?: string } } | undefined;
        if (d?.text) {
          frames.push(this.chunk({ content: d.text }));
          hasContent = true;
        } else if (d?.toolUse?.input) {
          const idx = this.toolByBlock.get(ev.contentBlockIndex as number) ?? 0;
          frames.push(this.chunk({ tool_calls: [{ index: idx, function: { arguments: d.toolUse.input } }] }));
          hasContent = true;
        }
        break;
      }
      case 'messageStop':
        this.finish = stopToFinish(ev.stopReason as string | undefined, this.nextTool > 0);
        break;
      case 'metadata':
        this.usage = converseUsageToOa(ev.usage as Json | undefined);
        break;
    }
    return { frames, hasContent };
  }

  finishFrames(includeUsage: boolean): Array<{ text: string; parsed: Json; usageOnly?: boolean }> {
    const frames: Array<{ text: string; parsed: Json; usageOnly?: boolean }> = [];
    if (!this.sentRole) frames.push(this.chunk({ role: 'assistant', content: '' }));
    frames.push(this.chunk({}, this.finish ?? 'stop'));
    if (includeUsage) {
      const u = this.usage ? { ...this.usage } : null;
      if (u) delete u.ct_cache_write_tokens;
      const parsed = { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [], usage: u };
      frames.push({ text: `data: ${JSON.stringify(parsed)}\n\n`, parsed, usageOnly: true });
    }
    frames.push({ text: 'data: [DONE]\n\n', parsed: {} });
    return frames;
  }
}

/** Split a byte stream into complete AWS event-stream messages. */
export async function* eventStreamMessages(body: AsyncIterable<Uint8Array | Buffer>): AsyncIterable<{ headers: Record<string, string>; body: Uint8Array }> {
  const codec = new EventStreamCodec(toUtf8, fromUtf8);
  let buf = new Uint8Array(0);
  for await (const chunk of body) {
    const c = chunk as Uint8Array;
    const merged = new Uint8Array(buf.length + c.length);
    merged.set(buf, 0);
    merged.set(c, buf.length);
    buf = merged;
    while (buf.length >= 4) {
      const total = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
      if (buf.length < total) break;
      const frame = buf.slice(0, total);
      buf = buf.slice(total);
      const msg = codec.decode(frame);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(msg.headers)) headers[k] = String((v as { value: unknown }).value);
      yield { headers, body: msg.body };
    }
  }
}

function region(p: ProviderRecord): string {
  return p.creds.region || (p.extra.region as string | undefined) || 'us-east-1';
}

function runtimeBase(p: ProviderRecord): string {
  return ((p.extra.endpoint as string | undefined) ?? `https://bedrock-runtime.${region(p)}.amazonaws.com`).replace(/\/+$/, '');
}

function controlBase(p: ProviderRecord): string {
  return ((p.extra.control_endpoint as string | undefined) ?? (p.extra.endpoint as string | undefined) ?? `https://bedrock.${region(p)}.amazonaws.com`).replace(/\/+$/, '');
}

async function signedHeaders(p: ProviderRecord, service: 'bedrock', method: 'POST' | 'GET', url: string, body: string | undefined): Promise<Record<string, string>> {
  const u = new URL(url);
  const signer = new SignatureV4({
    credentials: { accessKeyId: p.creds.access_key_id ?? '', secretAccessKey: p.creds.secret_access_key ?? '', ...(p.creds.session_token ? { sessionToken: p.creds.session_token } : {}) },
    region: region(p),
    service,
    sha256: Hash.bind(null, 'sha256'),
  });
  const req: HttpRequest = {
    method,
    protocol: u.protocol,
    hostname: u.hostname,
    ...(u.port ? { port: Number(u.port) } : {}),
    path: u.pathname,
    query: Object.fromEntries(u.searchParams.entries()),
    headers: { host: u.host, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), accept: 'application/json, application/vnd.amazon.eventstream' },
    ...(body !== undefined ? { body } : {}),
  };
  const signed = await signer.sign(req);
  return signed.headers;
}

export class BedrockAdapter implements ProviderAdapter {
  readonly kind = 'bedrock' as const;
  readonly nativeDialects: ReadonlySet<'openai-chat' | 'anthropic-messages'> = new Set(['openai-chat']);
  readonly caps = { streamUsage: 'yes' as const, embeddings: false, listModels: true };

  async send(ctx: UpstreamCtx, body: Record<string, unknown>, opts: SendOptions): Promise<AdapterResult> {
    const p = ctx.provider;
    if (!p.creds.access_key_id || !p.creds.secret_access_key) {
      return { kind: 'error', err: { code: 'provider_misconfigured', message: 'Bedrock provider needs access_key_id and secret_access_key', httpStatus: 502, fallback: false, cooldown: false } };
    }
    const model = opts.upstreamModel;
    const url = `${runtimeBase(p)}/model/${encodeURIComponent(model)}/${opts.stream ? 'converse-stream' : 'converse'}`;
    const reqBody = JSON.stringify(oaRequestToConverse(body));
    let headers: Record<string, string>;
    try {
      headers = await signedHeaders(p, 'bedrock', 'POST', url, reqBody);
    } catch (err) {
      return { kind: 'error', err: { code: 'provider_auth_error', message: `SigV4: ${(err as Error).message}`, httpStatus: 502, fallback: false, cooldown: false } };
    }
    const r = await sendUpstream(p.slug, { url, method: 'POST', headers, body: reqBody }, ctx.signal);
    if (!r.ok) return { kind: 'error', err: r.err };
    const res = r.res;
    if (res.status < 200 || res.status >= 300) {
      const text = await readBodyText(res.body);
      const err = normalizeHttpError(res.status, text, p.slug);
      if (res.status === 403) err.message = `Bedrock rejected the signature or the model is not enabled in ${region(p)}: ${err.message}`;
      return { kind: 'error', err };
    }
    ctx.onFirstByte?.();
    if (!opts.stream) {
      const text = await readBodyText(res.body, 32 * 1024 * 1024);
      const oa = converseResponseToOa(JSON.parse(text) as Json, model);
      const usage = usageFromOa(oa.usage as Json | undefined);
      const clean = { ...oa, usage: oa.usage ? { ...(oa.usage as Json) } : undefined };
      if (clean.usage) delete (clean.usage as Json).ct_cache_write_tokens;
      return { kind: 'json', status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(clean)), usage };
    }
    return { kind: 'stream', status: 200, contentType: 'text/event-stream', events: this.tap(res.body, ctx, model) };
  }

  private async *tap(body: AsyncIterable<Uint8Array | Buffer>, ctx: UpstreamCtx, model: string): AsyncIterable<UpstreamEvent> {
    const x = new ConverseToOaStream(model);
    const enc = new TextEncoder();
    for await (const msg of eventStreamMessages(body)) {
      if (ctx.signal.aborted) return;
      const mtype = msg.headers[':message-type'] ?? 'event';
      const text = toUtf8(msg.body);
      if (mtype === 'exception' || mtype === 'error') {
        let message = text;
        try {
          message = (JSON.parse(text) as { message?: string }).message ?? text;
        } catch {
          /* raw */
        }
        const etype = msg.headers[':exception-type'] ?? msg.headers[':error-code'] ?? 'exception';
        yield { t: 'error', err: { code: 'provider_stream_error', message: `${etype}: ${message}`, httpStatus: 502, fallback: false, cooldown: /throttl/i.test(etype) } };
        return;
      }
      const etype = msg.headers[':event-type'] ?? '';
      let ev: Json = {};
      try {
        ev = text ? (JSON.parse(text) as Json) : {};
      } catch {
        continue;
      }
      const r = x.feed(etype, ev);
      for (const f of r.frames) yield { t: 'frame', raw: enc.encode(f.text), hasContent: r.hasContent, parsed: f.parsed };
    }
    const u = usageFromOa(x.usage);
    if (u) yield { t: 'usage', usage: u, final: true };
    for (const f of x.finishFrames(true)) yield { t: 'frame', raw: enc.encode(f.text), hasContent: false, usageOnly: f.usageOnly ?? false, parsed: f.parsed };
    yield { t: 'done' };
  }

  async listModels(provider: ProviderRecord): Promise<Array<{ id: string; context?: number }>> {
    const url = `${controlBase(provider)}/foundation-models?byOutputModality=TEXT`;
    const headers = await signedHeaders(provider, 'bedrock', 'GET', url, undefined);
    const r = await sendUpstream(provider.slug, { url, method: 'GET', headers }, AbortSignal.timeout(15_000));
    if (!r.ok) throw new Error(r.err.message);
    const text = await readBodyText(r.res.body);
    if (r.res.status >= 300) throw new Error(normalizeHttpError(r.res.status, text, provider.slug).message);
    const j = JSON.parse(text) as { modelSummaries?: Array<{ modelId: string; inferenceTypesSupported?: string[] }> };
    return (j.modelSummaries ?? [])
      .filter((m) => !m.inferenceTypesSupported || m.inferenceTypesSupported.includes('ON_DEMAND') || m.inferenceTypesSupported.includes('INFERENCE_PROFILE'))
      .map((m) => ({ id: m.modelId }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async healthCheck(provider: ProviderRecord): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const t0 = Date.now();
    try {
      const models = await this.listModels(provider);
      return { ok: true, latencyMs: Date.now() - t0, detail: `${models.length} models visible in ${region(provider)}` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, detail: (err as Error).message };
    }
  }
}
