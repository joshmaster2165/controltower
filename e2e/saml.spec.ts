import { test, expect } from '@playwright/test';
import { CT, admin } from './support/admin';
import { readAuthnRequest, samlResponse, testSamlIdp, type ResponseSpec, type TestSamlIdp } from './support/saml-idp';

/**
 * SAML single sign-on: the assertion must be signed by the IdP's certificate, addressed to this service
 * provider, current, and answer the request this sign-in started — once. Tampering, signature wrapping, a
 * different signer, the wrong audience or issuer, expiry, replay and IdP-initiated posts are all refused.
 */
test.describe.configure({ mode: 'serial' });

let idp: TestSamlIdp;
let pid = '';
let spEntityId = '';

/** Start a sign-in and post the IdP's answer. `spec` gets the request's id and ACS so it can answer (or not). */
async function samlSignIn(make: (r: { id: string; acs: string }) => Partial<ResponseSpec> & { raw?: string }, reuse?: { body: URLSearchParams }): Promise<{ cookie?: string; error?: string; body: URLSearchParams }> {
  let body: URLSearchParams;
  if (reuse) body = reuse.body;
  else {
    const start = await fetch(`${CT}/admin/sso/${pid}/start`, { redirect: 'manual' });
    const loc = start.headers.get('location') ?? '';
    expect(loc.startsWith(idp.ssoUrl)).toBe(true);
    const r = readAuthnRequest(loc);
    const spec = make({ id: r.id, acs: r.acs });
    body = new URLSearchParams({ SAMLResponse: spec.raw ?? samlResponse(idp, { acs: r.acs, audience: spEntityId, inResponseTo: r.id, nameID: 'saml-user-1', email: 'saml-user@example.com', groups: ['ct-approvers'], ...spec }), RelayState: r.relayState });
  }
  const back = await fetch(`${CT}/admin/sso/${pid}/acs`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const cookie = back.headers.getSetCookie().find((c) => c.startsWith('ct_session='))?.split(';')[0];
  const error = new URL(back.headers.get('location') ?? '/', CT).searchParams.get('sso_error') ?? undefined;
  return { ...(cookie ? { cookie } : {}), ...(error ? { error } : {}), body };
}
const me = async (cookie: string) => (await (await fetch(`${CT}/admin/api/me`, { headers: { cookie } })).json()) as any;

test.beforeAll(async () => {
  await admin.signIn();
  idp = testSamlIdp();
});
test.afterAll(async () => {
  for (const u of ((await admin.get('/admin/api/users')).body.users as any[]).filter((x) => x.email.startsWith('saml-'))) await admin.del(`/admin/api/users/${u.id}`);
  if (pid) await admin.del(`/admin/api/identity-providers/${pid}`);
});

test('an admin adds a SAML identity provider; Control Tower publishes its metadata', async () => {
  expect((await admin.post('/admin/api/identity-providers', { kind: 'saml', name: 'Bad', saml_entry_point: idp.ssoUrl, saml_idp_cert: 'not a certificate' })).status).toBe(400);
  const p = await admin.post('/admin/api/identity-providers', { kind: 'saml', name: 'Test SAML', saml_entry_point: idp.ssoUrl, saml_idp_cert: idp.cert, saml_idp_issuer: idp.entityId, allowed_domains: ['example.com'], groups_claim: 'groups', role_map: { admin: ['ct-admins'], approver: ['ct-approvers'] }, default_role: 'viewer' });
  expect(p.status).toBe(201);
  pid = p.body.id;
  spEntityId = p.body.provider.sp_entity_id;
  expect(p.body.provider).toMatchObject({ kind: 'saml', acs_url: `${CT}/admin/sso/${pid}/acs`, sp_entity_id: `${CT}/admin/sso/${pid}/metadata`, saml_idp_cert_set: true });
  expect((await admin.post(`/admin/api/identity-providers/${pid}/test`)).body).toMatchObject({ ok: true, message: expect.stringContaining('test-saml-idp') });
  const md = await (await fetch(`${CT}/admin/sso/${pid}/metadata`)).text();
  expect(md).toContain(`entityID="${spEntityId}"`);
  expect(md).toContain(`Location="${CT}/admin/sso/${pid}/acs"`);
});

test('a signed assertion signs someone in, with the role their groups give; it is recorded', async () => {
  const r = await samlSignIn(() => ({}));
  expect(r.error).toBeUndefined();
  expect(await me(r.cookie!)).toMatchObject({ email: 'saml-user@example.com', role: 'approver' });
  // Groups decide the role at every sign-in.
  const again = await samlSignIn(() => ({ groups: ['ct-admins'] }));
  expect((await me(again.cookie!)).role).toBe('admin');
  // A single group with a space in its name (one attribute value, which arrives as a string) is one group.
  await admin.patch(`/admin/api/identity-providers/${pid}`, { role_map: { admin: ['ct-admins'], approver: ['CT Approvers'] } });
  const spaced = await samlSignIn(() => ({ groups: ['CT Approvers'] }));
  expect((await me(spaced.cookie!)).role).toBe('approver');
  const events = (await admin.get('/admin/api/audit?limit=200')).body.events as any[];
  expect(events.some((e) => e.action === 'auth.sign_in' && e.detail?.method === 'saml' && e.outcome === 'success')).toBe(true);
});

test('refused: tampered, unsigned, signed by another key, signature-wrapped', async () => {
  const cases: Array<[string, Partial<ResponseSpec>]> = [
    ['tampered after signing', { after: (x) => x.replace('saml-user@example.com', 'ceo@example.com') }],
    ['unsigned', { sign: 'none' }],
    ['signed by another key', { sign: 'other-key' }],
    [
      'signature wrapping: an unsigned admin assertion beside the signed one',
      {
        after: (x) => {
          const evil = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_evil" Version="2.0" IssueInstant="${new Date().toISOString()}"><saml:Issuer>${idp.entityId}</saml:Issuer><saml:Subject><saml:NameID>attacker</saml:NameID></saml:Subject><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>attacker@example.com</saml:AttributeValue></saml:Attribute><saml:Attribute Name="groups"><saml:AttributeValue>ct-admins</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
          return x.replace('<samlp:Status>', `${evil}<samlp:Status>`);
        },
      },
    ],
  ];
  for (const [name, spec] of cases) {
    const r = await samlSignIn(() => spec);
    expect(r.cookie, name).toBeUndefined();
    expect(r.error, name).toBeTruthy();
  }
});

test('refused: wrong audience, wrong issuer, expired, answering another request, replayed, IdP-initiated', async () => {
  for (const [name, spec] of [
    ['for another service provider', { audience: 'https://someone-else.example/sp' }],
    ['from another issuer', { issuer: 'https://impostor.example/saml' }],
    ['expired', { validMinutes: -5 }],
    ['answering a different request', { inResponseTo: '_not-the-request' }],
  ] as Array<[string, Partial<ResponseSpec>]>) {
    const r = await samlSignIn(() => spec);
    expect(r.cookie, name).toBeUndefined();
  }
  const ok = await samlSignIn(() => ({}));
  expect(ok.cookie).toBeTruthy();
  const replay = await samlSignIn(() => ({}), { body: ok.body });
  expect(replay.cookie).toBeUndefined();
  expect(replay.error).toContain('already used');
  // An IdP-initiated post (no RelayState from a sign-in we started) is refused.
  const unsolicited = new URLSearchParams({ SAMLResponse: samlResponse(idp, { acs: `${CT}/admin/sso/${pid}/acs`, audience: spEntityId, inResponseTo: '', nameID: 'saml-user-1', email: 'saml-user@example.com' }) });
  const r = await fetch(`${CT}/admin/sso/${pid}/acs`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: unsolicited });
  expect(r.headers.getSetCookie().some((c) => c.startsWith('ct_session='))).toBe(false);
  expect(new URL(r.headers.get('location')!, CT).searchParams.get('sso_error')).toContain('Start signing in from Control Tower');
});
