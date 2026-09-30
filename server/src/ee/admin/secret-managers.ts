import type { FastifyInstance, FastifyReply } from 'fastify';
import { ulid } from 'ulid';
import type { AppContext } from '../../context.js';
import { requireAdmin } from '../../admin/auth.js';
import { requireEnterprise } from './license.js';
import { MANAGER_KINDS, MANAGER_SECRET_FIELDS, managerHint, managerProblem, type ManagerConfig, type ManagerKind } from '../secret-managers/backends.js';
import { parseRef, secretRefs } from '../secret-managers/index.js';

/**
 * Secret managers: where credentials referenced as secret://<name>/<path>#<field> are read from. Their own
 * credentials are stored encrypted and never returned. Admins only; Enterprise.
 */
export async function secretManagerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = [requireAdmin(ctx), requireEnterprise(ctx, 'secret_managers')];
  const bad = (reply: FastifyReply, message: string) => reply.status(400).send({ error: { code: 'invalid', message } });
  const notFound = (reply: FastifyReply) => reply.status(404).send({ error: { code: 'not_found', message: 'secret manager not found' } });
  const aad = (id: string) => `secret_managers.config_enc.${id}`;
  const isSecret = (k: string) => (MANAGER_SECRET_FIELDS as readonly string[]).includes(k);
  const stored = async (id: string) => {
    const r = await ctx.db.read.selectFrom('secret_managers').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? { row: r, config: JSON.parse(ctx.secrets.decrypt(r.config_enc, aad(r.id))) as ManagerConfig } : undefined;
  };
  const refresh = (v: unknown): number | string => {
    if (v === undefined) return 300;
    const n = Number(v);
    return Number.isInteger(n) && n >= 30 && n <= 86_400 ? n : 'refresh_s must be between 30 and 86400 seconds';
  };

  app.get('/admin/api/secret-managers', { preHandler: guard }, async () => {
    const rows = await ctx.db.read.selectFrom('secret_managers').selectAll().orderBy('created_at').execute();
    return {
      kinds: MANAGER_KINDS,
      managers: rows.map((r) => {
        let config: ManagerConfig = {};
        try {
          config = JSON.parse(ctx.secrets.decrypt(r.config_enc, aad(r.id))) as ManagerConfig;
        } catch {
          // shown without settings
        }
        const pub: Record<string, unknown> = {};
        const set: string[] = [];
        for (const [k, v] of Object.entries(config)) {
          if (isSecret(k)) {
            if (v) set.push(k);
          } else pub[k] = v;
        }
        return { id: r.id, name: r.name, kind: r.kind, target_hint: r.target_hint, refresh_s: r.refresh_s, config: pub, secrets_set: set, created_at: r.created_at };
      }),
      refs: secretRefs.states(),
    };
  });

  app.post('/admin/api/secret-managers', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; kind?: string; config?: ManagerConfig; refresh_s?: number };
    const name = (b.name ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) return bad(reply, 'name must be lowercase letters, digits, - or _ (references use it: secret://<name>/…)');
    const kind = b.kind as ManagerKind;
    if (!(MANAGER_KINDS as readonly string[]).includes(kind)) return bad(reply, `kind must be one of ${MANAGER_KINDS.join(', ')}`);
    const config = Object.fromEntries(Object.entries(b.config ?? {}).filter(([, v]) => v !== '' && v !== null && v !== undefined)) as ManagerConfig;
    const problem = managerProblem(kind, config);
    if (problem) return bad(reply, problem);
    const r = refresh(b.refresh_s);
    if (typeof r === 'string') return bad(reply, r);
    if (await ctx.db.read.selectFrom('secret_managers').select('id').where('name', '=', name).executeTakeFirst()) return reply.status(409).send({ error: { code: 'exists', message: `a secret manager is already named "${name}"` } });
    const id = ulid();
    const now = Date.now();
    await ctx.db.write.insertInto('secret_managers').values({ id, name, kind, config_enc: ctx.secrets.encrypt(JSON.stringify(config), aad(id)), target_hint: managerHint(kind, config), refresh_s: r, created_at: now, updated_at: now }).execute();
    await secretRefs.reload();
    return reply.status(201).send({ id, name });
  });

  app.patch('/admin/api/secret-managers/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const cur = await stored(id);
    if (!cur) return notFound(reply);
    const b = (req.body ?? {}) as { config?: ManagerConfig; refresh_s?: number };
    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (b.refresh_s !== undefined) {
      const r = refresh(b.refresh_s);
      if (typeof r === 'string') return bad(reply, r);
      patch.refresh_s = r;
    }
    if (b.config) {
      // Secrets left empty keep their stored values; other fields set to "" are cleared.
      const merged = { ...cur.config } as Record<string, unknown>;
      for (const [k, v] of Object.entries(b.config)) {
        if (isSecret(k) && (v === '' || v === undefined)) continue;
        if (v === '' || v === null) delete merged[k];
        else merged[k] = v;
      }
      const problem = managerProblem(cur.row.kind as ManagerKind, merged as ManagerConfig);
      if (problem) return bad(reply, problem);
      patch.config_enc = ctx.secrets.encrypt(JSON.stringify(merged), aad(id));
      patch.target_hint = managerHint(cur.row.kind as ManagerKind, merged as ManagerConfig);
    }
    await ctx.db.write.updateTable('secret_managers').set(patch).where('id', '=', id).execute();
    await secretRefs.reload();
    return { ok: true };
  });

  app.delete('/admin/api/secret-managers/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const cur = await stored(id);
    if (!cur) return notFound(reply);
    // Removing a manager still referenced would leave those credentials unreadable after a restart.
    const using = secretRefs.states().filter((s) => s.manager === cur.row.name).flatMap((s) => s.used_by);
    if (using.length && (req.query as { force?: string }).force !== 'true') return reply.status(409).send({ error: { code: 'in_use', message: `still referenced by ${[...new Set(using)].slice(0, 5).join(', ')}; change those first, or delete with ?force=true` } });
    await ctx.db.write.deleteFrom('secret_managers').where('id', '=', id).execute();
    await secretRefs.reload();
    return { ok: true };
  });

  // Check the settings; with {ref} (or {path}), also read that secret — never answering its value.
  app.post('/admin/api/secret-managers/:id/test', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const cur = await stored(id);
    if (!cur) return notFound(reply);
    const b = (req.body ?? {}) as { ref?: string; path?: string };
    try {
      const message = await secretRefs.test(cur.row.name);
      const ref = b.ref ?? (b.path ? `secret://${cur.row.name}/${b.path.replace(/^\/+/, '')}` : undefined);
      if (!ref) return { ok: true, message };
      const parsed = parseRef(ref);
      if (!parsed || parsed.manager !== cur.row.name) return { ok: false, message: `${ref} is not a reference to ${cur.row.name}: write secret://${cur.row.name}/<path>#<field>` };
      const value = await secretRefs.resolve(ref);
      return { ok: true, message: `${message}; read ${ref} (${value.length} characters)` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  // Read every referenced secret again now.
  app.post('/admin/api/secret-managers/refresh', { preHandler: guard }, async () => {
    await secretRefs.refreshAll();
    return { refs: secretRefs.states() };
  });
}
