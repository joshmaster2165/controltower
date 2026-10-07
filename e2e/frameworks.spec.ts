import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { CT, admin } from './support/admin';

/**
 * Compliance (Enterprise): the EU AI Act, NIST AI RMF and ISO/IEC 42001, each requirement's status from what Control
 * Tower records, and the evidence pack — whose download is in the audit log with its digest.
 */
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
let keyId = '';
let ruleId = '';

test.beforeAll(async () => {
  await admin.signIn();
  const k = await admin.post('/admin/api/keys', { name: `evidence-agent-${run}`, team: 'platform', allowed_models: ['*'] });
  keyId = k.body.id;
});

test.afterAll(async () => {
  if (ruleId) await admin.del(`/admin/api/rules/${ruleId}`);
  if (keyId) await admin.del(`/admin/api/keys/${keyId}`);
});

test('each framework\'s requirements, checked against this installation, and moving as the setup changes', async () => {
  for (const fw of ['eu-ai-act', 'nist-ai-rmf', 'iso-42001']) {
    const r = await admin.get(`/admin/api/compliance?framework=${fw}&days=90`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const reqs = r.body.report.requirements as any[];
    expect(reqs.length).toBeGreaterThan(8);
    // Every requirement has a status; the ones no gateway can show are the organisation's, not "met".
    for (const q of reqs) expect(['met', 'partial', 'gap', 'organizational']).toContain(q.status);
    expect(reqs.some((q) => q.status === 'organizational')).toBe(true);
    const total = Object.values(r.body.report.summary as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBe(reqs.length);
  }
  const eu = async () => (await admin.get('/admin/api/compliance?framework=eu-ai-act&days=90')).body;
  const before = await eu();
  const art12 = before.report.requirements.find((q: any) => q.ref === 'Art. 12');
  expect(art12.results.map((c: any) => c.id)).toEqual(['logging', 'audit_trail']);
  // An agent that may use any model and tool: least privilege says so, and what to do. (Its owner is whoever made it.)
  const lp = (before.checks as any[]).find((c) => c.id === 'least_privilege');
  expect(lp.status).not.toBe('met');
  expect(lp.next).toContain('Limit the models and tools');
  expect((before.checks as any[]).find((c) => c.id === 'ownership').facts.with_owner).toBeGreaterThan(0);
  // A gate that asks a person: human oversight is met.
  ruleId = (await admin.post('/admin/api/rules', { name: `Deploys need a person ${run}`, target_kind: 'tool', effect: 'require_approval', priority: 50 })).body.id;
  const after = await eu();
  expect((after.checks as any[]).find((c) => c.id === 'human_oversight').status).toBe('met');
  expect(after.report.requirements.find((q: any) => q.ref === 'Art. 14').results[0].status).toBe('met');
  // The audit chain verifies.
  expect((after.checks as any[]).find((c) => c.id === 'audit_trail')).toMatchObject({ status: 'met' });
  expect((await admin.get('/admin/api/compliance?framework=sox')).status).toBe(400);
});

test('the evidence pack: the register, the records, and its digest in the audit log', async () => {
  const res = await fetch(`${CT}/admin/api/compliance/evidence?framework=iso-42001&days=30`, { headers: { cookie: admin.cookie } });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-disposition')).toMatch(/controltower-iso-42001-evidence-\d{4}-\d{2}-\d{2}\.md/);
  const pack = await res.text();
  const sha = crypto.createHash('sha256').update(pack).digest('hex');
  expect(res.headers.get('x-ct-sha256')).toBe(sha);
  expect(pack).toContain('# ISO/IEC 42001: evidence from Control Tower');
  expect(pack).toContain('| **A.6.2.8** Event logs |');
  expect(pack).toContain(`evidence-agent-${run}`);
  expect(pack).toContain('not a certification or legal advice');
  // JSON too, for your GRC tool.
  const json = await (await fetch(`${CT}/admin/api/compliance/evidence?framework=nist-ai-rmf&format=json`, { headers: { cookie: admin.cookie } })).json();
  expect(json.report.framework.id).toBe('nist-ai-rmf');
  expect(json.evidence.agents.some((a: any) => a.name === `evidence-agent-${run}`)).toBe(true);
  // On record: who took it, and the digest.
  const ev = (await admin.get('/admin/api/audit?action=compliance.evidence_exported&limit=5')).body.events as any[];
  expect(ev.some((e) => e.detail?.sha256 === sha && e.detail?.framework === 'iso-42001' && e.actor.email === 'e2e@example.com')).toBe(true);
});

test('the console page: a framework, its register, and the evidence pack', async ({ page }) => {
  await page.context().addCookies(admin.cookie.split('; ').map((c) => ({ name: c.split('=')[0]!, value: c.split('=').slice(1).join('='), url: CT })));
  await page.goto(`${CT}/#/compliance`);
  await expect(page.getByRole('heading', { name: 'Compliance' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Art. 12' })).toBeVisible();
  await page.getByRole('radio', { name: 'NIST AI RMF' }).click();
  await expect(page.getByRole('cell', { name: 'GOVERN 1.6' })).toBeVisible();
  await page.getByRole('cell', { name: 'GOVERN 1.6' }).click();
  await expect(page.getByText('Inventory of AI assistants and agents')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Evidence pack' })).toHaveAttribute('href', /framework=nist-ai-rmf/);
});
