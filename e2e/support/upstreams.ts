import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * Protocol-accurate upstreams for the real-world suite. Nothing here is demo
 * code: the MCP server is the official SDK's, and the model APIs speak the
 * wire formats the real providers do.
 */
export interface Recorded {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
export interface Upstream {
  url: string;
  calls: Recorded[];
  close(): Promise<void>;
}

function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void | Promise<void>, port = 0): Promise<Upstream> {
  const calls: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      Promise.resolve(handler(req, res, body)).catch((err: unknown) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => server.close(() => r())) });
    }),
  );
}

const json = (res: http.ServerResponse, status: number, v: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(v));
};

/** OpenAI Chat Completions, as api.openai.com speaks it. `rateLimited` answers every chat call with 429. */
export function openAiUpstream(opts: { models?: string[]; reply?: string; rateLimited?: boolean; failing?: boolean; port?: number } = {}): Promise<Upstream> {
  const models = opts.models ?? ['gpt-4.1-mini', 'text-embedding-3-small'];
  const reply = opts.reply ?? 'Hello from the OpenAI-compatible upstream';
  return serve((req, res, body) => {
    const path = (req.url ?? '').replace(/\?.*$/, '');
    if (req.method === 'GET' && path.endsWith('/models')) return json(res, 200, { object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'test' })) });
    if (path.endsWith('/embeddings')) return json(res, 200, { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }], model: 'text-embedding-3-small', usage: { prompt_tokens: 3, total_tokens: 3 } });
    if (path.endsWith('/responses')) return responsesApi(res, body, reply);
    if (!path.endsWith('/chat/completions')) return json(res, 404, { error: { message: 'not found' } });
    if (opts.failing) return json(res, 500, { error: { message: 'The server had an error while processing your request.', type: 'server_error' } });
    if (opts.rateLimited) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      return void res.end(JSON.stringify({ error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } }));
    }
    const b = JSON.parse(body || '{}') as { model: string; stream?: boolean; stream_options?: { include_usage?: boolean } };
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
    if (!b.stream) {
      return json(res, 200, { id, object: 'chat.completion', created, model: b.model, choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta: Record<string, unknown>, finish: string | null) => ({ id, object: 'chat.completion.chunk', created, model: b.model, choices: [{ index: 0, delta, finish_reason: finish }] });
    res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '' }, null))}\n\n`);
    for (const word of reply.split(' ')) res.write(`data: ${JSON.stringify(chunk({ content: `${word} ` }, null))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    if (b.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: b.model, choices: [], usage })}\n\n`);
    res.end('data: [DONE]\n\n');
  }, opts.port);
}

/** OpenAI's Responses API: a response object, or its typed SSE events ending in response.completed. */
function responsesApi(res: http.ServerResponse, body: string, reply: string): void {
  const b = JSON.parse(body || '{}') as { model: string; stream?: boolean };
  const id = `resp_${crypto.randomUUID().replace(/-/g, '')}`;
  const msgId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
  const usage = { input_tokens: 21, input_tokens_details: { cached_tokens: 5 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 30 };
  const base = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: b.model, parallel_tool_calls: true, tool_choice: 'auto', tools: [], text: { format: { type: 'text' } } };
  const message = { type: 'message', id: msgId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: reply, annotations: [] }] };
  if (!b.stream) return json(res, 200, { ...base, status: 'completed', output: [message], usage });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  let seq = 0;
  const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
  send('response.created', { response: { ...base, status: 'in_progress', output: [], usage: null } });
  send('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
  send('response.content_part.added', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  for (const word of reply.split(' ')) send('response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: `${word} ` });
  send('response.output_text.done', { item_id: msgId, output_index: 0, content_index: 0, text: reply });
  send('response.content_part.done', { item_id: msgId, output_index: 0, content_index: 0, part: message.content[0] });
  send('response.output_item.done', { output_index: 0, item: message });
  send('response.completed', { response: { ...base, status: 'completed', output: [message], usage } });
  res.end();
}

/** Anthropic Messages API, as api.anthropic.com speaks it (JSON and SSE). */
export function anthropicUpstream(opts: { reply?: string; models?: string[] } = {}): Promise<Upstream> {
  const reply = opts.reply ?? 'Hello from the Anthropic upstream';
  const models = opts.models ?? ['claude-sonnet-4-5'];
  return serve((req, res, body) => {
    const path = (req.url ?? '').replace(/\?.*$/, '');
    if (req.method === 'GET' && path.endsWith('/models')) return json(res, 200, { data: models.map((id) => ({ id, type: 'model', display_name: id })), has_more: false });
    if (path.endsWith('/messages/count_tokens')) return json(res, 200, { input_tokens: 42 });
    if (!path.endsWith('/messages')) return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } });
    const b = JSON.parse(body || '{}') as { model: string; stream?: boolean };
    const id = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
    if (!b.stream) {
      return json(res, 200, { id, type: 'message', role: 'assistant', model: b.model, content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 15, output_tokens: 9 } });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 15, output_tokens: 1 } } });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (const word of reply.split(' ')) send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${word} ` } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } });
    send('message_stop', { type: 'message_stop' });
    res.end();
  });
}

/**
 * An MCP server built with the official SDK, on the Streamable HTTP transport
 * in stateful mode (session ids, SSE responses) — what real servers run.
 * Requires `Authorization: Bearer <token>` so we can prove credential injection.
 */
export function mcpUpstream(token: string, port = 0): Promise<Upstream & { deleted: string[] }> {
  const deleted: string[] = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const build = () => {
    const server = new McpServer({ name: 'files-test-server', version: '1.0.0' });
    server.registerTool('read_file', { description: 'Read a file', inputSchema: { path: z.string() }, annotations: { readOnlyHint: true } }, async ({ path }) => ({
      content: [{ type: 'text', text: `contents of ${path} — owner: dana.whitfield@example.com` }],
    }));
    server.registerTool('delete_file', { description: 'Delete a file', inputSchema: { path: z.string() }, annotations: { destructiveHint: true } }, async ({ path }) => {
      deleted.push(path);
      return { content: [{ type: 'text', text: `deleted ${path}` }] };
    });
    return server;
  };
  return serve(async (req, res, body) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const parsed = body ? (JSON.parse(body) as unknown) : undefined;
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      if (req.method !== 'POST' || !isInitializeRequest(parsed)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' }, id: null }));
      }
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), onsessioninitialized: (id) => void transports.set(id, transport!) });
      await build().connect(transport);
    }
    await transport.handleRequest(req, res, parsed);
  }, port).then((u) => ({ ...u, deleted }));
}

/** Captures webhook deliveries (alerts). */
export function webhookReceiver(): Promise<Upstream> {
  return serve((_req, res) => json(res, 200, { ok: true }));
}
