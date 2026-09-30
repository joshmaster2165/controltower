import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { AuditLog, actionFor, redact } from '../src/ee/audit.js';

const person = { type: 'person' as const, id: 'u1', email: 'dana@example.com', role: 'admin' };

describe('audit log', () => {
  it('chains every event to the one before, and verify() finds edits, gaps and inserted rows', async () => {
    const db = openSqlite('', { memory: true });
    const log = new AuditLog(db);
    for (let i = 0; i < 5; i++) await log.record({ action: 'keys.create', outcome: 'success', actor: person, status: 201, target: { type: 'keys', id: `k${i}` }, detail: { body: { name: `agent-${i}` } } });
    expect(await log.verify()).toMatchObject({ ok: true, events: 5, first_seq: 1, last_seq: 5 });

    // Someone with database access rewrites history.
    db.raw.prepare("UPDATE audit_events SET detail = '{\"body\":{\"name\":\"innocent\"}}' WHERE seq = 3").run();
    expect(await log.verify()).toMatchObject({ ok: false, broken_at: 3, reason: expect.stringContaining('changed') });
    db.raw.prepare("UPDATE audit_events SET detail = '{\"body\":{\"name\":\"agent-2\"}}' WHERE seq = 3").run();
    expect((await log.verify()).ok).toBe(true);

    db.raw.prepare('DELETE FROM audit_events WHERE seq = 4').run();
    expect(await log.verify()).toMatchObject({ ok: false, broken_at: 4, reason: expect.stringContaining('missing') });
  });

  it('keeps one unbroken sequence under concurrent writes; retention trims from the oldest end', async () => {
    const db = openSqlite('', { memory: true });
    const log = new AuditLog(db);
    await Promise.all(Array.from({ length: 40 }, (_, i) => log.record({ action: 'rules.update', outcome: 'success', actor: person, target: { id: `r${i}` } })));
    expect(await log.verify()).toMatchObject({ ok: true, events: 40, first_seq: 1, last_seq: 40 });
    db.raw.prepare('DELETE FROM audit_events WHERE seq <= 10').run();
    expect(await log.verify()).toMatchObject({ ok: true, events: 30, first_seq: 11 });
  });

  it('never stores a private key, whatever the field is called', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----\n';
    const r = JSON.stringify(redact({ kind: 'gcp', config: { project: 'acme-prod', service_account_json: JSON.stringify({ client_email: 'ct@acme.iam.gserviceaccount.com', private_key: pem }) }, notes: `pasted by mistake: ${pem}`, truncated: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA' }));
    expect(r).not.toContain('MIIE');
    expect(r).toContain('acme-prod');
    expect(r).toContain('[private key]');
  });

  it('never stores secrets from a request', () => {
    const r = JSON.stringify(
      redact({
        name: 'OpenAI',
        credentials: { api_key: 'sk-proj-abcdefghijklmnop' },
        password: 'hunter2hunter2',
        current: 'old-password-1',
        client_secret: 'shh',
        match: { keys: ['key_01ABC'] },
        base_url: 'https://svc:pa55w0rd@llm.internal/v1',
        note: 'rotated sk-live-abcdefghijklmnop today',
        channels: [{ webhook: 'https://hooks.slack.com/services/T/B/x' }],
      }),
    );
    for (const leak of ['sk-proj-abcdefghijklmnop', 'hunter2', 'old-password-1', 'shh', 'pa55w0rd', 'sk-live-abcdefghijklmnop', 'hooks.slack.com']) expect(r, leak).not.toContain(leak);
    expect(r).toContain('key_01ABC'); // ids are kept: they say what was changed
    expect(r).toContain('OpenAI');
  });

  it('names actions after the route', () => {
    expect(actionFor('POST', '/admin/api/keys')).toBe('keys.create');
    expect(actionFor('PATCH', '/admin/api/users/:id')).toBe('users.update');
    expect(actionFor('DELETE', '/admin/api/rules/:id')).toBe('rules.delete');
    expect(actionFor('POST', '/admin/api/approvals/:id/decide')).toBe('approvals.decide');
    expect(actionFor('PUT', '/admin/api/airspace/layout')).toBe('airspace.layout.update');
    expect(actionFor('POST', '/admin/api/grants/:id/revoke')).toBe('grants.revoke');
    expect(actionFor('POST', '/key/generate')).toBe('key.generate');
    expect(actionFor('POST', '/admin/api/me/password')).toBe('me.password.change');
  });
});
