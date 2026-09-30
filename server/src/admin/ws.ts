import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { WsClientMessage, WsServerMessage } from '@controltower/shared';
import type { AppContext } from '../context.js';
import { loadSession } from './auth.js';
import { ADMIN_SCOPE, EMPTY_SCOPE, seesKey, type Scope } from './scope.js';

/** A browser always sends Origin on a WebSocket; one from another site is refused (the cookie alone isn't proof). */
function sameOrigin(ctx: AppContext, origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // not a browser: the session cookie still has to be valid
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (host && o.host.toLowerCase() === host.toLowerCase()) return true;
  if (ctx.config.publicUrl) {
    try {
      return o.host.toLowerCase() === new URL(ctx.config.publicUrl).host.toLowerCase();
    } catch {
      /* fall through */
    }
  }
  return false;
}

const MAX_BUFFERED = 1024 * 1024;
/** Topology notices are coalesced to one per frame. */
const FRAME_MS = 100;

/**
 * /admin/ws — live traffic for the console as summed frames (see LiveFrames:
 * a tick a second, plus the full events of held, denied and failed flights),
 * and topology changes coalesced to one notice per frame. The map is
 * best-effort: a socket that falls more than 1 MB behind has frames dropped
 * rather than stalling the server.
 */
export async function wsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/admin/ws', { websocket: true }, async (socket: WebSocket, req) => {
    if (!sameOrigin(ctx, req.headers.origin, req.headers['x-forwarded-host']?.toString().split(',')[0]?.trim() || req.headers.host)) {
      socket.close(4403, 'origin not allowed');
      return;
    }
    const session = await loadSession(ctx, req);
    if (!session || session.mustChangePassword) {
      socket.close(4401, 'unauthenticated');
      return;
    }

    // Someone who sees only their teams gets only their agents' traffic (their scope is looked at again every 10 s).
    let scope: Scope = ctx.orgs ? ctx.orgs.scopeFor(session) : session.role === 'member' ? EMPTY_SCOPE : ADMIN_SCOPE;
    let scopeAt = Date.now();
    const flightSeen = new Map<string, boolean>();
    const mine = (m: WsServerMessage): WsServerMessage | undefined => {
      if (Date.now() - scopeAt > 10_000 && ctx.orgs) {
        scope = ctx.orgs.scopeFor(session);
        scopeAt = Date.now();
      }
      if (scope.all) return m;
      const visible = (keyId: string) => seesKey(scope, ctx.registry.keysById.get(keyId));
      if (m.type === 'tick') {
        const paths = m.paths.filter((p) => visible(p[0]));
        const t = paths.reduce((a, p) => ({ flights: a.flights + p[3], errors: a.errors + p[4], denied: a.denied + p[5], cost: a.cost + p[6] }), { flights: 0, errors: 0, denied: 0, cost: 0 });
        return { ...m, paths, rules: {}, totals: { flights: t.flights, ok: Math.max(0, t.flights - t.errors - t.denied), errors: t.errors, denied: t.denied, cost_nanousd: t.cost, tokens: 0 } };
      }
      if (m.type === 'events') {
        for (const e of m.events) if (e.t === 'flight.started') flightSeen.set(e.flight_id, visible(e.key_id));
        if (flightSeen.size > 5000) for (const k of [...flightSeen.keys()].slice(0, 2500)) flightSeen.delete(k);
        const events = m.events.filter((e) => flightSeen.get(e.flight_id));
        return events.length ? { ...m, events } : undefined;
      }
      return m;
    };
    const send = (raw: WsServerMessage): void => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED) return;
      const m = mine(raw);
      if (m) socket.send(JSON.stringify(m));
    };

    send({ type: 'hello', server_time: Date.now(), version: ctx.config.version });
    for (const m of ctx.live.backlog()) send(m);
    send({ type: 'topology', version: ctx.registry.version });

    let topologyChanged = false;
    const timer = setInterval(() => {
      if (topologyChanged) {
        topologyChanged = false;
        send({ type: 'topology', version: ctx.registry.version });
      }
    }, FRAME_MS);
    timer.unref();
    const topology = (): void => {
      topologyChanged = true;
    };

    const unsubBus = ctx.live.subscribe(send);
    const unsubReg = ctx.registry.onChange(topology);
    const unsubApprovals = ctx.approvalsVersion.onChange((v) => send({ type: 'approvals', version: v }));
    const unsubPolicy = ctx.policy.onChange?.(topology) ?? (() => undefined);
    const unsubMcp = ctx.mcp.onChange(topology);
    const unsubHttp = ctx.http.onChange(topology);
    const unsubA2a = ctx.a2a.onChange(topology);
    const unsubAlerts = ctx.alertsVersion.onChange((v) => send({ type: 'alerts', version: v }));
    const unsubObserved = ctx.observedVersion.onChange(topology);
    const unsubViews = ctx.viewsVersion.onChange(topology);
    // A connection used for the first time needs a line on the map (a console open elsewhere missed its live frames).
    const unsubPaths = ctx.paths.onNew(topology);

    socket.on('message', (raw) => {
      let msg: WsClientMessage | undefined;
      try {
        msg = JSON.parse(String(raw)) as WsClientMessage;
      } catch {
        return;
      }
      if (msg.type === 'ping') send({ type: 'hello', server_time: Date.now(), version: ctx.config.version });
    });

    socket.on('close', () => {
      clearInterval(timer);
      unsubBus();
      unsubReg();
      unsubApprovals();
      unsubPolicy();
      unsubMcp();
      unsubHttp();
      unsubA2a();
      unsubAlerts();
      unsubObserved();
      unsubViews();
      unsubPaths();
    });
  });
}
