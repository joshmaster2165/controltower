import type { AppContext } from '../context.js';
import { generateApiKey } from '../crypto/apikeys.js';
import { BUILT_IN_KEYS } from '../admin/key-lifecycle.js';
import type { AuditActor } from './audit.js';
import { parseRef, secretRefs } from './secret-managers/index.js';

/**
 * Key rotation (Enterprise). A key gets a new secret; the old one keeps working for an overlap, so agents can
 * switch without a failed call. A key can rotate itself on a schedule and write the new secret to your secret
 * manager (`deliver_to`), where the agent reads it: nobody handles the secret, and it never lives long.
 *
 * The new secret is written to the manager before it is saved: if the manager refuses, nothing changes and
 * the error is shown on the key. With several instances, a claim on the key makes sure only one rotates it.
 */
export const MAX_OVERLAP_S = 7 * 86_400;
export const DEFAULT_OVERLAP_S = 3_600;
const CLAIM_MS = 60_000;
const CHECK_MS = 5 * 60_000;

export interface Rotated {
  key: string;
  prefix: string;
  last4: string;
  delivered_to: string | null;
  old_valid_until: number | null;
}

export class RotationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Where a new secret may be delivered: a reference to a secret manager that exists. */
export function deliveryProblem(ref: string): string | undefined {
  const r = parseRef(ref);
  if (!r) return 'deliver_to must be a secret reference: secret://<manager>/<path>#<field>';
  if (!secretRefs.managerNames().includes(r.manager)) return `no secret manager is named "${r.manager}"`;
  return undefined;
}

/** Give a key a new secret now. The old one works for `overlapS` more seconds (0: stops at once). */
export async function rotateKey(ctx: AppContext, keyId: string, opts: { overlapS: number; deliverTo?: string | undefined; actor: AuditActor; instance: string }): Promise<Rotated> {
  const w = ctx.db.write;
  const row = await w.selectFrom('api_keys').selectAll().where('id', '=', keyId).executeTakeFirst();
  if (!row) throw new RotationError('key not found', 404);
  if (BUILT_IN_KEYS.has(keyId)) throw new RotationError("Control Tower's own keys aren't rotated here");
  const overlap = Math.max(0, Math.min(MAX_OVERLAP_S, Math.round(opts.overlapS)));
  if (opts.deliverTo) {
    const problem = deliveryProblem(opts.deliverTo);
    if (problem) throw new RotationError(problem);
  }
  const now = Date.now();
  // Only one instance rotates a key at a time.
  const claimed = await w
    .updateTable('api_keys')
    .set({ rotation_claim: opts.instance, rotation_claim_until: now + CLAIM_MS })
    .where('id', '=', keyId)
    .where((eb) => eb.or([eb('rotation_claim_until', '<', now), eb('rotation_claim', '=', opts.instance)]))
    .executeTakeFirst();
  if (Number(claimed.numUpdatedRows) === 0) throw new RotationError('the key is being rotated right now', 409);
  const gen = generateApiKey();
  try {
    if (opts.deliverTo) {
      try {
        await secretRefs.write(opts.deliverTo, gen.plaintext);
      } catch (err) {
        const message = `the new secret could not be written to ${opts.deliverTo}: ${(err as Error).message}`.slice(0, 500);
        await w.updateTable('api_keys').set({ rotation_error: message }).where('id', '=', keyId).execute();
        // Scheduled rotations are recorded here (the admin API records its own requests); a schedule retrying
        // the same failure every few minutes is recorded once.
        if (opts.actor.type === 'system' && message !== row.rotation_error) await ctx.audit?.record({ action: 'keys.rotate', outcome: 'failure', actor: opts.actor, target: { type: 'keys', id: keyId }, detail: { deliver_to: opts.deliverTo, error: message } });
        throw new RotationError(message, 502);
      }
    }
    const done = await w
      .updateTable('api_keys')
      .set({ key_hash: gen.hash, key_prefix: gen.prefix, last4: gen.last4, prev_key_hash: overlap ? row.key_hash : null, prev_expires_at: overlap ? now + overlap * 1000 : null, last_rotated_at: now, rotation_error: null })
      .where('id', '=', keyId)
      .where('key_hash', '=', row.key_hash)
      .executeTakeFirst();
    if (Number(done.numUpdatedRows) === 0) throw new RotationError('the key changed while it was being rotated; try again', 409);
  } finally {
    await w.updateTable('api_keys').set({ rotation_claim: null, rotation_claim_until: 0 }).where('id', '=', keyId).where('rotation_claim', '=', opts.instance).execute();
  }
  await ctx.registry.reload();
  if (opts.actor.type === 'system') await ctx.audit?.record({ action: 'keys.rotate', outcome: 'success', actor: opts.actor, target: { type: 'keys', id: keyId }, detail: { overlap_s: overlap, ...(opts.deliverTo ? { deliver_to: opts.deliverTo } : {}), scheduled: opts.actor.type === 'system' } });
  return { key: gen.plaintext, prefix: gen.prefix, last4: gen.last4, delivered_to: opts.deliverTo ?? null, old_valid_until: overlap ? now + overlap * 1000 : null };
}

/** Stop accepting the old secret now (a leaked key: don't wait for the overlap to end). */
export async function endOverlap(ctx: AppContext, keyId: string): Promise<void> {
  await ctx.db.write.updateTable('api_keys').set({ prev_key_hash: null, prev_expires_at: null }).where('id', '=', keyId).execute();
  await ctx.registry.reload();
}

/** When a key with a schedule rotates next. */
export function nextRotation(k: { rotation: { everyDays: number | undefined; lastRotatedAt: number | undefined }; createdAt: number }): number | undefined {
  return k.rotation.everyDays ? (k.rotation.lastRotatedAt ?? k.createdAt) + k.rotation.everyDays * 86_400_000 : undefined;
}

/** Rotates keys whose schedule is due, every few minutes, while the license includes it. */
export class KeyRotator {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly ctx: () => AppContext,
    private readonly opts: { instance: string; allowed: () => boolean; log: () => { warn(o: object, m: string): void; info?(o: object, m: string): void } },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), CHECK_MS);
    this.timer.unref?.();
    const first = setTimeout(() => void this.tick(), 20_000);
    first.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Rotate every key that is due. Returns the ids rotated. */
  async tick(now = Date.now()): Promise<string[]> {
    if (this.running || !this.opts.allowed()) return [];
    this.running = true;
    const done: string[] = [];
    try {
      const ctx = this.ctx();
      for (const k of ctx.registry.keysById.values()) {
        const due = nextRotation(k);
        if (!due || due > now || !k.enabled || BUILT_IN_KEYS.has(k.id)) continue;
        // A failed delivery is tried again at the next check, not in a tight loop.
        try {
          await rotateKey(ctx, k.id, { overlapS: k.rotation.overlapS ?? DEFAULT_OVERLAP_S, deliverTo: k.rotation.deliverTo, actor: { type: 'system', id: 'key-rotation' }, instance: this.opts.instance });
          done.push(k.id);
          this.opts.log().info?.({ key: k.name }, 'key rotated on schedule');
        } catch (err) {
          if (!(err instanceof RotationError && err.status === 409)) this.opts.log().warn({ key: k.name, err: (err as Error).message }, 'scheduled key rotation failed');
        }
      }
    } finally {
      this.running = false;
    }
    return done;
  }
}
