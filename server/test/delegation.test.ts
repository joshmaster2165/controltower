import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Delegations, MAX_CHAIN, MAX_LIFETIME_MS, resolveDelegation } from '../src/policy/delegation.js';
import type { KeyRecord } from '../src/registry.js';

const key = (agentId: string, delegatedOnly = false): KeyRecord => ({
  id: `key_${agentId}`, name: agentId, hash: '', prefix: '', last4: '', agentId, team: undefined, project: undefined, tags: [], allowedModels: ['*'], allowedMcp: ['*'],
  limits: {}, enabled: true, expiresAt: undefined, demo: false, createdAt: 0, lastUsedAt: undefined, delegatedOnly,
});

describe('delegation tokens', () => {
  const d = new Delegations(crypto.randomBytes(32));
  const ctx = { delegations: d, registry: { agentTeams: new Map([['support-bot', new Set(['support'])]]) } } as unknown as Parameters<typeof resolveDelegation>[0];

  it('carry the chain to the agent they were issued to, and only to it', () => {
    const t = d.issue(['support-bot'], 'billing-agent', 'f1');
    expect(d.verify(t, 'billing-agent')).toMatchObject({ ok: true, chain: ['support-bot'], parent: 'f1' });
    expect(d.verify(t, 'other-agent')).toMatchObject({ ok: false, reason: expect.stringContaining('issued to another agent') });
  });

  it('refuse tampering, other servers’ tokens and expiry', () => {
    const t = d.issue(['support-bot'], 'billing-agent', 'f1');
    const [p, payload, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ c: ['ceo-agent'], t: 'billing-agent', e: Date.now() + 60_000, f: 'x' })).toString('base64url');
    expect(d.verify(`${p}.${forged}.${sig}`, 'billing-agent').ok).toBe(false);
    expect(new Delegations(crypto.randomBytes(32)).verify(t, 'billing-agent').ok).toBe(false);
    expect(d.verify(t, 'billing-agent', Date.now() + 16 * 60_000)).toMatchObject({ ok: false, reason: expect.stringContaining('expired') });
    expect(d.verify('not-a-token', 'billing-agent').ok).toBe(false);
    expect(payload).toBeTruthy();
  });

  it('resolve to principals for gates; delegated-only keys cannot drop their token', () => {
    const t = d.issue(['support-bot'], 'billing-agent', 'f1');
    expect(resolveDelegation(ctx, key('billing-agent'), t)).toEqual({ chain: ['support-bot'], onBehalfOf: ['agent:support-bot', 'team:support'], parentFlightId: expect.any(String) });
    // An ordinary key without a token acts on its own account; a delegated-only one is refused.
    expect(resolveDelegation(ctx, key('billing-agent'), undefined)).toEqual({ chain: [], onBehalfOf: [] });
    expect(resolveDelegation(ctx, key('billing-agent', true), undefined)).toMatchObject({ error: { status: 403, code: 'delegation_required' } });
    // A token for someone else: ignored for an ordinary key, refused for a delegated-only one.
    const other = d.issue(['support-bot'], 'someone-else', 'f2');
    expect(resolveDelegation(ctx, key('billing-agent'), other)).toMatchObject({ chain: [], invalid: expect.any(String) });
    expect(resolveDelegation(ctx, key('billing-agent', true), other)).toMatchObject({ error: { code: 'delegation_required' } });
    // Loops end.
    const deep = d.issue(Array.from({ length: MAX_CHAIN }, (_, i) => `a${i}`), 'billing-agent', 'f3');
    expect(resolveDelegation(ctx, key('billing-agent'), deep)).toMatchObject({ error: { code: 'delegation_too_deep' } });
  });

  it('keep the chain and the call it came from when a chain is refused as too deep', () => {
    const chain = Array.from({ length: MAX_CHAIN }, (_, i) => `a${i}`);
    const r = resolveDelegation(ctx, key('last'), d.issue(chain, 'last', 'f_parent'));
    expect(r).toMatchObject({ error: { code: 'delegation_too_deep' }, chain, parentFlightId: 'f_parent' });
  });

  it('renew for the agent they were issued to, keeping the chain and the call they came from, for up to a day', () => {
    const t0 = 1_000_000;
    const t = d.issue(['support-bot'], 'billing-agent', 'f_parent', t0);
    expect(d.renew(t, 'other-agent', t0 + 60_000)).toMatchObject({ ok: false });
    const r = d.renew(t, 'billing-agent', t0 + 14 * 60_000);
    expect(r.ok).toBe(true);
    const fresh = (r as { token: string }).token;
    // Valid past the first token's expiry, with the same chain and parent.
    expect(d.verify(fresh, 'billing-agent', t0 + 20 * 60_000)).toMatchObject({ ok: true, chain: ['support-bot'], parent: 'f_parent', origin: t0 });
    expect(d.verify(t, 'billing-agent', t0 + 20 * 60_000).ok).toBe(false);
    // Renewing again and again stops at the delegation's lifetime.
    let tok = fresh;
    let now = t0 + 14 * 60_000;
    while (now < t0 + MAX_LIFETIME_MS - 60_000) {
      now += 14 * 60_000;
      const n = d.renew(tok, 'billing-agent', now);
      if (!n.ok) break;
      tok = n.token;
      expect(n.expiresAt).toBeLessThanOrEqual(t0 + MAX_LIFETIME_MS);
    }
    expect(d.renew(tok, 'billing-agent', t0 + MAX_LIFETIME_MS + 1).ok).toBe(false);
  });
});
