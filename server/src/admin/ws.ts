import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { FlightEvent, WsClientMessage, WsServerMessage } from '@controltower/shared';
import type { AppContext } from '../context.js';
import { loadSession } from './auth.js';

const MAX_BUFFERED = 1024 * 1024;
/** Live events go out in one frame per tick rather than one per event: at hundreds of calls a second, per-event frames swamp the browser. */
const FRAME_MS = 100;

/**
 * /admin/ws — pushes every flight event to the console, batched per
 * FRAME_MS, and topology changes coalesced to one notice per frame. The map
 * is best-effort: a socket that falls more than 1 MB behind has frames
 * dropped rather than stalling the server.
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

    let batch: FlightEvent[] = [];
    let topologyChanged = false;
    const timer = setInterval(() => {
      if (batch.length) {
        const events = batch;
        batch = [];
        send(events.length === 1 ? { type: 'event', event: events[0]! } : { type: 'events', events });
      }
      if (topologyChanged) {
        topologyChanged = false;
        send({ type: 'topology', version: ctx.registry.version });
      }
    }, FRAME_MS);
    timer.unref();
    const topology = (): void => {
      topologyChanged = true;
    };

    const unsubBus = ctx.bus.subscribe((e) => {
      // Past the socket's backlog the frame would be dropped anyway; don't grow the batch without bound.
      if (batch.length < 20_000) batch.push(e);
    });
    const unsubReg = ctx.registry.onChange(topology);
    const unsubApprovals = ctx.approvalsVersion.onChange((v) => send({ type: 'approvals', version: v }));
    const unsubPolicy = ctx.policy.onChange?.(topology) ?? (() => undefined);
    const unsubMcp = ctx.mcp.onChange(topology);
    const unsubHttp = ctx.http.onChange(topology);
    const unsubAlerts = ctx.alertsVersion.onChange((v) => send({ type: 'alerts', version: v }));
    const unsubObserved = ctx.observedVersion.onChange(topology);

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
      unsubAlerts();
      unsubObserved();
    });
  });
}
