import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { clientOf, forPerson } from '../src/gateway/notices.js';
import { E } from '../src/gateway/errors.js';

const ctx = (label = 'Control Tower') =>
  ({
    config: { noticeLabel: label },
    policy: { rule: (id: string) => (id === 'r1' ? { name: 'Sonnet needs a manager', config: {} } : id === 'r2' ? { name: 'No credentials', config: { reason: 'Credentials stay out of models' } } : undefined) },
  }) as unknown as Parameters<typeof forPerson>[2];
const desktop = { client: 'claude-desktop', decision: { ruleId: 'r1' } };
const req = (ua: string, ctClient?: string) => ({ headers: { 'user-agent': ua }, ctClient }) as unknown as FastifyRequest;

describe("what a person's app is told", () => {
  it('knows the app from the laptop sign-in, or from its User-Agent', () => {
    expect(clientOf(req('anything', 'codex'))).toBe('codex');
    expect(clientOf(req('claude-cli/2.1.286 (external, claude-desktop-3p, agent-sdk/0.3.286)'))).toBe('claude-desktop');
    expect(clientOf(req('claude-cli/2.1.286 (external, cli)'))).toBe('claude-code');
    expect(clientOf(req('codex_cli_rs/0.50.0 (Mac OS 15.5.0; arm64)'))).toBe('codex');
    expect(clientOf(req('python-httpx/0.28', 'other'))).toBeUndefined();
  });

  it("leaves an agent's refusals exactly as they were", () => {
    const ge = E.policyDenied('Blocked by gate "x"', 'r1');
    expect(forPerson(ge, { client: undefined }, ctx())).toBe(ge);
  });

  it('says who decided and why, as a 400 (Claude reads a 403 as a failed sign-in)', () => {
    const denied = forPerson(E.policyDenied('Denied by maria@acme.com: Not before the audit closes.', 'r1'), desktop, ctx());
    expect(denied).toMatchObject({ status: 400, code: 'policy_denied', type: 'invalid_request_error', message: 'Control Tower: your request was denied by maria@acme.com: Not before the audit closes (gate “Sonnet needs a manager”).' });
    expect(forPerson(E.policyDenied('Credentials stay out of models', 'r2'), { client: 'claude-code', decision: { ruleId: 'r2' } }, ctx()).message).toBe('Control Tower blocked this request (gate “No credentials”): Credentials stay out of models.');
  });

  it('tells an expired hold from one still waiting, and keeps the details for programs', () => {
    const expired = forPerson(E.approvalRequired('CONTROL_TOWER_APPROVAL_EXPIRED: …', { ct: { v: 1, status: 'expired', request_id: 'apr_1' } }), desktop, ctx());
    expect(expired.message).toBe('Control Tower: this request needed approval (gate “Sonnet needs a manager”), and nobody approved it in time. Send your message again to ask again.');
    expect(expired.extra).toMatchObject({ ct: { status: 'expired', request_id: 'apr_1' } });
    const waiting = forPerson(E.approvalRequired('CONTROL_TOWER_APPROVAL_REQUIRED …', { ct: { v: 1, status: 'pending', console_url: 'https://ct.acme.com/#/tower/apr_2' } }), desktop, ctx('Acme AI Gateway'));
    expect(waiting.message).toBe('Acme AI Gateway: this request needs approval (gate “Sonnet needs a manager”). An approver has been asked; once they approve, send the same message again. Status: https://ct.acme.com/#/tower/apr_2');
  });

  it('turns any other 403 into a 400, and leaves sign-in failures alone', () => {
    expect(forPerson(E.modelNotAllowed('claude-opus-4'), desktop, ctx()).status).toBe(400);
    expect(forPerson(E.unauthorized(), desktop, ctx()).status).toBe(401);
  });
});
