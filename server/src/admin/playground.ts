import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { AppContext } from '../context.js';
import type { Database } from '../db/schema.js';
import { requireAdmin } from './auth.js';
import { FlightRunner } from '../pipeline/flight.js';
import { generateApiKey } from '../crypto/apikeys.js';

export const PLAYGROUND_KEY_ID = 'key_playground';

/**
 * The console's Playground sends requests through the real pipeline under a
 * system key, so playground flights show on the Airspace and in the Ledger
 * like any other agent. The key's secret is never revealed; the admin
 * session authorises the call.
 */
export async function ensurePlaygroundKey(db: Kysely<Database>): Promise<void> {
  const existing = await db.selectFrom('api_keys').select('id').where('id', '=', PLAYGROUND_KEY_ID).executeTakeFirst();
  if (existing) return;
  const gen = generateApiKey();
  await db
    .insertInto('api_keys')
    .values({
      id: PLAYGROUND_KEY_ID,
      name: 'playground',
      key_hash: gen.hash,
      key_prefix: gen.prefix,
      last4: gen.last4,
      agent_id: 'playground',
      team: null,
      project: null,
      tags: JSON.stringify(['system']),
      allowed_models: JSON.stringify(['*']),
      allowed_mcp: JSON.stringify(['*']),
      limits: JSON.stringify({}),
      enabled: 1,
      expires_at: null,
      created_by: 'system',
      demo: 0,
      created_at: Date.now(),
      last_used_at: null,
    })
    .execute();
}

export async function playgroundRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  const runner = new FlightRunner(ctx);

  app.post('/admin/api/playground/chat', { preHandler: guard }, async (req, reply) => {
    const key = ctx.registry.keysById.get(PLAYGROUND_KEY_ID);
    if (!key) return reply.status(500).send({ error: { code: 'no_playground_key', message: 'Playground key missing; restart the server.' } });
    await runner.runChat(req, reply, 'openai-chat', { keyOverride: key });
  });
}
