import type { Kysely } from 'kysely';
import type { FlightEvent } from '@controltower/shared';
import type { Database } from '../db/schema.js';
import type { SecretBox } from '../crypto/secrets.js';
import { Assembler, type FlightRecord } from './record.js';
import { deliver, type ExportConfig, type ExportKind } from './destinations.js';
import { secretRefs } from '../ee/secret-managers/index.js';

/**
 * Sends every flight, as it completes, to the destinations configured: batched (up to 500 records, every two
 * seconds), retried (three tries), and bounded — a destination that is down keeps at most 20,000 records
 * waiting, dropping the oldest, and says so. Each instance sends the calls it served.
 */
const BATCH = 500;
const FLUSH_MS = 2_000;
const QUEUE_CAP = 20_000;
const RETRY_MS = [0, 2_000, 10_000];

interface Dest {
  id: string;
  name: string;
  kind: ExportKind;
  config: ExportConfig;
  enabled: boolean;
  sendFlights: boolean;
  sendAudit: boolean;
  queue: FlightRecord[];
  sending: boolean;
  sent: number;
  dropped: number;
  lastStatus: string | undefined;
  lastError: string | undefined;
  lastSentAt: number | undefined;
  dirty: boolean;
}

export class Exporter {
  private dests = new Map<string, Dest>();
  private asm: Assembler;
  private timer: NodeJS.Timeout | undefined;
  private saver: NodeJS.Timeout | undefined;

  constructor(
    private readonly deps: {
      db: Kysely<Database>;
      secrets: SecretBox;
      version: string;
      instance?: string | undefined;
      log: () => { warn(o: object, m: string): void };
    },
  ) {
    this.asm = new Assembler(deps.instance);
  }

  /** From the flight bus: synchronous, no I/O. */
  push = (e: FlightEvent): void => {
    if (!this.dests.size) return;
    const r = this.asm.push(e);
    if (!r) return;
    for (const d of this.dests.values()) {
      if (!d.enabled || !d.sendFlights) continue;
      d.queue.push(r);
      if (d.queue.length > QUEUE_CAP) {
        d.queue.splice(0, d.queue.length - QUEUE_CAP);
        d.dropped++;
        d.dirty = true;
      }
      if (d.queue.length >= BATCH) void this.flush(d);
    }
  };

  async reload(): Promise<void> {
    const rows = await this.deps.db.selectFrom('export_destinations').selectAll().execute();
    const next = new Map<string, Dest>();
    for (const r of rows) {
      let config: ExportConfig;
      try {
        config = secretRefs.apply(JSON.parse(this.deps.secrets.decrypt(r.config_enc, `export_destinations.config_enc.${r.id}`)) as ExportConfig, `export ${r.name}`);
      } catch (err) {
        this.deps.log().warn({ destination: r.id, err: (err as Error).message }, 'export destination config could not be decrypted');
        continue;
      }
      const old = this.dests.get(r.id);
      next.set(r.id, {
        id: r.id,
        name: r.name,
        kind: r.kind as ExportKind,
        config,
        enabled: r.enabled === 1,
        sendFlights: r.send_flights === 1,
        sendAudit: r.send_audit === 1,
        queue: r.send_flights === 1 ? (old?.queue ?? []) : [],
        sending: old?.sending ?? false,
        sent: old?.sent ?? r.sent_count,
        dropped: old?.dropped ?? r.dropped_count,
        lastStatus: old?.lastStatus ?? r.last_status ?? undefined,
        lastError: old?.lastError ?? r.last_error ?? undefined,
        lastSentAt: old?.lastSentAt ?? r.last_sent_at ?? undefined,
        dirty: false,
      });
    }
    this.dests = next;
  }

  start(): void {
    this.timer = setInterval(() => {
      for (const d of this.dests.values()) if (d.queue.length) void this.flush(d);
    }, FLUSH_MS);
    this.timer.unref?.();
    this.saver = setInterval(() => void this.save(), 10_000);
    this.saver.unref?.();
  }

  /** Send what is waiting (at stop: everything, within a few seconds). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.saver) clearInterval(this.saver);
    await Promise.race([Promise.all([...this.dests.values()].map((d) => this.flush(d))), new Promise((r) => setTimeout(r, 5_000))]);
    await this.save();
  }

  /** Delivery state, for the console. */
  stats(id: string): { queued: number; sent: number; dropped: number; last_status: string | null; last_error: string | null; last_sent_at: number | null } | undefined {
    const d = this.dests.get(id);
    return d ? { queued: d.queue.length, sent: d.sent, dropped: d.dropped, last_status: d.lastStatus ?? null, last_error: d.lastError ?? null, last_sent_at: d.lastSentAt ?? null } : undefined;
  }

  /** Send one example record now, to check a destination's settings. */
  async test(kind: ExportKind, config: ExportConfig): Promise<void> {
    const now = Date.now();
    await deliver(kind, config, [sampleRecord(now, this.deps.instance)], { version: this.deps.version });
  }

  /** Flush a destination now; resolves when its queue is sent (or failed). For tests and "Send now". */
  async drain(id: string): Promise<void> {
    const d = this.dests.get(id);
    while (d && d.queue.length) {
      const before = d.queue.length;
      await this.flush(d);
      if (d.queue.length >= before) break;
    }
  }

  private async flush(d: Dest): Promise<void> {
    if (d.sending || !d.queue.length) return;
    d.sending = true;
    const batch = d.queue.splice(0, BATCH);
    try {
      let lastErr: unknown;
      for (const wait of RETRY_MS) {
        if (wait) await new Promise((r) => setTimeout(r, wait));
        try {
          await deliver(d.kind, d.config, batch, { version: this.deps.version });
          d.sent += batch.length;
          d.lastStatus = 'ok';
          d.lastError = undefined;
          d.lastSentAt = Date.now();
          d.dirty = true;
          return;
        } catch (err) {
          lastErr = err;
        }
      }
      d.dropped += batch.length;
      d.lastStatus = 'error';
      d.lastError = (lastErr as Error)?.message?.slice(0, 500) ?? 'failed';
      d.dirty = true;
      this.deps.log().warn({ destination: d.name, records: batch.length, err: d.lastError }, 'flight records could not be exported');
    } finally {
      d.sending = false;
    }
  }

  private async save(): Promise<void> {
    for (const d of this.dests.values()) {
      if (!d.dirty) continue;
      d.dirty = false;
      await this.deps.db
        .updateTable('export_destinations')
        .set({ last_status: d.lastStatus ?? null, last_error: d.lastError ?? null, last_sent_at: d.lastSentAt ?? null, sent_count: d.sent, dropped_count: d.dropped })
        .where('id', '=', d.id)
        .execute()
        .catch(() => undefined);
    }
  }

  encryptConfig(id: string, config: ExportConfig): string {
    return this.deps.secrets.encrypt(JSON.stringify(config), `export_destinations.config_enc.${id}`);
  }

  /** Destinations the audit log goes to (running, and set to receive it). */
  auditDestinations(): Array<{ id: string; name: string; kind: ExportKind; config: ExportConfig }> {
    return [...this.dests.values()].filter((d) => d.enabled && d.sendAudit).map((d) => ({ id: d.id, name: d.name, kind: d.kind, config: d.config }));
  }

  configOf(id: string): { kind: ExportKind; config: ExportConfig } | undefined {
    const d = this.dests.get(id);
    return d ? { kind: d.kind, config: d.config } : undefined;
  }
}

function sampleRecord(now: number, instance?: string): FlightRecord {
  return {
    type: 'controltower.flight',
    version: 1,
    id: `test_${now.toString(36)}`,
    started_at: new Date(now - 420).toISOString(),
    ended_at: new Date(now).toISOString(),
    start_ms: now - 420,
    end_ms: now,
    duration_ms: 420,
    status: 'ok',
    http_status: 200,
    kind: 'chat',
    agent: { key_id: 'key_test', key_name: 'Control Tower test', agent_id: 'controltower-test' },
    target: { model_requested: 'gpt-4.1-mini', provider_kind: 'openai', upstream_model: 'gpt-4.1-mini' },
    decision: { effect: 'allow' },
    attempts: 1,
    usage: { input: 12, output: 4, cache_read: 0, cache_write: 0, source: 'provider' },
    cost_usd: 0.0000112,
    cost_confidence: 'exact',
    latency: { ttfb_ms: 380, ttft_ms: 390, gateway_overhead_ms: 1 },
    instance,
  };
}
