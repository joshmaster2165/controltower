import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { AppContext } from './context.js';
import { gatewayRoutes } from './gateway/routes.js';
import { authRoutes, loadSession } from './admin/auth.js';
import { timingSafeEqual } from 'node:crypto';
import { adminRoutes } from './admin/routes.js';
import { wsRoutes } from './admin/ws.js';
import { providerRoutes } from './admin/providers.js';
import { playgroundRoutes } from './admin/playground.js';
import { policyRoutes } from './admin/policy.js';
import { mcpAdminRoutes } from './admin/mcp.js';
import { alertRoutes } from './admin/alerts.js';
import { importRoutes } from './admin/import.js';
import { McpGateway } from './mcp/gateway.js';
import { mountDemoMcpServers } from './demo/mcp-servers.js';

export async function buildApp(ctx: Omit<AppContext, 'log'>, opts: { uiDir?: string | undefined; logger?: boolean | object } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: ctx.config.logLevel },
    disableRequestLogging: true,
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: true,
    // Fastify defaults to a 30 s keep-alive; long LLM streams need more.
    keepAliveTimeout: 75_000,
    requestTimeout: 0,
  });
  (ctx as AppContext).log = app.log;
  const full = ctx as AppContext;

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  app.get('/healthz', async () => ({ ok: true }));

  // Prometheus scrape endpoint. Metrics name agents and show spend, so it is
  // never anonymous: a CT_METRICS_TOKEN bearer token, or an admin session.
  app.get('/metrics', async (req, reply) => {
    const token = full.config.metricsToken;
    const auth = req.headers.authorization ?? '';
    const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const tokenOk = !!token && presented.length === token.length && timingSafeEqual(Buffer.from(presented), Buffer.from(token));
    if (!tokenOk && !(await loadSession(full, req))) {
      return reply
        .status(401)
        .header('www-authenticate', 'Bearer')
        .send(token ? 'Unauthorized: send Authorization: Bearer <CT_METRICS_TOKEN>.\n' : 'Unauthorized: set CT_METRICS_TOKEN and scrape with Authorization: Bearer <token>, or sign in to the console.\n');
    }
    return reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8').header('cache-control', 'no-store').send(full.metrics.render());
  });
  app.get('/readyz', async (_req, reply) => {
    const ready = !full.shuttingDown && !full.dbSink.backpressure;
    return reply.status(ready ? 200 : 503).send({
      ok: ready,
      shutting_down: full.shuttingDown,
      pending_events: full.dbSink.pendingCount,
      wal_bytes: full.db.walBytes(),
      providers: { total: full.registry.providers.size },
    });
  });

  await app.register(async (g) => gatewayRoutes(g, full));
  await app.register(async (g) => new McpGateway(full).register(g));
  if (full.config.demo) await app.register(async (g) => mountDemoMcpServers(g));
  await app.register(async (a) => {
    await authRoutes(a, full);
    await adminRoutes(a, full);
    await providerRoutes(a, full);
    await playgroundRoutes(a, full);
    await policyRoutes(a, full);
    await mcpAdminRoutes(a, full);
    await alertRoutes(a, full);
    await importRoutes(a, full);
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
      if (req.method === "GET" && !url.startsWith("/v1") && !url.startsWith('/admin/api') && !url.startsWith('/mcp')) {
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
