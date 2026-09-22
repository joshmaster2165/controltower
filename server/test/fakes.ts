/**
 * Fake upstreams for contract tests and e2e: a Gemini API, a Bedrock runtime
 * (binary event-stream), and a Vertex endpoint with an OAuth token server.
 * They speak just enough of each wire protocol to exercise the adapters.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { EventStreamCodec } from '@smithy/eventstream-codec';
import { fromUtf8, toUtf8 } from '@smithy/util-utf8';

export interface FakeServer {
  url: string;
  close(): Promise<void>;
  calls: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string, calls: FakeServer['calls']) => unknown): Promise<FakeServer> {
  const calls: FakeServer['calls'] = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    calls.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    try {
      await handler(req, res, body, calls);
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        calls,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const geminiReply = (text: string, tool?: { name: string; args: unknown }) => ({
  candidates: [{ content: { role: 'model', parts: [...(text ? [{ text }] : []), ...(tool ? [{ functionCall: tool }] : [])] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
  responseId: 'gem123',
});

/** Gemini: /v1beta/models/<m>:generateContent and :streamGenerateContent?alt=sse, plus /v1beta/models. */
export function fakeGemini(): Promise<FakeServer> {
  return listen(async (req, res, body) => {
    const url = req.url ?? '';
    if (req.headers['x-goog-api-key'] !== 'gem-key') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT' } }));
    }
    if (url.startsWith('/v1beta/models?')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }] }));
    }
    const wantsTool = body.includes('"functionDeclarations"') && body.includes('get_weather');
    if (url.includes(':streamGenerateContent')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const parts = ['Hello', ' from', ' Gemini'];
      for (const t of parts) {
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: t }] } }], responseId: 'gem123' })}\r\n\r\n`);
        await sleep(5);
      }
      const last = wantsTool ? geminiReply('', { name: 'get_weather', args: { city: 'Paris' } }) : { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: geminiReply('').usageMetadata };
      res.write(`data: ${JSON.stringify(last)}\r\n\r\n`);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(wantsTool ? geminiReply('Calling', { name: 'get_weather', args: { city: 'Paris' } }) : geminiReply('Hello from Gemini')));
  });
}

const codec = new EventStreamCodec(toUtf8, fromUtf8);
function esMessage(eventType: string, payload: unknown, messageType = 'event'): Uint8Array {
  return codec.encode({
    headers: {
      ':message-type': { type: 'string', value: messageType },
      ':event-type': { type: 'string', value: eventType },
      ':content-type': { type: 'string', value: 'application/json' },
    },
    body: fromUtf8(JSON.stringify(payload)),
  });
}

/** Bedrock runtime + control plane. Requires a SigV4 Authorization header. */
export function fakeBedrock(): Promise<FakeServer> {
  return listen(async (req, res, body) => {
    const url = req.url ?? '';
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('AWS4-HMAC-SHA256 Credential=AKIATEST') || !req.headers['x-amz-date']) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: 'The security token included in the request is invalid.' }));
    }
    if (url.startsWith('/foundation-models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ modelSummaries: [{ modelId: 'anthropic.claude-sonnet-4-5', inferenceTypesSupported: ['ON_DEMAND'] }, { modelId: 'amazon.nova-lite-v1:0', inferenceTypesSupported: ['ON_DEMAND'] }] }));
    }
    const wantsTool = body.includes('"toolConfig"');
    if (url.endsWith('/converse-stream')) {
      res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
      res.write(esMessage('messageStart', { role: 'assistant' }));
      for (const t of ['Hello', ' from', ' Bedrock']) {
        res.write(esMessage('contentBlockDelta', { contentBlockIndex: 0, delta: { text: t } }));
        await sleep(5);
      }
      res.write(esMessage('contentBlockStop', { contentBlockIndex: 0 }));
      if (wantsTool) {
        res.write(esMessage('contentBlockStart', { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'tooluse_1', name: 'get_weather' } } }));
        res.write(esMessage('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '{"city":' } } }));
        res.write(esMessage('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '"Paris"}' } } }));
        res.write(esMessage('contentBlockStop', { contentBlockIndex: 1 }));
      }
      res.write(esMessage('messageStop', { stopReason: wantsTool ? 'tool_use' : 'end_turn' }));
      res.write(esMessage('metadata', { usage: { inputTokens: 13, outputTokens: 9, totalTokens: 22 }, metrics: { latencyMs: 40 } }));
      return res.end();
    }
    if (url.endsWith('/converse')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      const content: unknown[] = [{ text: 'Hello from Bedrock' }];
      if (wantsTool) content.push({ toolUse: { toolUseId: 'tooluse_1', name: 'get_weather', input: { city: 'Paris' } } });
      return res.end(JSON.stringify({ output: { message: { role: 'assistant', content } }, stopReason: wantsTool ? 'tool_use' : 'end_turn', usage: { inputTokens: 13, outputTokens: 9, totalTokens: 22 } }));
    }
    res.writeHead(404);
    res.end('not found');
  });
}

/** A throwaway RSA service account for Vertex tests. */
export function fakeServiceAccount(tokenUrl: string): string {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return JSON.stringify({
    type: 'service_account',
    client_email: 'ct-test@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: tokenUrl,
  });
}

/** Vertex: /token (OAuth JWT bearer) + publishers/google and publishers/anthropic. */
export function fakeVertex(): Promise<FakeServer> {
  return listen(async (req, res, body) => {
    const url = req.url ?? '';
    if (url === '/token') {
      const params = new URLSearchParams(body);
      const assertion = params.get('assertion') ?? '';
      const [h, c] = assertion.split('.');
      const claims = JSON.parse(Buffer.from(c ?? '', 'base64url').toString()) as { iss?: string; scope?: string };
      if (!h || claims.iss !== 'ct-test@example.iam.gserviceaccount.com' || !claims.scope?.includes('cloud-platform')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'vertex-token-123', expires_in: 3600, token_type: 'Bearer' }));
    }
    if (req.headers.authorization !== 'Bearer vertex-token-123') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 401, message: 'Request had invalid authentication credentials.' } }));
    }
    if (!url.startsWith('/v1/projects/test-proj/locations/us-central1/')) {
      res.writeHead(404);
      return res.end('wrong project/location');
    }
    if (url.includes('/publishers/google/')) {
      if (url.includes(':streamGenerateContent')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hello from Vertex' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 } })}\r\n\r\n`);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(geminiReply('Hello from Vertex')));
    }
    if (url.includes('/publishers/anthropic/')) {
      const parsed = JSON.parse(body) as { anthropic_version?: string; model?: unknown; stream?: boolean };
      if (parsed.anthropic_version !== 'vertex-2023-10-16' || parsed.model !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'bad anthropic request shape' } }));
      }
      if (url.includes(':streamRawPredict')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const evs = [
          { type: 'message_start', message: { id: 'msg_v', usage: { input_tokens: 6, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from Claude on Vertex' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ];
        for (const e of evs) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_v', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hello from Claude on Vertex' }], stop_reason: 'end_turn', usage: { input_tokens: 6, output_tokens: 5 } }));
    }
    res.writeHead(404);
    res.end('not found');
  });
}
