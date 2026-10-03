import type { FastifyReply } from 'fastify';

/**
 * Telling a person in the conversation itself (Claude Desktop, Claude Code: the Messages API, streamed). When a gate
 * holds their request, the reply starts at once with a line saying so, and keeps the connection alive while an
 * approver decides; once approved, the model's own answer follows in the same reply (its content blocks after ours).
 * A refusal is a short reply in words instead of an error box.
 *
 * Every line Control Tower writes begins with NOTICE_MARK (an invisible character): the next request carries the
 * conversation back, and those lines are taken out of it before anything else reads it (stripNotices), so the model
 * never sees them and approvals keep matching the conversation they were given for.
 */
export const NOTICE_MARK = '⁣';
const PING_MS = 10_000;

export class PersonStream {
  private ping: NodeJS.Timeout | undefined;
  private noticeOpen = false;
  /** The model's opening (its usage) when its answer follows ours: carried into the end. */
  private upstreamUsage: Record<string, unknown> | undefined;
  closed = false;

  constructor(
    private readonly reply: FastifyReply,
    private readonly flightId: string,
    private readonly model: string,
  ) {}

  private raw(s: string): void {
    const res = this.reply.raw;
    if (!res.writableEnded && !res.destroyed) res.write(s);
  }
  private event(type: string, data: Record<string, unknown>): void {
    this.raw(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  /** Start the reply with a line of ours, and keep it alive. */
  open(line: string): void {
    this.reply.hijack();
    this.reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-ct-flight-id': this.flightId });
    this.event('message_start', { message: { id: `msg_ct_${this.flightId}`, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    this.event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    this.noticeOpen = true;
    this.say(line);
    this.ping = setInterval(() => this.event('ping', {}), PING_MS);
    this.ping.unref?.();
  }

  /** Another line of ours. */
  say(line: string): void {
    if (this.noticeOpen) this.event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `${NOTICE_MARK}${line}\n\n` } });
  }

  /** A reply with nothing in it (a background call answered without the model). */
  empty(): void {
    this.reply.hijack();
    this.reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-ct-flight-id': this.flightId });
    this.event('message_start', { message: { id: `msg_ct_${this.flightId}`, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    this.event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } });
    this.event('message_stop', {});
    this.closed = true;
    this.reply.raw.end();
  }

  /** Our lines are done; the model's answer comes next. */
  handOver(): void {
    if (this.ping) clearInterval(this.ping);
    if (this.noticeOpen) this.event('content_block_stop', { index: 0 });
    this.noticeOpen = false;
  }

  /** End the reply with a last line of ours (a refusal, or an error after the start). */
  finish(line?: string): void {
    if (this.closed) return;
    if (line) {
      if (!this.noticeOpen) {
        this.event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        this.noticeOpen = true;
      }
      this.say(line);
    }
    this.handOver();
    this.event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } });
    this.event('message_stop', {});
    this.closed = true;
    this.reply.raw.end();
  }

  /**
   * The model's stream, fitted after our lines: its own message_start is dropped (ours went first; its usage is kept
   * for the end), and its content blocks are numbered after ours.
   */
  fit(chunk: string): string {
    let out = '';
    for (const block of chunk.split('\n\n')) {
      if (!block.trim()) continue;
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(data) as Record<string, unknown>;
      } catch {
        out += `${block}\n\n`;
        continue;
      }
      const type = String(ev.type ?? '');
      if (type === 'message_start') {
        this.upstreamUsage = ((ev.message as { usage?: Record<string, unknown> } | undefined)?.usage ?? undefined) as Record<string, unknown> | undefined;
        continue;
      }
      if (type.startsWith('content_block_') && typeof ev.index === 'number') ev.index = ev.index + 1;
      if (type === 'message_delta' && this.upstreamUsage) ev.usage = { ...this.upstreamUsage, ...((ev.usage as Record<string, unknown> | undefined) ?? {}) };
      if (type === 'message_stop') this.closed = true;
      out += `event: ${type}\ndata: ${JSON.stringify(ev)}\n\n`;
    }
    return out;
  }

  stop(): void {
    if (this.ping) clearInterval(this.ping);
  }
}

/** Take Control Tower's own lines out of a conversation carried back to it (Messages API bodies). */
export function stripNotices(body: Record<string, unknown>): void {
  if (!Array.isArray(body.messages)) return;
  const kept: unknown[] = [];
  for (const m of body.messages as Array<{ role?: string; content?: unknown }>) {
    if (m?.role !== 'assistant') {
      kept.push(m);
      continue;
    }
    if (typeof m.content === 'string') {
      const t = clean(m.content);
      if (t.trim()) kept.push({ ...m, content: t });
      continue;
    }
    if (Array.isArray(m.content)) {
      const content = (m.content as Array<{ type?: string; text?: unknown }>)
        .map((b) => (b?.type === 'text' && typeof b.text === 'string' ? { ...b, text: clean(b.text) } : b))
        .filter((b) => !(b?.type === 'text' && typeof b.text === 'string' && !b.text.trim()));
      if (content.length) kept.push({ ...m, content });
      continue;
    }
    kept.push(m);
  }
  body.messages = kept;
}

const NOTICE_LINE = new RegExp(`${NOTICE_MARK}[^\\n]*(\\n\\n?|$)`, 'g');
const clean = (s: string) => (s.includes(NOTICE_MARK) ? s.replace(NOTICE_LINE, '') : s);
