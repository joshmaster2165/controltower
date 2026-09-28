import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An OpenAI-compatible upstream whose models behave as their names say, for routing tests:
 *   ok-*          answers
 *   fail429x<N>-* rate-limits the first N calls, then answers
 *   down-*        answers 500
 *   ctxerr-*      refuses: the prompt is longer than its context window
 *   policy-*      refuses the content
 *   slow-*        answers after 600 ms
 * Every answer says which upstream gave it, so a test can see where a call went.
 */
export interface RoutingUpstream {
  url: string;
  name: string;
  /** Calls received, by model. */
  calls: Map<string, number>;
  /** Request bodies received, in order. */
  bodies: any[];
  close(): Promise<void>;
}

export function routingUpstream(name: string): Promise<RoutingUpstream> {
  const calls = new Map<string, number>();
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET') return send(200, { object: 'list', data: [] });
      let body: { model?: string } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        /* empty */
      }
      bodies.push(body);
      const model = body.model ?? '';
      const n = (calls.get(model) ?? 0) + 1;
      calls.set(model, n);
      const m429 = /^fail429x(\d+)-/.exec(model);
      if (m429 && n <= Number(m429[1])) return send(429, { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } });
      if (model.startsWith('down-')) return send(500, { error: { message: 'The server had an error', type: 'server_error' } });
      if (model.startsWith('ctxerr-')) return send(400, { error: { message: "This model's maximum context length is 64 tokens. However, your messages resulted in 900 tokens.", type: 'invalid_request_error', code: 'context_length_exceeded' } });
      if (model.startsWith('policy-')) return send(400, { error: { message: 'Your request was rejected as a result of our safety system.', type: 'invalid_request_error', code: 'content_policy_violation' } });
      if (model.startsWith('slow-')) await new Promise((r) => setTimeout(r, 600));
      send(200, {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: `${name}:${model}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, name, calls, bodies, close: () => new Promise((r) => server.close(() => r())) }),
    ),
  );
}
