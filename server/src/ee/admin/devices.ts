import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { KeyRecord } from '../../registry.js';
import { ulid } from 'ulid';
import type { AppContext } from '../../context.js';
import { auditOrigin, requireAdmin } from '../../admin/auth.js';
import { requireEnterprise } from './license.js';
import { ACCESS_TTL_S, CLIENT_NAMES, CLIENTS, DEVICE_CODE_GRANT, isClient, type DeviceAuth } from '../devices.js';
import { ROLLOUT_CLIENTS, helperScripts, idpProblem, rolloutFiles, rolloutUrlProblem, type RolloutClient, type RolloutOptions } from '../laptops/templates.js';

/** The address laptops reach this Control Tower at: CT_PUBLIC_URL when set, else the address this request came in on. */
function baseUrl(ctx: AppContext, req: FastifyRequest): string {
  if (ctx.config.publicUrl) return ctx.config.publicUrl.replace(/\/+$/, '');
  return `${req.protocol}://${req.host}`;
}

/** Form (RFC 8628 says so) or JSON bodies, for the endpoints the laptop calls. */
const field = (req: FastifyRequest, name: string): string => {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v.trim() : '';
};

/**
 * Laptop sign-in (Enterprise): the endpoints ct-auth calls (the device flow, refresh, sign out), the person's own
 * approval and sign-ins, and for admins the rules, every sign-in and the rollout files for MDM.
 */
export async function deviceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const devices = ctx.devices as DeviceAuth;
  const licensed = () => ctx.license.allows('laptops');
  const guard = [requireAdmin(ctx), requireEnterprise(ctx, 'laptops')];
  const oauthError = (reply: FastifyReply, status: number, error: string, description: string) => reply.status(status).header('cache-control', 'no-store').send({ error, error_description: description });

  // ---- what the laptop calls (no session: the device code, then the refresh token, is the credential) ----
  await app.register(async (pub) => {
    pub.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));

    pub.post('/device/code', async (req, reply) => {
      // Per address: an office behind one NAT signs many laptops in at once on rollout day.
      const slow = await ctx.limiter.admit(`device:start:${req.ip}`, 1, { rpm: 120 });
      if (!slow.ok) return oauthError(reply, 429, 'slow_down', 'Too many sign-ins started from here. Wait a minute.');
      if (!licensed()) return oauthError(reply, 403, 'unavailable', 'Laptop sign-in needs a Control Tower Enterprise license.');
      const client = field(req, 'client') || 'other';
      if (!isClient(client)) return oauthError(reply, 400, 'invalid_request', `client is one of ${CLIENTS.join(', ')}.`);
      const s = await devices.begin({ client, deviceName: field(req, 'device_name').replace(/[\p{C}<>"`\\]/gu, '').trim().slice(0, 120), ip: req.ip });
      const base = baseUrl(ctx, req);
      return reply.header('cache-control', 'no-store').send({
        device_code: s.deviceCode,
        user_code: s.userCode,
        verification_uri: `${base}/device`,
        verification_uri_complete: `${base}/device?code=${s.userCode}`,
        expires_in: s.expiresIn,
        interval: s.interval,
      });
    });

    pub.post('/device/token', async (req, reply) => {
      const slow = await ctx.limiter.admit(`device:token:${req.ip}`, 1, { rpm: 240 });
      if (!slow.ok) return oauthError(reply, 429, 'slow_down', 'Too many requests from here. Wait a minute.');
      if (!licensed()) return oauthError(reply, 403, 'unavailable', 'Laptop sign-in needs a Control Tower Enterprise license.');
      const grant = field(req, 'grant_type');
      if (grant === DEVICE_CODE_GRANT) {
        const code = field(req, 'device_code');
        if (!code) return oauthError(reply, 400, 'invalid_request', 'device_code is required.');
        const r = await devices.poll(code, req.ip);
        if (!r.ok) return oauthError(reply, r.error === 'unavailable' ? 403 : 400, r.error, r.error_description);
        await ctx.audit?.record({ action: 'devices.sign_in', outcome: 'success', actor: { type: 'person', email: r.person }, status: 200, detail: { key: r.key_name }, ...auditOrigin(req) });
        const { ok: _ok, ...body } = r;
        return reply.header('cache-control', 'no-store').send(body);
      }
      if (grant === 'refresh_token') {
        const token = field(req, 'refresh_token');
        if (!token) return oauthError(reply, 400, 'invalid_request', 'refresh_token is required.');
        const r = await devices.refresh(token, req.ip);
        if (!r.ok) return oauthError(reply, r.error === 'unavailable' ? 403 : 400, r.error, r.error_description);
        const { ok: _ok, sessionId: _s, ...body } = r;
        return reply.header('cache-control', 'no-store').send(body);
      }
      return oauthError(reply, 400, 'unsupported_grant_type', `grant_type is ${DEVICE_CODE_GRANT} or refresh_token.`);
    });

    // Sign out from the laptop (RFC 7009: the answer is the same whether or not the token was known).
    pub.post('/device/revoke', async (req, reply) => {
      const slow = await ctx.limiter.admit(`device:token:${req.ip}`, 1, { rpm: 240 });
      if (!slow.ok) return oauthError(reply, 429, 'slow_down', 'Too many requests from here. Wait a minute.');
      const token = field(req, 'token');
      if (token) {
        const id = await devices.revokeByRefresh(token);
        if (id) await ctx.audit?.record({ action: 'devices.sign_out', outcome: 'success', actor: { type: 'system', id: 'laptop' }, status: 200, target: { type: 'device_sessions', id }, ...auditOrigin(req) });
      }
      return reply.status(200).send({});
    });
  });

  // The helper itself, for trying it by hand before rolling it out (it holds nothing secret).
  app.get('/device/ct-auth.sh', async (_req, reply) => reply.type('text/x-shellscript; charset=utf-8').header('cache-control', 'no-cache').send(helperScripts().sh));
  app.get('/device/ct-auth.ps1', async (_req, reply) => reply.type('text/plain; charset=utf-8').header('cache-control', 'no-cache').send(helperScripts().ps1));

  // ---- the person's own: approve a sign-in, see and end their laptops' sign-ins ----
  const me = (req: FastifyRequest) => req.admin!.adminId;
  const person = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (['admin-key', 'control-plane'].includes(me(req))) {
      reply.status(400).send({ error: { code: 'not_a_person', message: 'Sign in as yourself to approve a laptop: the admin key is no one.' } });
      return false;
    }
    return true;
  };

  app.get('/admin/api/me/devices/pending', { preHandler: guard }, async (req, reply) => {
    if (!person(req, reply)) return reply;
    const code = String((req.query as { code?: string }).code ?? '');
    const slow = await ctx.limiter.admit(`device:lookup:${me(req)}`, 1, { rpm: 30 });
    if (!slow.ok) return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many codes tried. Wait a minute.' } });
    const row = await devices.pending(code);
    if (!row) return reply.status(404).send({ error: { code: 'not_found', message: 'No sign-in is waiting with that code. Codes last 10 minutes: start again on the laptop if it has expired.' } });
    const k = await devices.keyForPerson(me(req), row.client);
    return {
      user_code: row.user_code,
      client: row.client,
      client_name: isClient(row.client) ? CLIENT_NAMES[row.client] : row.client,
      device_name: row.device_name,
      ip: row.ip,
      started_at: row.created_at,
      expires_at: row.expires_at,
      ...('key' in k ? { key: { id: k.key.id, name: k.key.name, team: k.key.team ?? null } } : { problem: k.problem }),
    };
  });

  app.post('/admin/api/me/devices/approve', { preHandler: guard }, async (req, reply) => {
    if (!person(req, reply)) return reply;
    const b = (req.body ?? {}) as { user_code?: string; approve?: boolean };
    const row = await devices.pending(String(b.user_code ?? ''));
    if (!row) return reply.status(404).send({ error: { code: 'not_found', message: 'No sign-in is waiting with that code.' } });
    const approve = b.approve !== false;
    if (approve) {
      const k = await devices.keyForPerson(me(req), row.client);
      if ('problem' in k) return reply.status(409).send({ error: { code: 'no_rule', message: k.problem } });
    }
    const ok = await devices.decide(row.user_code, me(req), approve);
    if (!ok) return reply.status(409).send({ error: { code: 'already_decided', message: 'That sign-in was already approved or refused.' } });
    return { ok: true, approved: approve, client: row.client, device_name: row.device_name };
  });

  const sessionView = (s: { id: string; admin_id: string; client: string; device_name: string; created_at: number; last_used_at: number; last_ip: string | null; expires_at: number; revoked_at: number | null; revoked_by: string | null; key_id: string | null }, email?: string) => {
    const idleUntil = s.last_used_at + devices.settings.idleDays * 86_400_000;
    const now = Date.now();
    const status = s.revoked_at ? 'revoked' : s.expires_at < now || idleUntil < now ? 'expired' : 'active';
    return {
      id: s.id,
      person: email,
      client: s.client,
      client_name: isClient(s.client) ? CLIENT_NAMES[s.client] : s.client,
      device_name: s.device_name,
      created_at: s.created_at,
      last_used_at: s.last_used_at,
      last_ip: s.last_ip,
      ends_at: Math.min(s.expires_at, idleUntil),
      status,
      revoked_at: s.revoked_at,
      revoked_by: s.revoked_by,
      key: s.key_id ? { id: s.key_id, name: ctx.registry.keysById.get(s.key_id)?.name ?? null } : null,
    };
  };

  app.get('/admin/api/me/devices', { preHandler: guard }, async (req) => {
    const rows = await ctx.db.read.selectFrom('device_sessions').selectAll().where('admin_id', '=', me(req)).orderBy('created_at', 'desc').limit(200).execute();
    return { sessions: rows.map((r) => sessionView(r)), token_ttl_s: ACCESS_TTL_S };
  });

  app.delete('/admin/api/me/devices/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = await ctx.db.read.selectFrom('device_sessions').select(['id']).where('id', '=', id).where('admin_id', '=', me(req)).executeTakeFirst();
    if (!row) return reply.status(404).send({ error: { code: 'not_found', message: 'sign-in not found' } });
    await devices.revoke(id, req.admin!.email);
    return { ok: true };
  });

  // ---- admins: every laptop, the rules, settings and the rollout files ----
  app.get('/admin/api/devices', { preHandler: guard }, async (req) => {
    const rows = await ctx.db.read
      .selectFrom('device_sessions as s')
      .leftJoin('admins as a', 'a.id', 's.admin_id')
      .selectAll('s')
      .select('a.email')
      .orderBy('s.last_used_at', 'desc')
      .limit(1000)
      .execute();
    const teams = await ctx.db.read.selectFrom('teams').select(['id', 'name']).execute();
    const teamName = new Map(teams.map((t) => [t.id, t.name]));
    return {
      sessions: rows.map((r) => sessionView(r, r.email ?? '(removed)')),
      rules: devices.ruleList.map((r) => ({ id: r.id, client: r.client, team_id: r.teamId, team: r.teamId ? (teamName.get(r.teamId) ?? null) : null, key_id: r.keyId, key: ctx.registry.keysById.get(r.keyId)?.name ?? null })),
      settings: { session_days: devices.settings.sessionDays, idle_days: devices.settings.idleDays, token_ttl_s: ACCESS_TTL_S },
      url: baseUrl(ctx, req),
      public_url_set: !!ctx.config.publicUrl,
    };
  });

  app.delete('/admin/api/devices/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ok = await devices.revoke(id, req.admin!.email);
    if (!ok) return reply.status(404).send({ error: { code: 'not_found', message: 'no active sign-in with that id' } });
    return { ok: true };
  });

  // Replaces the rules, in order: the first that matches a person and client decides the key.
  app.put('/admin/api/devices/rules', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { rules?: Array<{ client?: string; team_id?: string | null; key_id?: string }> };
    if (!Array.isArray(b.rules) || b.rules.length > 200) return reply.status(400).send({ error: { code: 'invalid', message: 'Send {"rules": [{client, team_id, key_id}, …]}.' } });
    const teams = new Set((await ctx.db.read.selectFrom('teams').select('id').execute()).map((t) => t.id));
    for (const r of b.rules) {
      if (r.client !== '*' && !isClient(r.client)) return reply.status(400).send({ error: { code: 'invalid', message: `client is * or one of ${CLIENTS.join(', ')}.` } });
      if (r.team_id && !teams.has(r.team_id)) return reply.status(400).send({ error: { code: 'invalid', message: `No team ${r.team_id}.` } });
      const key = r.key_id ? ctx.registry.keysById.get(r.key_id) : undefined;
      if (!key) return reply.status(400).send({ error: { code: 'invalid', message: `No key ${r.key_id ?? '(none)'}.` } });
      if (key.demo) return reply.status(400).send({ error: { code: 'invalid', message: 'Demo keys can\'t be used for laptops.' } });
    }
    const now = Date.now();
    await ctx.db.write.transaction().execute(async (tx) => {
      await tx.deleteFrom('device_rules').execute();
      if (b.rules!.length) await tx.insertInto('device_rules').values(b.rules!.map((r, i) => ({ id: ulid(), position: i, client: r.client!, team_id: r.team_id || null, key_id: r.key_id!, created_at: now }))).execute();
    });
    await devices.reload();
    return { ok: true, rules: devices.ruleList.map((r) => ({ id: r.id, client: r.client, team_id: r.teamId, key_id: r.keyId })) };
  });

  app.put('/admin/api/devices/settings', { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as { session_days?: number; idle_days?: number };
    const ok = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 365);
    if (!ok(b.session_days) || !ok(b.idle_days)) return reply.status(400).send({ error: { code: 'invalid', message: 'session_days and idle_days are whole days, 1 to 365.' } });
    const now = Date.now();
    for (const [k, v] of [['devices_session_days', b.session_days], ['devices_idle_days', b.idle_days]] as const) {
      if (v === undefined) continue;
      await ctx.db.write.insertInto('settings').values({ key: k, value: String(v), updated_at: now }).onConflict((oc) => oc.column('key').doUpdateSet({ value: String(v), updated_at: now })).execute();
    }
    await devices.reload();
    return { ok: true, settings: { session_days: devices.settings.sessionDays, idle_days: devices.settings.idleDays } };
  });

  // The files IT uploads to its MDM, for the clients chosen, with this Control Tower's address in them.
  app.get('/admin/api/devices/rollout', { preHandler: guard }, async (req, reply) => {
    const q = req.query as { url?: string; clients?: string; mcp?: string; lockdown?: string; idp_issuer_id?: string; idp_client_id?: string; idp_scope?: string; idp_token?: string };
    const url = (q.url?.trim() || baseUrl(ctx, req)).replace(/\/+$/, '');
    const problem = rolloutUrlProblem(url);
    if (problem) return reply.status(400).send({ error: { code: 'invalid', message: problem } });
    const clients = (q.clients ? q.clients.split(',') : ROLLOUT_CLIENTS).filter((c): c is RolloutClient => (ROLLOUT_CLIENTS as string[]).includes(c));
    if (!clients.length) return reply.status(400).send({ error: { code: 'invalid', message: `Choose at least one of ${ROLLOUT_CLIENTS.join(', ')}.` } });
    // Signing in with the identity provider: one of Agent identity's trusted issuers, whose rules map people to keys.
    let idp: RolloutOptions['idp'];
    let issuerInfo: { id: string; name: string; issuer: string; principal_claim: string; rules: number; enabled: boolean; people: boolean } | undefined;
    if (q.idp_issuer_id) {
      const row = await ctx.db.read.selectFrom('token_issuers').selectAll().where('id', '=', q.idp_issuer_id).executeTakeFirst();
      if (!row) return reply.status(400).send({ error: { code: 'invalid', message: 'No such trusted issuer: add your identity provider under Agent identity first.' } });
      const clientId = (q.idp_client_id ?? '').trim();
      const audiences = JSON.parse(row.audiences || '[]') as string[];
      if (!clientId) return reply.status(400).send({ error: { code: 'invalid', message: 'Enter the client ID of the app laptops sign in with, registered at your identity provider.' } });
      if ((q.idp_token ?? 'id_token') === 'id_token' && !audiences.includes(clientId)) return reply.status(400).send({ error: { code: 'invalid', message: `ID tokens for ${clientId} are meant for that app: add "${clientId}" to ${row.name}'s accepted audiences under Agent identity, or Control Tower will refuse them.` } });
      idp = { issuer: row.issuer, clientId, scope: q.idp_scope?.trim() || undefined, token: q.idp_token === 'access_token' ? 'access_token' : 'id_token' };
      const problem = idpProblem(idp);
      if (problem) return reply.status(400).send({ error: { code: 'invalid', message: problem } });
      issuerInfo = { id: row.id, name: row.name, issuer: row.issuer, principal_claim: row.principal_claim, rules: (JSON.parse(row.rules || "[]") as unknown[]).length, enabled: !!row.enabled, people: !!row.people };
    }
    const files = rolloutFiles({ url, clients, mcp: q.mcp !== '0', lockdown: q.lockdown !== '0', idp });
    // Claude Desktop lists the Claude models Control Tower serves (GET /v1/models) and won't start without one ("Gateway
    // returned no usable models"). Models added on first use aren't listed until then: say so before it's rolled out.
    const warnings: string[] = [];
    if (clients.includes('claude-desktop')) {
      const claude = (k: KeyRecord) => ctx.registry.visibleModels(k).some((m) => /claude/i.test(m.id));
      const keyIds = idp ? [] : devices.ruleList.filter((r) => r.client === '*' || r.client === 'claude-desktop').map((r) => r.keyId);
      const keys = [...new Set(keyIds)].map((id) => ctx.registry.keysById.get(id)).filter((k): k is KeyRecord => !!k);
      const without = keys.filter((k) => !claude(k)).map((k) => k.name);
      const anyClaude = [...ctx.registry.keysById.values()].some((k) => !k.demo && claude(k));
      if (without.length) warnings.push(`Claude Desktop won't start for people whose key lists no Claude model (${without.join(', ')}): it shows "Gateway returned no usable models". Add a Claude model under Models (models added on first use aren't listed until someone uses them), or allow one on those keys.`);
      else if (!keys.length && !anyClaude) warnings.push('Claude Desktop won\'t start until Control Tower lists a Claude model: it shows "Gateway returned no usable models". Add one under Models before rolling it out.');
    }
    return { url, https: url.startsWith('https://'), clients, files, warnings, ...(issuerInfo ? { idp: issuerInfo } : {}) };
  });
}
