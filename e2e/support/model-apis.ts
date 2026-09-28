import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * Upstreams for the model APIs other than chat, speaking the real wire formats: an OpenAI-wire provider
 * (images, audio, moderations, rerank, legacy completions), Gemini's REST API, and Bedrock's runtime
 * (which refuses anything not SigV4-signed). Each records what reached it.
 */
export interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  json?: any;
}
export interface ApiUpstream {
  url: string;
  seen: Seen[];
  close(): Promise<void>;
}

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse, s: Seen) => void): Promise<ApiUpstream> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const s: Seen = { path: req.url ?? '', headers: req.headers, body };
      if (/json/.test(String(req.headers['content-type']))) {
        try {
          s.json = JSON.parse(body.toString('utf8'));
        } catch {
          /* not json */
        }
      }
      seen.push(s);
      handler(req, res, s);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        seen,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/** The model name a multipart upload carried. */
export function multipartField(body: Buffer, name: string): string | undefined {
  const m = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(body.toString('latin1'));
  return m?.[1];
}

export function openAiApis(): Promise<ApiUpstream> {
  return listen((req, res, s) => {
    const path = s.path.replace(/\?.*$/, '');
    if (s.headers.authorization !== 'Bearer sk-apis') return json(res, 401, { error: { message: 'bad key' } });
    if (req.method === 'GET' && path.endsWith('/models')) return json(res, 200, { object: 'list', data: ['gpt-image-1', 'dall-e-3', 'tts-1', 'gpt-4o-mini-tts', 'whisper-1', 'gpt-4o-transcribe', 'omni-moderation-latest', 'rerank-lite', 'instruct-1'].map((id) => ({ id, object: 'model' })) });
    const model = s.json?.model ?? multipartField(s.body, 'model');
    if (path.endsWith('/images/generations')) {
      const n = s.json?.n ?? 1;
      const data = Array.from({ length: n }, () => ({ b64_json: PNG_1PX }));
      if (model === 'gpt-image-1') return json(res, 200, { created: 1, data, usage: { input_tokens: 40, input_tokens_details: { text_tokens: 40, image_tokens: 0 }, output_tokens: 4160, total_tokens: 4200 } });
      return json(res, 200, { created: 1, data });
    }
    if (path.endsWith('/images/edits') || path.endsWith('/images/variations')) {
      if (!/filename="/.test(s.body.toString('latin1'))) return json(res, 400, { error: { message: 'image file missing' } });
      return json(res, 200, { created: 1, data: [{ b64_json: PNG_1PX }], ...(model === 'gpt-image-1' ? { usage: { input_tokens: 300, input_tokens_details: { text_tokens: 20, image_tokens: 280 }, output_tokens: 1056 } } : {}) });
    }
    if (path.endsWith('/audio/speech')) {
      if (s.json?.stream_format === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'speech.audio.delta', audio: Buffer.alloc(64, 1).toString('base64') })}\n\n`);
        res.end(`data: ${JSON.stringify({ type: 'speech.audio.done', usage: { input_tokens: 12, output_tokens: 600, total_tokens: 612 } })}\n\n`);
        return;
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(Buffer.alloc(4096, 7));
      return;
    }
    if (path.endsWith('/audio/transcriptions') || path.endsWith('/audio/translations')) {
      if (!/filename="/.test(s.body.toString('latin1'))) return json(res, 400, { error: { message: 'file missing' } });
      if (model === 'gpt-4o-transcribe') return json(res, 200, { text: 'hello from the transcript', usage: { type: 'tokens', input_tokens: 120, input_token_details: { text_tokens: 0, audio_tokens: 120 }, output_tokens: 8, total_tokens: 128 } });
      return json(res, 200, { text: 'hello from the transcript', usage: { type: 'duration', seconds: 42 } });
    }
    if (path.endsWith('/moderations')) return json(res, 200, { id: 'modr-1', model, results: [{ flagged: false, categories: {}, category_scores: {} }] });
    if (path.endsWith('/rerank')) return json(res, 200, { id: 'rr-1', results: [{ index: 1, relevance_score: 0.93 }, { index: 0, relevance_score: 0.12 }], meta: { billed_units: { search_units: 1 } } });
    if (path.endsWith('/completions')) {
      if (s.json?.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'text_completion', choices: [{ text: 'Hello', index: 0 }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'text_completion', choices: [], usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      return json(res, 200, { id: 'c1', object: 'text_completion', model, choices: [{ text: ' world', index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 } });
    }
    return json(res, 404, { error: { message: `no ${path}` } });
  });
}

export function geminiApi(): Promise<ApiUpstream> {
  return listen((_req, res, s) => {
    if (s.headers['x-goog-api-key'] !== 'gk-test') return json(res, 403, { error: { code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' } });
    const m = /\/models\/([^:]+):(\w+)/.exec(s.path);
    if (!m) return json(res, 404, { error: { code: 404, message: 'not found', status: 'NOT_FOUND' } });
    const usageMetadata = { promptTokenCount: 11, candidatesTokenCount: 5, thoughtsTokenCount: 3, totalTokenCount: 19 };
    const chunk = (text: string, withUsage: boolean) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] } }], ...(withUsage ? { usageMetadata } : {}), modelVersion: m[1] });
    if (m[2] === 'streamGenerateContent') {
      if (/alt=sse/.test(s.path)) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify(chunk('Hel', false))}\r\n\r\n`);
        res.end(`data: ${JSON.stringify(chunk('lo', true))}\r\n\r\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(`[${JSON.stringify(chunk('Hel', false))}`);
        res.end(`,\n${JSON.stringify(chunk('lo', true))}]`);
      }
      return;
    }
    if (m[2] === 'countTokens') return json(res, 200, { totalTokens: 11 });
    if (m[2] === 'embedContent') return json(res, 200, { embedding: { values: [0.1, 0.2] } });
    return json(res, 200, chunk('Hello from Gemini', true));
  });
}

// Bedrock's event stream, encoded with the codec the server itself uses.
// (The e2e package doesn't depend on them: they are loaded from the server's.)
const req = createRequire(path.resolve('server/package.json'));
type Codec = { encode(m: { headers: Record<string, { type: 'string'; value: string }>; body: Uint8Array }): Uint8Array };
const { EventStreamCodec } = req('@smithy/eventstream-codec') as { EventStreamCodec: new (to: unknown, from: unknown) => Codec };
const { toUtf8, fromUtf8 } = req('@smithy/util-utf8') as { toUtf8: (b: Uint8Array) => string; fromUtf8: (s: string) => Uint8Array };
const codec = new EventStreamCodec(toUtf8, fromUtf8);
function frame(eventType: string, payload: unknown): Uint8Array {
  return codec.encode({
    headers: { ':event-type': { type: 'string', value: eventType }, ':message-type': { type: 'string', value: 'event' }, ':content-type': { type: 'string', value: 'application/json' } },
    body: fromUtf8(JSON.stringify(payload)),
  });
}

export function bedrockRuntime(): Promise<ApiUpstream> {
  return listen((_req, res, s) => {
    if (!String(s.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256 Credential=AKIATEST')) return json(res, 403, { message: 'The request signature we calculated does not match' });
    const m = /\/model\/([^/]+)\/([a-z-]+)$/.exec(s.path);
    if (!m) return json(res, 404, { message: 'unknown operation' });
    const op = m[2];
    if (op === 'converse') return json(res, 200, { output: { message: { role: 'assistant', content: [{ text: 'Hello from Bedrock' }] } }, stopReason: 'end_turn', usage: { inputTokens: 21, outputTokens: 6, totalTokens: 27 } });
    if (op === 'invoke') return json(res, 200, { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hello from Claude on Bedrock' }], usage: { input_tokens: 30, output_tokens: 9 } }, { 'x-amzn-bedrock-input-token-count': '30', 'x-amzn-bedrock-output-token-count': '9', 'x-amzn-requestid': 'req-1' });
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
    if (op === 'converse-stream') {
      res.write(frame('messageStart', { role: 'assistant' }));
      res.write(frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hi' } }));
      res.write(frame('messageStop', { stopReason: 'end_turn' }));
      res.end(frame('metadata', { usage: { inputTokens: 17, outputTokens: 2, totalTokens: 19 }, metrics: { latencyMs: 10 } }));
      return;
    }
    // invoke-with-response-stream: model events as base64 bytes; the last carries the invocation metrics.
    const b = (o: unknown) => frame('chunk', { bytes: Buffer.from(JSON.stringify(o)).toString('base64') });
    res.write(b({ type: 'message_start', message: { usage: { input_tokens: 25 } } }));
    res.write(b({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }));
    res.end(b({ type: 'message_stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 25, outputTokenCount: 4, invocationLatency: 100, firstByteLatency: 50 } }));
  });
}
