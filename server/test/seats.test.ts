import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { admitPerson, seatsUsed, SEAT_WINDOW_MS } from '../src/ee/seats.js';

describe('seats', () => {
  it('count single sign-on people and people seen through an identity provider, once each; a new person waits for a free seat', async () => {
    const db = openSqlite('', { memory: true }).write;
    const now = Date.now();
    const person = (id: string, email: string, sso: boolean) =>
      db.insertInto('admins').values({ id, email, password_hash: 'x', created_at: now, role: 'member', must_change_password: 0, ...(sso ? { sso_provider_id: 'p1', sso_subject: id } : {}) } as never).execute();
    await person('a1', 'dana@acme.com', true);
    await person('a2', 'pat@acme.com', false); // a password: no seat
    expect(await seatsUsed(db, now)).toBe(1);
    // Riley signs in on a laptop through Okta: a seat. Again, and through another issuer: still one.
    expect(await admitPerson(db, 3, 'okta', 'Riley@Acme.com', now)).toBeUndefined();
    expect(await admitPerson(db, 3, 'okta', 'riley@acme.com', now + 1000)).toBeUndefined();
    expect(await admitPerson(db, 3, 'entra', 'riley@acme.com', now + 2000)).toBeUndefined();
    expect(await seatsUsed(db, now)).toBe(2);
    // Dana already has a seat through single sign-on: her laptop doesn't take another.
    expect(await admitPerson(db, 3, 'okta', 'dana@acme.com', now)).toBeUndefined();
    expect(await seatsUsed(db, now)).toBe(2);
    // One more fits; then the seats are full, and someone new is refused while everyone else carries on.
    expect(await admitPerson(db, 3, 'okta', 'sam@acme.com', now)).toBeUndefined();
    expect(await admitPerson(db, 3, 'okta', 'kim@acme.com', now)).toContain("over the license's 3 seats");
    expect(await admitPerson(db, 3, 'okta', 'riley@acme.com', now + 5000)).toBeUndefined();
    // After 30 days unseen, a seat is free again.
    const later = now + SEAT_WINDOW_MS + 60_000;
    expect(await seatsUsed(db, later)).toBe(1);
    expect(await admitPerson(db, 3, 'okta', 'kim@acme.com', later)).toBeUndefined();
    expect(await admitPerson(db, 3, 'okta', '', later)).toContain('names no one');
  });
});
