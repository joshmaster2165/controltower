import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

/** People seen through an identity provider's tokens use a seat for this long after their last call. */
export const SEAT_WINDOW_MS = 30 * 86_400_000;

/**
 * Seats: the people who come in through Enterprise identity, and are active —
 * - signed in with single sign-on, or provisioned by SCIM;
 * - or seen in the last 30 days through an identity provider's tokens, from an issuer marked as people (laptops
 *   signing in to Okta or Entra ID directly). Someone in both is one seat.
 * People with passwords don't use seats; nor do workloads (issuers not marked as people).
 */
export async function seatsUsed(db: Kysely<Database>, now = Date.now()): Promise<number> {
  const r = await db
    .selectFrom('admins')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where((eb) => eb.or([eb('sso_subject', 'is not', null), eb('scim_provider_id', 'is not', null)]))
    .where('disabled', '=', 0)
    .executeTakeFirst();
  return Number(r?.n ?? 0) + (await tokenPeople(db, now));
}

/** People seen through tokens in the window, who aren't already counted as single sign-on or SCIM people. */
async function tokenPeople(db: Kysely<Database>, now: number): Promise<number> {
  const r = await sql<{ n: number | string }>`
    SELECT COUNT(DISTINCT sp.who) AS n FROM seat_people sp
    WHERE sp.last_seen >= ${now - SEAT_WINDOW_MS}
      AND sp.who NOT IN (SELECT lower(email) FROM admins WHERE (sso_subject IS NOT NULL OR scim_provider_id IS NOT NULL) AND disabled = 0)`.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * A person presenting a token from an issuer marked as people: let them in if they already have a seat (seen in the
 * window, or counted through single sign-on), or if a seat is free. Returns why not, or undefined.
 */
export async function admitPerson(db: Kysely<Database>, seats: number, issuerId: string, who: string, now = Date.now()): Promise<string | undefined> {
  const person = who.trim().toLowerCase().slice(0, 300);
  if (!person) return 'the token names no one (its principal claim is empty)';
  const seen = await db.selectFrom('seat_people').select(['issuer_id', 'last_seen']).where('who', '=', person).where('last_seen', '>=', now - SEAT_WINDOW_MS).execute();
  const sso = await db.selectFrom('admins').select('id').where(sql<string>`lower(email)`, '=', person).where((eb) => eb.or([eb('sso_subject', 'is not', null), eb('scim_provider_id', 'is not', null)])).where('disabled', '=', 0).executeTakeFirst();
  if (!seen.length && !sso && (await seatsUsed(db, now)) >= seats) {
    return `over the license's ${seats} ${seats === 1 ? 'seat' : 'seats'}: ${person} would be one more. Add seats, or remove people who no longer need access.`;
  }
  // Seen now (written at most hourly per person and issuer).
  const mine = seen.find((s) => s.issuer_id === issuerId);
  if (!mine || now - mine.last_seen > 3600_000) {
    await db
      .insertInto('seat_people')
      .values({ issuer_id: issuerId, who: person, first_seen: now, last_seen: now })
      .onConflict((oc) => oc.columns(['issuer_id', 'who']).doUpdateSet({ last_seen: now }))
      .execute();
  }
  return undefined;
}
