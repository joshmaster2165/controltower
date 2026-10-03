import { describe, expect, it } from 'vitest';
import type { FastifyReply } from 'fastify';
import { NOTICE_MARK, PersonStream, stripNotices } from '../src/gateway/person-stream.js';

const fakeReply = () => {
  const out: string[] = [];
  const raw = { writableEnded: false, destroyed: false, writeHead: () => undefined, write: (s: string) => (out.push(s), true), end: () => ((raw.writableEnded = true), undefined) };
  return { reply: { hijack: () => undefined, raw } as unknown as FastifyReply, out };
};
const events = (s: string) =>
  s
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data:'))!.slice(5)) as { type: string; index?: number; delta?: { text?: string }; usage?: Record<string, number> });

describe("a person's reply, started by Control Tower", () => {
  it("fits the model's stream after its own lines: one opening, blocks renumbered, the model's usage kept", () => {
    const { reply, out } = fakeReply();
    const ps = new PersonStream(reply, 'f1', 'claude-sonnet-4-5');
    ps.open('waiting');
    ps.say('approved');
    ps.handOver();
    const upstream = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1200,"output_tokens":1}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const all = events(out.join('') + upstream.map((c) => ps.fit(c)).join(''));
    expect(all.filter((e) => e.type === 'message_start')).toHaveLength(1);
    expect(all.filter((e) => e.type === 'content_block_delta').map((e) => `${e.index}:${e.delta?.text}`)).toEqual([`0:${NOTICE_MARK}waiting\n\n`, `0:${NOTICE_MARK}approved\n\n`, '1:Hello']);
    expect(all.find((e) => e.type === 'message_delta')?.usage).toEqual({ input_tokens: 1200, output_tokens: 9 });
    expect(ps.closed).toBe(true);
  });

  it('ends a refusal properly, and its lines are taken out of the conversation that comes back', () => {
    const { reply, out } = fakeReply();
    const ps = new PersonStream(reply, 'f2', 'm');
    ps.open('Control Tower: your request was denied');
    ps.finish();
    const all = events(out.join(''));
    expect(all.map((e) => e.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    const body = {
      messages: [
        { role: 'user', content: 'draft it' },
        { role: 'assistant', content: [{ type: 'text', text: `${NOTICE_MARK}⏳ waiting\n\n${NOTICE_MARK}✓ approved\n\n` }, { type: 'text', text: 'The draft.' }] },
        { role: 'user', content: 'again' },
        { role: 'assistant', content: `${NOTICE_MARK}Control Tower: denied\n\n` },
        { role: 'user', content: 'please' },
      ],
    };
    stripNotices(body);
    expect(body.messages).toEqual([
      { role: 'user', content: 'draft it' },
      { role: 'assistant', content: [{ type: 'text', text: 'The draft.' }] },
      { role: 'user', content: 'again' },
      { role: 'user', content: 'please' },
    ]);
  });
});
