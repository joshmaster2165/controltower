import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { WsClientMessage, WsServerMessage } from '@controltower/shared';
import type { AppContext } from '../context.js';
import { loadSession } from './auth.js';

const MAX_BUFFERED = 1024 * 1024;

/**
 * /admin/ws — pushes every flight event to the console. The map is
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
    const backfill = ctx.ring.since(Date.now() - 15_000);
    if (backfill.length) send({ type: 'events', events: backfill });
    send({ type: 'topology', version: ctx.registry.version });

    const unsubBus = ctx.bus.subscribe((e) => send({ type: 'event', event: e }));
    const unsubReg = ctx.registry.onChange(() => send({ type: 'topology', version: ctx.registry.version }));
    const unsubApprovals = ctx.approvalsVersion.onChange((v) => send({ type: 'approvals', version: v }));
    const unsubPolicy = ctx.policy.onChange?.(() => send({ type: 'topology', version: ctx.registry.version })) ?? (() => undefined);
    const unsubMcp = ctx.mcp.onChange(() => send({ type: 'topology', version: ctx.registry.version }));
    const unsubHttp = ctx.http.onChange(() => send({ type: 'topology', version: ctx.registry.version }));
    const unsubAlerts = ctx.alertsVersion.onChange((v) => send({ type: 'alerts', version: v }));
    const unsubObserved = ctx.observedVersion.onChange(() => send({ type: 'topology', version: ctx.registry.version }));

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
      unsubBus();
      unsubReg();
      unsubApprovals();
      unsubPolicy();
      unsubMcp();
      unsubHttp();
      unsubAlerts();
      unsubObserved();
    });
  });
}
