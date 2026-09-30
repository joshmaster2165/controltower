import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ulid } from 'ulid';
import type { AppContext } from '../../context.js';
import { requireAdmin } from '../../admin/auth.js';
import { managesTeam, scopeOf, seesTeam, type Scope } from '../../admin/scope.js';
import { hashPassword, randomToken } from '../../crypto/secrets.js';
import { requireEnterprise } from './license.js';
import type { Orgs, Team } from '../orgs.js';

/**
 * Organisations and teams, and who belongs to them. Admins manage all of it; an organisation's admins add
 * teams to it and manage its people; a team's admins manage its people. Enterprise.
 */
export async function orgRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const orgs = ctx.orgs;
  if (!orgs) return;
  const guard = [requireAdmin(ctx), requireEnterprise(ctx, 'orgs')];
  const bad = (reply: FastifyReply, message: string) => reply.status(400).send({ error: { code: 'invalid', message } });
  const forbidden = (reply: FastifyReply, message: string) => reply.status(403).send({ error: { code: 'forbidden', message } });
  const notFound = (reply: FastifyReply, what: string) => reply.status(404).send({ error: { code: 'not_found', message: `${what} not found` } });
  const isAdmin = (s: Scope) => s.manage === 'all';
  const adminsOrg = (s: Scope, orgId: string | undefined) => s.orgAdmin === 'all' || (!!orgId && s.orgAdmin.has(orgId));
  const cleanName = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 80) : '');
  const reload = async () => {
    await orgs.reload();
    await ctx.registry.reload();
  };

  const people = async (ids: string[]) =>
    new Map((ids.length ? await ctx.db.read.selectFrom('admins').select(['id', 'email', 'display_name', 'role']).where('id', 'in', ids).execute() : []).map((p) => [p.id, p]));
  const membersView = async (scopeType: 'org' | 'team', id: string) => {
    const ms = orgs.membersOf(scopeType, id);
    const who = await people(ms.map((m) => m.adminId));
    return ms
      .map((m) => ({ id: m.adminId, email: who.get(m.adminId)?.email ?? '(removed)', name: who.get(m.adminId)?.display_name ?? null, role: m.role, source: m.source }))
      .sort((a, b) => (a.role === b.role ? a.email.localeCompare(b.email) : a.role === 'admin' ? -1 : 1));
  };
  const teamView = async (t: Team) => {
    const keys = [...ctx.registry.keysById.values()].filter((k) => k.team === t.name);
    const budget = ctx.budgets.snapshot().find((b) => b.scope === `team:${t.name}`);
    return {
      id: t.id,
      name: t.name,
      org_id: t.orgId ?? null,
      org_name: t.orgId ? (orgs.orgs.get(t.orgId)?.name ?? null) : null,
      idp_groups: t.idpGroups,
      keys: keys.length,
      members: await membersView('team', t.id),
      budget: budget ? { limit_usd: budget.limit_nanousd / 1e9, spent_usd: budget.spent_nanousd / 1e9, period: budget.period } : null,
    };
  };

  /** Add someone to a team or organisation by email; someone new is created as a member, with a one-time password. */
  const addMember = async (req: FastifyRequest, reply: FastifyReply, scopeType: 'org' | 'team', scopeId: string) => {
    const b = (req.body ?? {}) as { email?: string; role?: string };
    const email = (b.email ?? '').trim().toLowerCase();
    if (!email.includes('@') || email.length > 200) return bad(reply, 'Enter a valid email.');
    const role = b.role === 'admin' ? 'admin' : b.role === 'member' || b.role === undefined ? 'member' : undefined;
    if (!role) return bad(reply, 'role must be admin or member');
    let person = await ctx.db.read.selectFrom('admins').select(['id', 'email']).where('email', '=', email).executeTakeFirst();
    let password: string | undefined;
    if (!person) {
      password = randomToken(12);
      const id = ulid();
      await ctx.db.write.insertInto('admins').values({ id, email, password_hash: await hashPassword(password), created_at: Date.now(), role: 'member', must_change_password: 1 }).execute();
      person = { id, email };
    }
    await ctx.db.write
      .insertInto('memberships')
      .values({ admin_id: person.id, scope_type: scopeType, scope_id: scopeId, role, source: 'console', created_at: Date.now() })
      .onConflict((oc) => oc.columns(['admin_id', 'scope_type', 'scope_id']).doUpdateSet({ role, source: 'console' }))
      .execute();
    await reload();
    // Shown once when the person is new: they sign in with it and choose their own (or use single sign-on).
    return reply.status(password ? 201 : 200).send({ id: person.id, email, role, ...(password ? { created: true, password } : {}) });
  };
  const removeMember = async (reply: FastifyReply, scopeType: 'org' | 'team', scopeId: string, personId: string) => {
    const r = await ctx.db.write.deleteFrom('memberships').where('admin_id', '=', personId).where('scope_type', '=', scopeType).where('scope_id', '=', scopeId).executeTakeFirst();
    if (Number(r.numDeletedRows) === 0) return notFound(reply, 'membership');
    await reload();
    return { ok: true };
  };

  // ---- organisations ----
  app.get('/admin/api/orgs', { preHandler: guard }, async (req) => {
    const s = scopeOf(req);
    const mine = new Set(orgs.membershipsOf(req.admin?.adminId ?? '').filter((m) => m.scopeType === 'org').map((m) => m.scopeId));
    const list = [...orgs.orgs.values()].filter((o) => s.all || mine.has(o.id)).sort((a, b) => a.name.localeCompare(b.name));
    return {
      orgs: await Promise.all(list.map(async (o) => ({ id: o.id, name: o.name, teams: orgs.teamsOfOrg(o.id).map((t) => ({ id: t.id, name: t.name })), members: await membersView('org', o.id), may_manage: adminsOrg(s, o.id) }))),
    };
  });

  app.post('/admin/api/orgs', { preHandler: guard }, async (req, reply) => {
    const name = cleanName((req.body as { name?: string } | undefined)?.name);
    if (!name) return bad(reply, 'name is required');
    if ([...orgs.orgs.values()].some((o) => o.name.toLowerCase() === name.toLowerCase())) return reply.status(409).send({ error: { code: 'exists', message: `an organisation is already called ${name}` } });
    const id = ulid();
    await ctx.db.write.insertInto('orgs').values({ id, name, created_at: Date.now(), updated_at: Date.now() }).execute();
    await reload();
    return reply.status(201).send({ id, name });
  });

  app.patch('/admin/api/orgs/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!orgs.orgs.has(id)) return notFound(reply, 'organisation');
    const name = cleanName((req.body as { name?: string } | undefined)?.name);
    if (!name) return bad(reply, 'name is required');
    await ctx.db.write.updateTable('orgs').set({ name, updated_at: Date.now() }).where('id', '=', id).execute();
    await reload();
    return { ok: true };
  });

  app.delete('/admin/api/orgs/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!orgs.orgs.has(id)) return notFound(reply, 'organisation');
    // Its teams stay, outside any organisation; its memberships go.
    await ctx.db.write.transaction().execute(async (trx) => {
      await trx.updateTable('teams').set({ org_id: null, updated_at: Date.now() }).where('org_id', '=', id).execute();
      await trx.deleteFrom('memberships').where('scope_type', '=', 'org').where('scope_id', '=', id).execute();
      await trx.deleteFrom('orgs').where('id', '=', id).execute();
    });
    await reload();
    return { ok: true };
  });

  app.put('/admin/api/orgs/:id/members', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!orgs.orgs.has(id)) return notFound(reply, 'organisation');
    if (!adminsOrg(scopeOf(req), id)) return forbidden(reply, "Only an admin or the organisation's admins add people to it.");
    return addMember(req, reply, 'org', id);
  });

  app.delete('/admin/api/orgs/:id/members/:personId', { preHandler: guard }, async (req, reply) => {
    const { id, personId } = req.params as { id: string; personId: string };
    if (!orgs.orgs.has(id)) return notFound(reply, 'organisation');
    if (!adminsOrg(scopeOf(req), id)) return forbidden(reply, "Only an admin or the organisation's admins remove people from it.");
    return removeMember(reply, 'org', id, personId);
  });

  // ---- teams ----
  app.get('/admin/api/teams', { preHandler: guard }, async (req) => {
    const s = scopeOf(req);
    const visible = [...orgs.teams.values()].filter((t) => seesTeam(s, t.name)).sort((a, b) => a.name.localeCompare(b.name));
    // Team labels on keys that aren't teams yet (an admin can make them teams).
    const labels = isAdmin(s) ? [...new Set([...ctx.registry.keysById.values()].map((k) => k.team).filter((t): t is string => !!t && !orgs.teamsByName.has(t)))].sort() : [];
    return {
      teams: await Promise.all(visible.map(async (t) => ({ ...(await teamView(t)), may_manage: managesTeam(s, t.name), may_budget: isAdmin(s) || (!!t.orgId && adminsOrg(s, t.orgId)) }))),
      unassigned_labels: labels,
    };
  });

  app.post('/admin/api/teams', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; org_id?: string | null };
    const name = cleanName(b.name);
    if (!name) return bad(reply, 'name is required (the team label its keys carry)');
    const orgId = b.org_id || undefined;
    if (orgId && !orgs.orgs.has(orgId)) return notFound(reply, 'organisation');
    const s = scopeOf(req);
    if (!isAdmin(s) && !adminsOrg(s, orgId)) return forbidden(reply, "Teams are added by admins, or by an organisation's admins to their organisation.");
    if (orgs.teamsByName.has(name)) return reply.status(409).send({ error: { code: 'exists', message: `${name} is already a team` } });
    const id = ulid();
    await ctx.db.write.insertInto('teams').values({ id, name, org_id: orgId ?? null, idp_groups: '{}', created_at: Date.now(), updated_at: Date.now() }).execute();
    await reload();
    return reply.status(201).send({ id, name });
  });

  app.patch('/admin/api/teams/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const t = orgs.teams.get(id);
    if (!t) return notFound(reply, 'team');
    const s = scopeOf(req);
    if (!isAdmin(s) && !adminsOrg(s, t.orgId)) return forbidden(reply, "A team is changed by an admin or its organisation's admins.");
    const b = (req.body ?? {}) as { name?: string; org_id?: string | null; idp_groups?: { admin?: unknown; member?: unknown } };
    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (b.org_id !== undefined) {
      const to = b.org_id || undefined;
      if (to && !orgs.orgs.has(to)) return notFound(reply, 'organisation');
      // Moving a team takes admin of where it goes (and only admins take it out of every organisation).
      if (!isAdmin(s) && (!to || !adminsOrg(s, to))) return forbidden(reply, 'Move it only into an organisation you administer.');
      patch.org_id = to ?? null;
    }
    if (b.idp_groups !== undefined) {
      const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 50) : []);
      patch.idp_groups = JSON.stringify({ admin: list(b.idp_groups?.admin), member: list(b.idp_groups?.member) });
    }
    const name = b.name === undefined ? undefined : cleanName(b.name);
    if (name !== undefined && !name) return bad(reply, 'name cannot be empty');
    const renamed = name && name !== t.name;
    if (renamed && orgs.teamsByName.has(name)) return reply.status(409).send({ error: { code: 'exists', message: `${name} is already a team` } });
    await ctx.db.write.transaction().execute(async (trx) => {
      if (renamed) {
        // Its keys, and its budget, follow the new name. Past calls keep the name they were made under.
        patch.name = name;
        await trx.updateTable('api_keys').set({ team: name }).where('team', '=', t.name).execute();
        await trx.updateTable('budgets').set({ scope_id: name }).where('scope_type', '=', 'team').where('scope_id', '=', t.name).execute();
      }
      await trx.updateTable('teams').set(patch).where('id', '=', id).execute();
    });
    if (renamed) await ctx.budgets.reload();
    await reload();
    return { ok: true };
  });

  app.delete('/admin/api/teams/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const t = orgs.teams.get(id);
    if (!t) return notFound(reply, 'team');
    const s = scopeOf(req);
    if (!isAdmin(s) && !adminsOrg(s, t.orgId)) return forbidden(reply, "A team is removed by an admin or its organisation's admins.");
    // Its keys keep their label (an admin can make it a team again); its memberships go.
    await ctx.db.write.transaction().execute(async (trx) => {
      await trx.deleteFrom('memberships').where('scope_type', '=', 'team').where('scope_id', '=', id).execute();
      await trx.deleteFrom('teams').where('id', '=', id).execute();
    });
    await reload();
    return { ok: true };
  });

  app.put('/admin/api/teams/:id/members', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const t = orgs.teams.get(id);
    if (!t) return notFound(reply, 'team');
    if (!managesTeam(scopeOf(req), t.name)) return forbidden(reply, "Only the team's admins (or its organisation's, or an admin) add people to it.");
    return addMember(req, reply, 'team', id);
  });

  app.delete('/admin/api/teams/:id/members/:personId', { preHandler: guard }, async (req, reply) => {
    const { id, personId } = req.params as { id: string; personId: string };
    const t = orgs.teams.get(id);
    if (!t) return notFound(reply, 'team');
    if (!managesTeam(scopeOf(req), t.name)) return forbidden(reply, "Only the team's admins (or its organisation's, or an admin) remove people from it.");
    return removeMember(reply, 'team', id, personId);
  });
}

export type { Orgs };
