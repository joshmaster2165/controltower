import { openPostgres, openSqlite } from './index.js';

/**
 * Copy a SQLite install into a new Postgres database, to move to several instances without starting over.
 * The destination is migrated first and must be empty. Tables go in an order that satisfies their foreign
 * keys, in batches; the master key's id comes along, so the instances must keep using this install's master
 * key (CT_MASTER_KEY) — the stored credentials are encrypted with it.
 */
export async function copySqliteToPostgres(dataDir: string, url: string, log: (line: string) => void = console.log): Promise<Record<string, number>> {
  const src = openSqlite(dataDir);
  const dst = await openPostgres(url);
  const pool = dst.pool!;
  try {
    const busy = await pool.query<{ n: string }>('SELECT (SELECT COUNT(*) FROM admins) + (SELECT COUNT(*) FROM api_keys) AS n');
    if (Number(busy.rows[0]!.n) > 0) throw new Error('the Postgres database already has data (admins or keys): copy into an empty one');

    const tables = (src.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'").all() as Array<{ name: string }>).map((t) => t.name);
    // Parents before children.
    const deps = new Map(tables.map((t) => [t, (src.raw.prepare(`PRAGMA foreign_key_list(${JSON.stringify(t)})`).all() as Array<{ table: string }>).map((f) => f.table).filter((p) => p !== t)]));
    const order: string[] = [];
    const visit = (t: string, seen = new Set<string>()) => {
      if (order.includes(t) || seen.has(t)) return;
      seen.add(t);
      for (const p of deps.get(t) ?? []) visit(p, seen);
      order.push(t);
    };
    for (const t of tables) visit(t);

    const counts: Record<string, number> = {};
    for (const t of order) {
      const target = await pool.query<{ column_name: string }>('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [t]);
      const have = new Set(target.rows.map((r) => r.column_name));
      if (!have.size) continue;
      const cols = (src.raw.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all() as Array<{ name: string }>).map((c) => c.name).filter((c) => have.has(c));
      const quoted = cols.map((c) => `"${c}"`).join(', ');
      let batch: unknown[][] = [];
      let n = 0;
      const flush = async () => {
        if (!batch.length) return;
        const vals: unknown[] = [];
        const rows = batch.map((r) => `(${r.map((v) => (vals.push(v), `$${vals.length}`)).join(', ')})`);
        await pool.query(`INSERT INTO "${t}" (${quoted}) VALUES ${rows.join(', ')} ON CONFLICT DO NOTHING`, vals);
        n += batch.length;
        batch = [];
      };
      const size = Math.max(1, Math.floor(30_000 / Math.max(1, cols.length)));
      for (const row of src.raw.prepare(`SELECT ${quoted} FROM "${t}"`).iterate() as Iterable<Record<string, unknown>>) {
        batch.push(cols.map((c) => row[c] ?? null));
        if (batch.length >= size) await flush();
      }
      await flush();
      counts[t] = n;
      if (n) log(`  ${t}: ${n.toLocaleString()} rows`);
    }
    return counts;
  } finally {
    src.close();
    await dst.close();
  }
}
