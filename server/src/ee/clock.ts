import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

/**
 * Whether this server's clock has been set back (Enterprise licensing). License keys are checked offline, against
 * the server's own clock, so a clock set back would keep an ended license going. The server remembers the latest
 * time it has seen; a clock more than two days behind it is reported — in the console, once in the audit log, and
 * with the next renewal — but never acted on: licenses keep working, so a clock that was merely wrong never costs
 * anyone their Enterprise features. An admin who knows the clock is right says so, and the mark starts again.
 */
export const CLOCK_TOLERANCE_MS = 2 * 24 * 3600_000;
const KEY = 'clock_high_water';
const REPORTED = 'clock_behind_reported';
/** The mark is written at most this often (every instance moves it forward). */
const WRITE_EVERY_MS = 10 * 60_000;

export interface ClockState {
  /** The clock reads more than two days before the latest time seen. */
  behind: boolean;
  /** The latest time this server has seen. */
  high_water: number | null;
  behind_ms: number;
}

export class ClockWatch {
  private state: ClockState = { behind: false, high_water: null, behind_ms: 0 };
  private written = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deps: {
      db: Kysely<Database>;
      now?: () => number;
      /** Called once when the clock is first found behind (and again after an admin accepts it and it happens again). */
      onBehind?: (s: ClockState) => void | Promise<void>;
    },
  ) {}

  get current(): ClockState {
    return this.state;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async set(key: string, value: string, now: number): Promise<void> {
    await this.deps.db.insertInto('settings').values({ key, value, updated_at: now }).onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now })).execute();
  }

  async check(): Promise<ClockState> {
    const now = this.now();
    const rows = await this.deps.db.selectFrom('settings').select(['key', 'value']).where('key', 'in', [KEY, REPORTED]).execute();
    const stored = Number(rows.find((r) => r.key === KEY)?.value ?? 0) || 0;
    const reported = rows.find((r) => r.key === REPORTED)?.value;
    if (now >= stored) {
      if (now - Math.max(stored, this.written) >= WRITE_EVERY_MS || !stored) {
        await this.set(KEY, String(now), now);
        this.written = now;
      }
      this.state = { behind: false, high_water: Math.max(stored, now), behind_ms: 0 };
      return this.state;
    }
    const behind = stored - now;
    this.state = { behind: behind > CLOCK_TOLERANCE_MS, high_water: stored, behind_ms: behind };
    // Reported once per mark: not again until an admin accepts the clock, or the mark moves on.
    if (this.state.behind && reported !== String(stored)) {
      await this.set(REPORTED, String(stored), now);
      await this.deps.onBehind?.(this.state);
    }
    return this.state;
  }

  /** An admin says the clock is right: the latest time seen is now. */
  async accept(): Promise<ClockState> {
    const now = this.now();
    await this.set(KEY, String(now), now);
    this.written = now;
    this.state = { behind: false, high_water: now, behind_ms: 0 };
    return this.state;
  }

  start(everyMs = WRITE_EVERY_MS): void {
    void this.check().catch(() => undefined);
    this.timer = setInterval(() => void this.check().catch(() => undefined), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
