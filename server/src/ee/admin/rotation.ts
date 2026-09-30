import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { requireAdmin } from '../../admin/auth.js';
import { requireEnterprise } from './license.js';
import { DEFAULT_OVERLAP_S, MAX_OVERLAP_S, RotationError, deliveryProblem, endOverlap, rotateKey } from '../rotation.js';
import type { AuditActor } from '../audit.js';
import { managesTeam, scopeOf } from '../../admin/scope.js';

/** Key rotation: now, on a schedule, delivered to a secret manager; and ending an overlap early. Admins only; Enterprise. */
export async function keyRotationRoutes(app: FastifyInstance, ctx: AppContext, instance: string): Promise<void> {
  const guard = [requireAdmin(ctx), requireEnterprise(ctx, 'secret_managers')];
  const bad = (reply: FastifyReply, message: string) => reply.status(400).send({ error: { code: 'invalid', message } });
  const notYours = (reply: FastifyReply) => reply.status(403).send({ error: { code: 'forbidden', message: "That key isn't in one of your teams." } });
  const actor = (req: FastifyRequest): AuditActor => req.auditActor ?? { type: 'admin_key' };
  const overlapOf = (v: unknown, fallback: number): number | string => {
    if (v === undefined || v === null) return fallback;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= MAX_OVERLAP_S ? n : `overlap_s must be between 0 and ${MAX_OVERLAP_S} seconds (7 days)`;
  };

  // Rotate now. With deliver_to (or the key's own), the new secret goes to the secret manager and isn't answered.
  app.post('/admin/api/keys/:id/rotate', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const k = ctx.registry.keysById.get(id);
    if (!k) return reply.status(404).send({ error: { code: 'not_found', message: 'key not found' } });
    if (!managesTeam(scopeOf(req), k.team)) return notYours(reply);
    const b = (req.body ?? {}) as { overlap_s?: number; deliver_to?: string | null };
    const overlap = overlapOf(b.overlap_s, k.rotation.overlapS ?? DEFAULT_OVERLAP_S);
    if (typeof overlap === 'string') return bad(reply, overlap);
    const deliverTo = b.deliver_to === null ? undefined : (b.deliver_to ?? k.rotation.deliverTo);
    try {
      const r = await rotateKey(ctx, id, { overlapS: overlap, deliverTo, actor: actor(req), instance });
      return reply.status(201).send({ ...(r.delivered_to ? { delivered_to: r.delivered_to } : { key: r.key }), prefix: r.prefix, last4: r.last4, old_valid_until: r.old_valid_until });
    } catch (err) {
      if (err instanceof RotationError) return reply.status(err.status).send({ error: { code: err.status === 502 ? 'delivery_failed' : err.status === 409 ? 'conflict' : 'invalid', message: err.message } });
      throw err;
    }
  });

  // The schedule: every N days (null: never), the overlap, and where the new secret is delivered.
  app.put('/admin/api/keys/:id/rotation', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const k = ctx.registry.keysById.get(id);
    if (!k) return reply.status(404).send({ error: { code: 'not_found', message: 'key not found' } });
    if (!managesTeam(scopeOf(req), k.team)) return notYours(reply);
    const b = (req.body ?? {}) as { every_days?: number | null; overlap_s?: number | null; deliver_to?: string | null };
    const every = b.every_days === null || b.every_days === undefined ? null : Number(b.every_days);
    if (every !== null && !(Number.isInteger(every) && every >= 1 && every <= 365)) return bad(reply, 'every_days must be a whole number of days, 1 to 365');
    const overlap = overlapOf(b.overlap_s, DEFAULT_OVERLAP_S);
    if (typeof overlap === 'string') return bad(reply, overlap);
    const deliverTo = b.deliver_to ? b.deliver_to.trim() : null;
    if (deliverTo) {
      const problem = deliveryProblem(deliverTo);
      if (problem) return bad(reply, problem);
    }
    // A schedule with nobody to receive the secret would lock the agent out at the first rotation.
    if (every !== null && !deliverTo) return bad(reply, 'a schedule needs deliver_to: where the agent reads its new secret (secret://<manager>/<path>#<field>)');
    await ctx.db.write.updateTable('api_keys').set({ rotate_every_days: every, rotate_overlap_s: overlap, deliver_to: deliverTo, rotation_error: null }).where('id', '=', id).execute();
    await ctx.registry.reload();
    return { ok: true };
  });

  // Stop accepting the secret before the last rotation now.
  app.post('/admin/api/keys/:id/rotate/end-overlap', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const k = ctx.registry.keysById.get(id);
    if (!k) return reply.status(404).send({ error: { code: 'not_found', message: 'key not found' } });
    if (!managesTeam(scopeOf(req), k.team)) return notYours(reply);
    await endOverlap(ctx, id);
    return { ok: true };
  });
}
