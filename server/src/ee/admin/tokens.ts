import type { FastifyInstance, FastifyReply } from 'fastify';
import { ulid } from 'ulid';
import type { AppContext } from '../../context.js';
import { requireAdmin } from '../../admin/auth.js';
import { requireEnterprise } from './license.js';
import { looksLikeJwt, type TokenRule } from '../tokens.js';

/**
 * Token issuers: the identity providers whose tokens agents may present instead of a key's secret, and the rules
 * that map a token's claims to a key. Admins only; Enterprise.
 */
export async function tokenIssuerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const tokens = ctx.tokens;
  if (!tokens) return;
  const guard = [requireAdmin(ctx), requireEnterprise(ctx, 'jwt_auth')];
  const bad = (reply: FastifyReply, message: string) => reply.status(400).send({ error: { code: 'invalid', message } });
  const notFound = (reply: FastifyReply) => reply.status(404).send({ error: { code: 'not_found', message: 'token issuer not found' } });

  interface Body {
    name?: string;
    issuer?: string;
    jwks_uri?: string | null;
    jwks?: unknown;
    audiences?: unknown;
    rules?: unknown;
    principal_claim?: string;
    max_lifetime_s?: number | null;
    enabled?: boolean;
  }
  /** The stored values for a body (whole, or the fields a change sets), or what's wrong with it. */
  const parse = (b: Body, partial: boolean): Record<string, unknown> | string => {
    const out: Record<string, unknown> = {};
    if (!partial || b.name !== undefined) {
      const name = (b.name ?? '').trim();
      if (!name) return 'name is required';
      out.name = name.slice(0, 120);
    }
    if (!partial || b.issuer !== undefined) {
      const iss = (b.issuer ?? '').trim();
      if (!iss) return 'issuer is required: the tokens\' iss claim, exactly';
      out.issuer = iss.slice(0, 500);
    }
    if (b.jwks_uri !== undefined) {
      if (b.jwks_uri !== null && b.jwks_uri !== '' && !/^https?:\/\//.test(b.jwks_uri)) return 'jwks_uri must be an http(s) URL';
      out.jwks_uri = b.jwks_uri || null;
    }
    if (b.jwks !== undefined) {
      if (b.jwks === null || b.jwks === '') out.jwks_json = null;
      else {
        let j: unknown = b.jwks;
        if (typeof j === 'string') {
          try {
            j = JSON.parse(j);
          } catch {
            return 'jwks must be a JSON Web Key Set';
          }
        }
        const keys = (j as { keys?: unknown })?.keys;
        if (!Array.isArray(keys) || !keys.length) return 'jwks must be a JSON Web Key Set: {"keys": [...]}';
        for (const k of keys as Array<Record<string, unknown>>) {
          if (!k || typeof k !== 'object' || !['RSA', 'EC', 'OKP'].includes(String(k.kty))) return 'jwks keys must be public RSA, EC or OKP keys';
          // A signing key's private part never belongs here.
          if ('d' in k || 'p' in k || 'q' in k) return 'jwks contains a private key: give only the public keys';
        }
        out.jwks_json = JSON.stringify({ keys });
      }
    }
    if (!partial || b.audiences !== undefined) {
      const a = Array.isArray(b.audiences) ? (b.audiences as unknown[]).map((x) => String(x).trim()).filter(Boolean) : typeof b.audiences === 'string' ? b.audiences.split(',').map((x) => x.trim()).filter(Boolean) : [];
      if (!a.length) return 'audiences are required: the aud a token must carry to be accepted here (so tokens meant for other services are refused)';
      out.audiences = JSON.stringify(a.slice(0, 20));
    }
    if (!partial || b.rules !== undefined) {
      if (!Array.isArray(b.rules)) return 'rules must be a list of {claims, key_id}';
      const rules: TokenRule[] = [];
      for (const r of b.rules as Array<{ claims?: unknown; key_id?: unknown }>) {
        const claims = r?.claims && typeof r.claims === 'object' && !Array.isArray(r.claims) ? (r.claims as Record<string, unknown>) : undefined;
        const entries = Object.entries(claims ?? {}).map(([k, v]) => [k.trim(), String(v ?? '').trim()] as const).filter(([k, v]) => k && v);
        if (!entries.length) return 'each rule needs at least one claim to match, e.g. {"sub": "system:serviceaccount:prod:invoice-bot"}';
        if (entries.every(([, v]) => /^\*+$/.test(v))) return 'a rule must match something more specific than "*"';
        if (typeof r.key_id !== 'string' || !ctx.registry.keysById.has(r.key_id)) return `key ${String(r.key_id ?? '')} not found`;
        rules.push({ claims: Object.fromEntries(entries), key_id: r.key_id });
      }
      out.rules = JSON.stringify(rules.slice(0, 200));
    }
    if (b.principal_claim !== undefined) out.principal_claim = (b.principal_claim || 'sub').trim().slice(0, 100);
    if (b.max_lifetime_s !== undefined) {
      if (b.max_lifetime_s !== null && !(Number.isInteger(b.max_lifetime_s) && b.max_lifetime_s > 0)) return 'max_lifetime_s must be a whole number of seconds';
      out.max_lifetime_s = b.max_lifetime_s;
    }
    if (typeof b.enabled === 'boolean') out.enabled = b.enabled ? 1 : 0;
    return out;
  };

  const view = async () => {
    const rows = await ctx.db.read.selectFrom('token_issuers').selectAll().orderBy('created_at').execute();
    return rows.map((r) => {
      const live = tokens.stats(r.id);
      const rules = JSON.parse(r.rules) as TokenRule[];
      return {
        id: r.id,
        name: r.name,
        issuer: r.issuer,
        jwks_uri: r.jwks_uri,
        jwks_keys: r.jwks_json ? (JSON.parse(r.jwks_json) as { keys: unknown[] }).keys.length : null,
        audiences: JSON.parse(r.audiences) as string[],
        rules: rules.map((x) => ({ ...x, key_name: ctx.registry.keysById.get(x.key_id)?.name ?? null })),
        principal_claim: r.principal_claim,
        max_lifetime_s: r.max_lifetime_s,
        enabled: r.enabled === 1,
        keys_status: live?.keys_status ?? r.last_status,
        keys_error: live?.keys_error ?? r.last_error,
        accepted: live?.accepted ?? r.accepted_count,
        refused: live?.refused ?? r.refused_count,
        last_refusal: live?.last_refusal ?? r.last_refusal,
        last_refusal_at: live?.last_refusal_at ?? r.last_refusal_at,
        last_used_at: live?.last_used_at ?? r.last_used_at,
        created_at: r.created_at,
      };
    });
  };

  app.get('/admin/api/token-issuers', { preHandler: guard }, async () => ({ issuers: await view() }));

  app.post('/admin/api/token-issuers', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as Body;
    const v = parse(b, false);
    if (typeof v === 'string') return bad(reply, v);
    if (!b.jwks && !b.jwks_uri && !/^https:\/\//.test(String(v.issuer))) return bad(reply, 'an issuer that is not an https URL needs its keys: a jwks_uri, or the jwks themselves');
    if (await ctx.db.read.selectFrom('token_issuers').select('id').where('issuer', '=', String(v.issuer)).executeTakeFirst()) return reply.status(409).send({ error: { code: 'exists', message: 'that issuer is already set up' } });
    const id = ulid();
    const now = Date.now();
    await ctx.db.write
      .insertInto('token_issuers')
      .values({
        id,
        name: v.name as string,
        issuer: v.issuer as string,
        jwks_uri: (v.jwks_uri as string | null | undefined) ?? null,
        jwks_json: (v.jwks_json as string | null | undefined) ?? null,
        audiences: v.audiences as string,
        rules: v.rules as string,
        principal_claim: (v.principal_claim as string | undefined) ?? 'sub',
        max_lifetime_s: (v.max_lifetime_s as number | null | undefined) ?? 86_400,
        enabled: v.enabled === 0 ? 0 : 1,
        last_status: null,
        last_error: null,
        accepted_count: 0,
        refused_count: 0,
        last_refusal: null,
        last_refusal_at: null,
        last_used_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await tokens.reload();
    return reply.status(201).send({ id, issuer: (await view()).find((x) => x.id === id) });
  });

  app.patch('/admin/api/token-issuers/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const cur = await ctx.db.read.selectFrom('token_issuers').select(['id', 'issuer', 'jwks_uri', 'jwks_json']).where('id', '=', id).executeTakeFirst();
    if (!cur) return notFound(reply);
    const v = parse((req.body ?? {}) as Body, true);
    if (typeof v === 'string') return bad(reply, v);
    const iss = (v.issuer as string | undefined) ?? cur.issuer;
    const jwks = v.jwks_json !== undefined ? v.jwks_json : cur.jwks_json;
    const uri = v.jwks_uri !== undefined ? v.jwks_uri : cur.jwks_uri;
    if (!jwks && !uri && !/^https:\/\//.test(iss)) return bad(reply, 'an issuer that is not an https URL needs its keys: a jwks_uri, or the jwks themselves');
    if (v.issuer && v.issuer !== cur.issuer && (await ctx.db.read.selectFrom('token_issuers').select('id').where('issuer', '=', iss).executeTakeFirst())) return reply.status(409).send({ error: { code: 'exists', message: 'that issuer is already set up' } });
    await ctx.db.write.updateTable('token_issuers').set({ ...v, updated_at: Date.now() }).where('id', '=', id).execute();
    await tokens.reload();
    return { ok: true };
  });

  app.delete('/admin/api/token-issuers/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = await ctx.db.write.deleteFrom('token_issuers').where('id', '=', id).executeTakeFirst();
    if (Number(r.numDeletedRows) === 0) return notFound(reply);
    await tokens.reload();
    return { ok: true };
  });

  // Fetch an issuer's signing keys now.
  app.post('/admin/api/token-issuers/:id/test', { preHandler: guard }, async (req) => tokens.test((req.params as { id: string }).id));

  // Which key a token would be used as, or why it would be refused (to set up rules). The token isn't stored.
  app.post('/admin/api/token-issuers/check', { preHandler: guard }, async (req, reply) => {
    const token = String(((req.body ?? {}) as { token?: string }).token ?? '').trim().replace(/^bearer\s+/i, '');
    if (!looksLikeJwt(token)) return bad(reply, 'that is not a JWT');
    const v = await tokens.verify(token);
    if ('refused' in v) return { ok: false, reason: v.refused };
    const key = ctx.registry.keysById.get(v.keyId);
    return { ok: true, key: { id: v.keyId, name: key?.name ?? null }, principal: v.principal, expires_at: v.exp * 1000 };
  });
}
