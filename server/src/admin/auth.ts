import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ulid } from 'ulid';
import type { AppContext } from '../context.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword, randomToken } from '../crypto/secrets.js';
import { extractApiKey } from '../gateway/key.js';
import type { AuditActor } from '../audit/audit.js';

export const SESSION_COOKIE = 'ct_session';
const CSRF_HEADER = 'x-ct-csrf';

/** Console roles: admins change anything; approvers see everything and decide approvals; viewers see everything. */
export const ROLES = ['admin', 'approver', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export interface AdminSession {
  id: string;
  adminId: string;
  email: string;
  csrf: string;
  expiresAt: number;
  role: Role;
  mustChangePassword?: boolean;
}

/** Changes each role may make besides reading (by route pattern). Admins may make any. */
const ROLE_MAY: Record<Exclude<Role, 'admin'>, Set<string>> = {
  approver: new Set(['POST /admin/api/approvals/:id/decide', 'POST /admin/api/me/password']),
  viewer: new Set(['POST /admin/api/me/password']),
};
/** Reads only admins may make: people and their roles, the audit log, identity-provider settings. */
const ADMIN_ONLY_READS = new Set(['GET /admin/api/users', 'GET /admin/api/audit', 'GET /admin/api/audit/export', 'GET /admin/api/audit/verify', 'GET /admin/api/identity-providers']);

export function roleMay(role: Role, method: string, route: string): boolean {
  if (role === 'admin') return true;
  const k = `${method} ${route}`;
  if (method === 'GET' || method === 'HEAD') return !ADMIN_ONLY_READS.has(k);
  return ROLE_MAY[role].has(k);
}

const asRole = (r: string | null | undefined): Role => ((ROLES as readonly string[]).includes(r ?? '') ? (r as Role) : 'admin');

declare module 'fastify' {
  interface FastifyRequest {
    admin: AdminSession | undefined;
    /** Set by requireAdmin: who made this admin request, for the audit log (and why it was refused, if it was). */
    auditActor?: AuditActor;
    auditRefused?: string;
    /** The id of what a request created (read from its answer), for the audit log. */
    auditCreatedId?: string;
  }
}

/** Where a request came from, for the audit log. */
export function auditOrigin(req: FastifyRequest): { ip: string; userAgent: string | undefined; requestId: string } {
  return { ip: req.ip, userAgent: req.headers['user-agent'], requestId: String(req.id) };
}

/**
 * The code first-run setup asks for, so that whoever reaches a new install first can't claim it: printed in the
 * server's log at start. Derived from the master key, so every instance sharing a database prints the same one;
 * CT_SETUP_TOKEN sets it instead.
 */
export function setupCode(ctx: Pick<AppContext, 'config' | 'secrets'>): string {
  if (ctx.config.setupToken) return ctx.config.setupToken;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = ctx.secrets.deriveKey('setup-code');
  const chars = [...b.subarray(0, 12)].map((x) => alphabet[x % alphabet.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}
const normCode = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();

export async function isSetupComplete(ctx: AppContext): Promise<boolean> {
  const row = await ctx.db.read.selectFrom('settings').select('value').where('key', '=', 'setup_complete').executeTakeFirst();
  return row?.value === '1';
}

async function createSession(ctx: AppContext, adminId: string, email: string, role: Role = 'admin'): Promise<AdminSession> {
  const now = Date.now();
  const s: AdminSession = { id: randomToken(32), adminId, email, csrf: randomToken(16), expiresAt: now + ctx.config.sessionTtlMs, role };
  // Stored as a hash: reading the database doesn't give anyone a session to use.
  await ctx.db.write
    .insertInto('sessions')
    .values({ id: sessionKey(s.id), admin_id: adminId, csrf: s.csrf, created_at: now, expires_at: s.expiresAt, last_seen_at: now })
    .execute();
  return s;
}

function setCookie(ctx: AppContext, reply: FastifyReply, s: AdminSession): void {
  reply.setCookie(SESSION_COOKIE, s.id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Secure whenever the console is reached over HTTPS — directly, or through a proxy that says so.
    secure: (ctx.config.publicUrl ?? '').startsWith('https://') || reply.request.protocol === 'https',
    expires: new Date(s.expiresAt),
  });
}

/** What the sessions table holds for a session cookie. */
export function sessionKey(cookie: string): string {
  return createHash('sha256').update(cookie).digest('hex');
}

export async function loadSession(ctx: AppContext, req: FastifyRequest): Promise<AdminSession | undefined> {
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (!cookie) return undefined;
  const id = sessionKey(cookie);
  const row = await ctx.db.read
    .selectFrom('sessions')
    .innerJoin('admins', 'admins.id', 'sessions.admin_id')
    .select(['sessions.id', 'sessions.admin_id', 'sessions.csrf', 'sessions.expires_at', 'sessions.last_seen_at', 'admins.email', 'admins.role', 'admins.must_change_password'])
    .where('sessions.id', '=', id)
    .executeTakeFirst();
  const now = Date.now();
  if (!row || row.expires_at < now || now - row.last_seen_at > ctx.config.sessionIdleMs) return undefined;
  // Used now: kept alive (written at most once a minute).
  if (now - row.last_seen_at > 60_000) void ctx.db.write.updateTable('sessions').set({ last_seen_at: now }).where('id', '=', id).execute().catch(() => undefined);
  return { id: row.id, adminId: row.admin_id, email: row.email, csrf: row.csrf, expiresAt: row.expires_at, role: asRole(row.role), mustChangePassword: row.must_change_password === 1 };
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
  // Every refusal returns the reply: an async hook that only calls send() lets Fastify go on to the handler
  // whenever the response hasn't finished by the time the hook resolves (an async onSend hook delays it).
  return async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    if (hasAdminKey(ctx, req)) {
      req.admin = { id: 'admin-key', adminId: 'admin-key', email: 'admin key', csrf: '', expiresAt: Number.MAX_SAFE_INTEGER, role: 'admin' };
      req.auditActor = { type: 'admin_key', role: 'admin' };
      return;
    }
    const s = await loadSession(ctx, req);
    req.auditActor = s ? { type: 'person', id: s.adminId, email: s.email, role: s.role } : { type: 'anonymous' };
    if (!s) {
      req.auditRefused = 'unauthenticated';
      return reply.status(401).send({ error: { code: 'unauthenticated', message: 'Sign in required (or send the admin key as a bearer token).' } });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const hdr = Buffer.from(String(req.headers[CSRF_HEADER] ?? ''));
      const want = Buffer.from(s.csrf);
      if (hdr.length !== want.length || !timingSafeEqual(hdr, want)) {
        req.auditRefused = 'csrf';
        return reply.status(403).send({ error: { code: 'csrf', message: `Missing or invalid ${CSRF_HEADER} header.` } });
      }
    }
    // A one-time password (an admin made or reset it) only lets its owner choose a new one.
    if (s.mustChangePassword && (req.routeOptions.url ?? '') !== '/admin/api/me/password') {
      req.auditRefused = 'password_change_required';
      return reply.status(403).send({ error: { code: 'password_change_required', message: 'Choose your own password first.' } });
    }
    if (!roleMay(s.role, req.method, req.routeOptions.url ?? req.url)) {
      req.auditRefused = 'forbidden';
      return reply.status(403).send({ error: { code: 'forbidden', message: s.role === 'approver' ? 'Approvers can see everything and decide approvals, but not change settings. Ask an admin.' : `Your role (${s.role}) can see everything but not change it. Ask an admin.` } });
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
    const body = (req.body ?? {}) as { email?: string; password?: string; setup_code?: string };
    // Guessing the code is slowed down like signing in.
    const slow = await ctx.limiter.admit(`setup:ip:${req.ip}`, 1, { rpm: 10 });
    if (!slow.ok) return reply.status(429).header('retry-after', String(Math.ceil(slow.retryAfterMs / 1000))).send({ error: { code: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' } });
    const given = Buffer.from(normCode(body.setup_code ?? ''));
    const want = Buffer.from(normCode(setupCode(ctx)));
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      await ctx.audit?.record({ action: 'auth.setup', outcome: 'denied', actor: { type: 'anonymous' }, status: 403, detail: { reason: 'wrong setup code' }, ...auditOrigin(req) });
      return reply.status(403).send({ error: { code: 'setup_code', message: 'Enter the setup code from the server\'s log (it is printed at start, under "Setup code"; with Docker: docker logs <container>).' } });
    }
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';
    if (!email || !email.includes('@')) return reply.status(400).send({ error: { code: 'invalid_email', message: 'Enter a valid email.' } });
    if (password.length < 10) return reply.status(400).send({ error: { code: 'weak_password', message: 'Password must be at least 10 characters.' } });

    const id = ulid();
    const now = Date.now();
    const hash = await hashPassword(password);
    // Claim setup and create the admin in one step: of two requests at once, only one gets past the claim.
    const claimed = await ctx.db.write.transaction().execute(async (trx) => {
      const r = await trx
        .insertInto('settings')
        .values({ key: 'setup_complete', value: '1', updated_at: now })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: '1', updated_at: now }).where('settings.value', '!=', '1'))
        .executeTakeFirst();
      if (Number(r.numInsertedOrUpdatedRows ?? 0) === 0) return false;
      await trx.insertInto('admins').values({ id, email, password_hash: hash, created_at: now }).execute();
      return true;
    });
    if (!claimed) return reply.status(409).send({ error: { code: 'already_setup', message: 'Control Tower is already set up. Sign in instead.' } });
    const s = await createSession(ctx, id, email);
    setCookie(ctx, reply, s);
    ctx.log.info({ email }, 'admin account created');
    await ctx.audit?.record({ action: 'auth.setup', outcome: 'success', actor: { type: 'person', id, email, role: 'admin' }, status: 200, target: { type: 'users', id }, ...auditOrigin(req) });
    return reply.send({ ok: true, email, csrf: s.csrf });
  });

  app.post('/admin/api/login', async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; password?: string };
    const email = (body.email ?? '').trim().toLowerCase();
    // Guessing passwords is slowed to a crawl: per address, and per account (shared across instances with Redis).
    for (const [scope, rpm] of [[`login:ip:${req.ip}`, ctx.config.loginRpm * 2], [`login:email:${email}`, ctx.config.loginRpm]] as const) {
      const a = await ctx.limiter.admit(scope, 1, { rpm });
      if (!a.ok) {
        ctx.log.warn({ email, ip: req.ip }, 'sign-in attempts rate-limited');
        // One event per minute per scope is enough to show a guessing run.
        if ((await ctx.limiter.admit(`audit:${scope}`, 1, { rpm: 1 })).ok) await ctx.audit?.record({ action: 'auth.sign_in', outcome: 'denied', actor: { type: 'anonymous', email }, status: 429, detail: { reason: 'rate limited', scope: scope.split(':')[1] }, ...auditOrigin(req) });
        return reply.status(429).header('retry-after', String(Math.ceil(a.retryAfterMs / 1000))).send({ error: { code: 'rate_limited', message: 'Too many sign-in attempts. Wait a minute and try again.' } });
      }
    }
    const admin = await ctx.db.read.selectFrom('admins').selectAll().where('email', '=', email).executeTakeFirst();
    // Always run the verifier so timing does not leak whether the email exists.
    const ok = await verifyPassword(body.password ?? '', admin?.password_hash ?? 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    if (!admin || !ok) {
      await ctx.audit?.record({ action: 'auth.sign_in', outcome: 'denied', actor: { type: admin ? 'person' : 'anonymous', id: admin?.id, email }, status: 401, detail: { method: 'password', reason: admin ? 'wrong password' : 'no such person' }, ...auditOrigin(req) });
      await new Promise((r) => setTimeout(r, 250));
      return reply.status(401).send({ error: { code: 'bad_credentials', message: 'Incorrect email or password.' } });
    }
    const s = await createSession(ctx, admin.id, admin.email, asRole(admin.role));
    setCookie(ctx, reply, s);
    await ctx.audit?.record({ action: 'auth.sign_in', outcome: 'success', actor: { type: 'person', id: admin.id, email: admin.email, role: s.role }, status: 200, detail: { method: 'password' }, ...auditOrigin(req) });
    return reply.send({ ok: true, email: admin.email, csrf: s.csrf, role: s.role, must_change_password: admin.must_change_password === 1 });
  });

  app.post('/admin/api/logout', async (req, reply) => {
    const cookie = req.cookies?.[SESSION_COOKIE];
    const s = cookie ? await loadSession(ctx, req) : undefined;
    if (cookie) await ctx.db.write.deleteFrom('sessions').where('id', '=', sessionKey(cookie)).execute();
    if (s) await ctx.audit?.record({ action: 'auth.sign_out', outcome: 'success', actor: { type: 'person', id: s.adminId, email: s.email, role: s.role }, status: 200, ...auditOrigin(req) });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/admin/api/me', async (req, reply) => {
    const setup = await isSetupComplete(ctx);
    const s = await loadSession(ctx, req);
    if (!s) return reply.status(401).send({ setup_complete: setup, error: { code: 'unauthenticated', message: 'Sign in required.' } });
    return reply.send({ setup_complete: setup, email: s.email, csrf: s.csrf, role: s.role, must_change_password: !!s.mustChangePassword });
  });

  // Everyone may change their own password; their other sessions end.
  app.post('/admin/api/me/password', { preHandler: requireAdmin(ctx) }, async (req, reply) => {
    const me = req.admin!;
    if (me.adminId === 'admin-key') return reply.status(400).send({ error: { code: 'invalid', message: 'The admin key has no password to change.' } });
    const b = (req.body ?? {}) as { current?: string; password?: string };
    const row = await ctx.db.read.selectFrom('admins').select('password_hash').where('id', '=', me.adminId).executeTakeFirst();
    if (!row || !(await verifyPassword(b.current ?? '', row.password_hash))) return reply.status(403).send({ error: { code: 'bad_credentials', message: 'The current password is not right.' } });
    if ((b.password ?? '').length < 10) return reply.status(400).send({ error: { code: 'weak_password', message: 'Password must be at least 10 characters.' } });
    await ctx.db.write.updateTable('admins').set({ password_hash: await hashPassword(b.password!), must_change_password: 0 }).where('id', '=', me.adminId).execute();
    await ctx.db.write.deleteFrom('sessions').where('admin_id', '=', me.adminId).where('id', '!=', me.id).execute();
    ctx.log.info({ email: me.email }, 'password changed');
    return { ok: true };
  });
}
