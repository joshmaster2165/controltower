import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ulid } from 'ulid';
import type { AppContext } from '../context.js';
import type { Selectable } from 'kysely';
import type { AdminsTable } from '../db/schema.js';
import { hashPassword, randomToken } from '../crypto/secrets.js';
import { auditOrigin } from '../admin/auth.js';
import { SsoService, roleFor, type IdentityProvider } from './oidc.js';
import { seatsUsed } from './seats.js';
import { syncIdpTeams } from './orgs.js';

/**
 * SCIM 2.0 (RFC 7643/7644): an identity provider — Okta, Microsoft Entra ID, OneLogin, JumpCloud — adds,
 * changes, deactivates and removes the people who use the console, and pushes groups whose names map to roles
 * through the provider's role map. Each provider has its own bearer token; it sees and changes only what it
 * provisioned, plus people it claims by email (an admin added them before provisioning was set up).
 *
 * Deactivating someone signs them out and stops them signing in; their record stays for reactivation. Someone
 * in no group that maps to a role is kept, but deactivated, until a group gives them one.
 */

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

type Person = Selectable<AdminsTable>;
export const scimTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const newScimToken = () => `scim_${randomToken(32)}`;

class ScimError extends Error {
  constructor(readonly status: number, message: string, readonly scimType?: string) {
    super(message);
  }
}
const bool = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() === 'true' : !!v);

/** `attr eq "value"` (the filters IdPs send). Anything else is refused as unsupported. */
export function parseFilter(f: string | undefined): { attr: string; value: string } | undefined {
  if (!f) return undefined;
  const m = /^\s*([\w.:]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(f);
  if (!m) throw new ScimError(400, `Only "attribute eq \\"value\\"" filters are supported (got ${f.slice(0, 80)}).`, 'invalidFilter');
  return { attr: m[1]!.toLowerCase().replace(/^urn:ietf:params:scim:schemas:core:2\.0:(user|group):/, ''), value: m[2]!.replace(/\\(.)/g, '$1') };
}

export async function scimRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const sso = new SsoService(ctx.db.write, ctx.secrets);
  const w = ctx.db.write;

  await app.register(async (s) => {
    s.addContentTypeParser(['application/scim+json', 'application/json'], { parseAs: 'string', bodyLimit: 1024 * 1024 }, (_req, body, done) => {
      try {
        done(null, body ? JSON.parse(String(body)) : {});
      } catch {
        done(new ScimError(400, 'The body is not valid JSON.', 'invalidSyntax'), undefined);
      }
    });
    s.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
      const status = err instanceof ScimError ? err.status : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
      if (status >= 500) ctx.log.error({ err }, 'SCIM request failed');
      return reply
        .status(status)
        .type('application/scim+json')
        .send({ schemas: [ERROR], status: String(status), ...(err instanceof ScimError && err.scimType ? { scimType: err.scimType } : {}), detail: status >= 500 ? 'Control Tower could not process this request.' : err.message });
    });

    /** Which provider is calling: its bearer token. */
    const providerOf = async (req: FastifyRequest): Promise<IdentityProvider> => {
      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
      if (!m) throw new ScimError(401, 'Send the SCIM token as a bearer token.');
      const slow = await ctx.limiter.admit(`scim:ip:${req.ip}`, 1, { rpm: 600 });
      if (!slow.ok) throw new ScimError(429, 'Too many requests.');
      const hash = Buffer.from(scimTokenHash(m[1]!));
      const rows = await ctx.db.read.selectFrom('identity_providers').select(['id', 'scim_token_hash']).where('scim_token_hash', 'is not', null).execute();
      const row = rows.find((r) => r.scim_token_hash && timingSafeEqual(Buffer.from(r.scim_token_hash), hash));
      if (!row) throw new ScimError(401, 'The SCIM token is not valid.');
      if (!ctx.license.allows('scim')) throw new ScimError(403, 'SCIM provisioning is part of Control Tower Enterprise, and this server has no license for it.');
      const p = await sso.get(row.id);
      if (!p?.enabled) throw new ScimError(403, 'This identity provider is turned off in Control Tower.');
      return p;
    };
    const base = (req: FastifyRequest) => (ctx.config.publicUrl ?? `${req.protocol}://${req.host}`).replace(/\/+$/, '') + '/scim/v2';
    const audit = (req: FastifyRequest, p: IdentityProvider, action: string, target: { type: string; id?: string }, detail: Record<string, unknown>, status = 200) =>
      ctx.audit?.record({ action, outcome: 'success', actor: { type: 'scim', id: p.id, email: `scim:${p.name}` }, status, target, detail: { provider: p.name, ...detail }, ...auditOrigin(req) });

    // ----- people -----
    const groupsOf = async (pid: string, adminId: string) =>
      ctx.db.read.selectFrom('scim_group_members').innerJoin('scim_groups', 'scim_groups.id', 'scim_group_members.group_id').select(['scim_groups.id', 'scim_groups.display_name']).where('scim_group_members.admin_id', '=', adminId).where('scim_groups.provider_id', '=', pid).execute();
    const userOut = async (req: FastifyRequest, p: IdentityProvider, u: Person) => ({
      schemas: [USER],
      id: u.id,
      ...(u.scim_external_id ? { externalId: u.scim_external_id } : {}),
      userName: u.email,
      ...(u.display_name ? { displayName: u.display_name, name: { formatted: u.display_name } } : {}),
      emails: [{ value: u.email, type: 'work', primary: true }],
      // Active in the IdP's sense (not deactivated there); someone in no role-giving group is still active.
      active: u.disabled !== 1,
      groups: (await groupsOf(p.id, u.id)).map((g) => ({ value: g.id, display: g.display_name })),
      meta: { resourceType: 'User', created: new Date(u.created_at).toISOString(), location: `${base(req)}/Users/${u.id}` },
    });
    const mine = (p: IdentityProvider, u: Person | undefined) => !!u && u.scim_provider_id === p.id;
    const getUser = async (p: IdentityProvider, id: string) => {
      const u = await w.selectFrom('admins').selectAll().where('id', '=', id).executeTakeFirst();
      if (!u || (u.scim_provider_id && u.scim_provider_id !== p.id)) throw new ScimError(404, 'No such user.');
      return u;
    };
    /** The role groups give, or none (then the person is kept but can't sign in). */
    const roleOf = async (p: IdentityProvider, adminId: string) => roleFor(p, (await groupsOf(p.id, adminId)).map((g) => g.display_name));
    /** Apply the role their groups give now; sign them out if it changed. */
    const syncRole = async (req: FastifyRequest, p: IdentityProvider, adminId: string) => {
      const u = await w.selectFrom('admins').selectAll().where('id', '=', adminId).executeTakeFirst();
      if (!u || u.scim_provider_id !== p.id) return;
      // Their teams follow their groups too.
      if (ctx.orgs) await syncIdpTeams(w, ctx.orgs, adminId, (await groupsOf(p.id, adminId)).map((g) => g.display_name));
      const role = await roleOf(p, adminId);
      const patch: { role?: string; disabled?: number } = {};
      if (role && role !== u.role) patch.role = role;
      // No role from any group: kept but can't sign in (2) until one gives them a role. A deactivation by the IdP (1) stays.
      if (!role && u.disabled === 0) patch.disabled = 2;
      if (role && u.disabled === 2) patch.disabled = 0;
      if (!Object.keys(patch).length) return;
      await w.updateTable('admins').set(patch).where('id', '=', adminId).execute();
      await w.deleteFrom('sessions').where('admin_id', '=', adminId).execute();
      await audit(req, p, 'users.update', { type: 'users', id: adminId }, { reason: 'group membership changed', ...(patch.role ? { from: u.role, to: patch.role } : {}), ...(patch.disabled === 2 ? { access: 'none: in no group that gives a role' } : patch.disabled === 0 ? { access: 'restored by a group' } : {}) });
    };
    const needSeat = async (u: Person | undefined) => {
      const counted = !!u && (!!u.sso_subject || !!u.scim_provider_id) && u.disabled === 0;
      if (!counted && (await seatsUsed(w)) >= ctx.license.seats) throw new ScimError(403, `Control Tower's license covers ${ctx.license.seats} ${ctx.license.seats === 1 ? 'person' : 'people'}; add seats to provision more.`, 'seats');
    };

    /** Fields of a user resource (POST, PUT, or a PATCH without a path). */
    const fields = (b: Record<string, unknown>) => {
      const emails = Array.isArray(b.emails) ? (b.emails as Array<{ value?: string; primary?: boolean }>) : [];
      const email = String(b.userName ?? emails.find((e) => e.primary)?.value ?? emails[0]?.value ?? '').trim().toLowerCase();
      const name = b.name as { formatted?: string; givenName?: string; familyName?: string } | undefined;
      const display = String(b.displayName ?? name?.formatted ?? [name?.givenName, name?.familyName].filter(Boolean).join(' ')).trim();
      return { email, display: display || undefined, externalId: typeof b.externalId === 'string' ? b.externalId : undefined, active: b.active === undefined ? undefined : bool(b.active) };
    };

    s.get('/scim/v2/Users', async (req, reply) => {
      const p = await providerOf(req);
      const q = req.query as Record<string, string | undefined>;
      const f = parseFilter(q.filter);
      let sel = w.selectFrom('admins').selectAll();
      if (f) {
        if (f.attr === 'username' || f.attr === 'emails.value' || f.attr === 'emails') sel = sel.where('email', '=', f.value.toLowerCase());
        else if (f.attr === 'externalid') sel = sel.where('scim_external_id', '=', f.value).where('scim_provider_id', '=', p.id);
        else if (f.attr === 'id') sel = sel.where('id', '=', f.value);
        else throw new ScimError(400, `Filtering on ${f.attr} is not supported.`, 'invalidFilter');
        // A filter may find someone an admin added (so the IdP can take them over), never another provider's.
        sel = sel.where((eb) => eb.or([eb('scim_provider_id', 'is', null), eb('scim_provider_id', '=', p.id)]));
      } else sel = sel.where('scim_provider_id', '=', p.id);
      const all = await sel.orderBy('created_at').execute();
      const start = Math.max(1, Number(q.startIndex) || 1);
      const count = Math.min(Math.max(0, Number(q.count ?? 100) || 0), 500);
      const page = all.slice(start - 1, start - 1 + count);
      return reply.type('application/scim+json').send({ schemas: [LIST], totalResults: all.length, startIndex: start, itemsPerPage: page.length, Resources: await Promise.all(page.map((u) => userOut(req, p, u))) });
    });

    s.get('/scim/v2/Users/:id', async (req, reply) => {
      const p = await providerOf(req);
      return reply.type('application/scim+json').send(await userOut(req, p, await getUser(p, (req.params as { id: string }).id)));
    });

    s.post('/scim/v2/Users', async (req, reply) => {
      const p = await providerOf(req);
      const f = fields((req.body ?? {}) as Record<string, unknown>);
      if (!/^[^@\s]+@[^@\s]+$/.test(f.email)) throw new ScimError(400, 'userName (or a primary email) must be an email address.', 'invalidValue');
      if (p.allowedDomains.length && !p.allowedDomains.includes(f.email.split('@')[1]!)) throw new ScimError(400, `${f.email.split('@')[1]} is not one of this provider's allowed email domains.`, 'invalidValue');
      const existing = await w.selectFrom('admins').selectAll().where('email', '=', f.email).executeTakeFirst();
      if (existing && existing.scim_provider_id) throw new ScimError(409, `${f.email} is already provisioned.`, 'uniqueness');
      await needSeat(existing);
      let id: string;
      if (existing) {
        // Someone an admin added before provisioning: the IdP takes them over.
        id = existing.id;
        await w.updateTable('admins').set({ scim_provider_id: p.id, scim_external_id: f.externalId ?? null, ...(f.display ? { display_name: f.display } : {}), ...(f.active === false ? { disabled: 1 } : {}) }).where('id', '=', id).execute();
        await w.deleteFrom('sessions').where('admin_id', '=', id).execute();
      } else {
        id = ulid();
        const role = p.defaultRole === 'none' ? 'viewer' : p.defaultRole;
        await w.insertInto('admins').values({ id, email: f.email, password_hash: await hashPassword(randomToken(32)), created_at: Date.now(), role, must_change_password: 0, display_name: f.display ?? null, scim_provider_id: p.id, scim_external_id: f.externalId ?? null, disabled: f.active === false ? 1 : p.defaultRole === 'none' ? 2 : 0 }).execute();
      }
      await audit(req, p, 'users.create', { type: 'users', id }, { email: f.email, ...(existing ? { took_over: 'an account an admin had added' } : {}) }, 201);
      const u = await getUser(p, id);
      return reply.status(201).type('application/scim+json').header('location', `${base(req)}/Users/${id}`).send(await userOut(req, p, u));
    });

    const applyUser = async (req: FastifyRequest, p: IdentityProvider, u: Person, f: ReturnType<typeof fields>) => {
      const patch: { scim_provider_id: string; email?: string; display_name?: string | null; scim_external_id?: string | null; disabled?: number } = { scim_provider_id: p.id };
      if (f.email && f.email !== u.email) {
        if (await w.selectFrom('admins').select('id').where('email', '=', f.email).where('id', '!=', u.id).executeTakeFirst()) throw new ScimError(409, `${f.email} is already someone else.`, 'uniqueness');
        patch.email = f.email;
      }
      if (f.display !== undefined) patch.display_name = f.display;
      if (f.externalId !== undefined) patch.scim_external_id = f.externalId;
      if (f.active !== undefined) {
        if (f.active && u.disabled === 1) {
          await needSeat(u);
          // Reactivated: back in only if a group (or the default role) gives them a role.
          patch.disabled = (await roleOf(p, u.id)) ? 0 : 2;
        }
        if (!f.active) patch.disabled = 1;
      }
      await w.updateTable('admins').set(patch).where('id', '=', u.id).execute();
      if (patch.disabled === 1 || patch.email) await w.deleteFrom('sessions').where('admin_id', '=', u.id).execute();
      await audit(req, p, 'users.update', { type: 'users', id: u.id }, { ...(patch.email ? { email: patch.email } : {}), ...(f.active !== undefined ? { active: f.active } : {}) });
    };

    s.put('/scim/v2/Users/:id', async (req, reply) => {
      const p = await providerOf(req);
      const u = await getUser(p, (req.params as { id: string }).id);
      if (!mine(p, u)) await needSeat(u);
      await applyUser(req, p, u, fields((req.body ?? {}) as Record<string, unknown>));
      return reply.type('application/scim+json').send(await userOut(req, p, await getUser(p, u.id)));
    });

    s.patch('/scim/v2/Users/:id', async (req, reply) => {
      const p = await providerOf(req);
      const u = await getUser(p, (req.params as { id: string }).id);
      if (!mine(p, u)) await needSeat(u);
      const ops = ((req.body ?? {}) as { Operations?: Array<{ op?: string; path?: string; value?: unknown }> }).Operations ?? [];
      const merged: Record<string, unknown> = {};
      for (const o of ops) {
        const op = String(o.op ?? '').toLowerCase();
        if (!['add', 'replace', 'remove'].includes(op)) throw new ScimError(400, `Unsupported op ${o.op}.`, 'invalidValue');
        const path = (o.path ?? '').toLowerCase();
        if (!path && o.value && typeof o.value === 'object') Object.assign(merged, o.value);
        else if (path === 'active') merged.active = op === 'remove' ? false : o.value;
        else if (path === 'username') merged.userName = o.value;
        else if (path === 'displayname') merged.displayName = o.value;
        else if (path === 'externalid') merged.externalId = o.value;
        else if (path === 'name.formatted') merged.name = { formatted: o.value };
        else if (path.startsWith('name.')) merged.name = { ...((merged.name as object) ?? {}), [path === 'name.givenname' ? 'givenName' : 'familyName']: o.value };
        else if (path.startsWith('emails')) merged.userName = typeof o.value === 'string' ? o.value : (o.value as Array<{ value?: string }>)?.[0]?.value;
        // Other attributes (title, phone numbers, …) aren't kept: accepted and ignored.
      }
      await applyUser(req, p, u, { ...fields({ ...merged, userName: merged.userName ?? undefined }), email: merged.userName ? String(merged.userName).toLowerCase() : '' });
      return reply.type('application/scim+json').send(await userOut(req, p, await getUser(p, u.id)));
    });

    s.delete('/scim/v2/Users/:id', async (req, reply) => {
      const p = await providerOf(req);
      const u = await getUser(p, (req.params as { id: string }).id);
      if (!mine(p, u)) throw new ScimError(404, 'No such user.');
      await w.deleteFrom('sessions').where('admin_id', '=', u.id).execute();
      await w.deleteFrom('scim_group_members').where('admin_id', '=', u.id).execute();
      await w.deleteFrom('admins').where('id', '=', u.id).execute();
      await w.deleteFrom('memberships').where('admin_id', '=', u.id).execute();
      await ctx.orgs?.reload();
      await audit(req, p, 'users.delete', { type: 'users', id: u.id }, { email: u.email }, 204);
      return reply.status(204).send();
    });

    // ----- groups -----
    const groupOut = async (req: FastifyRequest, g: { id: string; display_name: string; external_id: string | null; created_at: number }) => {
      const members = await ctx.db.read.selectFrom('scim_group_members').innerJoin('admins', 'admins.id', 'scim_group_members.admin_id').select(['admins.id', 'admins.email']).where('scim_group_members.group_id', '=', g.id).execute();
      return { schemas: [GROUP], id: g.id, displayName: g.display_name, ...(g.external_id ? { externalId: g.external_id } : {}), members: members.map((m) => ({ value: m.id, display: m.email })), meta: { resourceType: 'Group', created: new Date(g.created_at).toISOString(), location: `${base(req)}/Groups/${g.id}` } };
    };
    const getGroup = async (p: IdentityProvider, id: string) => {
      const g = await w.selectFrom('scim_groups').selectAll().where('id', '=', id).where('provider_id', '=', p.id).executeTakeFirst();
      if (!g) throw new ScimError(404, 'No such group.');
      return g;
    };
    /** Set a group's members (only people this provider provisioned), then re-derive everyone affected's role. */
    const setMembers = async (req: FastifyRequest, p: IdentityProvider, groupId: string, change: { add?: string[]; remove?: string[]; replace?: string[] }) => {
      const before = (await w.selectFrom('scim_group_members').select('admin_id').where('group_id', '=', groupId).execute()).map((r) => r.admin_id);
      let next = new Set(change.replace ?? before);
      for (const a of change.add ?? []) next.add(a);
      for (const r of change.remove ?? []) next.delete(r);
      const valid = next.size ? (await w.selectFrom('admins').select('id').where('id', 'in', [...next]).where('scim_provider_id', '=', p.id).execute()).map((r) => r.id) : [];
      next = new Set(valid);
      await w.deleteFrom('scim_group_members').where('group_id', '=', groupId).execute();
      if (next.size) await w.insertInto('scim_group_members').values([...next].map((admin_id) => ({ group_id: groupId, admin_id }))).execute();
      for (const id of new Set([...before, ...next])) await syncRole(req, p, id);
    };
    const memberIds = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map((m) => String((m as { value?: string }).value ?? m));

    s.get('/scim/v2/Groups', async (req, reply) => {
      const p = await providerOf(req);
      const q = req.query as Record<string, string | undefined>;
      const f = parseFilter(q.filter);
      let sel = w.selectFrom('scim_groups').selectAll().where('provider_id', '=', p.id);
      if (f) {
        if (f.attr === 'displayname') sel = sel.where('display_name', '=', f.value);
        else if (f.attr === 'externalid') sel = sel.where('external_id', '=', f.value);
        else if (f.attr === 'id') sel = sel.where('id', '=', f.value);
        else throw new ScimError(400, `Filtering on ${f.attr} is not supported.`, 'invalidFilter');
      }
      const all = await sel.orderBy('created_at').execute();
      const start = Math.max(1, Number(q.startIndex) || 1);
      const count = Math.min(Math.max(0, Number(q.count ?? 100) || 0), 500);
      const page = all.slice(start - 1, start - 1 + count);
      const excludeMembers = String(q.excludedAttributes ?? '').includes('members');
      const out = await Promise.all(page.map(async (g) => {
        const r = await groupOut(req, g);
        return excludeMembers ? { ...r, members: undefined } : r;
      }));
      return reply.type('application/scim+json').send({ schemas: [LIST], totalResults: all.length, startIndex: start, itemsPerPage: page.length, Resources: out });
    });

    s.get('/scim/v2/Groups/:id', async (req, reply) => {
      const p = await providerOf(req);
      return reply.type('application/scim+json').send(await groupOut(req, await getGroup(p, (req.params as { id: string }).id)));
    });

    s.post('/scim/v2/Groups', async (req, reply) => {
      const p = await providerOf(req);
      const b = (req.body ?? {}) as { displayName?: string; externalId?: string; members?: unknown };
      const name = String(b.displayName ?? '').trim();
      if (!name) throw new ScimError(400, 'displayName is required.', 'invalidValue');
      if (await w.selectFrom('scim_groups').select('id').where('provider_id', '=', p.id).where('display_name', '=', name).executeTakeFirst()) throw new ScimError(409, `A group named ${name} already exists.`, 'uniqueness');
      const id = ulid();
      const now = Date.now();
      await w.insertInto('scim_groups').values({ id, provider_id: p.id, display_name: name, external_id: b.externalId ?? null, created_at: now, updated_at: now }).execute();
      await setMembers(req, p, id, { replace: memberIds(b.members) });
      await audit(req, p, 'groups.create', { type: 'groups', id }, { name }, 201);
      return reply.status(201).type('application/scim+json').header('location', `${base(req)}/Groups/${id}`).send(await groupOut(req, await getGroup(p, id)));
    });

    s.put('/scim/v2/Groups/:id', async (req, reply) => {
      const p = await providerOf(req);
      const g = await getGroup(p, (req.params as { id: string }).id);
      const b = (req.body ?? {}) as { displayName?: string; members?: unknown };
      if (b.displayName && b.displayName !== g.display_name) await w.updateTable('scim_groups').set({ display_name: b.displayName, updated_at: Date.now() }).where('id', '=', g.id).execute();
      await setMembers(req, p, g.id, { replace: memberIds(b.members) });
      await audit(req, p, 'groups.update', { type: 'groups', id: g.id }, { name: b.displayName ?? g.display_name });
      return reply.type('application/scim+json').send(await groupOut(req, await getGroup(p, g.id)));
    });

    s.patch('/scim/v2/Groups/:id', async (req, reply) => {
      const p = await providerOf(req);
      const g = await getGroup(p, (req.params as { id: string }).id);
      const ops = ((req.body ?? {}) as { Operations?: Array<{ op?: string; path?: string; value?: unknown }> }).Operations ?? [];
      let renamed = false;
      for (const o of ops) {
        const op = String(o.op ?? '').toLowerCase();
        const path = o.path ?? '';
        const one = /^members\[value eq "([^"]+)"\]$/i.exec(path);
        if (one && op === 'remove') await setMembers(req, p, g.id, { remove: [one[1]!] });
        else if (/^members$/i.test(path) && op === 'add') await setMembers(req, p, g.id, { add: memberIds(o.value) });
        else if (/^members$/i.test(path) && op === 'remove') await setMembers(req, p, g.id, o.value ? { remove: memberIds(o.value) } : { replace: [] });
        else if (/^members$/i.test(path) && op === 'replace') await setMembers(req, p, g.id, { replace: memberIds(o.value) });
        else if ((/^displayname$/i.test(path) || !path) && op === 'replace') {
          const v = o.value as { displayName?: string; members?: unknown } | string;
          const name = typeof v === 'string' ? v : v?.displayName;
          if (name) {
            await w.updateTable('scim_groups').set({ display_name: name, updated_at: Date.now() }).where('id', '=', g.id).execute();
            renamed = true;
          }
          if (typeof v === 'object' && v?.members !== undefined) await setMembers(req, p, g.id, { replace: memberIds(v.members) });
        } else throw new ScimError(400, `Unsupported operation ${o.op} ${path}.`, 'invalidPath');
      }
      // A new name can map to a different role: re-derive for every member.
      if (renamed) for (const m of await w.selectFrom('scim_group_members').select('admin_id').where('group_id', '=', g.id).execute()) await syncRole(req, p, m.admin_id);
      await audit(req, p, 'groups.update', { type: 'groups', id: g.id }, { operations: ops.map((o) => `${o.op} ${o.path ?? ''}`.trim()) });
      return reply.type('application/scim+json').send(await groupOut(req, await getGroup(p, g.id)));
    });

    s.delete('/scim/v2/Groups/:id', async (req, reply) => {
      const p = await providerOf(req);
      const g = await getGroup(p, (req.params as { id: string }).id);
      const members = (await w.selectFrom('scim_group_members').select('admin_id').where('group_id', '=', g.id).execute()).map((r) => r.admin_id);
      await w.deleteFrom('scim_group_members').where('group_id', '=', g.id).execute();
      await w.deleteFrom('scim_groups').where('id', '=', g.id).execute();
      for (const id of members) await syncRole(req, p, id);
      await audit(req, p, 'groups.delete', { type: 'groups', id: g.id }, { name: g.display_name }, 204);
      return reply.status(204).send();
    });

    // ----- discovery -----
    s.get('/scim/v2/ServiceProviderConfig', async (_req, reply) =>
      reply.type('application/scim+json').send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
        documentationUri: 'https://github.com/joshmaster2165/controltower/blob/main/docs/scim.md',
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: 500 },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'The SCIM token from Control Tower', primary: true }],
      }),
    );
    s.get('/scim/v2/ResourceTypes', async (_req, reply) =>
      reply.type('application/scim+json').send({
        schemas: [LIST],
        totalResults: 2,
        Resources: [
          { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER },
          { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP },
        ],
      }),
    );
    s.get('/scim/v2/Schemas', async (_req, reply) => reply.type('application/scim+json').send({ schemas: [LIST], totalResults: 2, Resources: [{ id: USER, name: 'User' }, { id: GROUP, name: 'Group' }] }));
  });
}

/** Admin side: issue or revoke a provider's SCIM token. */
export async function scimTokenRoutes(app: FastifyInstance, ctx: AppContext, guard: Array<(req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>>): Promise<void> {
  app.post('/admin/api/identity-providers/:id/scim-token', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const token = newScimToken();
    const r = await ctx.db.write.updateTable('identity_providers').set({ scim_token_hash: scimTokenHash(token), scim_token_last4: token.slice(-4), updated_at: Date.now() }).where('id', '=', id).executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) return reply.status(404).send({ error: { code: 'not_found', message: 'identity provider not found' } });
    // Shown once: paste it into the identity provider's provisioning settings.
    return reply.status(201).send({ token, scim_url: `${(ctx.config.publicUrl ?? `${req.protocol}://${req.host}`).replace(/\/+$/, '')}/scim/v2` });
  });
  app.delete('/admin/api/identity-providers/:id/scim-token', { preHandler: guard }, async (req) => {
    await ctx.db.write.updateTable('identity_providers').set({ scim_token_hash: null, scim_token_last4: null, updated_at: Date.now() }).where('id', '=', (req.params as { id: string }).id).execute();
    return { ok: true };
  });
}
