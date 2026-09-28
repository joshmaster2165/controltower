import { test, expect } from '@playwright/test';
import OpenAI, { toFile } from 'openai';
import { CT, admin, flightById } from './support/admin';
import { bedrockRuntime, geminiApi, multipartField, openAiApis, type ApiUpstream } from './support/model-apis';

/**
 * Model APIs other than chat pass through Control Tower: images, audio, moderations, rerank and legacy
 * completions (the official OpenAI SDK), and Gemini's and Bedrock's own APIs. Each is a recorded flight,
 * billed on what it made, with the provider's credentials swapped in and gates applied.
 */
test.describe.configure({ mode: 'serial' });

let oa: ApiUpstream;
let gem: ApiUpstream;
let bed: ApiUpstream;
let key = '';
let keyId = '';
const providerIds: string[] = [];
let client: OpenAI;
const nano = (usd: number) => Math.round(usd * 1e9);

/** The flight behind the last response (its id is in x-ct-flight-id). */
async function flightOf(res: Response | { headers: Headers }): Promise<any> {
  const id = res.headers.get('x-ct-flight-id');
  expect(id).toBeTruthy();
  return flightById(id!);
}

test.beforeAll(async () => {
  [oa, gem, bed] = await Promise.all([openAiApis(), geminiApi(), bedrockRuntime()]);
  await admin.signIn();
  const mk = async (b: unknown) => {
    const r = await admin.post('/admin/api/providers', b);
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const p = r.body.provider ?? r.body;
    providerIds.push(p.id);
    return p;
  };
  const mapi = await mk({ catalog_id: 'openai', name: 'APIs upstream', slug: 'mapi', base_url: `${oa.url}/v1`, credentials: { api_key: 'sk-apis' } });
  const g = await mk({ catalog_id: 'gemini', name: 'Gemini upstream', slug: 'gem', base_url: gem.url, credentials: { api_key: 'gk-test' } });
  // Its own name, so no other Gemini provider on this server can serve it.
  expect((await admin.post('/admin/api/deployments', { provider_id: g.id, upstream_model: 'gemini-2.5-flash', public_name: 'gem-e2e-flash' })).status).toBeLessThan(300);
  const b = await mk({ catalog_id: 'bedrock', name: 'Bedrock upstream', slug: 'bed', credentials: { access_key_id: 'AKIATEST', secret_access_key: 'secret', region: 'us-east-1' }, extra: { endpoint: bed.url } });
  expect((await admin.post('/admin/api/deployments', { provider_id: b.id, upstream_model: 'anthropic.claude-3-5-haiku-20241022-v1:0', public_name: 'bed-e2e-haiku' })).status).toBeLessThan(300);
  // A rerank model with a price per search, set by hand.
  const d = await admin.post('/admin/api/deployments', { provider_id: mapi.id, upstream_model: 'rerank-lite', public_name: 'rerank-lite', pricing_override: { mode: 'rerank', input: 0, output: 0, per_query: 0.002 } });
  expect(d.status, JSON.stringify(d.body)).toBeLessThan(300);
  const k = await admin.post('/admin/api/keys', { name: 'model-apis-agent', agent_id: 'model-apis-agent' });
  key = k.body.key;
  keyId = k.body.id;
  client = new OpenAI({ apiKey: key, baseURL: `${CT}/v1`, maxRetries: 0 });
});

test.afterAll(async () => {
  // Later specs add models on first use: they must not find these providers.
  for (const id of providerIds) await admin.del(`/admin/api/providers/${id}`);
  await Promise.all([oa?.close(), gem?.close(), bed?.close()]);
});

test('images: generations billed per image, and token-priced models by their tokens', async () => {
  const r = await client.images.generate({ model: 'mapi/dall-e-3', prompt: 'a control tower at dusk', size: '1024x1024' }).withResponse();
  expect(r.data.data).toHaveLength(1);
  const f = await flightOf(r.response);
  expect(f).toMatchObject({ kind: 'images', endpoint: 'images/generations', status: 'ok', cost_confidence: 'exact' });
  expect(JSON.parse(f.units)).toEqual({ images: 1 });
  expect(f.cost_nanousd).toBe(nano(1024 * 1024 * 3.81469e-8)); // standard 1024×1024: $0.04, priced per pixel
  const up = oa.seen.at(-1)!;
  expect(up.json.model).toBe('dall-e-3');
  expect(up.headers.authorization).toBe('Bearer sk-apis');

  const t = await client.images.generate({ model: 'mapi/gpt-image-1', prompt: 'a tower', n: 1 }).withResponse();
  const ft = await flightOf(t.response);
  expect(ft.cost_nanousd).toBe(nano(40 * 5e-6 + 4160 * 40e-6));
  expect(ft).toMatchObject({ in_tokens: 40, out_tokens: 4160, usage_source: 'provider' });
  // With a quality and size set, still billed by the tokens it reported, not a per-image price.
  const q = await client.images.generate({ model: 'mapi/gpt-image-1', prompt: 'a tower', size: '1024x1024', quality: 'low' }).withResponse();
  expect((await flightOf(q.response)).cost_nanousd).toBe(nano(40 * 5e-6 + 4160 * 40e-6));
});

test('images: an edit upload is passed on as it came, with the model renamed', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const r = await client.images.edit({ model: 'mapi/gpt-image-1', image: await toFile(png, 'tower.png', { type: 'image/png' }), prompt: 'make it blue' }).withResponse();
  expect(r.data.data?.[0]?.b64_json).toBeTruthy();
  const up = oa.seen.at(-1)!;
  expect(up.path).toBe('/v1/images/edits');
  expect(multipartField(up.body, 'model')).toBe('gpt-image-1');
  expect(multipartField(up.body, 'prompt')).toBe('make it blue');
  expect(up.body.includes(png)).toBe(true);
  const f = await flightOf(r.response);
  expect(f).toMatchObject({ kind: 'images', endpoint: 'images/edits', status: 'ok' });
  expect(f.cost_nanousd).toBe(nano(20 * 5e-6 + 280 * 10e-6 + 1056 * 40e-6));
});

test('audio: speech streams back as audio, billed per character; token-priced speech by its tokens', async () => {
  const input = 'Hello there, tower.';
  const r = await client.audio.speech.create({ model: 'mapi/tts-1', voice: 'alloy', input }).withResponse();
  expect(r.response.headers.get('content-type')).toBe('audio/mpeg');
  expect((await r.data.arrayBuffer()).byteLength).toBe(4096);
  const f = await flightOf(r.response);
  expect(f).toMatchObject({ kind: 'audio', endpoint: 'audio/speech', status: 'ok' });
  expect(JSON.parse(f.units)).toEqual({ characters: input.length });
  expect(f.cost_nanousd).toBe(nano(input.length * 0.000015));

  const s = await fetch(`${CT}/v1/audio/speech`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mapi/gpt-4o-mini-tts', voice: 'alloy', input: 'Hi', stream_format: 'sse' }) });
  expect(s.headers.get('content-type')).toContain('text/event-stream');
  expect(await s.text()).toContain('speech.audio.done');
  const fs = await flightOf(s);
  expect(fs.cost_nanousd).toBe(nano(12 * 0.6e-6 + 600 * 12e-6));
});

test('audio: transcriptions pass the file through, billed per second or by audio tokens', async () => {
  const audio = Buffer.alloc(8000, 3);
  const r = await client.audio.transcriptions.create({ model: 'mapi/whisper-1', file: await toFile(audio, 'call.mp3', { type: 'audio/mpeg' }) }).withResponse();
  expect(r.data.text).toBe('hello from the transcript');
  const up = oa.seen.at(-1)!;
  expect(multipartField(up.body, 'model')).toBe('whisper-1');
  expect(up.body.includes(audio)).toBe(true);
  const f = await flightOf(r.response);
  expect(JSON.parse(f.units)).toEqual({ seconds: 42 });
  expect(f.cost_nanousd).toBe(nano(42 * 0.0001));

  const t = await client.audio.transcriptions.create({ model: 'mapi/gpt-4o-transcribe', file: await toFile(audio, 'call.mp3', { type: 'audio/mpeg' }) }).withResponse();
  const ft = await flightOf(t.response);
  expect(ft.cost_nanousd).toBe(nano(120 * 2.5e-6 + 8 * 10e-6));
});

test('moderations, rerank and legacy completions', async () => {
  const m = await client.moderations.create({ model: 'mapi/omni-moderation-latest', input: 'is this fine?' }).withResponse();
  expect(m.data.results[0]!.flagged).toBe(false);
  const fm = await flightOf(m.response);
  expect(fm).toMatchObject({ kind: 'moderations', status: 'ok', cost_nanousd: 0 });

  const rr = await fetch(`${CT}/v1/rerank`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'rerank-lite', query: 'tower', documents: ['a bridge', 'a control tower'] }) });
  expect(rr.status).toBe(200);
  expect(((await rr.json()) as any).results[0].index).toBe(1);
  const fr = await flightOf(rr);
  expect(JSON.parse(fr.units)).toEqual({ queries: 1 });
  expect(fr.cost_nanousd).toBe(nano(0.002));

  const c = await client.completions.create({ model: 'mapi/instruct-1', prompt: 'Hello' }).withResponse();
  expect(c.data.choices[0]!.text).toBe(' world');
  const fc = await flightOf(c.response);
  expect(fc).toMatchObject({ kind: 'completions', in_tokens: 6, out_tokens: 2, usage_source: 'provider' });

  const stream = await client.completions.create({ model: 'mapi/instruct-1', prompt: 'Hello', stream: true }).withResponse();
  let text = '';
  for await (const ch of stream.data) text += ch.choices[0]?.text ?? '';
  expect(text).toBe('Hello');
  const fs = await flightOf(stream.response);
  expect(fs).toMatchObject({ in_tokens: 6, out_tokens: 3, stream: 1 });
});

test("Gemini's own API: the SDK's calls go through with Control Tower's key swapped for the provider's", async () => {
  const r = await fetch(`${CT}/gemini/v1beta/models/gem-e2e-flash:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }) });
  expect(r.status).toBe(200);
  expect(((await r.json()) as any).candidates[0].content.parts[0].text).toBe('Hello from Gemini');
  const up = gem.seen.at(-1)!;
  expect(up.headers['x-goog-api-key']).toBe('gk-test');
  expect(up.path).toBe('/v1beta/models/gemini-2.5-flash:generateContent'); // the deployment's upstream name
  const f = await flightOf(r);
  expect(f).toMatchObject({ kind: 'native', endpoint: 'gemini:generateContent', in_tokens: 11, out_tokens: 5, reasoning_tokens: 3, cost_confidence: 'exact' });
  expect(f.cost_nanousd).toBeGreaterThan(0);

  // Streaming, with the key as ?key= the way REST examples send it: it never reaches Google.
  const s = await fetch(`${CT}/gemini/v1beta/models/gem-e2e-flash:streamGenerateContent?alt=sse&key=${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }) });
  expect(s.headers.get('content-type')).toContain('text/event-stream');
  expect((await s.text()).match(/data:/g)).toHaveLength(2);
  expect(gem.seen.at(-1)!.path).toBe('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
  const fs = await flightOf(s);
  expect(fs).toMatchObject({ stream: 1, in_tokens: 11, out_tokens: 5 });

  // Without ?alt=sse the stream is a JSON array: passed through as it arrives, billed from its last element.
  const a = await fetch(`${CT}/gemini/v1beta/models/gem-e2e-flash:streamGenerateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ contents: [] }) });
  expect(JSON.parse(await a.text())).toHaveLength(2);
  expect(await flightOf(a)).toMatchObject({ in_tokens: 11, out_tokens: 5 });
});

test("Bedrock's own API: signed with the provider's AWS credentials, tokens from the body, headers or stream", async () => {
  const model = encodeURIComponent('anthropic.claude-3-5-haiku-20241022-v1:0');
  // The SDK names the model as the deployment is named here; Bedrock is sent the deployment's model id.
  const call = (op: string, body: unknown) => fetch(`${CT}/bedrock/model/bed-e2e-haiku/${op}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const c = await call('converse', { messages: [{ role: 'user', content: [{ text: 'hi' }] }] });
  expect(c.status).toBe(200);
  expect(((await c.json()) as any).output.message.content[0].text).toBe('Hello from Bedrock');
  expect(bed.seen.at(-1)!.path).toBe(`/model/${model}/converse`);
  const fc = await flightOf(c);
  expect(fc).toMatchObject({ kind: 'native', endpoint: 'bedrock:converse', in_tokens: 21, out_tokens: 6, cost_confidence: 'exact' });

  const i = await call('invoke', { anthropic_version: 'bedrock-2023-05-31', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] });
  expect(i.headers.get('x-amzn-bedrock-input-token-count')).toBe('30');
  expect(await flightOf(i)).toMatchObject({ in_tokens: 30, out_tokens: 9 });

  const cs = await call('converse-stream', { messages: [{ role: 'user', content: [{ text: 'hi' }] }] });
  expect(cs.headers.get('content-type')).toBe('application/vnd.amazon.eventstream');
  expect((await cs.arrayBuffer()).byteLength).toBeGreaterThan(100);
  expect(await flightOf(cs)).toMatchObject({ in_tokens: 17, out_tokens: 2, stream: 1 });

  const is = await call('invoke-with-response-stream', { anthropic_version: 'bedrock-2023-05-31', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] });
  await is.arrayBuffer();
  expect(await flightOf(is)).toMatchObject({ in_tokens: 25, out_tokens: 4 });
});

test('a model whose provider has no such endpoint is refused plainly', async () => {
  const r = await fetch(`${CT}/v1/images/generations`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gem-e2e-flash', prompt: 'x' }) });
  expect(r.status).toBe(400);
  expect(((await r.json()) as any).error.code).toBe('endpoint_not_supported');
});

test('gates see the endpoint: images blocked for this agent, moderations still allowed', async () => {
  const rule = await admin.post('/admin/api/rules', { name: 'No image generation', target_kind: 'model', match: { keys: [keyId], args: [{ path: 'endpoint', op: 'eq', value: 'images/generations' }] }, effect: 'deny' });
  expect(rule.status, JSON.stringify(rule.body)).toBeLessThan(300);
  try {
    const r = await fetch(`${CT}/v1/images/generations`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mapi/dall-e-3', prompt: 'x' }) });
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error.code).toBe('policy_denied');
    const m = await client.moderations.create({ model: 'mapi/omni-moderation-latest', input: 'ok' });
    expect(m.results).toHaveLength(1);
  } finally {
    await admin.del(`/admin/api/rules/${rule.body.id ?? rule.body.rule?.id}`);
  }
});
