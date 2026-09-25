import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { retireIdleKeys } from '../src/admin/key-lifecycle.js';
import { ADMIN_KEY_ID } from '../src/admin/admin-key.js';

const DAY = 24 * 3600 * 1000;

describe('retiring idle keys', () => {
  it('expires keys unused for N days — counting from creation if never used — and leaves the rest alone', async () => {
    const db = openSqlite('', { memory: true });
    const now = Date.UTC(2026, 8, 25, 12);
    const key = (id: string, createdAt: number, extra: Record<string, unknown> = {}) => ({ id, name: id, createdAt, expiresAt: undefined as number | undefined, demo: false, lastUsedAt: undefined, ...extra });
    const keys = [
      key('busy', now - 60 * DAY), // used yesterday
      key('stale', now - 60 * DAY), // last used 40 days ago
      key('abandoned', now - 45 * DAY), // never used, made 45 days ago
      key('fresh', now - 2 * DAY), // never used, made 2 days ago
      key('demo', now - 90 * DAY, { demo: true }),
      key('gone', now - 90 * DAY, { expiresAt: now - DAY }), // already expired
      key(ADMIN_KEY_ID, now - 90 * DAY),
    ];
    const insert = db.raw.prepare("INSERT INTO api_keys (id, name, key_hash, key_prefix, last4, created_at) VALUES (?, ?, ?, 'ct_sk_', 'abcd', ?)");
    for (const k of keys) insert.run(k.id, k.name, `h_${k.id}`, k.createdAt);
    const flight = db.raw.prepare("INSERT INTO flights (id, ts, key_id, key_name, kind, dialect, model_requested) VALUES (?, ?, ?, ?, 'chat', 'openai-chat', 'm')");
    flight.run('f1', now - DAY, 'busy', 'busy');
    flight.run('f2', now - 40 * DAY, 'stale', 'stale');
    let reloads = 0;
    const registry = { keysById: new Map(keys.map((k) => [k.id, k])), reload: async () => void reloads++ };

    const retired = await retireIdleKeys({ db, registry } as never, 30, now);
    expect(retired.map((k) => k.id).sort()).toEqual(['abandoned', 'stale']);
    const expiresOf = (id: string) => (db.raw.prepare('SELECT expires_at AS e FROM api_keys WHERE id = ?').get(id) as { e: number | null }).e;
    expect(expiresOf('stale')).toBe(now);
    expect(expiresOf('abandoned')).toBe(now);
    expect(expiresOf('busy')).toBeNull();
    expect(expiresOf('fresh')).toBeNull();
    expect(expiresOf('demo')).toBeNull();
    expect(expiresOf(ADMIN_KEY_ID)).toBeNull();
    expect(reloads).toBe(1);

    // Off means off.
    expect(await retireIdleKeys({ db, registry } as never, 0, now)).toEqual([]);
  });
});
