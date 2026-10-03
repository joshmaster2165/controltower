import { test, expect } from '@playwright/test';
import { CT, admin } from './support/admin';
import { openAiUpstream, type Upstream } from './support/upstreams';

/**
 * Your own guardrails, built in Control Tower with no outside service: detectors, keywords, patterns, and a policy in
 * your own words judged by a model Control Tower serves. Tried on sample text, used by gates by name, changed in one
 * place.
 */
test.describe.configure({ mode: 'serial' });

let llm: Upstream;
let judge: Upstream;
const ids: { provider: string[]; key?: string; rules: string[]; guardrails: string[] } = { provider: [], rules: [], guardrails: [] };
let agentKey = '';
const run = Date.now().toString(36);

test.beforeAll(async () => {
  await admin.signIn();
  llm = await openAiUpstream({ models: ['og-model'] });
  // The policy judge: says a text breaks the rule when it gives revenue figures.
  judge = await openAiUpstream({
    models: ['og-judge'],
    reply: (b) => {
      const content = String(b.messages?.at(-1)?.content ?? '');
      return /revenue|\$\d/i.test(content) ? '{"violates": true, "reason": "it gives unannounced revenue figures"}' : '{"violates": false, "reason": "no figures"}';
    },
  });
  for (const [slug, u, model] of [[`og-llm-${run}`, llm, 'og-model'], [`og-judge-${run}`, judge, 'og-judge']] as const) {
    const p = await admin.post('/admin/api/providers', { catalog_id: 'custom', name: slug, slug, base_url: `${u.url}/v1` });
    ids.provider.push(p.body.provider.id);
    await admin.post('/admin/api/deployments', { provider_id: p.body.provider.id, upstream_model: model, public_name: model });
  }
  const k = await admin.post('/admin/api/keys', { name: `og-agent-${run}` });
  ids.key = k.body.id;
  agentKey = k.body.key;
});

test.afterAll(async () => {
  for (const r of ids.rules) await admin.del(`/admin/api/rules/${r}`);
  for (const g of ids.guardrails) await admin.del(`/admin/api/guardrails/${g}`);
  if (ids.key) await admin.del(`/admin/api/keys/${ids.key}`);
  for (const p of ids.provider) await admin.del(`/admin/api/providers/${p}`);
  await llm.close();
  await judge.close();
});

const chat = (content: string) =>
  fetch(`${CT}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${agentKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'og-model', messages: [{ role: 'user', content }] }) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

test('a guardrail is made from detectors, keywords and patterns, checked when saved, and tried on sample text', async () => {
  const checks = { detectors: ['email', 'aws_access_key'], keywords: ['Project Falcon'], patterns: [{ name: 'order', regex: 'ORD-\\d{6}' }] };
  const made = await admin.post('/admin/api/guardrails', { name: `Launch secrets ${run}`, description: 'Code names, order numbers, contacts', checks });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  ids.guardrails.push(made.body.guardrail.id);
  expect((await admin.post('/admin/api/guardrails', { name: `Launch secrets ${run}`, checks })).status).toBe(409);
  expect((await admin.post('/admin/api/guardrails', { name: 'empty', checks: {} })).body.error.message).toContain('something to look for');
  expect((await admin.post('/admin/api/guardrails', { name: 'broken', checks: { patterns: [{ name: 'x', regex: 'ORD-(' }] } })).status).toBe(400);
  // A pattern that can run away on some text is refused before it reaches the gateway.
  const slow = await admin.post('/admin/api/guardrails', { name: 'slow', checks: { patterns: [{ name: 'runaway', regex: '(a+)+$' }] } });
  expect(slow.status).toBe(400);
  expect(slow.body.error.message).toContain('too long');

  const tried = await admin.post('/admin/api/guardrails/test', { id: made.body.guardrail.id, text: 'Project Falcon ships with ORD-123456; ask jane@acme.test, not project falconry.' });
  expect(tried.status, JSON.stringify(tried.body)).toBe(200);
  expect(tried.body.found.map((f: any) => f.id).sort()).toEqual(['custom:launch-secrets-' + run + '_order', 'email', 'keyword'].sort());
  expect(tried.body.masked).toBe('[REDACTED] ships with [REDACTED:LAUNCH-SECRETS-' + run.toUpperCase() + '_ORDER]; ask [EMAIL], not project falconry.');
  // Unsaved checks can be tried too.
  const draft = await admin.post('/admin/api/guardrails/test', { checks: { keywords: ['Osprey'] }, text: 'Osprey is next.' });
  expect(draft.body.masked).toBe('[REDACTED] is next.');
});

test('a policy in your own words is judged by a model Control Tower serves', async () => {
  const made = await admin.post('/admin/api/guardrails', { name: `Board figures ${run}`, checks: { policy: { model: 'og-judge', instructions: 'Revenue or pipeline figures for quarters not yet announced.' } } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  ids.guardrails.push(made.body.guardrail.id);
  const bad = await admin.post('/admin/api/guardrails/test', { id: made.body.guardrail.id, text: 'Q3 revenue came in at $4.2M.' });
  expect(bad.body).toMatchObject({ withheld: true, found: [{ id: `policy:board-figures-${run}` }] });
  expect(bad.body.reasons.join(' ')).toContain('unannounced revenue figures');
  const fine = await admin.post('/admin/api/guardrails/test', { id: made.body.guardrail.id, text: 'The offsite is on Tuesday.' });
  expect(fine.body).toMatchObject({ withheld: false, found: [] });
  expect((await admin.post('/admin/api/guardrails', { name: 'no model', checks: { policy: { model: '', instructions: 'Nothing about revenue please.' } } })).status).toBe(400);
});

test('gates use guardrails by name: block, mask, judge; a change to a guardrail changes every gate using it', async () => {
  const all = (await admin.get('/admin/api/guardrails')).body.guardrails as any[];
  const launch = all.find((g) => g.name === `Launch secrets ${run}`)!;
  const board = all.find((g) => g.name === `Board figures ${run}`)!;
  expect((await admin.post('/admin/api/rules', { name: 'x', target_kind: 'model', effect: 'inspect', config: { guardrails: ['gr_nope'], action: 'block' } })).body.error.message).toContain('unknown guardrail');

  const block = await admin.post('/admin/api/rules', { name: `Launch secrets stay in ${run}`, target_kind: 'model', match: { keys: [ids.key] }, effect: 'inspect', config: { guardrails: [launch.id, board.id], action: 'block', direction: 'input' }, priority: 5 });
  expect(block.status, JSON.stringify(block.body)).toBe(201);
  ids.rules.push(block.body.id);
  expect((await admin.get('/admin/api/guardrails')).body.guardrails.find((g: any) => g.id === launch.id).used_by).toEqual([{ id: block.body.id, name: `Launch secrets stay in ${run}` }]);

  expect((await chat('What is the weather?')).status).toBe(200);
  const code = await chat('Draft the Project Falcon announcement');
  expect(code.status).toBe(400);
  expect(code.body.error.message).toContain('blocked keyword');
  const figures = await chat('Our Q3 revenue was $4.2M, put it in the deck');
  expect(figures.status).toBe(400);
  expect(figures.body.error.message).toContain(`board-figures-${run}`);

  // One change to the guardrail, and the gate follows.
  expect((await chat('Osprey kickoff notes')).status).toBe(200);
  expect((await admin.patch(`/admin/api/guardrails/${launch.id}`, { checks: { ...launch.checks, keywords: ['Project Falcon', 'Osprey'] } })).status).toBe(200);
  expect((await chat('Osprey kickoff notes')).status).toBe(400);

  // A masking gate: the model gets the text with what was found taken out.
  await admin.del(`/admin/api/rules/${block.body.id}`);
  ids.rules = ids.rules.filter((r) => r !== block.body.id);
  const mask = await admin.post('/admin/api/rules', { name: `Mask launch secrets ${run}`, target_kind: 'model', match: { keys: [ids.key] }, effect: 'inspect', config: { guardrails: [launch.id], action: 'mask', direction: 'input' }, priority: 5 });
  ids.rules.push(mask.body.id);
  expect((await chat('Email jane@acme.test about ORD-654321')).status).toBe(200);
  const sent = JSON.parse(llm.calls.at(-1)!.body).messages.at(-1).content as string;
  expect(sent).toBe(`Email [EMAIL] about [REDACTED:LAUNCH-SECRETS-${run.toUpperCase()}_ORDER]`);

  // A guardrail a gate uses can't be removed from under it.
  expect((await admin.del(`/admin/api/guardrails/${launch.id}`)).status).toBe(409);
});
