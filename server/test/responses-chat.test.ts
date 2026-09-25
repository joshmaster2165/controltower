import { describe, expect, it } from 'vitest';
import { ChatToResponsesStream, chatResponseToResponses, customToolNames, responsesRequestToChat } from '../src/translate/responses-chat.js';

const events = (frames: string[]) =>
  frames.map((f) => {
    const data = JSON.parse(f.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as Record<string, any>;
    return data;
  });

describe('Responses API through Chat Completions', () => {
  it('translates a Codex-style request: instructions, turns, tool calls and their results, tools', () => {
    const body = {
      model: 'claude-sonnet-4-5',
      instructions: 'You are a coding agent.',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Use the shell.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List the files.' }] },
        { type: 'reasoning', summary: [] },
        { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":["ls"]}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'a.txt\nb.txt' },
        { type: 'custom_tool_call', call_id: 'call_2', name: 'apply_patch', input: '*** Begin Patch' },
        { type: 'custom_tool_call_output', call_id: 'call_2', output: 'ok' },
      ],
      tools: [
        { type: 'function', name: 'shell', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'array' } } } },
        { type: 'custom', name: 'apply_patch', description: 'Edit files', format: { type: 'grammar' } },
        { type: 'web_search' },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      max_output_tokens: 500,
      stream: true,
      store: false,
      reasoning: { effort: 'medium' },
    };
    const chat = responsesRequestToChat(body);
    expect(chat.messages).toEqual([
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'system', content: 'Use the shell.' },
      { role: 'user', content: 'List the files.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":["ls"]}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'a.txt\nb.txt' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' } }] },
      { role: 'tool', tool_call_id: 'call_2', content: 'ok' },
    ]);
    expect((chat.tools as any[]).map((t) => t.function.name)).toEqual(['shell', 'apply_patch']); // built-in tools dropped
    expect(chat).toMatchObject({ tool_choice: 'auto', parallel_tool_calls: false, max_tokens: 500, stream: true, stream_options: { include_usage: true } });
    expect(chat).not.toHaveProperty('reasoning');
    expect(() => responsesRequestToChat({ model: 'x', input: 'hi', previous_response_id: 'resp_1' })).toThrow(/previous_response_id/);
  });

  it('turns a chat reply into a Responses object, custom tools back in their own shape', () => {
    const res = chatResponseToResponses(
      {
        id: 'chatcmpl-1',
        created: 1,
        choices: [{ message: { role: 'assistant', content: 'Done.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      },
      'claude-sonnet-4-5',
      new Set(['apply_patch']),
    );
    expect(res).toMatchObject({ object: 'response', status: 'completed', model: 'claude-sonnet-4-5', output_text: 'Done.', usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } });
    expect((res.output as any[]).map((o) => o.type)).toEqual(['message', 'custom_tool_call']);
    expect((res.output as any[])[1]).toMatchObject({ call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch' });
  });

  it('streams chat chunks as Responses events, ending with response.completed', () => {
    const s = new ChatToResponsesStream('claude-sonnet-4-5', customToolNames({ tools: [] }));
    const frames = [
      ...s.feed({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] }).frames,
      ...s.feed({ choices: [{ index: 0, delta: { content: 'lo' } }] }).frames,
      ...s.feed({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'shell', arguments: '{"command"' } }] } }] }).frames,
      ...s.feed({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':["ls"]}' } }] }, finish_reason: 'tool_calls' }] }).frames,
      ...s.feed({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }).frames,
      ...s.finish(),
    ];
    const ev = events(frames);
    expect(ev.map((e) => e.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(ev.map((e) => e.sequence_number)).toEqual(ev.map((_, i) => i));
    const done = ev.at(-1)!.response;
    expect(done.output.map((o: any) => o.type)).toEqual(['message', 'function_call']);
    expect(done.output[0].content[0].text).toBe('Hello');
    expect(done.output[1]).toMatchObject({ call_id: 'call_9', name: 'shell', arguments: '{"command":["ls"]}' });
    expect(done.usage).toMatchObject({ input_tokens: 7, output_tokens: 3 });
  });
});
