import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { Budgets } from '../src/limits/budgets.js';
import { MemoryLimiter, SpendTracker } from '../src/limits/limiter.js';
import { LimitExchange, SharedLimiter } from '../src/ee/multi-region/shared-limits.js';

describe('limits shared across regions', () => {
  it("notes what it let through for keys, models and gates, and counts what other regions let through", async () => {
    const east = new SharedLimiter(new MemoryLimiter());
    const west = new SharedLimiter(new MemoryLimiter());
    const now = Date.now();
    for (let i = 0; i < 3; i++) expect((await east.admit('key:k1', 10, { rpm: 4 }, now)).ok).toBe(true);
    // Sign-in throttles and limitless scopes stay local.
    await east.admit('setup:ip:1.2.3.4', 1, { rpm: 10 }, now);
    await east.admit('key:k2', 1, {}, now);
    const sent = east.take();
    expect(sent).toEqual([{ scope: 'key:k1', requests: 3, tokens: 30, rpm: 4 }]);
    expect(east.take()).toEqual([]);
    // West has let nothing through, but east's three count: one more fits, then no.
    await west.apply(sent);
    expect((await west.admit('key:k1', 1, { rpm: 4 })).ok).toBe(true);
    expect((await west.admit('key:k1', 1, { rpm: 4 })).ok).toBe(false);
    // Usage that couldn't be sent is sent next time.
    const again = west.take();
    west.putBack(again);
    expect(west.take()).toEqual(again);
  });

  it('the control plane hands each region what the others let through, once', async () => {
    const x = new LimitExchange(undefined);
    await x.offer('us-east', ['us-east', 'eu-west', 'asia'], [{ scope: 'key:k1', requests: 2, tokens: 20, rpm: 60 }]);
    await x.offer('', ['us-east', 'eu-west', 'asia'], [{ scope: 'key:k1', requests: 1, tokens: 5, rpm: 60 }]);
    expect(await x.drain('us-east')).toEqual([{ scope: 'key:k1', requests: 1, tokens: 5, rpm: 60 }]);
    expect(await x.drain('eu-west')).toEqual([{ scope: 'key:k1', requests: 3, tokens: 25, rpm: 60 }]);
    expect(await x.drain('eu-west')).toEqual([]);
  });

  it('a budget is one total across regions; spend while the answer was on its way is kept', async () => {
    const cpDb = openSqlite('', { memory: true });
    const euDb = openSqlite('', { memory: true });
    const row = { id: 'b1', scope_type: 'key', scope_id: 'k1', limit_nanousd: 100, period: 'total', hard: 1, resets_at: null, spent_nanousd: 0 };
    await cpDb.write.insertInto('budgets').values(row as never).execute();
    await euDb.write.insertInto('budgets').values(row as never).execute();
    const cp = new Budgets(cpDb.write, new SpendTracker());
    const eu = new Budgets(euDb.write, new SpendTracker());
    eu.regional = true;
    await cp.reload();
    await eu.reload();
    // The control plane spends 30 itself (and writes it), the region 25.
    cp.tracker.get('key:k1')!.spent += 30;
    await cp.persist();
    eu.tracker.get('key:k1')!.spent += 25;
    const { items, base } = eu.remoteItems();
    expect(items).toEqual([{ scope: 'key:k1', delta: 25, prev_resets_at: null, resets_at: null }]);
    const totals = await cp.applyRemote(items);
    expect(totals).toEqual([{ scope: 'key:k1', spent: 55, resets_at: null }]);
    eu.tracker.get('key:k1')!.spent += 5; // spent meanwhile
    await eu.settleRemote(totals, base);
    expect(eu.tracker.get('key:k1')!.spent).toBe(60);
    // Its own database keeps the total, for a restart; persist() leaves it alone.
    await eu.persist();
    expect((await euDb.read.selectFrom('budgets').select('spent_nanousd').executeTakeFirstOrThrow()).spent_nanousd).toBe(55);
    // Next time only the 5 goes.
    expect(eu.remoteItems().items[0]!.delta).toBe(5);
    // The control plane sees the region's spend when it next reads the total.
    await cp.persist();
    expect(cp.tracker.get('key:k1')!.spent).toBe(55);
  });
});
