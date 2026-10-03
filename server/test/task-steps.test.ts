import { describe, expect, it } from 'vitest';
import { isFollowUp, lastUserText, taskText } from '../src/policy/approvals.js';

const reminder = { type: 'text', text: '<system-reminder>Today is Saturday.</system-reminder>' };
describe("a task's next steps", () => {
  it('are told apart from something the person typed (Messages, Chat, Responses)', () => {
    const asked = { role: 'user', content: [reminder, { type: 'text', text: 'Summarize README.md' }] };
    const step = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '# Q3' }, reminder] };
    const messages = [asked, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] }, step];
    expect(isFollowUp({ messages: [asked] })).toBe(false);
    expect(isFollowUp({ messages })).toBe(true);
    expect(taskText({ messages })).toBe('Summarize README.md');
    expect(lastUserText({ messages: [asked] })).toBe('Summarize README.md');
    // Chat: a tool message last.
    expect(isFollowUp({ messages: [{ role: 'user', content: 'go' }, { role: 'assistant', tool_calls: [{}] }, { role: 'tool', content: 'ok' }] })).toBe(true);
    // Responses: a tool's output item last; the task is the last input_text the person typed.
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'Fix the build' }] }, { type: 'function_call', name: 'shell' }, { type: 'function_call_output', output: 'ok' }];
    expect(isFollowUp({ input })).toBe(true);
    expect(taskText({ input })).toBe('Fix the build');
    // Something new they typed after the tools ran is not a step: it asks again.
    expect(isFollowUp({ messages: [...messages, { role: 'assistant', content: 'Done.' }, { role: 'user', content: 'Now email it to the board' }] })).toBe(false);
  });
});
