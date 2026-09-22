import { z } from 'zod';
import { FlightEvent } from './events.js';

/** Messages the server pushes over /admin/ws. */
export const WsServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), server_time: z.number(), version: z.string() }),
  z.object({ type: z.literal('event'), event: FlightEvent }),
  z.object({ type: z.literal('events'), events: z.array(FlightEvent) }),
  z.object({ type: z.literal('topology'), version: z.number() }),
  z.object({ type: z.literal('approvals'), version: z.number() }),
]);
export type WsServerMessage = z.infer<typeof WsServerMessage>;

/** Messages the UI sends. */
export const WsClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), channels: z.array(z.enum(['flights', 'topology', 'approvals'])) }),
  z.object({ type: z.literal('ping') }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessage>;
