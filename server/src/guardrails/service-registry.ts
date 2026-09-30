import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import type { SecretBox } from '../crypto/secrets.js';
import { checkService, type CheckContext, type GuardrailConfig, type GuardrailKind, type ServiceResult } from './services.js';
import { secretRefs } from '../ee/secret-managers/index.js';

/** The guardrail services configured, decrypted in memory; reloaded when one changes. */
export interface GuardrailService {
  id: string;
  name: string;
  kind: GuardrailKind;
  config: GuardrailConfig;
  enabled: boolean;
}

export class GuardrailServices {
  services = new Map<string, GuardrailService>();
  /** The last outcome of each, for the console (kept in memory, written every so often). */
  private health = new Map<string, { status: 'ok' | 'error'; error: string | undefined; at: number; dirty: boolean }>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly secrets: SecretBox,
  ) {}

  async reload(): Promise<void> {
    const rows = await this.db.selectFrom('guardrail_services').selectAll().execute();
    const next = new Map<string, GuardrailService>();
    for (const r of rows) {
      try {
        next.set(r.id, { id: r.id, name: r.name, kind: r.kind as GuardrailKind, config: secretRefs.apply(JSON.parse(this.secrets.decrypt(r.config_enc, `guardrail_services.config_enc.${r.id}`)) as GuardrailConfig, `guardrail ${r.name}`), enabled: r.enabled === 1 });
      } catch (err) {
        console.error(`[guardrails] cannot decrypt service ${r.id}:`, (err as Error).message);
      }
    }
    this.services = next;
  }

  encryptConfig(id: string, c: GuardrailConfig): string {
    return this.secrets.encrypt(JSON.stringify(c), `guardrail_services.config_enc.${id}`);
  }

  async check(id: string, texts: string[], ctx: CheckContext): Promise<(ServiceResult & { service: GuardrailService }) | undefined> {
    const s = this.services.get(id);
    if (!s || !s.enabled) return undefined;
    const r = await checkService(s.kind, s.config, texts, ctx);
    this.health.set(id, { status: r.verdict === 'error' ? 'error' : 'ok', error: r.verdict === 'error' ? r.reason : undefined, at: Date.now(), dirty: true });
    return { ...r, service: s };
  }

  lastOutcome(id: string): { status: string; error: string | undefined; at: number } | undefined {
    return this.health.get(id);
  }

  /** Write what the console shows about each service (called now and then). */
  async save(): Promise<void> {
    for (const [id, h] of this.health) {
      if (!h.dirty) continue;
      h.dirty = false;
      await this.db.updateTable('guardrail_services').set({ last_status: h.status, last_error: h.error ?? null, last_checked_at: h.at }).where('id', '=', id).execute().catch(() => undefined);
    }
  }
}

/** The texts in a value (skipping protocol fields and binary), and a way to put masked texts back. */
export function textLeaves(value: unknown, skip: (key: string | undefined, s: string) => boolean): { texts: string[]; rebuild: (masked: string[]) => unknown } {
  const texts: string[] = [];
  const walk = (v: unknown, key?: string): void => {
    if (typeof v === 'string') {
      if (!skip(key, v)) texts.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(value);
  const rebuild = (masked: string[]): unknown => {
    let i = 0;
    const put = (v: unknown, key?: string): unknown => {
      if (typeof v === 'string') return skip(key, v) ? v : (masked[i++] ?? v);
      if (Array.isArray(v)) return v.map((x) => put(x));
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, put(x, k)]));
      return v;
    };
    return put(value);
  };
  return { texts, rebuild };
}
