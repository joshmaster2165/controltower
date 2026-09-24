import { describe, expect, it } from 'vitest';
import { emailMessage, isEmail, smtpFromEnv } from '../src/alerts/email.js';
import type { AlertPayload } from '../src/alerts/alerts.js';

const payload = (over: Partial<AlertPayload> = {}): AlertPayload => ({
  type: 'controltower.alert',
  id: 'alert_1',
  kind: 'gate',
  title: 'Refunds need approval: <b>billing-bot</b> → stripe__refund held',
  trigger: 'held',
  count: 1,
  digest: false,
  window_s: 300,
  first_at: '2026-09-24T12:00:00Z',
  last_at: '2026-09-24T12:00:00Z',
  alert_rule: { id: 'r', name: 'Refunds' },
  subject: null,
  gate: { id: 'g', name: 'Refunds need approval', effect: 'require_approval' },
  agents: [{ name: 'billing-bot', count: 1 }],
  destinations: [{ name: 'stripe__refund', count: 1 }],
  reason: null,
  lines: [],
  flights: [],
  approval: { id: 'apr_1', scope: 'Approve this ONE call to stripe__refund with exactly these arguments', url: 'https://tower.example.com/#/tower/apr_1' },
  console_url: 'https://tower.example.com/#/alerts',
  ...over,
});

describe('email alerts', () => {
  it('reads CT_SMTP_URL and CT_SMTP_FROM', () => {
    expect(smtpFromEnv({ CT_SMTP_URL: 'smtp://mailer:p%40ss@smtp.example.com:2525', CT_SMTP_FROM: 'Tower <t@example.com>' })).toEqual({ host: 'smtp.example.com', port: 2525, secure: false, user: 'mailer', pass: 'p@ss', from: 'Tower <t@example.com>' });
    expect(smtpFromEnv({ CT_SMTP_URL: 'smtps://smtp.example.com' })).toMatchObject({ port: 465, secure: true, from: 'controltower@smtp.example.com' });
    expect(smtpFromEnv({})).toBeUndefined();
    expect(smtpFromEnv({ CT_SMTP_URL: 'not a url' })).toBeUndefined();
  });
  it('marks approval requests and links to the card, escaping names in HTML', () => {
    const m = emailMessage(payload());
    expect(m.subject.startsWith('[Approval needed] ')).toBe(true);
    expect(m.text).toContain('Review & approve: https://tower.example.com/#/tower/apr_1');
    expect(m.html).toContain('href="https://tower.example.com/#/tower/apr_1"');
    expect(m.html).toContain('&lt;b&gt;billing-bot&lt;/b&gt;');
    expect(m.html).not.toContain('<b>billing-bot</b>');
  });
  it('other alerts link to the console', () => {
    const m = emailMessage(payload({ approval: null, trigger: 'blocked', title: 'Blocked' }));
    expect(m.subject).toBe('Blocked');
    expect(m.text).toContain('Open Control Tower: https://tower.example.com/#/alerts');
  });
  it('validates addresses', () => {
    expect(isEmail('oncall@example.com')).toBe(true);
    expect(isEmail('not an email')).toBe(false);
    expect(isEmail('a@b')).toBe(false);
  });
});
