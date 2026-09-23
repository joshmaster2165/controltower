import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { Versioned } from '../src/util/versioned.js';
import { classifyTarget, normalizeTarget, ObservedStore, parseObserveBody, parseOtlpTraces } from '../src/observe/observe.js';

describe('observed targets', () => {
  it('keeps a name, never paths, query strings or credentials', () => {
    expect(normalizeTarget('https://api.stripe.com/v1/charges?amount=100')).toBe('api.stripe.com');
    expect(normalizeTarget('postgresql://app:hunter2@db.internal:5432/orders?sslmode=require')).toBe('postgresql://db.internal:5432/orders');
    expect(normalizeTarget('redis://:secret@cache:6379/0')).toBe('redis://cache:6379/0');
    expect(normalizeTarget('admin:pw@internal-api.corp:8443/v2/users')).toBe('internal-api.corp:8443');
    expect(normalizeTarget('   ')).toBeNull();
  });

  it('recognises model providers called directly as a gateway bypass, and known SaaS', () => {
    expect(classifyTarget('api.openai.com', 'http', undefined)).toEqual({ kind: 'model', system: 'OpenAI', bypass: true });
    expect(classifyTarget('bedrock-runtime.us-east-1.amazonaws.com', undefined, undefined)).toEqual({ kind: 'model', system: 'AWS Bedrock', bypass: true });
    expect(classifyTarget('api.stripe.com', 'http', undefined)).toEqual({ kind: 'saas', system: 'Stripe', bypass: false });
    expect(classifyTarget('postgresql://db.internal:5432/orders', 'database', undefined)).toEqual({ kind: 'database', system: undefined, bypass: false });
  });

  it('parses the simple /v1/observe format', () => {
    const r = parseObserveBody({ events: [{ target: 'https://api.github.com/repos/acme/x', operation: 'write', status: 'error', duration_ms: 120, count: 3 }, { nope: true }, 'junk'] }, 1000);
    expect(r).toEqual({ events: [{ target: 'api.github.com', kind: 'http', system: undefined, write: true, error: true, durationMs: 120, ts: 1000, count: 3 }] });
    expect(parseObserveBody({ foo: 1 })).toHaveProperty('error');
  });

  it('maps OpenTelemetry client spans and skips server spans and calls to Control Tower itself', () => {
    const at = (key: string, v: string) => ({ key, value: { stringValue: v } });
    const span = (kind: number | string, attributes: Array<{ key: string; value: { stringValue: string } }>, code = 1) => ({ kind, attributes, status: { code }, startTimeUnixNano: '1000000000', endTimeUnixNano: '1250000000' });
    const body = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                span(3, [at('http.request.method', 'POST'), at('url.full', 'https://api.stripe.com/v1/refunds')]),
                span('SPAN_KIND_CLIENT', [at('db.system', 'postgresql'), at('server.address', 'db.internal'), at('db.namespace', 'orders'), at('db.operation.name', 'DELETE')], 2),
                span(3, [at('gen_ai.system', 'openai'), at('server.address', 'api.openai.com')]),
                span(3, [at('url.full', 'http://localhost:4000/v1/chat/completions')]),
                span(2, [at('url.full', 'https://inbound.example.com/')]),
              ],
            },
          ],
        },
      ],
    };
    const ev = parseOtlpTraces(body, new Set(['localhost:4000']), 5_000);
    expect(ev.map((e) => [e.target, e.kind, e.write, e.error, e.durationMs])).toEqual([
      ['api.stripe.com', 'http', true, false, 250],
      ['postgresql://db.internal/orders', 'database', true, true, 250],
      ['api.openai.com', 'model', false, false, 250],
    ]);
  });

  it('aggregates per agent and system, and signals new paths once', async () => {
    const db = openSqlite('', { memory: true });
    const v = new Versioned();
    const store = new ObservedStore(db.write, v);
    const now = Date.now();
    const e = (target: string, extra: Partial<{ error: boolean; write: boolean }> = {}) => ({ target, kind: 'http' as const, system: undefined, write: false, error: false, durationMs: 10, ts: now, count: 1, ...extra });
    await store.record('k_bot', [e('api.stripe.com'), e('api.stripe.com', { error: true }), e('api.openai.com', { write: true })]);
    await store.record('k_bot', [e('api.stripe.com')]);
    const s = await store.summary(now - 86_400_000);
    expect(s.targets.map((t) => [t.target, t.kind, t.system, t.bypass, t.count_24h, t.errors_24h]).sort()).toEqual([
      ['api.openai.com', 'model', 'OpenAI', true, 1, 0],
      ['api.stripe.com', 'saas', 'Stripe', false, 3, 1],
    ]);
    expect(s.edges.find((x) => x.target_id === 'obs:api.stripe.com')).toMatchObject({ key_id: 'k_bot', count_24h: 3, errors_24h: 1, writes_24h: 0 });
    store.stop();
  });
});
