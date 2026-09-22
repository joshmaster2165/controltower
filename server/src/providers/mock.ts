import type { Usage } from '@controltower/shared';
import type { AdapterResult, ProviderAdapter, SendOptions, UpstreamCtx, UpstreamEvent } from './adapter.js';

/**
 * In-process provider used by CT_DEMO and by tests. Streams generated tokens
 * at a realistic rate with a Gaussian time-to-first-token, and injects a
 * small rate of 429/500 so fallback lanes show up on the Airspace.
 *
 * Tunables live in provider.extra: { tokPerSec, ttftMeanMs, ttftSdMs,
 * err429Rate, err500Rate, latencyScale }.
 */

const LOREM =
  'the quick brown fox jumps over the lazy dog while the control tower watches every flight cross the airspace and holds the ones that need a human to say yes before they land'.split(
    ' ',
  );

function gauss(mean: number, sd: number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function estimateInput(body: Record<string, unknown>): number {
  const msgs = (body.messages as Array<{ content?: unknown }> | undefined) ?? [];
  let chars = 0;
  for (const m of msgs) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) chars += JSON.stringify(m.content).length;
  }
  if (typeof body.system === 'string') chars += body.system.length;
  return Math.max(8, Math.round(chars / 4));
}

export class MockAdapter implements ProviderAdapter {
  readonly kind = 'mock' as const;
  readonly nativeDialects: ReadonlySet<'openai-chat' | 'anthropic-messages'> = new Set(['openai-chat']);
  readonly caps = { streamUsage: 'yes' as const, embeddings: true, listModels: true };

  async send(ctx: UpstreamCtx, body: Record<string, unknown>, opts: SendOptions): Promise<AdapterResult> {
    const extra = ctx.provider.extra as {
      tokPerSec?: number;
      ttftMeanMs?: number;
      ttftSdMs?: number;
      err429Rate?: number;
      err500Rate?: number;
      latencyScale?: number;
    };
    const tokPerSec = extra.tokPerSec ?? 40;
    const scale = extra.latencyScale ?? 1;
    const ttft = Math.max(20, gauss(extra.ttftMeanMs ?? 300, extra.ttftSdMs ?? 120)) * scale;
    const r = Math.random();
    if (r < (extra.err429Rate ?? 0)) {
      await sleep(30 * scale, ctx.signal);
      return { kind: 'error', err: { code: 'provider_rate_limited', message: 'mock: rate limited', httpStatus: 429, upstreamStatus: 429, fallback: true, cooldown: true } };
    }
    if (r < (extra.err429Rate ?? 0) + (extra.err500Rate ?? 0)) {
      await sleep(80 * scale, ctx.signal);
      return { kind: 'error', err: { code: 'provider_error', message: 'mock: internal error', httpStatus: 502, upstreamStatus: 500, fallback: true, cooldown: true } };
    }

    const inputTokens = estimateInput(body);
    const requested = typeof body.max_tokens === 'number' ? body.max_tokens : 160;
    const outTokens = Math.max(4, Math.min(requested, Math.round(gauss(90, 40))));
    const usage: Usage = { input: inputTokens, output: outTokens, cacheRead: 0, cacheWrite: 0 };
    const id = `chatcmpl-mock-${ctx.flightId}`;
    const created = Math.floor(Date.now() / 1000);
    const model = opts.upstreamModel;

    if (!opts.stream) {
      await sleep(ttft + (outTokens / tokPerSec) * 1000 * scale, ctx.signal);
      ctx.onFirstByte?.();
      const text = words(outTokens);
      const json = {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
      };
      return { kind: 'json', status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(json)), usage };
    }

    const events = this.streamEvents(ctx, { id, created, model, outTokens, tokPerSec, ttft, scale, usage, includeUsage: true });
    return { kind: 'stream', status: 200, contentType: 'text/event-stream', events };
  }

  private async *streamEvents(
    ctx: UpstreamCtx,
    p: { id: string; created: number; model: string; outTokens: number; tokPerSec: number; ttft: number; scale: number; usage: Usage; includeUsage: boolean },
  ): AsyncIterable<UpstreamEvent> {
    const enc = new TextEncoder();
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      enc.encode(
        `data: ${JSON.stringify({
          id: p.id,
          object: 'chat.completion.chunk',
          created: p.created,
          model: p.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      );

    await sleep(p.ttft, ctx.signal);
    ctx.onFirstByte?.();
    yield { t: 'frame', raw: chunk({ role: 'assistant', content: '' }, null), hasContent: false };
    const perTok = (1000 / p.tokPerSec) * p.scale;
    let sent = 0;
    while (sent < p.outTokens) {
      if (ctx.signal.aborted) return;
      const n = Math.min(p.outTokens - sent, 1 + Math.floor(Math.random() * 3));
      const text = (sent === 0 ? '' : ' ') + words(n);
      yield { t: 'frame', raw: chunk({ content: text }, null), hasContent: true };
      sent += n;
      await sleep(perTok * n, ctx.signal);
    }
    yield { t: 'frame', raw: chunk({}, 'stop'), hasContent: false };
    yield { t: 'usage', usage: p.usage, final: true };
    yield {
      t: 'frame',
      raw: enc.encode(
        `data: ${JSON.stringify({
          id: p.id,
          object: 'chat.completion.chunk',
          created: p.created,
          model: p.model,
          choices: [],
          usage: { prompt_tokens: p.usage.input, completion_tokens: p.usage.output, total_tokens: p.usage.input + p.usage.output },
        })}\n\n`,
      ),
      hasContent: false,
      usageOnly: true,
    };
    yield { t: 'frame', raw: enc.encode('data: [DONE]\n\n'), hasContent: false };
    yield { t: 'done' };
  }

  async listModels(): Promise<Array<{ id: string; context?: number }>> {
    return [
      { id: 'mock-smart', context: 200000 },
      { id: 'mock-fast', context: 128000 },
      { id: 'mock-cheap', context: 32000 },
      { id: 'mock-embed', context: 8192 },
    ];
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    return { ok: true, latencyMs: 1 };
  }
}

function words(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(LOREM[Math.floor(Math.random() * LOREM.length)]!);
  return out.join(' ');
}
