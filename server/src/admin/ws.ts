import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { WsClientMessage, WsServerMessage } from '@controltower/shared';
import type { AppContext } from '../context.js';
import { loadSession } from './auth.js';

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
    const session = await loadSession(ctx, req);
    if (!session) {
      socket.close(4401, 'unauthenticated');
      return;
    }

    const send = (m: WsServerMessage): void => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED) return;
      socket.send(JSON.stringify(m));
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
    });
  });
}
