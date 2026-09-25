import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { AppContext } from '../context.js';
import type { Database } from '../db/schema.js';
import { requireAdmin } from './auth.js';
import { ADMIN_KEY_ID } from './admin-key.js';
import { PLAYGROUND_KEY_ID } from './playground.js';
import { GUARDRAIL_KEY_ID } from '../guardrails/model-check.js';

/**
 * Agents come and go: a session spins up sub-agents, a pipeline mints a key per
 * run, a prototype is abandoned. Keys are the only way an agent gets onto the
 * map, so this is where they leave it again:
 *
 * - a key can be made to expire (short-lived sub-agents), and an expired key
 *   leaves the map — its history stays in Flights and the Ledger;
 * - keys unused for N days can be retired automatically (they expire, so they
 *   stop working and leave the map; setting a new expiry brings one back);
 * - idle, never-used and expired keys can be disabled or deleted in bulk.
 */
export const BUILT_IN_KEYS = new Set([ADMIN_KEY_ID, PLAYGROUND_KEY_ID, GUARDRAIL_KEY_ID]);
const SETTING = 'keys.retire_idle_days';
const DAY = 86_400_000;
export const RETIRE_CHOICES = [0, 7, 30, 90] as const;

/** When each key last did anything: a gateway call, or a report through /v1/observe. */
export async function lastUseByKey(ctx: { db: { read: Kysely<Database> } }): Promise<Map<string, number>> {
  const used = new Map<string, number>();
  const flightRows = await ctx.db.read.selectFrom('flights').select(['key_id', sql<number>`max(ts)`.as('ts')]).where('key_id', 'is not', null).groupBy('key_id').execute();
  for (const r of flightRows) if (r.key_id) used.set(r.key_id, Number(r.ts));
  const observedRows = await ctx.db.read.selectFrom('observed_hourly').select(['key_id', sql<number>`max(last_seen)`.as('ts')]).groupBy('key_id').execute();
  for (const r of observedRows) used.set(r.key_id, Math.max(used.get(r.key_id) ?? 0, Number(r.ts)));
  return used;
}

export async function retireIdleDays(db: Kysely<Database>): Promise<number> {
  const row = await db.selectFrom('settings').select('value').where('key', '=', SETTING).executeTakeFirst();
  const n = Number(row?.value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * One pass: every key (not built-in, not demo, not already expired) that has
 * done nothing for `days` — counting from its creation if it never did
 * anything — expires now. Returns the keys it retired.
 */
export async function retireIdleKeys(ctx: Pick<AppContext, 'db' | 'registry'>, days: number, now = Date.now()): Promise<Array<{ id: string; name: string }>> {
  if (!(days > 0)) return [];
  const used = await lastUseByKey(ctx);
  const cutoff = now - days * DAY;
  const idle = [...ctx.registry.keysById.values()].filter(
    (k) => !BUILT_IN_KEYS.has(k.id) && !k.demo && !(k.expiresAt && k.expiresAt <= now) && (used.get(k.id) ?? k.lastUsedAt ?? k.createdAt) < cutoff,
  );
  if (idle.length === 0) return [];
  await ctx.db.write
    .updateTable('api_keys')
    .set({ expires_at: now })
    .where(
      'id',
      'in',
      idle.map((k) => k.id),
    )
    .execute();
  await ctx.registry.reload();
  return idle.map((k) => ({ id: k.id, name: k.name }));
}

/** Runs the retirement pass shortly after start and then every hour, when it is switched on. */
export function startKeyRetirement(ctx: AppContext, log: (retired: Array<{ id: string; name: string }>, days: number) => void, onError: (err: unknown) => void): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    retireIdleDays(ctx.db.read)
      .then(async (days) => {
        const retired = await retireIdleKeys(ctx, days);
        if (retired.length) log(retired, days);
      })
      .catch(onError)
      .finally(() => (running = false));
  };
  const first = setTimeout(tick, 90_000);
  const every = setInterval(tick, 3600_000);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

export async function keyLifecycleRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);

  app.get('/admin/api/keys/retire-policy', { preHandler: guard }, async () => ({ idle_days: await retireIdleDays(ctx.db.read), choices: RETIRE_CHOICES }));

  // Switching it on retires what is already idle at once, and reports it.
  app.put('/admin/api/keys/retire-policy', { preHandler: guard }, async (req, reply) => {
    const days = (req.body as { idle_days?: unknown } | undefined)?.idle_days;
    if (typeof days !== 'number' || !(RETIRE_CHOICES as readonly number[]).includes(days)) {
      return reply.status(400).send({ error: { code: 'invalid', message: `idle_days must be one of ${RETIRE_CHOICES.join(', ')} (0 = never)` } });
    }
    const now = Date.now();
    await ctx.db.write
      .insertInto('settings')
      .values({ key: SETTING, value: String(days), updated_at: now })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: String(days), updated_at: now }))
      .execute();
    const retired = await retireIdleKeys(ctx, days, now);
    if (retired.length) app.log.info({ retired: retired.map((k) => k.name), days }, 'keys retired after going unused');
    return { idle_days: days, retired };
  });

  // Tidy up many keys at once: disable (reversible) or delete (history stays in Flights and the Ledger).
  app.post('/admin/api/keys/bulk', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { ids?: unknown; action?: unknown };
    const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string') : [];
    if (b.action !== 'disable' && b.action !== 'delete') return reply.status(400).send({ error: { code: 'invalid', message: 'action must be disable or delete' } });
    if (ids.length === 0 || ids.length > 5000) return reply.status(400).send({ error: { code: 'invalid', message: 'ids must list 1 to 5000 keys' } });
    const target = ids.filter((id) => !BUILT_IN_KEYS.has(id) && ctx.registry.keysById.has(id));
    if (target.length) {
      if (b.action === 'disable') {
        await ctx.db.write.updateTable('api_keys').set({ enabled: 0 }).where('id', 'in', target).execute();
      } else {
        await ctx.db.write.deleteFrom('api_keys').where('id', 'in', target).execute();
        await ctx.db.write.deleteFrom('budgets').where('scope_type', '=', 'key').where('scope_id', 'in', target).execute();
        await ctx.budgets.reload();
      }
      await ctx.registry.reload();
    }
    return { action: b.action, done: target.length, skipped: ids.length - target.length };
  });
}
