import { describe, expect, it } from 'vitest';
import { AnthropicToOaStream, anthropicResponseToOa, oaRequestToAnthropic } from '../src/translate/openai-anthropic.js';
import { OaToAnthropicStream, anRequestToOa, oaResponseToAnthropic } from '../src/translate/anthropic-openai.js';

function frames(s: string[]): Array<Record<string, unknown>> {
  return s
    .flatMap((f) => f.split('\n').filter((l) => l.startsWith('data:')))
    .map((l) => l.slice(5).trim())
    .filter((d) => d !== '[DONE]')
    .map((d) => JSON.parse(d) as Record<string, unknown>);
}

describe('OpenAI → Anthropic', () => {
  it('translates a tool-using conversation', () => {
    const out = oaRequestToAnthropic({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'weather in Paris?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '18C' },
        { role: 'user', content: [{ type: 'text', text: 'thanks' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      tool_choice: 'required',
      stop: ['END'],
      temperature: 0.2,
    });
    expect(out.system).toBe('be terse');
    expect(out.max_tokens).toBe(4096);
    expect(out.tool_choice).toEqual({ type: 'any' });
    expect(out.stop_sequences).toEqual(['END']);
    const msgs = out.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[1]!.content[0]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } });
    // tool_result and the following user text merge into one user turn
    expect(msgs[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1', content: '18C' });
    expect(msgs[2]!.content[1]).toMatchObject({ type: 'text', text: 'thanks' });
    expect(msgs[2]!.content[2]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
    expect((out.tools as unknown[]).length).toBe(1);
  });

  it('translates a response with text and tool use', () => {
    const r = anthropicResponseToOa(
      {
        id: 'msg_1',
        content: [
          { type: 'text', text: 'Calling.' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 },
      },
      'smart',
    );
    const choice = (r.choices as Array<Record<string, unknown>>)[0]!;
    expect(choice.finish_reason).toBe('tool_calls');
    const msg = choice.message as Record<string, unknown>;
    expect(msg.content).toBe('Calling.');
    expect((msg.tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'toolu_1', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } });
    expect(r.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 90 } });
  });

  it('synthesises OpenAI chunks from an Anthropic stream', () => {
    const x = new AnthropicToOaStream('smart', true);
    const out: string[] = [];
    const seq = [
      { type: 'message_start', message: { id: 'msg_s', usage: { input_tokens: 7, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'f' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '1}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ];
    let content = 0;
    for (const ev of seq) {
      const r = x.feed(ev);
      if (r.hasContent) content++;
      out.push(...r.frames);
    }
    expect(content).toBe(5);
    const chunks = frames(out);
    expect((chunks[0]!.choices as Array<{ delta: { role: string } }>)[0]!.delta.role).toBe('assistant');
    const text = chunks.map((c) => ((c.choices as Array<{ delta?: { content?: string } }>)[0]?.delta?.content ?? '')).join('');
    expect(text).toBe('Hello');
    const args = chunks
      .flatMap((c) => ((c.choices as Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>)[0]?.delta?.tool_calls ?? []))
      .map((t) => t.function?.arguments ?? '')
      .join('');
    expect(args).toBe('{"a":1}');
    const finish = chunks.find((c) => (c.choices as Array<{ finish_reason: string | null }>)[0]?.finish_reason);
    expect((finish!.choices as Array<{ finish_reason: string }>)[0]!.finish_reason).toBe('tool_calls');
    const usage = chunks.find((c) => Array.isArray(c.choices) && (c.choices as unknown[]).length === 0);
    expect(usage!.usage).toMatchObject({ prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 });
    expect(out[out.length - 1]).toBe('data: [DONE]\n\n');
  });
});

describe('Anthropic → OpenAI', () => {
  it('translates a request with tool results and tools', () => {
    const out = anRequestToOa({
      model: 'gpt-4.1',
      system: 'be terse',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '18C' }, { type: 'text', text: 'and Rome?' }] },
      ],
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'get_weather' },
      stream: true,
    });
    const msgs = out.messages as Array<Record<string, unknown>>;
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(msgs[3]).toMatchObject({ role: 'tool', tool_call_id: 'toolu_1', content: '18C' });
    expect((msgs[2]!.tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'toolu_1', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } });
    expect(out.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.max_tokens).toBe(100);
  });

  it('translates a JSON response', () => {
    const r = oaResponseToAnthropic(
      { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'Hi', tool_calls: [{ id: 'call_2', function: { name: 'f', arguments: '{"x":2}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } },
      'smart',
    );
    expect(r.type).toBe('message');
    expect(r.stop_reason).toBe('tool_use');
    expect(r.content).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'tool_use', id: 'call_2', name: 'f', input: { x: 2 } },
    ]);
    expect(r.usage).toMatchObject({ input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 2 });
  });

  it('synthesises Anthropic events from OpenAI chunks', () => {
    const x = new OaToAnthropicStream('smart', 5);
    const out: string[] = [];
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => ({ id: 'chatcmpl-9', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
    for (const c of [
      chunk({ role: 'assistant', content: '' }),
      chunk({ content: 'Hel' }),
      chunk({ content: 'lo' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_7', type: 'function', function: { name: 'f', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] }),
      chunk({}, 'tool_calls'),
      chunk({}, null, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 4 } }),
    ]) {
      out.push(...x.feed(c as Record<string, unknown>).frames);
    }
    out.push(...x.finish());
    const evs = out.map((f) => JSON.parse(f.split('\n')[1]!.slice(5)) as Record<string, unknown>);
    const types = evs.map((e) => e.type);
    expect(types[0]).toBe('message_start');
    expect(types).toContain('content_block_start');
    expect(types[types.length - 1]).toBe('message_stop');
    const text = evs.filter((e) => e.type === 'content_block_delta' && (e.delta as { type: string }).type === 'text_delta').map((e) => (e.delta as { text: string }).text).join('');
    expect(text).toBe('Hello');
    const toolStart = evs.find((e) => e.type === 'content_block_start' && (e.content_block as { type: string }).type === 'tool_use');
    expect(toolStart!.index).toBe(1);
    const md = evs.find((e) => e.type === 'message_delta')!;
    expect((md.delta as { stop_reason: string }).stop_reason).toBe('tool_use');
    expect((md.usage as { output_tokens: number }).output_tokens).toBe(4);
    // Every opened block is closed exactly once.
    expect(evs.filter((e) => e.type === 'content_block_stop').length).toBe(2);
  });
});
