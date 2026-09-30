import { extractApiKey } from './gateway/key.js';
import fs from 'node:fs';
import { keyLifecycleRoutes } from './admin/key-lifecycle.js';
import path from 'node:path';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { AppContext } from './context.js';
import { gatewayRoutes } from './gateway/routes.js';
import { compatRoutes } from './gateway/compat.js';
import { auditOrigin, authRoutes, hasAdminKey, loadSession } from './admin/auth.js';
import { actionFor } from './ee/audit.js';
import { looksLikeJwt } from './ee/tokens.js';
import { tokenIssuerRoutes } from './ee/admin/tokens.js';
import { secretManagerRoutes } from './ee/admin/secret-managers.js';
import { keyRotationRoutes } from './ee/admin/rotation.js';
import { orgRoutes } from './ee/admin/orgs.js';
import { regionRoutes } from './ee/admin/regions.js';
import { ControlPlane } from './ee/multi-region/control-plane.js';
import { auditRoutes } from './ee/admin/audit.js';
import { ssoRoutes } from './ee/admin/sso.js';
import { licenseRoutes } from './ee/admin/license.js';
import { scimRoutes } from './ee/scim.js';
import { timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { adminRoutes } from './admin/routes.js';
import { wsRoutes } from './admin/ws.js';
import { providerRoutes } from './admin/providers.js';
import { playgroundRoutes } from './admin/playground.js';
import { policyRoutes } from './admin/policy.js';
import { mcpAdminRoutes } from './admin/mcp.js';
import { alertRoutes } from './admin/alerts.js';
import { importRoutes } from './admin/import.js';
import { exportRoutes } from './admin/export.js';
import { McpGateway } from './mcp/gateway.js';
import { HttpGateway } from './http/gateway.js';
import { A2aGateway } from './a2a/gateway.js';
import { httpAdminRoutes } from './admin/http.js';
import { managementApiRoutes } from './admin/management-api.js';
import { budgetRoutes } from './admin/budgets.js';
import { replayRoutes } from './admin/replay.js';
import { customerRoutes } from './admin/customers.js';
import { exportDestinationRoutes } from './admin/exports.js';
import { guardrailServiceRoutes } from './admin/guardrail-services.js';
import { userRoutes } from './admin/users.js';
import { viewRoutes } from './admin/views.js';
import { a2aAdminRoutes } from './admin/a2a.js';
import { mountDemoMcpServers } from './demo/mcp-servers.js';
import { mountDemoHttpApis } from './demo/http-apis.js';

export async function buildApp(ctx: Omit<AppContext, 'log'>, opts: { uiDir?: string | undefined; logger?: boolean | object } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: ctx.config.logLevel },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: true,
    // Fastify defaults to a 30 s keep-alive; long LLM streams need more.
    keepAliveTimeout: 75_000,
    // Time to receive a whole request (headers and body): long enough for a large upload, not forever.
    requestTimeout: 300_000,
  });
  (ctx as AppContext).log = app.log;
  const full = ctx as AppContext;

  await app.register(fastifyCookie);
  // Live frames repeat the same ids every second: compressed, a busy map costs a few KB/s. Small messages go as they are.
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024, perMessageDeflate: { threshold: 1024 } } });

  // Large console API answers (the map's topology, flight lists, exports) are gzipped when the
  // browser accepts it. Only /admin/api: gateway traffic is passed through exactly as it came.
  const gzipAsync = promisify(gzip);
  // A key this instance doesn't know yet may have just been made through another one: look it up before any route checks it.
  app.addHook('onRequest', async (req) => {
    // HTTP APIs pass Authorization on to the API: there, only x-ct-key carries Control Tower's credential.
    const xct = req.headers['x-ct-key'];
    const presented = req.url.startsWith('/http/') ? (typeof xct === 'string' ? xct.trim() : undefined) : (extractApiKey(req) ?? (typeof xct === 'string' ? xct.trim() : undefined));
    if (!presented) return;
    // A token from a trusted issuer (Enterprise): checked once, then known until it expires.
    if (looksLikeJwt(presented)) {
      if (!full.tokens?.configured) return;
      const v = await full.tokens.verify(presented);
      if ('principal' in v) req.ctPrincipal = v.principal;
      return;
    }
    if (!full.registry.authenticate(presented)) await full.registry.findStored(presented);
  });
  // A region's configuration is the control plane's: changes are made there. What is the region's own stays
  // local: signing in, its first-run setup and password, deciding its held calls, ending its approval windows,
  // and its alert inbox.
  if (full.config.region) {
    const LOCAL = /^\/admin\/api\/(login|logout|setup|me\/password|approvals\/[^/]+\/decide|grants\/[^/]+\/revoke|alerts\/read)$/;
    app.addHook('onRequest', async (req, reply) => {
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
      const p = req.url.split('?')[0]!;
      if ((p.startsWith('/admin/api/') && !LOCAL.test(p)) || p.startsWith('/key/') || p.startsWith('/model/') || p.startsWith('/team/') || p.startsWith('/customer/')) {
        return reply.status(409).send({ error: { code: 'managed_by_control_plane', message: `This is region ${full.config.region!.name}: change its configuration on the control plane (${full.config.region!.controlPlaneUrl}).` } });
      }
    });
  } else {
    full.controlPlane ??= new ControlPlane(full);
    full.controlPlane.routes(app);
  }

  app.addHook('onSend', async (req, reply, payload) => {
    if (typeof payload !== 'string' || payload.length < 16 * 1024 || !(req.url.startsWith('/admin/api/') || req.url.startsWith('/cp/'))) return payload;
    if (reply.getHeader('content-encoding') || !/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) return payload;
    reply.header('content-encoding', 'gzip');
    reply.header('vary', 'accept-encoding');
    reply.removeHeader('content-length');
    return gzipAsync(payload, { level: 6 });
  });

  // Security headers. The console (and every answer) can't be framed or sniffed; its pages get a strict CSP;
  // HSTS over HTTPS. Proxied HTTP APIs (/http/…) keep their own headers.
  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/http/')) return payload;
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    if (req.protocol === 'https' || (full.config.publicUrl ?? '').startsWith('https://')) reply.header('strict-transport-security', 'max-age=31536000');
    if (String(reply.getHeader('content-type') ?? '').includes('text/html')) reply.header('content-security-policy', CSP);
    return payload;
  });

  // What a change created: the id in its answer (`{id}`, or `{provider: {id}}`), so the audit event can name it.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.auditActor && req.method === 'POST' && reply.statusCode < 300 && typeof payload === 'string' && payload.length < 64 * 1024 && payload.startsWith('{')) {
      try {
        const j = JSON.parse(payload) as Record<string, unknown>;
        const nested = Object.values(j).find((v) => v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') as { id: string } | undefined;
        const id = typeof j.id === 'string' ? j.id : nested?.id;
        if (id) req.auditCreatedId = id;
      } catch {
        /* not JSON */
      }
    }
    return payload;
  });

  // The audit log: every change made through a route behind requireAdmin (which says who asked), and refused
  // attempts. Reads aren't recorded, except a signed-in person refused one. Anonymous refusals are capped per address.
  app.addHook('onResponse', async (req, reply) => {
    const actor = req.auditActor;
    if (!full.audit || !actor) return;
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (read && (!req.auditRefused || actor.type === 'anonymous')) return;
    if (actor.type === 'anonymous' && !(await full.limiter.admit(`audit:anon:${req.ip}`, 1, { rpm: 20 })).ok) return;
    const route = req.routeOptions.url ?? req.url.split('?')[0] ?? req.url;
    const status = reply.statusCode;
    const params = (req.params ?? {}) as Record<string, string>;
    const resource = route.replace(/^\/admin\/api\//, '').replace(/^\//, '').split('/')[0] || undefined;
    await full.audit.record({
      action: actionFor(req.method, route),
      outcome: req.auditRefused || status === 401 || status === 403 ? 'denied' : status >= 400 ? 'failure' : 'success',
      actor,
      status,
      target: { type: resource, id: params.id ?? req.auditCreatedId },
      detail: { method: req.method, route, ...(Object.keys(params).length ? { params } : {}), ...(req.auditRefused ? { refused: req.auditRefused } : {}), ...(req.body !== undefined && req.body !== null && !read ? { body: req.body } : {}) },
      ...auditOrigin(req),
    });
  });

  // Errors nobody meant to send: details go to the log, not to whoever asked.
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'request failed');
      return reply.status(status).send({ error: { code: 'internal_error', message: `Control Tower hit an error handling this request (logged as ${req.id}).` } });
    }
    return reply.status(status).send({ error: { code: err.code ?? 'bad_request', message: err.message } });
  });

  app.get('/healthz', async () => ({ ok: true }));

  // Prometheus scrape endpoint. Metrics name agents and show spend, so it is
  // never anonymous: a CT_METRICS_TOKEN bearer token, or an admin session.
  app.get('/metrics', async (req, reply) => {
    const token = full.config.metricsToken;
    const auth = req.headers.authorization ?? '';
    const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const tokenOk = !!token && presented.length === token.length && timingSafeEqual(Buffer.from(presented), Buffer.from(token));
    // A session still on a one-time password can't read anything yet.
    const signedIn = (await loadSession(full, req))?.mustChangePassword === false;
    if (!tokenOk && !hasAdminKey(full, req) && !signedIn) {
      return reply
        .status(401)
        .header('www-authenticate', 'Bearer')
        .send(token ? 'Unauthorized: send Authorization: Bearer <CT_METRICS_TOKEN>.\n' : 'Unauthorized: set CT_METRICS_TOKEN and scrape with Authorization: Bearer <token>, or sign in to the console.\n');
    }
    return reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8').header('cache-control', 'no-store').send(full.metrics.render());
  });
  app.get('/readyz', async (req, reply) => {
    const ready = !full.shuttingDown && !full.dbSink.backpressure;
    // Load balancers need the status; the details are for the admin key.
    const details = hasAdminKey(full, req) ? { pending_events: full.dbSink.pendingCount, wal_bytes: full.db.walBytes(), providers: { total: full.registry.providers.size } } : {};
    return reply.status(ready ? 200 : 503).send({ ok: ready, shutting_down: full.shuttingDown, ...details });
  });

  await app.register(async (g) => gatewayRoutes(g, full));
  await app.register(async (g) => compatRoutes(g, full));
  await app.register(async (g) => new McpGateway(full).register(g));
  await app.register(async (g) => new HttpGateway(full).register(g));
  await app.register(async (g) => new A2aGateway(full).register(g));
  // Demo upstreams are always mounted but answer only while demo mode is on (it can be started from the console).
  await app.register(async (g) => {
    g.addHook('onRequest', async (_req, reply) => {
      if (!full.demo) return reply.status(404).send({ error: { code: 'not_found', message: 'demo mode is off' } });
    });
    await mountDemoMcpServers(g);
    await mountDemoHttpApis(g);
  });
  await app.register(async (a) => {
    await authRoutes(a, full);
    await adminRoutes(a, full);
    await keyLifecycleRoutes(a, full);
    await providerRoutes(a, full);
    await playgroundRoutes(a, full);
    full.modelChecker.register(a, full);
    await policyRoutes(a, full);
    await mcpAdminRoutes(a, full);
    await httpAdminRoutes(a, full);
    await managementApiRoutes(a, full);
    await budgetRoutes(a, full);
    await replayRoutes(a, full);
    await customerRoutes(a, full);
    if (full.exporter) await exportDestinationRoutes(a, full);
    if (full.guardrails) await guardrailServiceRoutes(a, full);
    await userRoutes(a, full);
    await auditRoutes(a, full);
    await tokenIssuerRoutes(a, full);
    await secretManagerRoutes(a, full);
    await keyRotationRoutes(a, full, full.instanceId ?? 'local');
    await orgRoutes(a, full);
    await regionRoutes(a, full);
    await ssoRoutes(a, full);
    await licenseRoutes(a, full);
    await scimRoutes(a, full);
    await viewRoutes(a, full);
    await a2aAdminRoutes(a, full);
    await alertRoutes(a, full);
    await importRoutes(a, full);
    await exportRoutes(a, full);
    await wsRoutes(a, full);
  });

  // Static console with SPA fallback for non-API GETs.
  const uiDir = opts.uiDir;
  if (uiDir && fs.existsSync(path.join(uiDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: uiDir,
      prefix: '/',
      index: false,
      // Only content-hashed build output may be cached forever. index.html (and
      // anything unhashed) must revalidate, or browsers keep loading a console
      // whose asset files no longer exist after an upgrade.
      cacheControl: false,
      setHeaders: (reply, filePath) => {
        reply.header('cache-control', filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.get('/', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply.sendFile('index.html');
    });
    app.setNotFoundHandler(async (req, reply) => {
      const url = req.raw.url ?? '/';
      if (req.method === "GET" && !url.startsWith("/v1") && !url.startsWith('/admin/api') && !url.startsWith('/mcp') && !url.startsWith('/http/')) {
        reply.header('cache-control', 'no-store');
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${url} not found` } });
    });
  } else {
    app.get('/', async () => ({
      name: 'Control Tower',
      version: full.config.version,
      note: 'UI build not found. Run `pnpm build` or set CT_UI_DIR.',
      api: { openai: '/v1', anthropic: '/v1/messages', mcp: '/mcp', admin: '/admin/api' },
    }));
  }

  return app;
}
