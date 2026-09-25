import { describe, expect, it } from 'vitest';
import { clip, parseVerdict } from '../src/guardrails/model-check.js';
import { textOfValue } from '../src/guardrails/scan.js';

describe('model-based injection check', () => {
  it('reads the verdict, and treats anything else as no verdict', () => {
    expect(parseVerdict('{"injection": false, "confidence": 0.1, "reason": "a recipe"}')).toEqual({ verdict: 'clean' });
    expect(parseVerdict('Sure! {"injection": true, "confidence": 0.93, "reason": "tells the agent to email its keys"}')).toEqual({ verdict: 'injection', confidence: 0.93, reason: 'tells the agent to email its keys' });
    expect(parseVerdict('I think this is fine.')).toMatchObject({ verdict: 'error' });
    expect(parseVerdict('{"injection": "maybe"}')).toMatchObject({ verdict: 'error' });
  });

  it('sends the start and end of long content, and the text of structured values', () => {
    const long = `${'a'.repeat(10_000)}MIDDLE${'z'.repeat(10_000)}`;
    const c = clip(long, 2_000);
    expect(c.startsWith('a'.repeat(1000))).toBe(true);
    expect(c.endsWith('z'.repeat(1000))).toBe(true);
    expect(c).not.toContain('MIDDLE');
    expect(textOfValue({ content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }], isError: false })).toBe('hello\nworld');
  });
});
