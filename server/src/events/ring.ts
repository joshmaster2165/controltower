import type { FlightEvent } from '@controltower/shared';

/**
 * Small in-memory ring of recent events so a freshly connected Airspace can
 * back-fill the last few seconds of traffic instead of starting blank.
 */
export class EventRing {
  private buf: FlightEvent[] = [];
  constructor(private readonly cap = 2000) {}

  push = (e: FlightEvent): void => {
    this.buf.push(e);
    if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap);
  };

  since(ts: number, max = 1000): FlightEvent[] {
    const out: FlightEvent[] = [];
    for (let i = this.buf.length - 1; i >= 0 && out.length < max; i--) {
      const e = this.buf[i]!;
      if (e.ts < ts) break;
      out.push(e);
    }
    return out.reverse();
  }
}
