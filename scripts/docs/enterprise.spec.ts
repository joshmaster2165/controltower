import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { nav, shot, startServer } from './helpers';
import { TEST_LICENSE_PUBLIC_KEY, testLicense } from '../../e2e/support/license';
import { testIdp, type TestIdp } from '../../e2e/support/oidc-idp';
import { testSamlIdp } from '../../e2e/support/saml-idp';
import { signJwt, testSigner } from '../../e2e/support/jwt';

/**
 * Screenshots for the Enterprise and administration pages: License, People, single sign-on (OIDC and SAML),
 * SCIM provisioning, the audit log, guardrail services and exports. A real server with a license signed by the
 * test key (development builds trust it; the published image doesn't); the identity providers are local stand-ins.
 */
test.describe.configure({ mode: 'serial' });

const AK = 'docs-admin-key-0123456789abcdef';

test('enterprise: license, people, single sign-on, SCIM, audit log, guardrails, exports', async ({ page, browser }) => {
  const idp: TestIdp = await testIdp({ clientId: 'control-tower', clientSecret: 'okta-client-secret' });
  const saml = testSamlIdp();
  const ct = await startServer(4000, { CT_ADMIN_KEY: AK, CT_LICENSE_PUBLIC_KEY: TEST_LICENSE_PUBLIC_KEY, CT_MODEL_HEALTH_INTERVAL_S: '0' });
  const api = (method: string, p: string, body?: unknown) =>
    fetch(`${ct.url}${p}`, { method, headers: { authorization: `Bearer ${AK}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => (await r.json().catch(() => ({}))) as any);
  const signIn = async (p: Page, email: string, password: string) => {
    await p.goto(ct.url);
    await p.getByLabel('Email or username').fill(email);
    await p.getByLabel('Password').fill(password);
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(p.locator('.side-user')).toBeVisible();
  };
  try {
    // An admin of their own (not the admin key), with a real password.
    const dana = await api('POST', '/admin/api/users', { email: 'dana@acme.com', role: 'admin' });
    const login = await fetch(`${ct.url}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dana@acme.com', password: dana.password }) });
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const csrf = ((await login.json()) as any).csrf;
    await fetch(`${ct.url}/admin/api/me/password`, { method: 'POST', headers: { cookie, 'x-ct-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ current: dana.password, password: 'dana-password-123' }) });
    await signIn(page, 'dana@acme.com', 'dana-password-123');

    // Without a license: the Enterprise notice where a feature would be.
    await page.goto(`${ct.url}/#/audit`);
    await expect(page.getByText('is part of Control Tower Enterprise')).toBeVisible();
    await shot(page, 'enterprise-notice', { clip: page.locator('.page'), pad: 0 });

    // Adding the license.
    await page.goto(`${ct.url}/#/license`);
    await page.getByLabel('Add a license key').fill(testLicense({ customer: 'Acme Corp', email: 'it@acme.com', seats: 25, requests_per_year: 250_000_000 }));
    await shot(page, 'license-add', { el: page.getByRole('button', { name: 'Save' }) });
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Acme Corp')).toBeVisible();
    await shot(page, 'license');

    // People: adding someone, and their one-time password.
    await nav(page, 'People');
    await page.getByPlaceholder('dana@example.com').fill('sam@acme.com');
    await page.locator('select').first().selectOption('approver');
    await shot(page, 'people-add', { el: page.getByRole('button', { name: 'Add person' }) });
    await page.getByRole('button', { name: 'Add person' }).click();
    await expect(page.getByText('One-time password for')).toBeVisible();
    await shot(page, 'people-otp', { clip: page.locator('.notice-row'), pad: 8 });
    await page.getByRole('button', { name: 'Done' }).click();

    // Single sign-on: an OIDC provider (the form), then Okta and a SAML provider in place.
    await page.getByRole('button', { name: '+ Identity provider' }).click();
    const form = page.locator('form.card').last();
    await form.getByLabel('Name on the sign-in page').fill('Okta');
    await form.getByLabel('Issuer URL').fill('https://acme.okta.com');
    await form.getByLabel('Client ID').fill('0oa9x2kfl1ZqH7s8d5d7');
    await form.getByLabel('Client secret').fill('an-example-client-secret');
    await form.getByLabel('Email domains allowed').fill('acme.com');
    await form.getByLabel('Admin groups').fill('ct-admins');
    await form.getByLabel('Approver groups').fill('ct-approvers');
    await form.scrollIntoViewIfNeeded();
    await shot(page, 'sso-oidc-form', { clip: form, pad: 8 });
    await form.getByRole('button', { name: 'Cancel' }).click();

    const okta = await api('POST', '/admin/api/identity-providers', { name: 'Okta', issuer: idp.url, client_id: idp.clientId, client_secret: idp.clientSecret, allowed_domains: ['acme.com'], groups_claim: 'groups', role_map: { admin: ['ct-admins'], approver: ['ct-approvers'] }, default_role: 'viewer' });
    const entra = await api('POST', '/admin/api/identity-providers', { kind: 'saml', name: 'Microsoft Entra ID', saml_entry_point: 'https://login.microsoftonline.com/acme-tenant/saml2', saml_idp_cert: saml.cert, saml_idp_issuer: 'https://sts.windows.net/acme-tenant/', allowed_domains: ['acme.com'], groups_claim: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups', role_map: { admin: ['CT Admins'], approver: ['CT Approvers'] }, default_role: 'none' });
    await page.reload();
    const section = page.locator('section', { hasText: 'Single sign-on and provisioning' });
    await expect(section.getByText('Microsoft Entra ID', { exact: true }).first()).toBeVisible();

    // SCIM: turning on provisioning shows the URL and token once.
    await section.locator('.card', { hasText: 'Microsoft Entra ID' }).getByRole('button', { name: 'Turn on provisioning' }).click();
    await expect(section.getByText('The token is shown only now')).toBeVisible();
    await shot(page, 'scim-token', { clip: section.locator('.card', { hasText: 'Microsoft Entra ID' }), pad: 8 });
    const token = (await section.locator('code').filter({ hasText: /^scim_/ }).textContent())!.trim();
    await section.getByRole('button', { name: 'Done' }).click();
    // The list as it looks with a real Okta tenant (the local stand-in's address set back right after).
    await api('PATCH', `/admin/api/identity-providers/${okta.id}`, { issuer: 'https://acme.okta.com' });
    await page.reload();
    await expect(section.getByText('https://acme.okta.com')).toBeVisible();
    await shot(page, 'sso-providers', { clip: section, pad: 8 });
    await api('PATCH', `/admin/api/identity-providers/${okta.id}`, { issuer: idp.url });

    // The SAML provider's settings, with what to give the IdP.
    await section.locator('.card', { hasText: 'Microsoft Entra ID' }).getByRole('button', { name: 'Edit' }).click();
    const samlForm = section.locator('form.card');
    await expect(samlForm.getByText('ACS (reply) URL')).toBeVisible();
    await shot(page, 'saml-form', { clip: samlForm, pad: 8 });
    await samlForm.getByRole('button', { name: 'Cancel' }).click();

    // People the IdP provisions over SCIM, with roles from its groups; one deactivated.
    const scim = (method: string, p: string, body: unknown) => fetch(`${ct.url}/scim/v2${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
    const made: Record<string, string> = {};
    for (const [email, given, family] of [['priya@acme.com', 'Priya', 'Nair'], ['marco@acme.com', 'Marco', 'Rossi'], ['lee@acme.com', 'Lee', 'Park']]) {
      made[email!] = (await scim('POST', '/Users', { userName: email, name: { givenName: given, familyName: family }, active: true })).id;
    }
    await scim('POST', '/Groups', { displayName: 'CT Admins', members: [{ value: made['priya@acme.com'] }] });
    await scim('POST', '/Groups', { displayName: 'CT Approvers', members: [{ value: made['marco@acme.com'] }, { value: made['lee@acme.com'] }] });
    await scim('PATCH', `/Users/${made['lee@acme.com']}`, { Operations: [{ op: 'Replace', path: 'active', value: 'False' }] });
    await page.reload();
    await expect(page.getByText('priya@acme.com')).toBeVisible();
    await shot(page, 'people', { clip: page.locator('table.table').first(), pad: 8 });
    void entra;

    // The sign-in page offers single sign-on.
    const visitor = await browser.newPage();
    await visitor.goto(ct.url);
    await expect(visitor.getByRole('button', { name: 'Sign in with Okta' })).toBeVisible();
    await shot(visitor, 'sso-signin');
    // Someone signs in with Okta, so the audit log shows single sign-on too.
    idp.user = { sub: '00u1', email: 'jordan@acme.com', groups: ['ct-approvers'] };
    await visitor.getByRole('button', { name: 'Sign in with Okta' }).click();
    await expect(visitor.locator('.side-user')).toContainText('jordan@acme.com');
    idp.user = { sub: '00u9', email: 'eve@example.org', groups: [] };
    await visitor.context().clearCookies();
    await visitor.goto(ct.url);
    await visitor.getByRole('button', { name: 'Sign in with Okta' }).click();
    await expect(visitor.getByText('is not one of the email domains')).toBeVisible();
    await shot(visitor, 'sso-refused', { clip: visitor.locator('form.auth'), pad: 12 });
    await visitor.close();

    // Guardrail services and exports, for their pages.
    await api('POST', '/admin/api/guardrail-services', { name: 'Presidio (PII)', kind: 'presidio', config: { analyzer_url: 'http://presidio-analyzer:5002', language: 'en', score_threshold: 0.6 } });
    await api('POST', '/admin/api/guardrail-services', { name: 'Lakera Guard', kind: 'lakera', config: { api_key: 'lak_example_key_not_real', project_id: 'project-acme' } });
    await nav(page, 'Guardrails');
    await expect(page.getByText('Lakera Guard').first()).toBeVisible();
    await shot(page, 'guardrails');
    // Datadog gets calls and the audit log (its intake is a local stand-in, so the audit log shows as delivered).
    const intake = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => (res.writeHead(202, { 'content-type': 'application/json' }), res.end('{}')));
    });
    await new Promise<void>((r) => intake.listen(0, '127.0.0.1', () => r()));
    const dd = await api('POST', '/admin/api/exports', { name: 'Datadog', kind: 'datadog', config: { api_key: 'dd_example_key_not_real', site: 'datadoghq.com', service: 'controltower', endpoint: `http://127.0.0.1:${(intake.address() as AddressInfo).port}` }, send_audit: true, audit_from: 'start' });
    await api('POST', '/admin/api/exports', { name: 'OpenTelemetry collector', kind: 'otlp', config: { endpoint: 'http://otel-collector:4318', signal: 'traces' } });
    await api('POST', `/admin/api/exports/${dd.id}/flush`);
    await nav(page, 'Exports');
    await expect(page.getByText('OpenTelemetry collector').first()).toBeVisible();
    await expect(page.getByText('Audit log: up to date')).toBeVisible();
    await shot(page, 'exports');
    // Adding Splunk for the audit log only.
    await page.getByRole('button', { name: '+ Splunk' }).click();
    const exForm = page.locator('form.card');
    await exForm.getByLabel('Name').fill('Splunk (security)');
    await exForm.getByLabel('HTTP Event Collector URL').fill('https://splunk.acme.com:8088');
    await exForm.getByLabel('HEC token').fill('an-example-hec-token');
    await exForm.getByRole('checkbox', { name: /Calls/ }).uncheck();
    await exForm.getByRole('checkbox', { name: /The audit log/ }).check();
    await exForm.getByLabel('Index for the audit log (optional)').fill('security');
    await exForm.getByLabel('Start from').selectOption('start');
    await shot(page, 'exports-audit-form', { clip: exForm, pad: 8 });
    await exForm.getByRole('button', { name: 'Cancel' }).click();
    intake.close();

    // Agent identity: a Kubernetes cluster's and GitHub Actions' tokens, used as keys.
    const invoice = await api('POST', '/admin/api/keys', { name: 'invoice-bot', agent_id: 'invoice-bot', team: 'finance' });
    const release = await api('POST', '/admin/api/keys', { name: 'release-notes', agent_id: 'release-notes', team: 'platform' });
    const eks = testSigner('eks-1');
    const gh = testSigner('gh-1');
    const EKS = 'https://oidc.eks.us-east-1.amazonaws.com/id/B71EXAMPLE5D3A9C4F2E';
    const GH = 'https://token.actions.githubusercontent.com';
    await api('POST', '/admin/api/token-issuers', { name: 'EKS prod cluster', issuer: EKS, jwks: { keys: [eks.jwk] }, audiences: ['controltower'], max_lifetime_s: 3600, rules: [{ claims: { sub: 'system:serviceaccount:finance:invoice-bot' }, key_id: invoice.id }, { claims: { sub: 'system:serviceaccount:finance:*' }, key_id: release.id }] });
    await api('POST', '/admin/api/token-issuers', { name: 'GitHub Actions', issuer: GH, jwks: { keys: [gh.jwk] }, audiences: ['controltower'], rules: [{ claims: { repository: 'acme/website', ref: 'refs/heads/main' }, key_id: release.id }] });
    for (let i = 0; i < 3; i++) await fetch(`${ct.url}/v1/models`, { headers: { authorization: `Bearer ${signJwt(eks, { iss: EKS, aud: 'controltower', sub: 'system:serviceaccount:finance:invoice-bot', n: i })}` } });
    await fetch(`${ct.url}/v1/models`, { headers: { authorization: `Bearer ${signJwt(gh, { iss: GH, aud: 'controltower', sub: 'repo:acme/website:ref:refs/heads/main', repository: 'acme/website', ref: 'refs/heads/main' })}` } });
    await fetch(`${ct.url}/v1/models`, { headers: { authorization: `Bearer ${signJwt(gh, { iss: GH, aud: 'controltower', sub: 'repo:acme/website:ref:refs/heads/feature-x', repository: 'acme/website', ref: 'refs/heads/feature-x' })}` } });
    await api('PATCH', `/admin/api/keys/${invoice.id}`, { tokens_only: true });
    await page.goto(`${ct.url}/#/agent-identity`);
    await expect(page.getByText('EKS prod cluster')).toBeVisible();
    await expect(page.getByText('3 accepted')).toBeVisible();
    await shot(page, 'agent-identity');
    // "Try a token" with one for another service.
    await page.getByLabel('Token').fill(signJwt(eks, { iss: EKS, aud: 'https://graph.microsoft.com', sub: 'system:serviceaccount:finance:invoice-bot' }));
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByText('Refused: the token is not meant for Control Tower')).toBeVisible();
    await shot(page, 'agent-identity-check', { clip: page.locator('section.card', { hasText: 'Try a token' }), pad: 8 });
    await page.getByRole('button', { name: '+ Token issuer' }).click();
    await page.getByRole('button', { name: 'Kubernetes' }).click();
    const idForm = page.locator('form.card');
    await idForm.getByLabel('Name', { exact: true }).fill('EKS staging cluster');
    await idForm.getByLabel('Issuer (the tokens\' iss)').fill('https://oidc.eks.eu-west-1.amazonaws.com/id/C24EXAMPLE9B1E07D5A3');
    await idForm.getByLabel('Longest token lifetime (seconds)').fill('3600');
    await idForm.getByLabel('Matches').first().fill('system:serviceaccount:staging:invoice-bot');
    await idForm.getByLabel('Key', { exact: true }).first().selectOption({ label: 'invoice-bot' });
    await shot(page, 'agent-identity-form', { clip: idForm, pad: 8 });
    await idForm.getByRole('button', { name: 'Cancel' }).click();
    await nav(page, 'Keys');
    await expect(page.getByText('tokens only from EKS prod cluster')).toBeVisible();
    await shot(page, 'keys-tokens', { clip: page.locator('table.table').first(), pad: 8 });

    // Secret managers: a stand-in Vault holding the OpenAI key; a provider reads it by reference; a key rotates into it.
    const kv = new Map<string, Record<string, unknown>>([['ai/openai', { api_key: 'sk-proj-example-not-real' }]]);
    const vaultSrv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const json = (st: number, o: unknown) => (res.writeHead(st, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
        if (req.url === '/v1/auth/token/lookup-self') return json(200, { data: { display_name: 'token-controltower', policies: ['controltower'] } });
        const m = /^\/v1\/secret\/data\/(.+)$/.exec(req.url ?? '');
        if (!m) return json(404, { errors: [] });
        if (req.method === 'POST') return (kv.set(m[1]!, (JSON.parse(Buffer.concat(chunks).toString()) as { data: Record<string, unknown> }).data), json(200, {}));
        return kv.has(m[1]!) ? json(200, { data: { data: kv.get(m[1]!) } }) : json(404, { errors: [] });
      });
    });
    await new Promise<void>((r) => vaultSrv.listen(8200, '127.0.0.1', () => r()));
    await api('POST', '/admin/api/secret-managers', { name: 'vault', kind: 'vault', config: { address: 'http://127.0.0.1:8200', token: 'hvs.example-not-real' }, refresh_s: 300 });
    const oai = await api('POST', '/admin/api/providers', { catalog_id: 'openai', name: 'OpenAI', credentials: { api_key: 'secret://vault/ai/openai#api_key' } });
    void oai;
    await api('PUT', `/admin/api/keys/${invoice.id}/rotation`, { every_days: 30, overlap_s: 3600, deliver_to: 'secret://vault/agents/invoice-bot#api_key' });
    await api('POST', `/admin/api/keys/${invoice.id}/rotate`, {});
    await api('POST', '/admin/api/secret-managers/refresh');
    await page.goto(`${ct.url}/#/secret-managers`);
    await expect(page.getByText('provider OpenAI')).toBeVisible();
    await shot(page, 'secret-managers');
    await page.getByRole('button', { name: '+ HashiCorp Vault' }).click();
    const smForm = page.locator('form.card');
    await smForm.getByLabel('Name (references use it)').fill('vault-prod');
    await smForm.getByLabel('Address').fill('https://vault.acme.internal:8200');
    await smForm.getByLabel('KV v2 mount').fill('ai');
    await smForm.getByLabel('Sign in with').selectOption('kubernetes');
    await smForm.getByLabel('Vault role').fill('controltower');
    await shot(page, 'secret-managers-form', { clip: smForm, pad: 8 });
    await smForm.getByRole('button', { name: 'Cancel' }).click();
    await nav(page, 'Keys');
    await page.locator('tr', { hasText: 'invoice-bot' }).getByRole('button', { name: 'rotation…' }).click();
    await expect(page.locator('.rotation-panel')).toBeVisible();
    await shot(page, 'key-rotation', { clip: page.locator('table.table').first(), pad: 8 });
    vaultSrv.close();

    // The audit log, after all that, and its check.
    await page.goto(`${ct.url}/#/audit`);
    await page.getByRole('button', { name: '24 hours' }).click();
    await expect(page.locator('td.mono', { hasText: 'identity_providers.create' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('status')).toContainText('Intact');
    await shot(page, 'audit-log');
    await page.getByPlaceholder('Action, e.g. keys or auth.sign_in').fill('users.update');
    await expect(page.locator('td.mono', { hasText: 'identity_providers' })).toHaveCount(0);
    await page.locator('tr', { hasText: 'SCIM' }).filter({ hasText: 'users.update' }).last().click();
    await shot(page, 'audit-event', { clip: page.locator('table.table'), pad: 8 });
  } finally {
    await ct.stop();
    await idp.close();
  }
});
