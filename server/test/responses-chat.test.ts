import { describe, expect, it } from 'vitest';
import { ChatToResponsesStream, chatResponseToResponses, flatToolName, requestTools, responsesRequestToChat } from '../src/translate/responses-chat.js';

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
      { custom: new Set(['apply_patch']), namespaced: new Map() },
    );
    expect(res).toMatchObject({ object: 'response', status: 'completed', model: 'claude-sonnet-4-5', output_text: 'Done.', usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } });
    expect((res.output as any[]).map((o) => o.type)).toEqual(['message', 'custom_tool_call']);
    expect((res.output as any[])[1]).toMatchObject({ call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch' });
  });

  it('streams chat chunks as Responses events, ending with response.completed', () => {
    const s = new ChatToResponsesStream('claude-sonnet-4-5', requestTools({ tools: [] }));
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

  // Codex (the ChatGPT desktop app) sends each MCP server's tools as one `namespace` tool, and calls them by namespace and name.
  const codexMcp = {
    model: 'claude-sonnet-4-5',
    instructions: 'You are Codex.',
    tools: [
      { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } },
      {
        type: 'namespace',
        name: 'mcp__controltower',
        description: 'Tools are named <server>__<tool>.',
        tools: [{ type: 'function', name: 'files__read_file', description: 'Read a file', strict: false, parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
      },
    ],
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read notes/plan.md' }] },
      { type: 'function_call', name: 'files__read_file', namespace: 'mcp__controltower', arguments: '{"path":"notes/plan.md"}', call_id: 'call_1' },
      { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'the plan' }] },
    ],
  };

  it('gives a chat model the tools inside a namespace, named <namespace>__<tool>', () => {
    const chat = responsesRequestToChat(codexMcp) as any;
    expect(chat.tools.map((t: any) => t.function.name)).toEqual(['exec_command', 'mcp__controltower__files__read_file']);
    expect(chat.tools[1].function.parameters.required).toEqual(['path']);
    expect(chat.messages[0]).toEqual({ role: 'system', content: 'You are Codex.' });
    expect(chat.messages[1]).toEqual({ role: 'system', content: 'Tools named mcp__controltower__…: Tools are named <server>__<tool>.' });
    expect(chat.messages[3].tool_calls[0].function.name).toBe('mcp__controltower__files__read_file');
    expect(chat.messages[4]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'the plan' });
  });

  it('calls a namespaced tool back by its namespace and name, whole or streamed', () => {
    const tools = requestTools(codexMcp);
    const whole = chatResponseToResponses({ id: 'x', choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'mcp__controltower__files__read_file', arguments: '{"path":"a"}' } }] }, finish_reason: 'tool_calls' }] }, 'claude-sonnet-4-5', tools) as any;
    expect(whole.output[0]).toMatchObject({ type: 'function_call', name: 'files__read_file', namespace: 'mcp__controltower', call_id: 'call_2', arguments: '{"path":"a"}' });

    const s = new ChatToResponsesStream('claude-sonnet-4-5', tools);
    const ev = events([...s.feed({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_3', function: { name: 'mcp__controltower__files__read_file', arguments: '{"path":"b"}' } }] }, finish_reason: 'tool_calls' }] }).frames, ...s.finish()]);
    expect(ev.find((e) => e.type === 'response.output_item.added')!.item).toMatchObject({ name: 'files__read_file', namespace: 'mcp__controltower' });
    expect(ev.find((e) => e.type === 'response.output_item.done')!.item).toMatchObject({ name: 'files__read_file', namespace: 'mcp__controltower', arguments: '{"path":"b"}' });
    // Tools outside a namespace are untouched.
    expect((chatResponseToResponses({ id: 'y', choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'exec_command', arguments: '{}' } }] } }] }, 'm', tools) as any).output[0]).not.toHaveProperty('namespace');
  });

  it('keeps flattened names within 64 characters, distinct and stable', () => {
    const a = flatToolName('mcp__a_very_long_server_name_for_testing', 'a_tool_with_a_long_name_that_overflows_1');
    const b = flatToolName('mcp__a_very_long_server_name_for_testing', 'a_tool_with_a_long_name_that_overflows_2');
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
    expect(flatToolName('mcp__a_very_long_server_name_for_testing', 'a_tool_with_a_long_name_that_overflows_1')).toBe(a);
    const tools = requestTools({ tools: [{ type: 'namespace', name: 'mcp__a_very_long_server_name_for_testing', tools: [{ type: 'function', name: 'a_tool_with_a_long_name_that_overflows_1' }] }] });
    expect(tools.namespaced.get(a)).toEqual({ namespace: 'mcp__a_very_long_server_name_for_testing', name: 'a_tool_with_a_long_name_that_overflows_1' });
  });
});
