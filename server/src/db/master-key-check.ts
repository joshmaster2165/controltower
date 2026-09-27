import type { Db } from './index.js';

/**
 * Every instance on a database must use the same master key: it encrypts provider credentials and signs
 * delegation tokens. The first instance records its key's id; one with a different key refuses to start
 * rather than fail later on every secret.
 */
export async function checkMasterKey(db: Db, keyId: string): Promise<void> {
  const row = await db.read.selectFrom('settings').select('value').where('key', '=', 'master_key_id').executeTakeFirst();
  if (!row) {
    await db.write
      .insertInto('settings')
      .values({ key: 'master_key_id', value: keyId, updated_at: Date.now() })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute();
    return;
  }
  if (row.value !== keyId)
    throw new Error(
      `this database was set up with a different master key (${row.value}); this instance has ${keyId}. Every instance sharing a database must use the same CT_MASTER_KEY.`,
    );
}
