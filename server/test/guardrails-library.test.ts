import { describe, expect, it } from 'vitest';
import { guardrailProblem, slugOf, withGuardrails, type GuardrailRecord } from '../src/guardrails/library.js';
import { compileInspector, runInspectors, validatePattern } from '../src/guardrails/scan.js';
import { parsePolicyVerdict } from '../src/guardrails/model-check.js';

describe('your own guardrails', () => {
  it('refuse a pattern that can run away, and accept ordinary ones quickly', () => {
    const t = Date.now();
    expect(validatePattern('ORD-\\d{6}')).toBeNull();
    expect(validatePattern('\\b[A-Z]{2}\\d{4}\\b')).toBeNull();
    expect(Date.now() - t).toBeLessThan(200);
    expect(validatePattern('(a+)+$')).toContain('too long');
    expect(validatePattern('(x|x)*y')).toContain('too long');
    expect(validatePattern('ORD-(')).toBeTruthy();
  });

  it('say what is missing', () => {
    expect(guardrailProblem({ name: '', checks: { keywords: ['x'] } })).toContain('name');
    expect(guardrailProblem({ name: 'x', checks: {} })).toContain('something to look for');
    expect(guardrailProblem({ name: 'x', checks: { detectors: ['nope'] } })).toContain('Unknown detector');
    expect(guardrailProblem({ name: 'x', checks: { policy: { model: 'm', instructions: 'short' } } })).toContain('Write the policy');
    expect(guardrailProblem({ name: 'x', checks: { patterns: [{ name: '', regex: 'a' }] } })).toContain('needs a name');
    expect(guardrailProblem({ name: 'Launch', checks: { keywords: ['Falcon'], patterns: [{ name: 'order', regex: 'ORD-\\d+' }] } })).toBeNull();
  });

  it("join a gate's checks under their own name, and a gate finds with them", () => {
    const lib = new Map<string, GuardrailRecord>([
      ['g1', { id: 'g1', name: 'Launch secrets', description: null, checks: { detectors: ['email'], keywords: ['Falcon'], patterns: [{ name: 'order', regex: 'ORD-\\d{6}' }] } }],
      ['g2', { id: 'g2', name: 'Board figures', description: null, checks: { policy: { model: 'judge', instructions: 'No unannounced revenue figures.' } } }],
    ]);
    const cfg = withGuardrails({ guardrails: ['g1', 'g2', 'gone'], detectors: ['aws_access_key'], action: 'mask' }, lib);
    expect(cfg.detectors?.sort()).toEqual(['aws_access_key', 'email']);
    expect(cfg.policies).toEqual([{ name: 'board-figures', model: 'judge', instructions: 'No unannounced revenue figures.' }]);
    const r = runInspectors([{ rule: { id: 'r', name: 'gate', config: cfg }, compiled: compileInspector(cfg) }], 'input', { text: 'Falcon order ORD-123456 for a@b.co' });
    expect((r.value as { text: string }).text).toBe('[REDACTED] order [REDACTED:LAUNCH-SECRETS_ORDER] for [EMAIL]');
    expect(slugOf('Board figures (Q3)!')).toBe('board-figures-q3');
  });

  it("read a policy judge's verdict, and nothing else", () => {
    expect(parsePolicyVerdict('{"violates": true, "reason": "revenue figures"}')).toEqual({ verdict: 'violates', reason: 'revenue figures' });
    expect(parsePolicyVerdict('Sure! {"violates": false}')).toEqual({ verdict: 'clean' });
    expect(parsePolicyVerdict('I think it is fine').verdict).toBe('error');
    expect(parsePolicyVerdict('{"violates": "yes"}').verdict).toBe('error');
  });
});
