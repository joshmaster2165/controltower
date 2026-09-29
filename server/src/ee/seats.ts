import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

/**
 * Seats: the people who come in through Enterprise identity — signed in with single sign-on, or provisioned
 * by SCIM — and are active. People with passwords don't use seats.
 */
export async function seatsUsed(db: Kysely<Database>): Promise<number> {
  const r = await db
    .selectFrom('admins')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where((eb) => eb.or([eb('sso_subject', 'is not', null), eb('scim_provider_id', 'is not', null)]))
    .where('disabled', '=', 0)
    .executeTakeFirst();
  return Number(r?.n ?? 0);
}
