/** A monotonically increasing version with change listeners. */
export class Versioned {
  private v = 0;
  private listeners = new Set<(v: number) => void>();

  get version(): number {
    return this.v;
  }

  bump(): number {
    this.v++;
    for (const l of this.listeners) {
      try {
        l(this.v);
      } catch (err) {
        console.error('[versioned] listener error', err);
      }
    }
    return this.v;
  }

  onChange(fn: (v: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
