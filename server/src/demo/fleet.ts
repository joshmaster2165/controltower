import type { FastifyBaseLogger } from 'fastify';
import { DEMO_AGENTS, type DemoAgent } from './seed.js';

/**
 * Synthetic agent fleet. Calls the gateway over loopback HTTP with real demo
 * keys, so every demo flight traverses the real pipeline and the real event
 * bus. Poisson arrivals per agent; a fraction of calls stream.
 */
const PROMPTS = [
  'Summarize the customer ticket and propose a reply.',
  'Review this diff for security issues and style problems.',
  'Find three recent papers on retrieval-augmented generation and compare them.',
  'Check the deploy logs and tell me whether the rollout is healthy.',
  'Draft a short outbound email for a VP of Engineering at a fintech.',
  'What is the fastest way to delete all contacts in the CRM?',
  'Explain this stack trace and suggest a fix.',
  'Translate the release notes into Spanish and German.',
];

/** AWS's own documentation example credentials — not real, but shaped like real ones. */
const LEAKY_PROMPT = 'Deploy the staging stack with these credentials: AKIAIOSFODNN7EXAMPLE / aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

function pad(n: number): string {
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon'.split(' ');
  const out: string[] = [];
  let len = 0;
  while (len < n) {
    const w = words[Math.floor(Math.random() * words.length)]!;
    out.push(w);
    len += w.length + 1;
  }
  return out.join(' ');
}

export class DemoFleet {
  private running = false;
  private timers = new Set<NodeJS.Timeout>();
  private inflight = new Set<AbortController>();
  public sent = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly keys: Map<string, string>,
    private readonly log: FastifyBaseLogger,
    private readonly speed = 1,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const agent of DEMO_AGENTS) {
      this.schedule(agent);
      for (const tool of agent.tools ?? []) this.scheduleTool(agent, tool);
    }
    this.scheduleObserved();
    this.log.info({ agents: DEMO_AGENTS.length }, 'demo fleet started');
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const c of this.inflight) c.abort();
    this.inflight.clear();
  }

  private schedule(agent: DemoAgent): void {
    if (!this.running) return;
    // Exponential inter-arrival → Poisson process.
    const lambda = agent.rate * this.speed;
    const delay = -Math.log(1 - Math.random()) / lambda;
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.fire(agent);
      this.schedule(agent);
    }, Math.max(20, delay * 1000));
    t.unref?.();
    this.timers.add(t);
  }

  /**
   * Calls the demo agents make *around* Control Tower — SaaS APIs, a database,
   * and one agent calling a model provider directly — reported the way real
   * agents would: the simple /v1/observe API, and OpenTelemetry spans.
   */
  private scheduleObserved(): void {
    if (!this.running) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.reportObserved();
      this.scheduleObserved();
    }, 4000 / this.speed);
    t.unref?.();
    this.timers.add(t);
  }

  private async reportObserved(): Promise<void> {
    const post = async (agentId: string, path: string, body: unknown) => {
      const key = this.keys.get(agentId);
      if (!key) return;
      await fetch(`${this.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) }).catch(() => undefined);
    };
    const n = (mean: number) => Math.max(0, Math.round(mean * (0.5 + Math.random())));
    await post('support-bot', '/v1/observe', { events: [{ target: 'https://acme.zendesk.com/api/v2/tickets', operation: 'read', count: n(6) || 1 }, { target: 'https://acme.zendesk.com/api/v2/tickets', operation: 'write', count: n(2) || 1 }] });
    await post('sdr-agent', '/v1/observe', { events: [{ target: 'https://api.hubapi.com/crm/v3/objects/contacts', operation: 'write', count: n(3) || 1 }] });
    await post('code-reviewer', '/v1/observe', { events: [{ target: 'https://api.github.com/repos/acme/ledger/pulls', operation: 'read', count: n(4) || 1, status: Math.random() < 0.05 ? 'error' : 'ok' }] });
    // A direct model call that should have gone through the gateway.
    if (Math.random() < 0.3) await post('researcher', '/v1/observe', { events: [{ target: 'https://api.openai.com/v1/chat/completions', operation: 'write', count: 1 }] });
    // ops-agent reports through OpenTelemetry, like an instrumented service would.
    const now = BigInt(Date.now()) * 1_000_000n;
    const span = (name: string, attrs: Record<string, string>, ms: number) => ({
      name,
      kind: 3,
      startTimeUnixNano: String(now - BigInt(ms) * 1_000_000n),
      endTimeUnixNano: String(now),
      attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: { stringValue: v } })),
      status: { code: 1 },
    });
    await post('ops-agent', '/v1/traces', {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'ops-agent' } }] },
          scopeSpans: [
            {
              spans: [
                span('SELECT orders', { 'db.system': 'postgresql', 'server.address': 'orders-db.internal', 'db.namespace': 'orders', 'db.operation.name': 'SELECT' }, 12),
                span('GET', { 'http.request.method': 'GET', 'url.full': 'https://status.internal.acme.dev/api/health' }, 40),
              ],
            },
          ],
        },
      ],
    });
  }

  private scheduleTool(agent: DemoAgent, tool: NonNullable<DemoAgent['tools']>[number]): void {
    if (!this.running) return;
    const delay = -Math.log(1 - Math.random()) / (tool.rate * this.speed);
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.fireTool(agent, tool);
      this.scheduleTool(agent, tool);
    }, Math.max(50, delay * 1000));
    t.unref?.();
    this.timers.add(t);
  }

  private async fireTool(agent: DemoAgent, tool: NonNullable<DemoAgent['tools']>[number]): Promise<void> {
    const key = this.keys.get(agent.id);
    if (!key) return;
    const ctrl = new AbortController();
    this.inflight.add(ctrl);
    try {
      this.sent++;
      const res = await fetch(`${this.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.sent, method: 'tools/call', params: { name: tool.name, arguments: tool.args } }),
        signal: ctrl.signal,
      });
      await res.text();
    } catch (err) {
      if (!ctrl.signal.aborted) this.log.debug({ err: (err as Error).message, agent: agent.id }, 'demo tool call failed');
    } finally {
      this.inflight.delete(ctrl);
    }
  }

  private async fire(agent: DemoAgent): Promise<void> {
    const key = this.keys.get(agent.id);
    if (!key) return;
    const ctrl = new AbortController();
    this.inflight.add(ctrl);
    const stream = Math.random() < agent.streamRatio;
    const [lo, hi] = agent.promptChars;
    const chars = lo + Math.floor(Math.random() * (hi - lo));
    const body = {
      model: agent.models[Math.floor(Math.random() * agent.models.length)]!,
      stream,
      max_tokens: Math.max(16, Math.round(agent.maxTokens * (0.5 + Math.random()))),
      messages: [
        { role: 'system', content: `You are ${agent.name}, an automated agent for the ${agent.team} team.` },
        { role: 'user', content: `${agent.id === 'rogue-intern' && Math.random() < 0.15 ? LEAKY_PROMPT : PROMPTS[Math.floor(Math.random() * PROMPTS.length)]}\n\n${pad(chars)}` },
      ],
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
    try {
      this.sent++;
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.body) {
        // Drain the body so the flight completes normally.
        const reader = res.body.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
    } catch (err) {
      if (!ctrl.signal.aborted) this.log.debug({ err: (err as Error).message, agent: agent.id }, 'demo request failed');
    } finally {
      this.inflight.delete(ctrl);
    }
  }
}
