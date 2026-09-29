import { test, expect } from '@playwright/test';
import { CT, admin } from './support/admin';
import { testIdp, type TestIdp } from './support/oidc-idp';

/**
 * SCIM 2.0 provisioning, the way Microsoft Entra ID and Okta drive it: look a person up by userName, create
 * them, put them in groups whose names map to roles, deactivate (Okta: replace without a path; Entra: a
 * string "False"), reactivate, remove. Each provider's token sees only its own people and groups.
 */
test.describe.configure({ mode: 'serial' });

let pid = '';
let other = '';
let token = '';
let otherToken = '';
let idp: TestIdp;

const scim = (method: string, p: string, body?: unknown, tok = token) =>
  fetch(`${CT}/scim/v2${p}`, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/scim+json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as any }));
const person = async (email: string) => ((await admin.get('/admin/api/users')).body.users as any[]).find((u) => u.email === email);

async function ssoSignIn(id: string): Promise<{ cookie?: string; error?: string }> {
  const start = await fetch(`${CT}/admin/sso/${id}/start`, { redirect: 'manual' });
  const state = start.headers.getSetCookie().find((c) => c.startsWith('ct_sso='))?.split(';')[0] ?? '';
  const atIdp = await fetch(start.headers.get('location')!, { redirect: 'manual' });
  const back = await fetch(atIdp.headers.get('location')!, { redirect: 'manual', headers: { cookie: state } });
  const cookie = back.headers.getSetCookie().find((c) => c.startsWith('ct_session='))?.split(';')[0];
  const error = new URL(back.headers.get('location') ?? '/', CT).searchParams.get('sso_error') ?? undefined;
  return { ...(cookie ? { cookie } : {}), ...(error ? { error } : {}) };
}

test.beforeAll(async () => {
  await admin.signIn();
  idp = await testIdp();
  const p = await admin.post('/admin/api/identity-providers', { name: 'Entra (SCIM test)', issuer: idp.url, client_id: idp.clientId, client_secret: idp.clientSecret, role_map: { admin: ['CT Admins'], approver: ['CT Approvers'] }, default_role: 'none' });
  pid = p.body.id;
  other = (await admin.post('/admin/api/identity-providers', { name: 'Other IdP', issuer: idp.url, client_id: 'x' })).body.id;
});
test.afterAll(async () => {
  for (const e of ['scim-dana@example.com', 'scim-lee@example.com', 'scim-added@example.com']) {
    const u = await person(e);
    if (u) await admin.del(`/admin/api/users/${u.id}`);
  }
  for (const id of [pid, other]) if (id) await admin.del(`/admin/api/identity-providers/${id}`);
  await idp.close();
});

test('an admin issues a SCIM token; only it gets in', async () => {
  const t = await admin.post(`/admin/api/identity-providers/${pid}/scim-token`);
  expect(t.status).toBe(201);
  expect(t.body).toMatchObject({ token: expect.stringMatching(/^scim_/), scim_url: `${CT}/scim/v2` });
  token = t.body.token;
  otherToken = (await admin.post(`/admin/api/identity-providers/${other}/scim-token`)).body.token;
  expect((await admin.get('/admin/api/identity-providers')).body.providers.find((p: any) => p.id === pid).scim_token_set).toBe(true);
  expect(JSON.stringify((await admin.get('/admin/api/identity-providers')).body)).not.toContain(token);

  expect((await scim('GET', '/Users', undefined, '')).status).toBe(401);
  const bad = await scim('GET', '/Users', undefined, 'scim_wrong');
  expect(bad).toMatchObject({ status: 401, body: { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '401' } });
  expect((await scim('GET', '/ServiceProviderConfig')).body.patch.supported).toBe(true);
});

test('Entra-style: look up, create, and a group that maps to a role grants access', async () => {
  expect((await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "scim-dana@example.com"')}`)).body).toMatchObject({ totalResults: 0, Resources: [] });
  const c = await scim('POST', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'scim-dana@example.com', externalId: 'entra-001', name: { givenName: 'Dana', familyName: 'Ruiz' }, emails: [{ value: 'scim-dana@example.com', primary: true }], active: true });
  expect(c.status).toBe(201);
  expect(c.body).toMatchObject({ userName: 'scim-dana@example.com', externalId: 'entra-001', displayName: 'Dana Ruiz', active: true });
  const dana = c.body.id;
  expect((await scim('POST', '/Users', { userName: 'scim-dana@example.com' })).status).toBe(409);
  // In no group that maps to a role (the default is "refused"): kept, but can't sign in.
  idp.user = { sub: 'entra-dana', email: 'scim-dana@example.com' };
  expect((await ssoSignIn(pid)).error).toContain('deactivated');

  const g = await scim('POST', '/Groups', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'CT Approvers', members: [{ value: dana }] });
  expect(g.status).toBe(201);
  expect((await person('scim-dana@example.com')).role).toBe('approver');
  const s = await ssoSignIn(pid);
  expect(s.cookie).toBeTruthy(); // linked by email to the provisioned person, no extra seat

  // Renaming the group to one that maps to admin makes them an admin (and ends their session).
  await scim('PATCH', `/Groups/${g.body.id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'displayName', value: 'CT Admins' }] });
  expect((await person('scim-dana@example.com')).role).toBe('admin');
  expect((await fetch(`${CT}/admin/api/me`, { headers: { cookie: s.cookie! } })).status).toBe(401);
  // Entra removes a member with a filtered path.
  await scim('PATCH', `/Groups/${g.body.id}`, { Operations: [{ op: 'Remove', path: `members[value eq "${dana}"]` }] });
  expect((await ssoSignIn(pid)).error).toContain('deactivated');
  await scim('PATCH', `/Groups/${g.body.id}`, { Operations: [{ op: 'Add', path: 'members', value: [{ value: dana }] }] });
  expect((await ssoSignIn(pid)).cookie).toBeTruthy();
});

test('deactivating: Okta\'s replace-without-path and Entra\'s string "False" both sign the person out; reactivating restores them', async () => {
  const dana = (await person('scim-dana@example.com')).id;
  idp.user = { sub: 'entra-dana', email: 'scim-dana@example.com' };
  const s = await ssoSignIn(pid);
  expect((await scim('PATCH', `/Users/${dana}`, { Operations: [{ op: 'replace', value: { active: false } }] })).body.active).toBe(false);
  expect((await fetch(`${CT}/admin/api/me`, { headers: { cookie: s.cookie! } })).status).toBe(401);
  expect((await ssoSignIn(pid)).error).toContain('deactivated');
  expect((await scim('PATCH', `/Users/${dana}`, { Operations: [{ op: 'Replace', path: 'active', value: 'True' }] })).body.active).toBe(true);
  expect((await ssoSignIn(pid)).cookie).toBeTruthy();
  expect((await scim('PATCH', `/Users/${dana}`, { Operations: [{ op: 'Replace', path: 'active', value: 'False' }] })).body.active).toBe(false);
  expect((await ssoSignIn(pid)).error).toContain('deactivated');
  // Staying deactivated even when a group change happens.
  const g = (await scim('GET', `/Groups?filter=${encodeURIComponent('displayName eq "CT Admins"')}`)).body.Resources[0];
  await scim('PATCH', `/Groups/${g.id}`, { Operations: [{ op: 'Add', path: 'members', value: [{ value: dana }] }] });
  expect((await ssoSignIn(pid)).error).toContain('deactivated');
});

test('someone an admin added is taken over by email; another provider sees none of it; removing deletes', async () => {
  await admin.post('/admin/api/users', { email: 'scim-added@example.com', role: 'viewer' });
  const found = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "scim-added@example.com"')}`);
  expect(found.body.totalResults).toBe(1);
  const took = await scim('POST', '/Users', { userName: 'scim-added@example.com', active: true });
  expect(took.status).toBe(201);
  expect(took.body.id).toBe(found.body.Resources[0].id);

  expect((await scim('GET', '/Users', undefined, otherToken)).body.totalResults).toBe(0);
  expect((await scim('GET', `/Users/${took.body.id}`, undefined, otherToken)).status).toBe(404);
  expect((await scim('POST', '/Users', { userName: 'scim-added@example.com' }, otherToken)).status).toBe(409);

  const list = await scim('GET', '/Users?startIndex=1&count=1');
  expect(list.body).toMatchObject({ totalResults: 2, itemsPerPage: 1, startIndex: 1 });
  expect((await scim('GET', `/Users?filter=${encodeURIComponent('title co "x"')}`)).body.scimType).toBe('invalidFilter');

  expect((await scim('DELETE', `/Users/${took.body.id}`)).status).toBe(204);
  expect(await person('scim-added@example.com')).toBeUndefined();

  const events = (await admin.get('/admin/api/audit?limit=300')).body.events as any[];
  expect(events.some((e) => e.actor.type === 'scim' && e.action === 'users.delete' && e.detail.email === 'scim-added@example.com')).toBe(true);
});

test('revoking the token shuts SCIM out', async () => {
  await admin.del(`/admin/api/identity-providers/${pid}/scim-token`);
  expect((await scim('GET', '/Users')).status).toBe(401);
});
