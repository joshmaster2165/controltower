import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ulid } from 'ulid';
import type { AppContext } from '../../context.js';
import { hashPassword, randomToken } from '../../crypto/secrets.js';
import { SsoService, issuerProblem, type IdentityProvider, type SsoResult, type SsoRole } from '../oidc.js';
import { seatsUsed } from '../seats.js';
import { samlFinish, samlMetadata, samlStart } from '../saml.js';
import { X509Certificate } from 'node:crypto';
import { scimTokenRoutes } from '../scim.js';
import { asRole, auditOrigin, createSession, requireAdmin, setCookie, ssoOnly } from '../../admin/auth.js';
import { requireEnterprise } from './license.js';

const STATE_COOKIE = 'ct_sso';
const STATE_TTL_MS = 10 * 60_000;
const ROLES: SsoRole[] = ['admin', 'approver', 'viewer'];

/** The address the IdP sends people back to. CT_PUBLIC_URL when set, else the address this request came in on. */
function baseUrl(ctx: AppContext, req: FastifyRequest): string {
  if (ctx.config.publicUrl) return ctx.config.publicUrl.replace(/\/+$/, '');
  return `${req.protocol}://${req.host}`;
}
const redirectUri = (base: string, id: string) => `${base}/admin/sso/${id}/callback`;
/** SAML: where the IdP posts its response, and this service provider's entity ID (also its metadata URL). */
const acsUrl = (base: string, id: string) => `${base}/admin/sso/${id}/acs`;
const spEntityId = (base: string, id: string) => `${base}/admin/sso/${id}/metadata`;
const SAML_COOKIE = 'ct_saml';

function publicProvider(p: IdentityProvider, base: string, row?: { last_status: string | null; last_error: string | null }) {
  return {
    id: p.id,
    name: p.name,
    issuer: p.issuer,
    client_id: p.clientId,
    client_secret_set: !!p.clientSecret,
    scopes: p.scopes,
    allowed_domains: p.allowedDomains,
    groups_claim: p.groupsClaim ?? null,
    role_map: p.roleMap,
    default_role: p.defaultRole,
    create_users: p.createUsers,
    enabled: p.enabled,
    token_auth: p.tokenAuth,
    kind: p.kind,
    redirect_uri: redirectUri(base, p.id),
    saml_entry_point: p.samlEntryPoint ?? null,
    saml_idp_cert_set: !!p.samlIdpCert,
    saml_idp_issuer: p.samlIdpIssuer ?? null,
    email_attribute: p.emailAttribute ?? null,
    acs_url: acsUrl(base, p.id),
    sp_entity_id: spEntityId(base, p.id),
    metadata_url: spEntityId(base, p.id),
    scim_token_set: p.scimTokenSet,
    scim_url: `${base}/scim/v2`,
    last_status: row?.last_status ?? null,
    last_error: row?.last_error ?? null,
  };
}

/**
 * Single sign-on: people sign in through an OpenID Connect identity provider; the provider's groups decide their
 * role. Admins configure providers here; the sign-in itself is two browser redirects (start, callback).
 */
export async function ssoRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const sso = new SsoService(ctx.db.write, ctx.secrets);
  const guard = [requireAdmin(ctx), requireEnterprise(ctx, 'sso')];
  const licensed = () => ctx.license.allows('sso');
  const bad = (reply: FastifyReply, message: string) => reply.status(400).send({ error: { code: 'invalid', message } });
  const failTo = (reply: FastifyReply, message: string) => reply.redirect(`/?sso_error=${encodeURIComponent(message)}`, 303);
  const clearState = (reply: FastifyReply) => reply.clearCookie(STATE_COOKIE, { path: '/admin/sso' });

  type Deny = (reason: string, email?: string, shown?: string) => Promise<FastifyReply>;
  /**
   * After the IdP vouched for someone (OIDC or SAML): who they are here, whether a seat covers them, their role,
   * and a session. Someone who signed in this way before is found by their IdP identity; otherwise by email (an
   * admin or SCIM added them), or created.
   */
  const complete = async (p: IdentityProvider, result: Extract<SsoResult, { ok: true }>, origin: ReturnType<typeof auditOrigin>, deny: Deny, reply: FastifyReply, method: 'oidc' | 'saml'): Promise<FastifyReply> => {
    const w = ctx.db.write;
    const noGroup = 'You are in none of the groups allowed to sign in. Ask an admin to add you.';
    let person = await w.selectFrom('admins').selectAll().where('sso_provider_id', '=', p.id).where('sso_subject', '=', result.subject).executeTakeFirst();
    if (!person) {
      const pre = await w.selectFrom('admins').select('scim_provider_id').where('email', '=', result.email).executeTakeFirst();
      // Roles from the IdP's groups apply to people it didn't provision over SCIM (SCIM decides for those).
      if (!pre?.scim_provider_id && !result.role) return deny('in none of the groups allowed to sign in', result.email, noGroup);
      const byEmail = await w.selectFrom('admins').selectAll().where('email', '=', result.email).executeTakeFirst();
      if (byEmail && byEmail.sso_subject && (byEmail.sso_provider_id !== p.id || byEmail.sso_subject !== result.subject)) {
        return deny('email already linked to another single sign-on identity', result.email, 'This email signs in through another identity. Ask an admin.');
      }
      // Seats: people who come in through Enterprise identity. Someone already counted (provisioned by SCIM) isn't charged twice.
      if (!byEmail?.scim_provider_id && (await seatsUsed(w)) >= ctx.license.seats) {
        return deny(`over the license's ${ctx.license.seats} single sign-on seats`, result.email, `Control Tower's license covers ${ctx.license.seats} ${ctx.license.seats === 1 ? 'person' : 'people'} signing in with single sign-on, and all seats are taken. Ask an admin to add seats.`);
      }
      if (byEmail) {
        await w.updateTable('admins').set({ sso_provider_id: p.id, sso_subject: result.subject }).where('id', '=', byEmail.id).execute();
        person = { ...byEmail, sso_provider_id: p.id, sso_subject: result.subject };
      } else if (p.createUsers) {
        const newId = ulid();
        // No usable password: they sign in through the IdP (an admin can still give them a one-time password).
        await w.insertInto('admins').values({ id: newId, email: result.email, password_hash: await hashPassword(randomToken(32)), created_at: Date.now(), role: result.role ?? 'viewer', must_change_password: 0, sso_provider_id: p.id, sso_subject: result.subject }).execute();
        person = await w.selectFrom('admins').selectAll().where('id', '=', newId).executeTakeFirstOrThrow();
        await ctx.audit?.record({ action: 'users.create', outcome: 'success', actor: { type: 'system' }, status: 201, target: { type: 'users', id: newId }, detail: { reason: 'first single sign-on', provider: p.name, email: result.email, role: result.role }, ...origin });
      } else {
        return deny('not added to Control Tower (new people are not created from this provider)', result.email, 'You have not been added to Control Tower. Ask an admin to add you.');
      }
    }
    if ((person.disabled ?? 0) !== 0) return deny('account deactivated', result.email, 'This account has been deactivated. Ask an admin.');
    const scim = !!person.scim_provider_id;
    if (!scim && !result.role && p.groupsClaim) return deny('in none of the groups allowed to sign in', result.email, noGroup);
    // With groups mapped, the IdP decides the role at every sign-in: moving someone between groups changes it here.
    // (For people provisioned over SCIM, SCIM's groups decide instead.)
    let role = asRole(person.role);
    if (!scim && p.groupsClaim && result.role && role !== result.role) {
      await w.updateTable('admins').set({ role: result.role }).where('id', '=', person.id).execute();
      await w.deleteFrom('sessions').where('admin_id', '=', person.id).execute();
      await ctx.audit?.record({ action: 'users.update', outcome: 'success', actor: { type: 'system' }, status: 200, target: { type: 'users', id: person.id }, detail: { reason: 'groups changed at the identity provider', provider: p.name, from: role, to: result.role }, ...origin });
      role = result.role;
    }
    const s = await createSession(ctx, person.id, person.email, role);
    setCookie(ctx, reply, s);
    clearState(reply);
    await ctx.audit?.record({ action: 'auth.sign_in', outcome: 'success', actor: { type: 'person', id: person.id, email: person.email, role }, status: 200, detail: { method, provider: p.name, groups: result.groups.slice(0, 50) }, ...origin });
    return reply.redirect('/', 303);
  };

  // For the sign-in page: which providers to offer, and whether passwords still work. Nothing else.
  app.get('/admin/api/sso', async () => {
    const providers = licensed() ? (await sso.list()).filter((p) => p.enabled).map((p) => ({ id: p.id, name: p.name })) : [];
    return { providers, sso_only: await ssoOnly(ctx) };
  });

  app.get('/admin/sso/:id/start', async (req, reply) => {
    const slow = await ctx.limiter.admit(`sso:ip:${req.ip}`, 1, { rpm: ctx.config.loginRpm * 3 });
    if (!slow.ok) return failTo(reply, 'Too many sign-in attempts. Wait a minute and try again.');
    if (!licensed()) return failTo(reply, 'Single sign-on needs a Control Tower Enterprise license. Sign in with a password, or ask an admin.');
    const p = await sso.get((req.params as { id: string }).id);
    if (!p || !p.enabled) return failTo(reply, 'That sign-in option is not available.');
    const base = baseUrl(ctx, req);
    if (p.kind === 'saml') {
      const nonce = randomToken(16);
      let url: URL;
      try {
        const st = await samlStart(p, acsUrl(base, p.id), spEntityId(base, p.id), '');
        // RelayState carries the sealed sign-in (the IdP returns it unchanged): the request id the response must
        // answer, for this provider, until it expires. Requests aren't signed, so it can be set on the URL here.
        url = new URL(st.url);
        url.searchParams.set('RelayState', ctx.secrets.encrypt(JSON.stringify({ p: p.id, rid: st.requestId, inst: st.instant, n: nonce, e: Date.now() + STATE_TTL_MS }), 'saml-state'));
      } catch (err) {
        ctx.log.warn({ err: (err as Error).message, provider: p.name }, 'single sign-on: SAML sign-in could not start');
        return failTo(reply, `${p.name} is not set up correctly. Ask an admin to check its settings.`);
      }
      // Over https a cookie binds the sign-in to this browser too (SameSite=None: the IdP posts back cross-site).
      if (base.startsWith('https://')) reply.setCookie(SAML_COOKIE, nonce, { path: '/admin/sso', httpOnly: true, sameSite: 'none', secure: true, maxAge: STATE_TTL_MS / 1000 });
      return reply.redirect(url.href, 302);
    }
    const uri = redirectUri(base, p.id);
    let start;
    try {
      start = await sso.start(p, uri);
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message, provider: p.name }, 'single sign-on: the identity provider could not be reached');
      return failTo(reply, `${p.name} could not be reached. Try again, or ask an admin to check its settings.`);
    }
    // What the callback must match, sealed so the browser can carry it but not read or change it.
    const sealed = ctx.secrets.encrypt(JSON.stringify({ p: p.id, v: start.verifier, s: start.state, n: start.nonce, r: uri, e: Date.now() + STATE_TTL_MS }), 'sso-state');
    reply.setCookie(STATE_COOKIE, sealed, { path: '/admin/sso', httpOnly: true, sameSite: 'lax', secure: uri.startsWith('https://'), maxAge: STATE_TTL_MS / 1000 });
    return reply.redirect(start.url, 302);
  });

  app.get('/admin/sso/:id/callback', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as Record<string, string | undefined>;
    const origin = auditOrigin(req);
    const deny = async (reason: string, email?: string, shown = reason) => {
      await ctx.audit?.record({ action: 'auth.sign_in', outcome: 'denied', actor: { type: 'anonymous', email }, status: 403, detail: { method: 'oidc', provider: id, reason }, ...origin });
      clearState(reply);
      return failTo(reply, shown);
    };
    const slow = await ctx.limiter.admit(`sso:ip:${req.ip}`, 1, { rpm: ctx.config.loginRpm * 3 });
    if (!slow.ok) return failTo(reply, 'Too many sign-in attempts. Wait a minute and try again.');

    let st: { p: string; v: string; s: string; n: string; r: string; e: number };
    try {
      st = JSON.parse(ctx.secrets.decrypt(req.cookies?.[STATE_COOKIE] ?? '', 'sso-state'));
    } catch {
      return deny('no sign-in in progress (missing or altered state cookie)', undefined, 'This sign-in expired or was started elsewhere. Start again.');
    }
    if (st.p !== id || st.e < Date.now()) return deny('sign-in state expired or for another provider', undefined, 'This sign-in expired. Start again.');
    if (!licensed()) return deny('no Enterprise license', undefined, 'Single sign-on needs a Control Tower Enterprise license. Sign in with a password, or ask an admin.');
    if (q.error) return deny(`the identity provider refused: ${q.error}${q.error_description ? ` (${q.error_description})` : ''}`, undefined, `${q.error_description || q.error}`);
    const p = await sso.get(id);
    if (!p || !p.enabled) return deny('provider removed or turned off', undefined, 'That sign-in option is not available.');

    const callbackUrl = new URL(st.r);
    callbackUrl.search = new URL(req.url, 'http://x').search;
    let result;
    try {
      result = await sso.finish(p, callbackUrl, { verifier: st.v, state: st.s, nonce: st.n });
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message, provider: p.name }, 'single sign-on failed');
      return deny(`the sign-in could not be verified: ${(err as Error).message}`, undefined, 'The sign-in could not be verified. Start again.');
    }
    if (!result.ok) return deny(result.reason, result.email, result.reason);

    return complete(p, result, origin, deny, reply, 'oidc');
  });

  // SAML: the IdP posts its response here (a cross-site form POST, so only this route parses form bodies).
  await app.register(async (saml) => {
    saml.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
    saml.post('/admin/sso/:id/acs', async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const origin = auditOrigin(req);
      const deny: Deny = async (reason, email, shown = reason) => {
        await ctx.audit?.record({ action: 'auth.sign_in', outcome: 'denied', actor: { type: 'anonymous', email }, status: 403, detail: { method: 'saml', provider: id, reason }, ...origin });
        reply.clearCookie(SAML_COOKIE, { path: '/admin/sso' });
        return failTo(reply, shown);
      };
      const slow = await ctx.limiter.admit(`sso:ip:${req.ip}`, 1, { rpm: ctx.config.loginRpm * 3 });
      if (!slow.ok) return failTo(reply, 'Too many sign-in attempts. Wait a minute and try again.');
      const body = (req.body ?? {}) as Record<string, string>;
      if (!body.SAMLResponse) return deny('no SAMLResponse in the post', undefined, 'The identity provider sent nothing to sign in with.');
      let st: { p: string; rid: string; inst: string; n: string; e: number };
      try {
        st = JSON.parse(ctx.secrets.decrypt(body.RelayState ?? '', 'saml-state'));
      } catch {
        return deny('no sign-in in progress (missing or altered RelayState: IdP-initiated sign-in is not accepted)', undefined, 'Start signing in from Control Tower, not from the identity provider.');
      }
      if (st.p !== id || st.e < Date.now()) return deny('sign-in expired or for another provider', undefined, 'This sign-in expired. Start again.');
      const base = baseUrl(ctx, req);
      if (base.startsWith('https://') && req.cookies?.[SAML_COOKIE] !== st.n) return deny('sign-in started in another browser', undefined, 'This sign-in was started in another browser. Start again.');
      if (!licensed()) return deny('no Enterprise license', undefined, 'Single sign-on needs a Control Tower Enterprise license. Sign in with a password, or ask an admin.');
      const p = await sso.get(id);
      if (!p || !p.enabled || p.kind !== 'saml') return deny('provider removed or turned off', undefined, 'That sign-in option is not available.');
      let result;
      try {
        result = await samlFinish(p, acsUrl(base, p.id), spEntityId(base, p.id), { SAMLResponse: body.SAMLResponse, ...(body.RelayState ? { RelayState: body.RelayState } : {}) }, { id: st.rid, instant: st.inst });
      } catch (err) {
        ctx.log.warn({ err: (err as Error).message, provider: p.name }, 'SAML sign-in refused');
        return deny(`the SAML response could not be verified: ${(err as Error).message}`, undefined, 'The sign-in could not be verified. Start again.');
      }
      if (!result.ok) return deny(result.reason, result.email, result.reason);
      // Once only: the first post of a response wins; the same response again (a replay) is refused.
      const first = await ctx.db.write.insertInto('sso_used').values({ id: `saml:${st.rid}`, expires_at: st.e + 60_000 }).onConflict((oc) => oc.column('id').doNothing()).executeTakeFirst();
      if (Number(first.numInsertedOrUpdatedRows ?? 0) === 0) return deny('a SAML response for this request was already used (replay)', result.email, 'This sign-in was already used. Start again.');
      reply.clearCookie(SAML_COOKIE, { path: '/admin/sso' });
      return complete(p, result, origin, deny, reply, 'saml');
    });
  });

  // SAML: this service provider's metadata (entity ID, ACS URL), for the IdP's app settings.
  app.get('/admin/sso/:id/metadata', async (req, reply) => {
    const p = await sso.get((req.params as { id: string }).id);
    if (!p || p.kind !== 'saml') return reply.status(404).send({ error: { code: 'not_found', message: 'no SAML provider here' } });
    const base = baseUrl(ctx, req);
    return reply.type('application/samlmetadata+xml').send(samlMetadata(p, acsUrl(base, p.id), spEntityId(base, p.id)));
  });

  await scimTokenRoutes(app, ctx, [requireAdmin(ctx), requireEnterprise(ctx, 'scim')]);

  // Settings, for admins.
  interface Body {
    kind?: string;
    saml_entry_point?: string;
    saml_idp_cert?: string;
    saml_idp_issuer?: string | null;
    email_attribute?: string | null;
    name?: string;
    issuer?: string;
    client_id?: string;
    client_secret?: string | null;
    scopes?: string;
    allowed_domains?: string[];
    groups_claim?: string | null;
    role_map?: Partial<Record<SsoRole, string[]>>;
    default_role?: string;
    create_users?: boolean;
    enabled?: boolean;
    token_auth?: string;
  }
  const check = (b: Body, partial: boolean, kind: 'oidc' | 'saml'): string | undefined => {
    if (!partial || b.name !== undefined) if (!b.name?.trim() || b.name.length > 80) return 'Give it a name people will recognise on the sign-in page, such as "Okta".';
    if (kind === 'saml') {
      if (!partial || b.saml_entry_point !== undefined) {
        const problem = issuerProblem(b.saml_entry_point ?? '');
        if (problem) return problem.replace('issuer', 'SAML sign-in URL');
      }
      if (!partial || b.saml_idp_cert !== undefined) {
        try {
          new X509Certificate(pem(b.saml_idp_cert ?? ''));
        } catch {
          return 'Paste the identity provider\'s signing certificate (X.509, PEM or base64).';
        }
      }
    } else {
      if (!partial || b.issuer !== undefined) {
        const problem = issuerProblem(b.issuer ?? '');
        if (problem) return problem;
      }
      if (!partial || b.client_id !== undefined) if (!b.client_id?.trim()) return 'Enter the client ID from your identity provider.';
    }
    if (b.default_role !== undefined && ![...ROLES, 'none'].includes(b.default_role)) return 'default_role must be admin, approver, viewer or none.';
    if (b.token_auth !== undefined && !['client_secret_basic', 'client_secret_post', 'none'].includes(b.token_auth)) return 'token_auth must be client_secret_basic, client_secret_post or none.';
    if (b.role_map !== undefined) {
      if (typeof b.role_map !== 'object' || Object.keys(b.role_map).some((k) => !ROLES.includes(k as SsoRole) || !Array.isArray(b.role_map![k as SsoRole]))) return 'role_map maps admin, approver and viewer to lists of group names.';
    }
    if (b.allowed_domains !== undefined && (!Array.isArray(b.allowed_domains) || b.allowed_domains.some((d) => typeof d !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)))) return 'allowed_domains is a list of email domains, such as example.com.';
    return undefined;
  };
  /** A certificate as PEM, whether it was pasted as PEM or as the bare base64 IdPs often show. */
  const pem = (c: string) => {
    const t = c.trim();
    if (t.includes('BEGIN CERTIFICATE')) return t;
    return `-----BEGIN CERTIFICATE-----\n${t.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----`;
  };
  const columns = (b: Body, id: string): Record<string, unknown> => ({
    ...(b.saml_entry_point !== undefined ? { saml_entry_point: b.saml_entry_point.trim() } : {}),
    ...(b.saml_idp_cert !== undefined ? { saml_idp_cert: pem(b.saml_idp_cert) } : {}),
    ...(b.saml_idp_issuer !== undefined ? { saml_idp_issuer: b.saml_idp_issuer?.trim() || null } : {}),
    ...(b.email_attribute !== undefined ? { email_attribute: b.email_attribute?.trim() || null } : {}),
    ...(b.name !== undefined ? { name: b.name.trim() } : {}),
    ...(b.issuer !== undefined ? { issuer: b.issuer.trim().replace(/\/+$/, '') } : {}),
    ...(b.client_id !== undefined ? { client_id: b.client_id.trim() } : {}),
    ...(b.client_secret !== undefined ? { client_secret_enc: b.client_secret ? sso.encryptSecret(id, b.client_secret) : null } : {}),
    ...(b.scopes !== undefined ? { scopes: b.scopes.includes('openid') ? b.scopes : `openid ${b.scopes}` } : {}),
    ...(b.allowed_domains !== undefined ? { allowed_domains: JSON.stringify(b.allowed_domains.map((d) => d.toLowerCase())) } : {}),
    ...(b.groups_claim !== undefined ? { groups_claim: b.groups_claim?.trim() || null } : {}),
    ...(b.role_map !== undefined ? { role_map: JSON.stringify(b.role_map) } : {}),
    ...(b.default_role !== undefined ? { default_role: b.default_role } : {}),
    ...(b.create_users !== undefined ? { create_users: b.create_users ? 1 : 0 } : {}),
    ...(b.enabled !== undefined ? { enabled: b.enabled ? 1 : 0 } : {}),
    ...(b.token_auth !== undefined ? { token_auth: b.token_auth } : {}),
  });

  app.get('/admin/api/identity-providers', { preHandler: guard }, async (req) => {
    const base = baseUrl(ctx, req);
    const rows = await ctx.db.read.selectFrom('identity_providers').select(['id', 'last_status', 'last_error']).execute();
    const status = new Map(rows.map((r) => [r.id, r]));
    return {
      providers: (await sso.list()).map((p) => publicProvider(p, base, status.get(p.id))),
      sso_only: await ssoOnly(ctx),
      admin_key_set: !!ctx.config.adminKey,
      redirect_uri_pattern: redirectUri(base, '<id>'),
    };
  });

  app.post('/admin/api/identity-providers', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as Body;
    const kind = b.kind === 'saml' ? 'saml' : 'oidc';
    const problem = check(b, false, kind);
    if (problem) return bad(reply, problem);
    const id = ulid();
    const now = Date.now();
    await ctx.db.write
      .insertInto('identity_providers')
      .values({
        id,
        name: '',
        kind,
        // SAML has no OIDC issuer or client: the IdP's sign-in URL stands in (the columns are required).
        issuer: kind === 'saml' ? (b.saml_idp_issuer || b.saml_entry_point || '') : '',
        client_id: '',
        client_secret_enc: null,
        scopes: 'openid email profile',
        allowed_domains: '[]',
        groups_claim: null,
        role_map: '{}',
        default_role: 'none',
        create_users: 1,
        enabled: 1,
        token_auth: b.client_secret ? 'client_secret_basic' : 'none',
        last_status: null,
        last_error: null,
        created_at: now,
        updated_at: now,
        ...columns(b, id),
      } as never)
      .execute();
    const p = (await sso.get(id))!;
    return reply.status(201).send({ id, provider: publicProvider(p, baseUrl(ctx, req)) });
  });

  app.patch('/admin/api/identity-providers/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = await sso.get(id);
    if (!existing) return reply.status(404).send({ error: { code: 'not_found', message: 'identity provider not found' } });
    const b = (req.body ?? {}) as Body;
    const problem = check(b, true, existing.kind);
    if (problem) return bad(reply, problem);
    await ctx.db.write.updateTable('identity_providers').set({ ...columns(b, id), updated_at: Date.now() }).where('id', '=', id).execute();
    return { ok: true, provider: publicProvider((await sso.get(id))!, baseUrl(ctx, req)) };
  });

  app.delete('/admin/api/identity-providers/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const others = (await sso.list()).filter((p) => p.id !== id && p.enabled);
    if ((await ssoOnly(ctx)) && !others.length) return bad(reply, 'Single sign-on is required and this is the last provider: turn "Only single sign-on" off first.');
    await ctx.db.write.updateTable('admins').set({ sso_provider_id: null, sso_subject: null }).where('sso_provider_id', '=', id).execute();
    await ctx.db.write.deleteFrom('identity_providers').where('id', '=', id).execute();
    return { ok: true };
  });

  // Fetch the provider's discovery document: the issuer is right, and reachable from here.
  app.post('/admin/api/identity-providers/:id/test', { preHandler: guard }, async (req, reply) => {
    const p = await sso.get((req.params as { id: string }).id);
    if (!p) return reply.status(404).send({ error: { code: 'not_found', message: 'identity provider not found' } });
    let result: { ok: boolean; message: string; authorization_endpoint?: string | undefined };
    if (p.kind === 'saml') {
      try {
        const cert = new X509Certificate(p.samlIdpCert ?? '');
        const until = new Date(cert.validTo);
        result = until.getTime() < Date.now() ? { ok: false, message: `The signing certificate expired on ${until.toISOString().slice(0, 10)}.` } : { ok: true, message: `Signing certificate for ${cert.subject.replace(/\n/g, ', ')}, valid until ${until.toISOString().slice(0, 10)}.` };
      } catch {
        result = { ok: false, message: 'The signing certificate could not be read.' };
      }
      await ctx.db.write.updateTable('identity_providers').set({ last_status: result.ok ? 'ok' : 'error', last_error: result.ok ? null : result.message }).where('id', '=', p.id).execute();
      return result;
    }
    try {
      const meta = (await sso.config(p)).serverMetadata();
      result = { ok: true, message: `Found ${meta.issuer}.`, authorization_endpoint: meta.authorization_endpoint };
    } catch (err) {
      result = { ok: false, message: `Could not load ${p.issuer}/.well-known/openid-configuration: ${(err as Error).message}` };
    }
    await ctx.db.write.updateTable('identity_providers').set({ last_status: result.ok ? 'ok' : 'error', last_error: result.ok ? null : result.message.slice(0, 500) }).where('id', '=', p.id).execute();
    return result;
  });

  app.put('/admin/api/sso/settings', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { sso_only?: boolean };
    if (typeof b.sso_only !== 'boolean') return bad(reply, 'Send {"sso_only": true} or false.');
    if (b.sso_only) {
      if (!ctx.config.adminKey) return bad(reply, 'Set CT_ADMIN_KEY first: with passwords off, the admin key is the way back in if the identity provider breaks.');
      if (!(await sso.list()).some((p) => p.enabled)) return bad(reply, 'Add and turn on an identity provider first.');
      // Whoever turns passwords off has shown single sign-on works: they signed in with it (or use the admin key).
      if (req.admin && req.admin.adminId !== 'admin-key') {
        const me = await ctx.db.read.selectFrom('admins').select('sso_subject').where('id', '=', req.admin.adminId).executeTakeFirst();
        if (!me?.sso_subject) return bad(reply, 'Sign in with single sign-on yourself first, so you know it works before passwords are turned off.');
      }
    }
    const now = Date.now();
    await ctx.db.write.insertInto('settings').values({ key: 'sso_only', value: b.sso_only ? '1' : '0', updated_at: now }).onConflict((oc) => oc.column('key').doUpdateSet({ value: b.sso_only ? '1' : '0', updated_at: now })).execute();
    // Password sessions end when passwords are turned off (except the admin key's own sign-in).
    if (b.sso_only) {
      const envAdmin = await ctx.db.read.selectFrom('settings').select('value').where('key', '=', 'env_admin_email').executeTakeFirst();
      const keep = (await ctx.db.read.selectFrom('admins').select('id').where((eb) => eb.or([eb('sso_subject', 'is not', null), eb('email', '=', envAdmin?.value ?? '')])).execute()).map((r) => r.id);
      let del = ctx.db.write.deleteFrom('sessions');
      if (keep.length) del = del.where('admin_id', 'not in', keep);
      await del.execute();
    }
    return { ok: true, sso_only: b.sso_only };
  });
}
