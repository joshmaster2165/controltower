import { z } from 'zod';
import { FlightEvent } from './events.js';

/** Messages the server pushes over /admin/ws. */
/**
 * One second of traffic, summed: what the live map and counters need from the
 * calls that went fine. `paths` rows are [key id, target id (deployment or
 * tool server; null if unrouted), tool, calls started, errors, blocked, spend
 * in nanousd] — outcomes are counted in the second the call finished; `rules`
 * counts gate decisions (deny, hold, inspect) per gate.
 */
export const LiveTick = z.object({
  type: z.literal('tick'),
  ts: z.number(),
  ms: z.number(),
  totals: z.object({ flights: z.number(), ok: z.number(), errors: z.number(), denied: z.number(), cost_nanousd: z.number(), tokens: z.number() }),
  paths: z.array(z.tuple([z.string(), z.string().nullable(), z.string().nullable(), z.number(), z.number(), z.number(), z.number()])),
  rules: z.record(z.string(), z.number()),
});
export type LiveTick = z.infer<typeof LiveTick>;

/**
 * Live updates: a `tick` every second counts all traffic; `events` carries the
 * full events of flights a person should see — held, denied or failed — within
 * 100 ms. Events never count toward totals (the ticks already do).
 */
export const WsServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), server_time: z.number(), version: z.string() }),
  LiveTick,
  z.object({ type: z.literal('events'), events: z.array(FlightEvent) }),
  z.object({ type: z.literal('topology'), version: z.number() }),
  z.object({ type: z.literal('approvals'), version: z.number() }),
  z.object({ type: z.literal('alerts'), version: z.number() }),
]);
export type WsServerMessage = z.infer<typeof WsServerMessage>;

/** Messages the UI sends. */
export const WsClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), channels: z.array(z.enum(['flights', 'topology', 'approvals'])) }),
  z.object({ type: z.literal('ping') }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessage>;
