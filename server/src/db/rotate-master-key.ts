import type { Db } from './index.js';
import type { SecretBox } from '../crypto/secrets.js';

/**
 * Every column encrypted with the master key. Each value's AAD is `<table>.<column>.<row id>`. A new encrypted
 * column must be added here, or rotating the master key would leave it unreadable (a test checks the list
 * against the schema).
 */
export const ENCRYPTED_COLUMNS = [
  ['providers', 'creds_enc'],
  ['mcp_servers', 'auth_enc'],
  ['http_apis', 'auth_enc'],
  ['a2a_agents', 'auth_enc'],
  ['a2a_push_relays', 'target_enc'],
  ['alert_channels', 'config_enc'],
  ['export_destinations', 'config_enc'],
  ['guardrail_services', 'config_enc'],
  ['identity_providers', 'client_secret_enc'],
  ['secret_managers', 'config_enc'],
] as const;

/**
 * Re-encrypt every stored secret under a new master key, in one transaction, and record the new key's id so
 * instances still holding the old key refuse to start. Run with every instance stopped.
 *
 * What was sealed with the old key and not stored is not carried over: delegation tokens issued to agents, and
 * single sign-on attempts under way, stop working.
 */
export async function rotateMasterKey(db: Db, from: SecretBox, to: SecretBox): Promise<Record<string, number>> {
  if (from.keyId === to.keyId) throw new Error('the new master key is the same as the current one');
  const counts: Record<string, number> = {};
  await db.write.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('settings').select('value').where('key', '=', 'master_key_id').executeTakeFirst();
    if (row && row.value !== from.keyId) throw new Error(`this database's master key is ${row.value}, not the current key (${from.keyId}): nothing was changed`);
    for (const [table, column] of ENCRYPTED_COLUMNS) {
      // Table and column names come from the fixed list above.
      const t = trx as unknown as import('kysely').Kysely<Record<string, Record<string, string | null>>>;
      const rows = await t.selectFrom(table).select(['id', column]).where(column, 'is not', null).execute();
      for (const r of rows) {
        const aad = `${table}.${column}.${r.id}`;
        const value = from.decrypt(r[column]!, aad);
        await t.updateTable(table).set({ [column]: to.encrypt(value, aad) }).where('id', '=', r.id!).execute();
      }
      counts[`${table}.${column}`] = rows.length;
    }
    await trx
      .insertInto('settings')
      .values({ key: 'master_key_id', value: to.keyId, updated_at: Date.now() })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: to.keyId, updated_at: Date.now() }))
      .execute();
  });
  return counts;
}
