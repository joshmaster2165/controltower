import { describe, expect, it } from 'vitest';
import { defaultClass, exfilRisks, internalHost, worstRisk, type Link, type TrustClass } from '../src/airspace/classes.js';

const link = (system_id: string, o: Partial<Link> = {}): Link => ({ agent_id: 'a', system_id, calls: 10, op: 'read', mitigated: false, mitigation: null, outside: false, state: 'allow', ...o });

describe('trust classes', () => {
  it('knows an internal host', () => {
    expect(internalHost('http://10.2.3.4:8080')).toBe(true);
    expect(internalHost('https://crm.acme.internal/mcp')).toBe(true);
    expect(internalHost('http://ollama:11434')).toBe(true);
    expect(internalHost('https://api.openai.com')).toBe(false);
    expect(internalHost(undefined)).toBe(false);
  });

  it('classes systems by what they are', () => {
    expect(defaultClass({ id: 'provider:p', kind: 'model', name: 'Anthropic', url: 'https://api.anthropic.com', subkind: 'anthropic' }).class).toBe('D');
    expect(defaultClass({ id: 'provider:o', kind: 'model', name: 'Local', url: 'http://ollama:11434', subkind: 'ollama' }).class).toBe('C');
    expect(defaultClass({ id: 'tool:k8s', kind: 'mcp', name: 'k8s-prod', url: 'https://mcp.example.com' }).class).toBe('A');
    expect(defaultClass({ id: 'tool:crm', kind: 'mcp', name: 'Salesforce', url: 'https://mcp.salesforce.com' }).class).toBe('B');
    expect(defaultClass({ id: 'tool:gh', kind: 'mcp', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp' }).class).toBe('C');
    expect(defaultClass({ id: 'tool:w', kind: 'http', name: 'Weather', url: 'https://api.weather.com' }).class).toBe('D');
    expect(defaultClass({ id: 'observed:x', kind: 'observed', name: 'pastebin.com', url: 'pastebin.com', subkind: 'http' }).class).toBe('E');
    expect(defaultClass({ id: 'observed:y', kind: 'observed', name: 'orders', url: 'pg.acme.internal', subkind: 'database' }).class).toBe('B');
  });

  it('finds the paths data could leave by', () => {
    const cls: Record<string, TrustClass> = { crm: 'B', model: 'D', paste: 'E', gh: 'C', vendor: 'D' };
    const classOf = (id: string) => cls[id]!;
    // Restricted data in reach; out to a model unchecked (high), to an outside host around the gateway (critical).
    const risks = exfilRisks([link('crm'), link('model', { op: 'model' }), link('paste', { outside: true, op: 'write' })], classOf);
    expect(risks.map((r) => [r.dest_id, r.level])).toEqual([['paste', 'critical'], ['model', 'high']]);
    expect(risks[0]!.source_id).toBe('crm');
    expect(worstRisk(risks)).toBe('critical');
    // Something on the way out lowers it.
    expect(exfilRisks([link('crm'), link('model', { op: 'model', mitigated: true, mitigation: 'inspected by Mask' })], classOf)[0]!.level).toBe('low');
    // Internal only: a vendor isn't a risk, the public internet is (medium through the gateway).
    expect(exfilRisks([link('gh'), link('vendor')], classOf)).toEqual([]);
    expect(exfilRisks([link('gh'), link('paste')], classOf)[0]!.level).toBe('medium');
    // A blocked source isn't within reach; an agent that reaches nothing inside has no source.
    expect(exfilRisks([link('crm', { state: 'deny' }), link('model', { op: 'model' })], classOf)).toEqual([]);
    expect(worstRisk([])).toBeNull();
  });
});
