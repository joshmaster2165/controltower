import { describe, expect, it } from 'vitest';
import { failedTask } from '../src/a2a/gateway.js';

describe('an A2A reply that reports a failed task', () => {
  it('is a failed call in both protocol versions, with what the agent said', () => {
    // A2A 1.0: the task is wrapped, states are TASK_STATE_*.
    expect(failedTask({ task: { id: 't', status: { state: 'TASK_STATE_FAILED', message: { parts: [{ text: 'Agent execution error: boom' }] } } } })).toEqual({ code: 'agent_task_failed', message: 'Agent execution error: boom' });
    // A2A 0.3: the task is the result, states are lower-case.
    expect(failedTask({ kind: 'task', id: 't', status: { state: 'rejected' } })).toEqual({ code: 'agent_task_rejected', message: 'the agent reported its task rejected' });
  });
  it('leaves everything else alone', () => {
    expect(failedTask({ task: { status: { state: 'TASK_STATE_COMPLETED' } } })).toBeUndefined();
    expect(failedTask({ kind: 'task', status: { state: 'working' } })).toBeUndefined();
    expect(failedTask({ kind: 'message', parts: [{ kind: 'text', text: 'hi' }] })).toBeUndefined();
    expect(failedTask(undefined)).toBeUndefined();
  });
});
