import { ulid } from 'ulid';
import type { AppContext } from '../context.js';
import { hashPassword } from '../crypto/secrets.js';
import { hashApiKey } from '../crypto/apikeys.js';

/**
 * The admin key (CT_ADMIN_KEY, or general_settings.master_key in a --config
 * file) is:
 *  - a bearer token for the admin API and the /key and /model routes (see requireAdmin);
 *  - an all-access key for model and tool calls, shown as the agent "master-key";
 *  - the console password for UI_USERNAME (default "admin"), unless UI_PASSWORD is set.
 * The console sign-in is only created on a fresh install; its password then follows
 * the admin key (or UI_PASSWORD) on every boot, so rotating the key rotates it.
 */
export const ADMIN_KEY_ID = 'key_admin_master';
const ENV_ADMIN = 'env_admin_email';

export async function applyAdminKey(ctx: AppContext): Promise<void> {
  const key = ctx.config.adminKey;
  const w = ctx.db.write;
  const now = Date.now();
  if (!key) {
    await w.updateTable('api_keys').set({ enabled: 0 }).where('id', '=', ADMIN_KEY_ID).execute();
    await ctx.registry.reload();
    return;
  }
  if (key.length < 16) ctx.log.warn('The admin key is shorter than 16 characters — use a long random value (e.g. sk-$(openssl rand -hex 32)).');

  await w
    .insertInto('api_keys')
    .values({
      id: ADMIN_KEY_ID,
      name: 'master-key',
      key_hash: hashApiKey(key),
      key_prefix: key.slice(0, 6),
      last4: key.slice(-4),
      agent_id: 'master-key',
      team: null,
      project: null,
      tags: JSON.stringify(['admin']),
      allowed_models: JSON.stringify(['*']),
      allowed_mcp: JSON.stringify(['*']),
      limits: JSON.stringify({}),
      enabled: 1,
      expires_at: null,
      created_by: 'admin key',
      demo: 0,
      created_at: now,
      last_used_at: null,
    })
    .onConflict((oc) => oc.column('id').doUpdateSet({ key_hash: hashApiKey(key), key_prefix: key.slice(0, 6), last4: key.slice(-4), enabled: 1 }))
    .execute();
  await ctx.registry.reload();

  // Console sign-in: UI_USERNAME / (UI_PASSWORD or the admin key).
  const username = ctx.config.uiUsername.trim().toLowerCase();
  const password = ctx.config.uiPassword ?? key;
  const admins = await w.selectFrom('admins').select(['id', 'email']).execute();
  const marker = await w.selectFrom('settings').select('value').where('key', '=', ENV_ADMIN).executeTakeFirst();
  if (!admins.length) {
    await w.transaction().execute(async (trx) => {
      await trx.insertInto('admins').values({ id: ulid(), email: username, password_hash: await hashPassword(password), created_at: now }).execute();
      for (const [k, v] of [['setup_complete', '1'], [ENV_ADMIN, username]] as const) {
        await trx.insertInto('settings').values({ key: k, value: v, updated_at: now }).onConflict((oc) => oc.column('key').doUpdateSet({ value: v, updated_at: now })).execute();
      }
    });
    ctx.log.info({ username }, 'console sign-in created from the admin key');
  } else if (marker && admins.some((a) => a.email === marker.value)) {
    await w.updateTable('admins').set({ password_hash: await hashPassword(password) }).where('email', '=', marker.value).execute();
  }
}
