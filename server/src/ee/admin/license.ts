import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { requireAdmin } from '../../admin/auth.js';
import { LICENSE_STORE, type Feature } from '../license.js';
import { seatsUsed } from '../seats.js';
import { scopeOf } from '../../admin/scope.js';

const NAMES: Record<Feature, string> = {
  sso: 'Single sign-on',
  scim: 'SCIM provisioning',
  audit: 'The audit log',
  jwt_auth: 'JWT authentication',
  secret_managers: 'Secret managers',
  orgs: 'Organisations and team admins',
  multi_region: 'The multi-region control plane',
  siem_export: 'Sending the audit log to a SIEM',
  laptops: 'Laptop sign-in',
};

/** preHandler: 402 unless the license in force includes the feature. */
export function requireEnterprise(ctx: AppContext, feature: Feature) {
  return async (_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    if (ctx.license.allows(feature)) return;
    return reply.status(402).send({ error: { code: 'enterprise_required', feature, message: `${NAMES[feature]} is part of Control Tower Enterprise. Add a license under License, or start a free trial.` } });
  };
}

/** The license, as the console shows it: never the key itself. */
export async function licenseUsage(ctx: AppContext) {
  return ctx.metering ? await ctx.metering.usage() : undefined;
}

export function publicLicense(ctx: AppContext) {
  const s = ctx.license.current;
  const l = s.license;
  return {
    status: s.status,
    ...(s.reason ? { reason: s.reason } : {}),
    source: s.source ?? null,
    editable: !ctx.config.licenseKey,
    store_url: LICENSE_STORE,
    ...(l
      ? {
          license: {
            id: l.id,
            customer: l.customer,
            email: l.email,
            plan: l.plan,
            seats: l.seats,
            requests_per_year: l.requests_per_year,
            features: l.features,
            issued_at: l.issued_at,
            expires_at: l.expires_at,
            // Bought (a subscription to manage), not a trial or a key issued by hand.
            subscription: !!l.sub,
          },
        }
      : {}),
  };
}

export async function licenseRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);

  // Everyone signed in sees the state (the console shows a banner when a license is ending); admins change it.
  app.get('/admin/api/license', { preHandler: guard }, async (req) => {
    // Requests this license year, against the allowance: the whole install's, so not for those who see only their teams.
    const usage = scopeOf(req).all ? await licenseUsage(ctx) : undefined;
    const clock = scopeOf(req).all && ctx.clock ? await ctx.clock.check() : undefined;
    return { ...publicLicense(ctx), seats_used: await seatsUsed(ctx.db.read), ...(usage ? { usage } : {}), ...(clock ? { clock } : {}) };
  });

  // Check for a renewal now (after buying seats, say) rather than at the next daily check.
  app.post('/admin/api/license/refresh', { preHandler: guard }, async (_req, reply) => {
    const server = ctx.config.licenseServer === 'off' ? undefined : (ctx.config.licenseServer ?? LICENSE_STORE ?? undefined);
    if (!server) return reply.status(409).send({ error: { code: 'offline', message: 'This server doesn\'t reach the license service (CT_LICENSE_SERVER=off): add a renewed key by hand.' } });
    const result = await ctx.license.refresh(server, ctx.log);
    return { result, ...publicLicense(ctx) };
  });

  // The clock is right (it was once set ahead, say): the latest time seen starts again from now.
  app.post('/admin/api/license/clock', { preHandler: guard }, async (req, reply) => {
    if (!ctx.clock) return reply.status(404).send({ error: { code: 'not_found', message: 'no clock watch here' } });
    // Recorded in the audit log like every change made here.
    return { clock: await ctx.clock.accept() };
  });

  app.put('/admin/api/license', { preHandler: guard }, async (req, reply) => {
    const key = ((req.body ?? {}) as { key?: string }).key;
    if (typeof key !== 'string' || !key.trim()) return reply.status(400).send({ error: { code: 'invalid', message: 'Paste the license key (it starts with ctl1.).' } });
    try {
      await ctx.license.save(key);
    } catch (err) {
      return reply.status(400).send({ error: { code: 'invalid_license', message: (err as Error).message } });
    }
    ctx.log.info({ customer: ctx.license.current.license?.customer, status: ctx.license.current.status }, 'license added');
    return publicLicense(ctx);
  });

  app.delete('/admin/api/license', { preHandler: guard }, async (_req, reply) => {
    try {
      await ctx.license.save(null);
    } catch (err) {
      return reply.status(400).send({ error: { code: 'invalid', message: (err as Error).message } });
    }
    return publicLicense(ctx);
  });
}
