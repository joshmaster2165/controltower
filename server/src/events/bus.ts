import type { FlightEvent } from '@controltower/shared';

export type Sink = (e: FlightEvent) => void;

/**
 * Synchronous fan-out. `emit` never throws and never awaits: a sink that
 * throws is logged and skipped, so the hot path cannot be broken by a
 * consumer.
 */
export class FlightBus {
  private sinks = new Set<Sink>();
  private onError: (err: unknown) => void;

  constructor(onError: (err: unknown) => void = (e) => console.error('[bus] sink error', e)) {
    this.onError = onError;
  }

  emit(e: FlightEvent): void {
    for (const s of this.sinks) {
      try {
        s(e);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  subscribe(sink: Sink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  get size(): number {
    return this.sinks.size;
  }
}
