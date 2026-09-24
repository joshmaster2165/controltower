import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ulid } from 'ulid';
import type { AppContext } from '../context.js';
import { timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword, randomToken } from '../crypto/secrets.js';
import { extractApiKey } from '../gateway/key.js';

export const SESSION_COOKIE = 'ct_session';
const CSRF_HEADER = 'x-ct-csrf';

export interface AdminSession {
  id: string;
  adminId: string;
  email: string;
  csrf: string;
  expiresAt: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin: AdminSession | undefined;
  }
}

export async function isSetupComplete(ctx: AppContext): Promise<boolean> {
  const row = await ctx.db.read.selectFrom('settings').select('value').where('key', '=', 'setup_complete').executeTakeFirst();
  return row?.value === '1';
}

async function createSession(ctx: AppContext, adminId: string, email: string): Promise<AdminSession> {
  const now = Date.now();
  const s: AdminSession = { id: randomToken(32), adminId, email, csrf: randomToken(16), expiresAt: now + ctx.config.sessionTtlMs };
  await ctx.db.write
    .insertInto('sessions')
    .values({ id: s.id, admin_id: adminId, csrf: s.csrf, created_at: now, expires_at: s.expiresAt, last_seen_at: now })
    .execute();
  return s;
}

function setCookie(ctx: AppContext, reply: FastifyReply, s: AdminSession): void {
  reply.setCookie(SESSION_COOKIE, s.id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: (ctx.config.publicUrl ?? '').startsWith('https://'),
    expires: new Date(s.expiresAt),
  });
}

export async function loadSession(ctx: AppContext, req: FastifyRequest): Promise<AdminSession | undefined> {
  const id = req.cookies?.[SESSION_COOKIE];
  if (!id) return undefined;
  const row = await ctx.db.read
    .selectFrom('sessions')
    .innerJoin('admins', 'admins.id', 'sessions.admin_id')
    .select(['sessions.id', 'sessions.admin_id', 'sessions.csrf', 'sessions.expires_at', 'admins.email'])
    .where('sessions.id', '=', id)
    .executeTakeFirst();
  if (!row || row.expires_at < Date.now()) return undefined;
  return { id: row.id, adminId: row.admin_id, email: row.email, csrf: row.csrf, expiresAt: row.expires_at };
}

/** True when the request carries the admin key. */
export function hasAdminKey(ctx: AppContext, req: FastifyRequest): boolean {
  const key = ctx.config.adminKey;
  const presented = extractApiKey(req);
  if (!key || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * preHandler: requires a valid session (mutations also need the CSRF header),
 * or the admin key as a bearer token — the way scripts and CI tooling
 * call admin routes. Browsers never attach a bearer header on their own, so it needs no CSRF check.
 */
export function requireAdmin(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (hasAdminKey(ctx, req)) {
      req.admin = { id: 'admin-key', adminId: 'admin-key', email: 'admin key', csrf: '', expiresAt: Number.MAX_SAFE_INTEGER };
      return;
    }
    const s = await loadSession(ctx, req);
    if (!s) {
      reply.status(401).send({ error: { code: 'unauthenticated', message: 'Sign in required (or send the admin key as a bearer token).' } });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const hdr = req.headers[CSRF_HEADER];
      if (hdr !== s.csrf) {
        reply.status(403).send({ error: { code: 'csrf', message: `Missing or invalid ${CSRF_HEADER} header.` } });
        return;
      }
    }
    req.admin = s;
  };
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.decorateRequest('admin', undefined);

  app.post('/admin/api/setup', async (req, reply) => {
    if (await isSetupComplete(ctx)) {
      return reply.status(409).send({ error: { code: 'already_setup', message: 'Control Tower is already set up. Sign in instead.' } });
    }
    const body = (req.body ?? {}) as { email?: string; password?: string };
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';
    if (!email || !email.includes('@')) return reply.status(400).send({ error: { code: 'invalid_email', message: 'Enter a valid email.' } });
    if (password.length < 10) return reply.status(400).send({ error: { code: 'weak_password', message: 'Password must be at least 10 characters.' } });

    const id = ulid();
    const now = Date.now();
    await ctx.db.write.transaction().execute(async (trx) => {
      await trx.insertInto('admins').values({ id, email, password_hash: await hashPassword(password), created_at: now }).execute();
      await trx
        .insertInto('settings')
        .values({ key: 'setup_complete', value: '1', updated_at: now })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: '1', updated_at: now }))
        .execute();
    });
    const s = await createSession(ctx, id, email);
    setCookie(ctx, reply, s);
    ctx.log.info({ email }, 'admin account created');
    return reply.send({ ok: true, email, csrf: s.csrf });
  });

  app.post('/admin/api/login', async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; password?: string };
    const email = (body.email ?? '').trim().toLowerCase();
    const admin = await ctx.db.read.selectFrom('admins').selectAll().where('email', '=', email).executeTakeFirst();
    // Always run the verifier so timing does not leak whether the email exists.
    const ok = await verifyPassword(body.password ?? '', admin?.password_hash ?? 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    if (!admin || !ok) {
      await new Promise((r) => setTimeout(r, 250));
      return reply.status(401).send({ error: { code: 'bad_credentials', message: 'Incorrect email or password.' } });
    }
    const s = await createSession(ctx, admin.id, admin.email);
    setCookie(ctx, reply, s);
    return reply.send({ ok: true, email: admin.email, csrf: s.csrf });
  });

  app.post('/admin/api/logout', async (req, reply) => {
    const id = req.cookies?.[SESSION_COOKIE];
    if (id) await ctx.db.write.deleteFrom('sessions').where('id', '=', id).execute();
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/admin/api/me', async (req, reply) => {
    const setup = await isSetupComplete(ctx);
    const s = await loadSession(ctx, req);
    if (!s) return reply.status(401).send({ setup_complete: setup, error: { code: 'unauthenticated', message: 'Sign in required.' } });
    return reply.send({ setup_complete: setup, email: s.email, csrf: s.csrf });
  });
}
