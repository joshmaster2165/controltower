import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdapterResult, UpstreamCtx, UpstreamEvent } from '../src/providers/adapter.js';
import { GeminiAdapter } from '../src/providers/gemini.js';
import { BedrockAdapter } from '../src/providers/bedrock.js';
import { VertexAdapter } from '../src/providers/vertex.js';
import type { DeploymentRecord, ProviderRecord } from '../src/registry.js';
import { fakeBedrock, fakeGemini, fakeServiceAccount, fakeVertex, type FakeServer } from './fakes.js';

function provider(kind: ProviderRecord['kind'], slug: string, creds: Record<string, string>, extra: Record<string, unknown> = {}, baseUrl?: string): ProviderRecord {
  return { id: `prov_${slug}`, kind, name: slug, slug, baseUrl, creds, extra, health: 'unknown', healthDetail: undefined, streamUsageSupported: undefined, demo: false };
}
const deployment: DeploymentRecord = { id: 'dep', providerId: 'p', upstreamModel: 'm', publicName: undefined, caps: {}, pricingOverride: undefined, weight: 100, enabled: true, coolingUntil: undefined, cooldownStrikes: 0, ewmaTtftMs: undefined, demo: false };
const ctx = (p: ProviderRecord): UpstreamCtx => ({ flightId: 'f1', provider: p, deployment, signal: new AbortController().signal });

async function collect(r: AdapterResult): Promise<{ text: string; chunks: Array<Record<string, unknown>>; usage: UpstreamEvent | undefined; errors: UpstreamEvent[] }> {
  if (r.kind !== 'stream') throw new Error(`expected stream, got ${r.kind}`);
  let text = '';
  const chunks: Array<Record<string, unknown>> = [];
  let usage: UpstreamEvent | undefined;
  const errors: UpstreamEvent[] = [];
  for await (const ev of r.events) {
    if (ev.t === 'frame') {
      const raw = Buffer.from(ev.raw).toString('utf8');
      text += raw;
      const data = raw.replace(/^data: /, '').trim();
      if (data && data !== '[DONE]') chunks.push(JSON.parse(data) as Record<string, unknown>);
    } else if (ev.t === 'usage') usage = ev;
    else if (ev.t === 'error') errors.push(ev);
  }
  return { text, chunks, usage, errors };
}
const contentOf = (chunks: Array<Record<string, unknown>>) => chunks.map((c) => ((c.choices as Array<{ delta?: { content?: string } }>)[0]?.delta?.content ?? '')).join('');
const toolArgsOf = (chunks: Array<Record<string, unknown>>) =>
  chunks.flatMap((c) => ((c.choices as Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>)[0]?.delta?.tool_calls ?? [])).map((t) => t.function?.arguments ?? '').join('');
const weatherTools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, additionalProperties: false } } }];

describe('GeminiAdapter', () => {
  let srv: FakeServer;
  beforeAll(async () => (srv = await fakeGemini()));
  afterAll(() => srv.close());
  const p = () => provider('gemini', 'gemini', { api_key: 'gem-key' }, {}, srv.url);
  const a = new GeminiAdapter();

  it('lists models and passes health', async () => {
    expect((await a.listModels(p())).map((m) => m.id)).toEqual(['gemini-2.5-flash']);
    expect((await a.healthCheck(p())).ok).toBe(true);
  });

  it('translates a non-streaming request and response', async () => {
    const r = await a.send(ctx(p()), { model: 'x', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }], max_tokens: 20 }, { inboundDialect: 'openai-chat', stream: false, upstreamModel: 'gemini-2.5-flash' });
    expect(r.kind).toBe('json');
    if (r.kind !== 'json') return;
    const j = JSON.parse(Buffer.from(r.body).toString()) as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number } };
    expect(j.choices[0]!.message.content).toBe('Hello from Gemini');
    expect(r.usage).toMatchObject({ input: 11, output: 7 });
    const sent = JSON.parse(srv.calls.at(-1)!.body) as { systemInstruction: { parts: Array<{ text: string }> }; generationConfig: { maxOutputTokens: number } };
    expect(sent.systemInstruction.parts[0]!.text).toBe('be brief');
    expect(sent.generationConfig.maxOutputTokens).toBe(20);
    expect(srv.calls.at(-1)!.url).toContain('gemini-2.5-flash:generateContent');
  });

  it('streams OpenAI chunks with a tool call and usage', async () => {
    const r = await a.send(ctx(p()), { model: 'x', messages: [{ role: 'user', content: 'weather?' }], tools: weatherTools, stream: true }, { inboundDialect: 'openai-chat', stream: true, upstreamModel: 'gemini-2.5-flash' });
    const out = await collect(r);
    expect(out.errors).toHaveLength(0);
    expect(contentOf(out.chunks)).toBe('Hello from Gemini');
    expect(toolArgsOf(out.chunks)).toBe('{"city":"Paris"}');
    expect(out.text.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(out.usage && out.usage.t === 'usage' ? out.usage.usage : null).toMatchObject({ input: 11, output: 7 });
    const sent = JSON.parse(srv.calls.at(-1)!.body) as { tools: Array<{ functionDeclarations: Array<{ parameters: Record<string, unknown> }> }> };
    expect(sent.tools[0]!.functionDeclarations[0]!.parameters.additionalProperties).toBeUndefined();
  });

  it('maps a bad key to provider_bad_request', async () => {
    const r = await a.send(ctx(provider('gemini', 'gemini', { api_key: 'nope' }, {}, srv.url)), { model: 'x', messages: [{ role: 'user', content: 'hi' }] }, { inboundDialect: 'openai-chat', stream: false, upstreamModel: 'gemini-2.5-flash' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.err.code).toBe('provider_bad_request');
  });
});

describe('BedrockAdapter', () => {
  let srv: FakeServer;
  beforeAll(async () => (srv = await fakeBedrock()));
  afterAll(() => srv.close());
  const p = (key = 'AKIATEST12345') => provider('bedrock', 'bedrock', { access_key_id: key, secret_access_key: 'secret', region: 'us-east-1' }, { endpoint: srv.url });
  const a = new BedrockAdapter();

  it('signs requests with SigV4 and lists models', async () => {
    expect((await a.listModels(p())).map((m) => m.id)).toEqual(['amazon.nova-lite-v1:0', 'anthropic.claude-sonnet-4-5']);
    const h = srv.calls.at(-1)!.headers;
    expect(String(h.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST12345\/\d{8}\/us-east-1\/bedrock\/aws4_request/);
    expect(h['x-amz-date']).toBeTruthy();
  });

  it('translates Converse non-streaming with tools', async () => {
    const r = await a.send(ctx(p()), { model: 'x', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'weather?' }], tools: weatherTools, max_tokens: 50 }, { inboundDialect: 'openai-chat', stream: false, upstreamModel: 'anthropic.claude-sonnet-4-5' });
    expect(r.kind).toBe('json');
    if (r.kind !== 'json') return;
    const j = JSON.parse(Buffer.from(r.body).toString()) as { choices: Array<{ message: { content: string; tool_calls: Array<{ function: { name: string; arguments: string } }> }; finish_reason: string }> };
    expect(j.choices[0]!.message.content).toBe('Hello from Bedrock');
    expect(j.choices[0]!.message.tool_calls[0]!.function).toEqual({ name: 'get_weather', arguments: '{"city":"Paris"}' });
    expect(j.choices[0]!.finish_reason).toBe('tool_calls');
    expect(r.usage).toMatchObject({ input: 13, output: 9 });
    const sent = JSON.parse(srv.calls.at(-1)!.body) as { system: Array<{ text: string }>; inferenceConfig: { maxTokens: number }; toolConfig: { tools: Array<{ toolSpec: { name: string } }> } };
    expect(sent.system[0]!.text).toBe('sys');
    expect(sent.inferenceConfig.maxTokens).toBe(50);
    expect(sent.toolConfig.tools[0]!.toolSpec.name).toBe('get_weather');
  });

  it('decodes the binary event stream into OpenAI chunks', async () => {
    const r = await a.send(ctx(p()), { model: 'x', messages: [{ role: 'user', content: 'weather?' }], tools: weatherTools, stream: true }, { inboundDialect: 'openai-chat', stream: true, upstreamModel: 'anthropic.claude-sonnet-4-5' });
    const out = await collect(r);
    expect(out.errors).toHaveLength(0);
    expect(contentOf(out.chunks)).toBe('Hello from Bedrock');
    expect(toolArgsOf(out.chunks)).toBe('{"city":"Paris"}');
    const finish = out.chunks.find((c) => (c.choices as Array<{ finish_reason: string | null }>)[0]?.finish_reason);
    expect((finish!.choices as Array<{ finish_reason: string }>)[0]!.finish_reason).toBe('tool_calls');
    expect(out.usage && out.usage.t === 'usage' ? out.usage.usage : null).toMatchObject({ input: 13, output: 9 });
    expect(srv.calls.at(-1)!.url).toContain('/converse-stream');
  });

  it('surfaces a signature rejection as provider_auth_error', async () => {
    const r = await a.send(ctx(p('AKIAWRONG')), { model: 'x', messages: [{ role: 'user', content: 'hi' }] }, { inboundDialect: 'openai-chat', stream: false, upstreamModel: 'amazon.nova-lite-v1:0' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.err.code).toBe('provider_auth_error');
  });
});

describe('VertexAdapter', () => {
  let srv: FakeServer;
  beforeAll(async () => (srv = await fakeVertex()));
  afterAll(() => srv.close());
  const p = () => provider('vertex', 'vertex', { service_account_json: fakeServiceAccount(`${srv.url}/token`) }, { project: 'test-proj', location: 'us-central1', endpoint: srv.url });
  const a = new VertexAdapter();

  it('exchanges a service-account JWT for a token and passes health', async () => {
    const h = await a.healthCheck(p());
    expect(h.ok).toBe(true);
    expect(srv.calls.some((c) => c.url === '/token')).toBe(true);
  });

  it('routes Gemini models to the google publisher (stream)', async () => {
    const r = await a.send(ctx(p()), { model: 'x', messages: [{ role: 'user', content: 'hi' }], stream: true }, { inboundDialect: 'openai-chat', stream: true, upstreamModel: 'gemini-2.5-pro' });
    const out = await collect(r);
    expect(contentOf(out.chunks)).toBe('Hello from Vertex');
    expect(srv.calls.at(-1)!.url).toContain('/publishers/google/models/gemini-2.5-pro:streamGenerateContent');
    expect(out.usage && out.usage.t === 'usage' ? out.usage.usage : null).toMatchObject({ input: 5, output: 4 });
  });

  it('routes Claude models to the anthropic publisher with the vertex version and no model field', async () => {
    const r = await a.send(ctx(p()), { model: 'x', messages: [{ role: 'user', content: 'hi' }] }, { inboundDialect: 'openai-chat', stream: false, upstreamModel: 'claude-sonnet-4-5' });
    expect(r.kind).toBe('json');
    if (r.kind !== 'json') return;
    const j = JSON.parse(Buffer.from(r.body).toString()) as { choices: Array<{ message: { content: string } }> };
    expect(j.choices[0]!.message.content).toBe('Hello from Claude on Vertex');
    expect(srv.calls.at(-1)!.url).toContain('/publishers/anthropic/models/claude-sonnet-4-5:rawPredict');
    const s = await a.send(ctx(p()), { model: 'x', messages: [{ role: 'user', content: 'hi' }], stream: true }, { inboundDialect: 'openai-chat', stream: true, upstreamModel: 'claude-sonnet-4-5' });
    const out = await collect(s);
    expect(contentOf(out.chunks)).toBe('Hello from Claude on Vertex');
    expect(out.usage && out.usage.t === 'usage' ? out.usage.usage : null).toMatchObject({ input: 6, output: 5 });
  });
});
