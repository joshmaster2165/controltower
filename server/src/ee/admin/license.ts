import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { requireAdmin } from '../../admin/auth.js';
import { LICENSE_STORE, type Feature } from '../license.js';

const NAMES: Record<Feature, string> = {
  sso: 'Single sign-on',
  scim: 'SCIM provisioning',
  audit: 'The audit log',
  jwt_auth: 'JWT authentication',
  secret_managers: 'Secret managers',
  orgs: 'Organisations and team admins',
  multi_region: 'The multi-region control plane',
  siem_export: 'Audit export to a SIEM',
};

/** preHandler: 402 unless the license in force includes the feature. */
export function requireEnterprise(ctx: AppContext, feature: Feature) {
  return async (_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    if (ctx.license.allows(feature)) return;
    return reply.status(402).send({ error: { code: 'enterprise_required', feature, message: `${NAMES[feature]} is part of Control Tower Enterprise. Add a license under License, or start a free trial.` } });
  };
}

/** The license, as the console shows it: never the key itself. */
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
          },
        }
      : {}),
  };
}

export async function licenseRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);

  // Everyone signed in sees the state (the console shows a banner when a license is ending); admins change it.
  app.get('/admin/api/license', { preHandler: guard }, async () => {
    const seatsUsed = Number((await ctx.db.read.selectFrom('admins').select((eb) => eb.fn.countAll<number>().as('n')).where('sso_subject', 'is not', null).executeTakeFirst())?.n ?? 0);
    return { ...publicLicense(ctx), seats_used: seatsUsed };
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
