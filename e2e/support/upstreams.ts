import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import express from 'express';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { Role, TaskState } from '@a2a-js/sdk';

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
/**
 * A sub-agent exposed as an MCP tool, the way people build them: an MCP server (official SDK) whose
 * `ask` tool does its own work — here, `work(question, delegationToken)` — and returns the answer.
 * The delegation token Control Tower attaches is read from the request's `_meta`, falling back to
 * the `x-ct-delegation` header, exactly as the docs tell a sub-agent to do.
 */
export function subAgentUpstream(work: (question: string, token: string | undefined) => Promise<string>): Promise<Upstream> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const build = () => {
    const server = new McpServer({ name: 'research-agent', version: '1.0.0' });
    server.registerTool('ask', { description: 'Ask the research agent a question', inputSchema: { question: z.string() } }, async ({ question }, extra) => {
      const meta = (extra._meta ?? {}) as Record<string, unknown>;
      const header = extra.requestInfo?.headers['x-ct-delegation'];
      const token = typeof meta['controltower/delegation'] === 'string' ? (meta['controltower/delegation'] as string) : typeof header === 'string' ? header : undefined;
      return { content: [{ type: 'text', text: await work(question, token) }] };
    });
    return server;
  };
  return serve(async (req, res, body) => {
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
  });
}

/**
 * A remote agent speaking A2A over JSON-RPC, as the specification describes it: an Agent Card at
 * `/.well-known/agent-card.json` and a JSON-RPC endpoint at `/rpc` that requires `token`. Version
 * '1.0' uses `supportedInterfaces` and PascalCase methods (SendMessage, SendStreamingMessage,
 * GetTask, GetExtendedAgentCard); '0.3' uses `url` / `preferredTransport` and `message/send`.
 * Replies echo the message's text, so a test can see what arrived.
 */
export function a2aUpstream(opts: { version: '1.0' | '0.3'; token: string; reply?: (text: string) => string }): Promise<Upstream & { tasks: Map<string, unknown> }> {
  const tasks = new Map<string, unknown>();
  let base = '';
  const card = () =>
    opts.version === '1.0'
      ? {
          name: 'Research agent',
          description: 'Answers research questions',
          version: '2.1.0',
          supportedInterfaces: [{ url: `${base}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
          capabilities: { streaming: true, extendedAgentCard: true },
          securitySchemes: { upstream: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
          securityRequirements: [{ schemes: { upstream: { list: [] } } }],
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
          skills: [{ id: 'research', name: 'Research', description: 'Looks things up', tags: ['search'] }],
          signatures: [{ protected: 'e30', signature: 'c2ln' }],
        }
      : {
          name: 'Legacy agent',
          description: 'An A2A 0.3 agent',
          version: '0.9.0',
          protocolVersion: '0.3.0',
          url: `${base}/rpc`,
          preferredTransport: 'JSONRPC',
          capabilities: { streaming: false },
          securitySchemes: { upstream: { type: 'http', scheme: 'bearer' } },
          security: [{ upstream: [] }],
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
          skills: [{ id: 'legacy', name: 'Legacy', description: 'Old but gold', tags: [] }],
        };
  const textOf = (message: any): string => (message?.parts ?? []).map((p: any) => p.text ?? '').join('');
  const say = (text: string) => (opts.reply ? opts.reply(text) : `echo: ${text}`);
  const up = serve((req, res, body) => {
    const path = (req.url ?? '').replace(/\?.*$/, '');
    if (req.method === 'GET' && path === '/.well-known/agent-card.json') return json(res, 200, card());
    if (path !== '/rpc' || req.method !== 'POST') return json(res, 404, { error: 'not found' });
    if (req.headers.authorization !== `Bearer ${opts.token}`) return json(res, 401, { error: 'unauthorized' });
    const rpc = JSON.parse(body) as { id: unknown; method: string; params: any };
    const ok = (result: unknown) => json(res, 200, { jsonrpc: '2.0', id: rpc.id, result });
    const fail = (code: number, message: string) => json(res, 200, { jsonrpc: '2.0', id: rpc.id, error: { code, message } });
    const newTask = (text: string, v1: boolean) => {
      const id = crypto.randomUUID();
      const reply = { messageId: crypto.randomUUID(), role: v1 ? 'ROLE_AGENT' : 'agent', parts: v1 ? [{ text: say(text) }] : [{ kind: 'text', text: say(text) }], ...(v1 ? {} : { kind: 'message' }) };
      const task = v1
        ? { id, contextId: 'ctx-1', status: { state: 'TASK_STATE_COMPLETED', message: reply }, artifacts: [{ artifactId: 'a1', parts: [{ text: say(text) }] }] }
        : { kind: 'task', id, contextId: 'ctx-1', status: { state: 'completed', message: reply } };
      tasks.set(id, task);
      return task;
    };
    if (opts.version === '1.0') {
      if (rpc.method === 'SendMessage') return ok({ task: newTask(textOf(rpc.params.message), true) });
      if (rpc.method === 'GetTask') return tasks.has(rpc.params.id) ? ok(tasks.get(rpc.params.id)) : fail(-32001, 'Task not found');
      if (rpc.method === 'GetExtendedAgentCard') return ok({ ...card(), description: 'The extended card' });
      if (rpc.method === 'SendStreamingMessage') {
        const task = newTask(textOf(rpc.params.message), true) as any;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = (result: unknown) => res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`);
        send({ task: { id: task.id, contextId: task.contextId, status: { state: 'TASK_STATE_WORKING' } } });
        send({ artifactUpdate: { taskId: task.id, contextId: task.contextId, artifact: task.artifacts[0], lastChunk: true } });
        send({ statusUpdate: { taskId: task.id, contextId: task.contextId, status: task.status } });
        return void res.end();
      }
      return fail(-32601, 'Method not found');
    }
    if (rpc.method === 'message/send') return ok(newTask(textOf(rpc.params.message), false));
    if (rpc.method === 'tasks/get') return tasks.has(rpc.params.id) ? ok(tasks.get(rpc.params.id)) : fail(-32001, 'Task not found');
    return fail(-32601, 'Method not found');
  });
  return up.then((u) => {
    base = u.url;
    return { ...u, tasks };
  });
}

/**
 * An A2A agent built with the official SDK (`@a2a-js/sdk`), the way its samples build one: an
 * `AgentExecutor` behind `DefaultRequestHandler`, served by the SDK's Express handlers, behind a
 * bearer check. Each message becomes a task that works, produces an artifact and completes. What
 * the agent received — the text, the request metadata and the headers — is kept for the test.
 */
export async function a2aSdkAgent(token: string): Promise<{ url: string; received: Array<{ text: string; metadata: Record<string, unknown>; headers: http.IncomingHttpHeaders }>; close(): Promise<void> }> {
  const received: Array<{ text: string; metadata: Record<string, unknown>; headers: http.IncomingHttpHeaders }> = [];
  let lastHeaders: http.IncomingHttpHeaders = {};
  const app = express();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const card = {
    name: 'SDK research agent',
    description: 'Built with the official A2A SDK',
    version: '1.0.0',
    supportedInterfaces: [{ url: `${url}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
    provider: undefined,
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'research', name: 'Research', description: 'Looks things up', tags: ['search'], examples: [], inputModes: [], outputModes: [], securityRequirements: [] }],
    signatures: [],
  };
  const textPart = (text: string) => ({ content: { $case: 'text' as const, value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' });
  const executor: AgentExecutor = {
    async execute(ctx, bus) {
      const text = ctx.userMessage.parts.map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join('');
      received.push({ text, metadata: (ctx.request.metadata ?? {}) as Record<string, unknown>, headers: lastHeaders });
      const base = { id: ctx.taskId, contextId: ctx.contextId, artifacts: [], history: [ctx.userMessage], metadata: undefined };
      bus.publish(AgentEvent.task({ ...base, status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: undefined } } as never));
      bus.publish(AgentEvent.statusUpdate({ taskId: ctx.taskId, contextId: ctx.contextId, status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined }, metadata: undefined } as never));
      bus.publish(AgentEvent.artifactUpdate({ taskId: ctx.taskId, contextId: ctx.contextId, artifact: { artifactId: 'answer', name: 'answer', description: '', parts: [textPart(`researched: ${text}`)], metadata: undefined, extensions: [] }, append: false, lastChunk: true, metadata: undefined } as never));
      bus.publish(
        AgentEvent.statusUpdate({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          status: { state: TaskState.TASK_STATE_COMPLETED, message: { messageId: crypto.randomUUID(), contextId: ctx.contextId, taskId: ctx.taskId, role: Role.ROLE_AGENT, parts: [textPart('done')], metadata: undefined, extensions: [], referenceTaskIds: [] }, timestamp: undefined },
          metadata: undefined,
        } as never),
      );
      bus.finished();
    },
    async cancelTask() {},
  };
  const handler = new DefaultRequestHandler(card as never, new InMemoryTaskStore(), executor);
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }));
  app.use('/a2a/jsonrpc', (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${token}`) return void res.status(401).json({ error: 'unauthorized' });
    lastHeaders = req.headers;
    next();
  });
  app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  return { url, received, close: () => new Promise((r) => server.close(() => r())) };
}

export function webhookReceiver(): Promise<Upstream> {
  return serve((_req, res) => json(res, 200, { ok: true }));
}
