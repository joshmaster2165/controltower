import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import type { AppContext } from '../context.js';
import { hashPassword, randomToken } from '../crypto/secrets.js';
import { ROLES, requireAdmin, type Role } from './auth.js';

/**
 * The people who sign in to the console, and what each may do: admins change anything; approvers see
 * everything and decide approvals; viewers see everything. Only admins manage people. A new person, or one
 * whose password an admin resets, gets a one-time password to change at first sign-in.
 */
export async function userRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  const adminOnly = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (req.admin?.role !== 'admin') return reply.status(403).send({ error: { code: 'forbidden', message: 'Only admins manage people.' } });
  };
  const bad = (reply: import('fastify').FastifyReply, message: string) => reply.status(400).send({ error: { code: 'invalid', message } });
  const tempPassword = () => randomToken(12);
  const admins = async () => Number((await ctx.db.read.selectFrom('admins').select((eb) => eb.fn.countAll<number>().as('n')).where('role', '=', 'admin').executeTakeFirst())?.n ?? 0);

  app.get('/admin/api/users', { preHandler: [guard, adminOnly] }, async () => {
    const rows = await ctx.db.read.selectFrom('admins').select(['id', 'email', 'role', 'created_at', 'must_change_password', 'sso_subject']).orderBy('created_at').execute();
    const seen = await ctx.db.read.selectFrom('sessions').select((eb) => ['admin_id', eb.fn.max<number>('last_seen_at').as('last')]).groupBy('admin_id').execute();
    const last = new Map(seen.map((s) => [s.admin_id, Number(s.last)]));
    return { users: rows.map((r) => ({ id: r.id, email: r.email, role: r.role ?? 'admin', created_at: r.created_at, last_seen_at: last.get(r.id) ?? null, must_change_password: r.must_change_password === 1, sso: !!r.sso_subject })), roles: ROLES };
  });

  app.post('/admin/api/users', { preHandler: [guard, adminOnly] }, async (req, reply) => {
    const b = (req.body ?? {}) as { email?: string; role?: string };
    const email = (b.email ?? '').trim().toLowerCase();
    if (!email.includes('@') || email.length > 200) return bad(reply, 'Enter a valid email.');
    const role = (b.role ?? 'viewer') as Role;
    if (!(ROLES as readonly string[]).includes(role)) return bad(reply, `role must be ${ROLES.join(', ')}`);
    if (await ctx.db.read.selectFrom('admins').select('id').where('email', '=', email).executeTakeFirst()) return reply.status(409).send({ error: { code: 'conflict', message: `${email} can already sign in.` } });
    const password = tempPassword();
    const id = ulid();
    await ctx.db.write.insertInto('admins').values({ id, email, password_hash: await hashPassword(password), created_at: Date.now(), role, must_change_password: 1 }).execute();
    ctx.log.info({ email, role, by: req.admin?.email }, 'console user added');
    // Shown once: the person signs in with it and chooses their own.
    return reply.status(201).send({ id, email, role, password });
  });

  app.patch('/admin/api/users/:id', { preHandler: [guard, adminOnly] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { role?: string; reset_password?: boolean };
    const user = await ctx.db.read.selectFrom('admins').select(['id', 'email', 'role']).where('id', '=', id).executeTakeFirst();
    if (!user) return reply.status(404).send({ error: { code: 'not_found', message: 'user not found' } });
    const patch: Record<string, unknown> = {};
    if (b.role !== undefined) {
      if (!(ROLES as readonly string[]).includes(b.role)) return bad(reply, `role must be ${ROLES.join(', ')}`);
      if ((user.role ?? 'admin') === 'admin' && b.role !== 'admin' && (await admins()) <= 1) return bad(reply, 'Someone has to stay an admin: make another person an admin first.');
      patch.role = b.role;
    }
    let password: string | undefined;
    if (b.reset_password) {
      password = tempPassword();
      patch.password_hash = await hashPassword(password);
      patch.must_change_password = 1;
    }
    if (!Object.keys(patch).length) return bad(reply, 'nothing to change');
    await ctx.db.write.updateTable('admins').set(patch).where('id', '=', id).execute();
    // A new role or a new password takes effect at once: their sessions end.
    await ctx.db.write.deleteFrom('sessions').where('admin_id', '=', id).execute();
    ctx.log.info({ email: user.email, role: patch.role, reset: !!password, by: req.admin?.email }, 'console user changed');
    return { ok: true, ...(password ? { password } : {}) };
  });

  app.delete('/admin/api/users/:id', { preHandler: [guard, adminOnly] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (id === req.admin?.adminId) return bad(reply, "You can't remove yourself.");
    const user = await ctx.db.read.selectFrom('admins').select(['role', 'email']).where('id', '=', id).executeTakeFirst();
    if (!user) return reply.status(404).send({ error: { code: 'not_found', message: 'user not found' } });
    if ((user.role ?? 'admin') === 'admin' && (await admins()) <= 1) return bad(reply, 'Someone has to stay an admin.');
    await ctx.db.write.deleteFrom('sessions').where('admin_id', '=', id).execute();
    await ctx.db.write.deleteFrom('admins').where('id', '=', id).execute();
    ctx.log.info({ email: user.email, by: req.admin?.email }, 'console user removed');
    return { ok: true };
  });
}
