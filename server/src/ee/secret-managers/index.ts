import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import type { SecretBox } from '../../crypto/secrets.js';
import { backendFor, type Backend, type ManagerConfig, type ManagerKind } from './backends.js';
import { forgetCredentials } from './cloud-auth.js';

/**
 * Credentials kept in your secret manager instead of Control Tower's database (Enterprise). Anywhere a
 * credential goes — a provider's API key, a tool server's token, an export's HEC token — a reference can go
 * instead:
 *
 *     secret://<manager>/<path>[#<field>]
 *
 * e.g. `secret://vault/ai/openai#api_key`, `secret://aws-prod/prod/anthropic`. Control Tower reads each value
 * when it's first needed and keeps it in memory only, re-reads it every few minutes (the manager's refresh
 * interval), and when a value changed — a key rotated in the manager — reloads what uses it. A value that can't
 * be read is reported, and the last one read keeps being used.
 */
export const REF = /^secret:\/\/([a-z0-9][a-z0-9_-]{0,62})\/([^#\s]+?)(?:#([^\s#]+))?$/;
export interface SecretRef {
  manager: string;
  path: string;
  field: string | undefined;
}
export function parseRef(s: string): SecretRef | undefined {
  const m = REF.exec(s.trim());
  return m ? { manager: m[1]!, path: m[2]!, field: m[3] } : undefined;
}
export const isRef = (v: unknown): v is string => typeof v === 'string' && v.startsWith('secret://') && !!parseRef(v);

interface Manager {
  id: string;
  name: string;
  kind: ManagerKind;
  backend: Backend;
  refreshMs: number;
}
interface Entry {
  value: string | undefined;
  readAt: number;
  error: string | undefined;
  errorAt: number | undefined;
  changedAt: number | undefined;
  reading: Promise<void> | undefined;
  users: Set<string>;
}

const CHECK_MS = 15_000;
/** A value that couldn't be read is tried again after this long (not on every reload). */
const RETRY_MS = 30_000;

export class SecretRefs {
  private deps: { db: Kysely<Database>; secrets: SecretBox; log: () => { warn(o: object, m: string): void } } | undefined;
  private managers = new Map<string, Manager>();
  private entries = new Map<string, Entry>();
  private listeners: Array<() => Promise<void>> = [];
  private timer: NodeJS.Timeout | undefined;
  private notifyTimer: NodeJS.Timeout | undefined;

  configure(deps: { db: Kysely<Database>; secrets: SecretBox; log: () => { warn(o: object, m: string): void } }): void {
    this.deps = deps;
  }

  /** Called when a referenced value is first read or changes: reload what uses it. */
  onChange(fn: () => Promise<void>): void {
    this.listeners.push(fn);
  }

  async reload(): Promise<void> {
    if (!this.deps) return;
    const rows = await this.deps.db.selectFrom('secret_managers').selectAll().execute();
    const next = new Map<string, Manager>();
    for (const r of rows) {
      let config: ManagerConfig;
      try {
        config = JSON.parse(this.deps.secrets.decrypt(r.config_enc, `secret_managers.config_enc.${r.id}`)) as ManagerConfig;
      } catch (err) {
        this.deps.log().warn({ manager: r.name, err: (err as Error).message }, 'secret manager settings could not be decrypted');
        continue;
      }
      forgetCredentials(r.id);
      next.set(r.name, { id: r.id, name: r.name, kind: r.kind as ManagerKind, backend: backendFor(r.kind as ManagerKind, config, r.id), refreshMs: r.refresh_s * 1000 });
    }
    this.managers = next;
    // Settings changed: read every value again.
    for (const [ref, e] of this.entries) {
      e.readAt = 0;
      e.errorAt = undefined;
      void this.read(ref);
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.refresh(), CHECK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
  }

  /**
   * Replace every reference in a credential object with its value (synchronously, from memory). References not
   * read yet are left as they are and read now; what uses them reloads when they arrive. `user` says what holds
   * the object (for the console: "provider OpenAI").
   */
  apply<T>(obj: T, user: string): T {
    if (!this.deps) return obj;
    const walk = (v: unknown): unknown => {
      if (isRef(v)) {
        const e = this.entry(v);
        e.users.add(user);
        if (e.value === undefined) {
          void this.read(v);
          return v;
        }
        return e.value;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return walk(obj) as T;
  }

  /** Wait for reads under way (at boot, so the first calls have their credentials). */
  async settle(timeoutMs = 15_000): Promise<void> {
    const pending = [...this.entries.values()].map((e) => e.reading).filter(Boolean);
    if (pending.length) await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, timeoutMs))]);
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
      await this.notify();
    }
  }

  /** Read every value now (for "Refresh"), and reload what changed. */
  async refreshAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((ref) => this.read(ref, true)));
    await this.settle();
  }

  /** The value of one reference now, read from the manager (for tests and rotation). */
  async resolve(ref: string): Promise<string> {
    const r = parseRef(ref);
    if (!r) throw new Error(`not a secret reference: ${ref}`);
    const m = this.managers.get(r.manager);
    if (!m) throw new Error(`no secret manager is named "${r.manager}"`);
    return pick(await m.backend.read(r.path), r);
  }

  /** Store a new value at a reference (a rotated key, delivered to where the agent reads it). */
  async write(ref: string, value: string): Promise<void> {
    const r = parseRef(ref);
    if (!r) throw new Error(`not a secret reference: ${ref}`);
    const m = this.managers.get(r.manager);
    if (!m) throw new Error(`no secret manager is named "${r.manager}"`);
    await m.backend.write(r.path, value, r.field);
  }

  managerNames(): string[] {
    return [...this.managers.keys()];
  }

  async test(name: string): Promise<string> {
    const m = this.managers.get(name);
    if (!m) throw new Error('not found');
    return m.backend.test();
  }

  /** References in use and how reading them went, for the console. Never the values. */
  states(): Array<{ ref: string; manager: string; used_by: string[]; status: 'ok' | 'error' | 'reading'; error: string | null; read_at: number | null; changed_at: number | null }> {
    return [...this.entries.entries()]
      .filter(([, e]) => e.users.size)
      .map(([ref, e]) => ({
        ref,
        manager: parseRef(ref)!.manager,
        used_by: [...e.users].sort(),
        status: e.error && (e.errorAt ?? 0) >= e.readAt ? 'error' : e.value !== undefined ? 'ok' : 'reading',
        error: e.error ?? null,
        read_at: e.readAt || null,
        changed_at: e.changedAt ?? null,
      }));
  }

  private entry(ref: string): Entry {
    let e = this.entries.get(ref);
    if (!e) {
      e = { value: undefined, readAt: 0, error: undefined, errorAt: undefined, changedAt: undefined, reading: undefined, users: new Set() };
      this.entries.set(ref, e);
    }
    return e;
  }

  private async refresh(): Promise<void> {
    const now = Date.now();
    for (const [ref, e] of this.entries) {
      const m = this.managers.get(parseRef(ref)!.manager);
      if (e.errorAt && now - e.errorAt < RETRY_MS) continue;
      if (!m || now - e.readAt >= m.refreshMs) void this.read(ref);
    }
  }

  private read(ref: string, force = false): Promise<void> {
    const e = this.entry(ref);
    if (e.reading) return e.reading;
    if (!force && e.errorAt && Date.now() - e.errorAt < RETRY_MS) return Promise.resolve();
    e.reading = (async () => {
      try {
        const value = await this.resolve(ref);
        const changed = e.value !== undefined && e.value !== value;
        const first = e.value === undefined;
        e.value = value;
        e.readAt = Date.now();
        e.error = undefined;
        e.errorAt = undefined;
        if (changed) e.changedAt = Date.now();
        if (changed || first) this.scheduleNotify();
      } catch (err) {
        // The last value read keeps being used.
        e.error = (err as Error).message.slice(0, 300);
        e.errorAt = Date.now();
        e.readAt = e.readAt || 0;
        this.deps?.log().warn({ ref, err: e.error }, 'secret could not be read');
      } finally {
        e.reading = undefined;
      }
    })();
    return e.reading;
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      void this.notify();
    }, 100);
    this.notifyTimer.unref?.();
  }

  private async notify(): Promise<void> {
    for (const fn of this.listeners) await fn().catch((err: unknown) => this.deps?.log().warn({ err: (err as Error).message }, 'reload after a secret changed failed'));
  }
}

/** A reference's value from what the manager answered: the field named, or the whole (single) value. */
function pick(v: string | Record<string, unknown>, r: SecretRef): string {
  if (r.field) {
    if (typeof v !== 'object') throw new Error(`${r.path} is not a JSON secret, so it has no field "${r.field}"`);
    const x = v[r.field];
    if (typeof x !== 'string' && typeof x !== 'number') throw new Error(`${r.path} has no field "${r.field}"`);
    return String(x);
  }
  if (typeof v === 'string') return v;
  const vals = Object.values(v);
  if (vals.length === 1 && (typeof vals[0] === 'string' || typeof vals[0] === 'number')) return String(vals[0]);
  throw new Error(`${r.path} has several fields (${Object.keys(v).slice(0, 5).join(', ')}): name one with #field`);
}

/** The one instance, shared by every registry that holds credentials. */
export const secretRefs = new SecretRefs();
