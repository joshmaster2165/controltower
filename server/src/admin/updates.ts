import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';

/**
 *   GET  /admin/api/updates        this version, newer releases, how to update where this runs, backups, upgrade history
 *   POST /admin/api/updates/check  fetch the release feed now
 * Admins only.
 */
export async function updateRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  app.get('/admin/api/updates', { preHandler: guard }, async (_req, reply) => {
    if (!ctx.updates) return reply.status(404).send({ error: { code: 'not_found', message: 'Updates are not available here.' } });
    return ctx.updates.status();
  });
  app.post('/admin/api/updates/check', { preHandler: guard }, async (_req, reply) => {
    if (!ctx.updates) return reply.status(404).send({ error: { code: 'not_found', message: 'Updates are not available here.' } });
    await ctx.updates.check();
    return ctx.updates.status();
  });
}
