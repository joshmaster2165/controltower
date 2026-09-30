import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ulid } from 'ulid';
import type { AppContext } from '../../context.js';
import { requireAdmin } from '../../admin/auth.js';
import { requireEnterprise } from './license.js';

/**
 * Regions of a multi-region deployment, managed on the control plane (Enterprise). Adding a region makes its
 * token (how it signs in) and its own master key (what credentials sent to it are encrypted with), shown once.
 */
export const regionToken = () => `ctr_${crypto.randomBytes(24).toString('base64url')}`;
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** How a region is doing, from what it last reported. */
export function regionStatus(r: { last_seen: number | null; applied_etag: string | null }, currentEtag: string | undefined, now = Date.now()): 'waiting' | 'in_sync' | 'behind' | 'unreachable' {
  if (!r.last_seen) return 'waiting';
  if (now - r.last_seen > 60_000) return 'unreachable';
  return currentEtag && r.applied_etag === currentEtag ? 'in_sync' : 'behind';
}

export async function regionRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  if (ctx.config.region) return; // a region has no regions of its own
  const guard = [requireAdmin(ctx), requireEnterprise(ctx, 'multi_region')];
  const bad = (reply: FastifyReply, message: string) => reply.status(400).send({ error: { code: 'invalid', message } });
  const notFound = (reply: FastifyReply) => reply.status(404).send({ error: { code: 'not_found', message: 'region not found' } });
  const publicUrl = () => ctx.config.publicUrl ?? '<this control plane’s URL>';
  /** What to set on the region's servers. */
  const envFor = (name: string, token: string, masterKey: string) => ({
    CT_ROLE: 'region',
    CT_REGION: name,
    CT_CONTROL_PLANE_URL: publicUrl(),
    CT_REGION_TOKEN: token,
    CT_MASTER_KEY: masterKey,
  });

  app.get('/admin/api/regions', { preHandler: guard }, async () => {
    const rows = await ctx.db.read.selectFrom('regions').selectAll().orderBy('name').execute();
    const current = ctx.controlPlane?.currentEtag();
    return {
      control_plane_url: ctx.config.publicUrl ?? null,
      config_etag: current ?? null,
      regions: rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: regionStatus(r, current),
        last_seen: r.last_seen,
        instance: r.last_instance,
        version: r.last_version,
        applied_etag: r.applied_etag,
        applied_at: r.applied_at,
        error: r.last_error,
        created_at: r.created_at,
      })),
    };
  });

  app.post('/admin/api/regions', { preHandler: guard }, async (req, reply) => {
    const name = String((req.body as { name?: string } | undefined)?.name ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) return bad(reply, 'name must be lowercase letters, digits and -, e.g. eu-west');
    if (await ctx.db.read.selectFrom('regions').select('id').where('name', '=', name).executeTakeFirst()) return reply.status(409).send({ error: { code: 'exists', message: `a region is already called ${name}` } });
    const id = ulid();
    const token = regionToken();
    const masterKey = crypto.randomBytes(32).toString('base64');
    await ctx.db.write
      .insertInto('regions')
      .values({
        id,
        name,
        token_hash: sha256(token),
        token_enc: ctx.secrets.encrypt(token, `regions.token_enc.${id}`),
        master_key_enc: ctx.secrets.encrypt(masterKey, `regions.master_key_enc.${id}`),
        created_at: Date.now(),
        last_seen: null,
        last_instance: null,
        last_version: null,
        applied_etag: null,
        applied_at: null,
        last_error: null,
      })
      .execute();
    // Shown once: the region's servers start with these; the control plane keeps only what it needs.
    return reply.status(201).send({ id, name, env: envFor(name, token, masterKey) });
  });

  // A new token (the old one stops at once); the region's master key stays.
  app.post('/admin/api/regions/:id/token', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = await ctx.db.read.selectFrom('regions').select(['name', 'master_key_enc']).where('id', '=', id).executeTakeFirst();
    if (!r) return notFound(reply);
    const token = regionToken();
    await ctx.db.write.updateTable('regions').set({ token_hash: sha256(token), token_enc: ctx.secrets.encrypt(token, `regions.token_enc.${id}`) }).where('id', '=', id).execute();
    return { name: r.name, env: envFor(r.name, token, ctx.secrets.decrypt(r.master_key_enc, `regions.master_key_enc.${id}`)) };
  });

  app.delete('/admin/api/regions/:id', { preHandler: guard }, async (req, reply) => {
    const r = await ctx.db.write.deleteFrom('regions').where('id', '=', (req.params as { id: string }).id).executeTakeFirst();
    if (Number(r.numDeletedRows) === 0) return notFound(reply);
    return { ok: true };
  });
}
