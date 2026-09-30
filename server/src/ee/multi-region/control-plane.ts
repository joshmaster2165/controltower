import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { SecretBox, keyId } from '../../crypto/secrets.js';
import { REPLICATED, SETTINGS_KEYS, sign } from './tables.js';
import { sha256 } from '../admin/regions.js';

/**
 * The control plane of a multi-region deployment (Enterprise): it sends each region the configuration it serves
 * with — keys, models, providers, gates, tool servers, guardrails, exports, token issuers, secret managers, the
 * license — and hears from each region what it applied. Calls, flights and held calls never come here.
 *
 * A snapshot is every replicated table, whole. Credentials in it are re-encrypted for the region's own master key
 * (so the region works like any install, and a snapshot is useless to anyone without that key), and the snapshot
 * is signed with the region's token.
 */
type Row = Record<string, unknown>;
interface Snapshot {
  etag: string;
  at: number;
  tables: Record<string, Row[]>;
  settings: Record<string, string>;
}

export class ControlPlane {
  private cached: Snapshot | undefined;

  constructor(private readonly ctx: AppContext) {}

  /** The configuration now (read at most every 2 s, however many regions ask). */
  async snapshot(): Promise<Snapshot> {
    if (this.cached && Date.now() - this.cached.at < 2_000) return this.cached;
    const r = this.ctx.db.read as unknown as import('kysely').Kysely<Record<string, Row>>;
    const tables: Record<string, Row[]> = {};
    for (const t of REPLICATED) {
      const rows = await r.selectFrom(t.name).selectAll().execute();
      // Only configuration goes: what the region counts and measures itself stays there.
      tables[t.name] = rows
        .filter((row) => !t.skip?.(row))
        .map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !t.local.includes(k))))
        .sort((a, b) => keyOf(t.key, a).localeCompare(keyOf(t.key, b)));
    }
    const settings = Object.fromEntries((await r.selectFrom('settings').select(['key', 'value']).where('key', 'in', [...SETTINGS_KEYS]).execute()).map((s) => [String(s.key), String(s.value)]));
    // A license set in the control plane's environment is the one regions run under too.
    if (this.ctx.config?.licenseKey) {
      settings.license_key = this.ctx.config.licenseKey;
      delete settings.license_key_renewed;
    }
    // The fingerprint leaves out what changes without anyone changing the configuration (a health check's updated_at).
    const stable = Object.fromEntries(REPLICATED.map((t) => [t.name, t.volatile?.length ? tables[t.name]!.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !t.volatile!.includes(k)))) : tables[t.name]]));
    const etag = crypto.createHash('sha256').update(JSON.stringify({ tables: stable, settings })).digest('base64url').slice(0, 32);
    this.cached = { etag, at: Date.now(), tables, settings };
    return this.cached;
  }

  currentEtag(): string | undefined {
    return this.cached?.etag;
  }

  /** Forget the cached snapshot (after a change, so regions hear of it at their next poll). */
  invalidate(): void {
    this.cached = undefined;
  }

  /** The snapshot for one region: credentials re-encrypted for its master key. */
  forRegion(s: Snapshot, regionMasterKey: Buffer): { etag: string; tables: Record<string, Row[]>; settings: Record<string, string>; master_key_id: string } {
    const to = new SecretBox({ id: keyId(regionMasterKey), key: regionMasterKey, source: 'env' });
    const tables: Record<string, Row[]> = {};
    for (const t of REPLICATED) {
      tables[t.name] = (s.tables[t.name] ?? []).map((row) => {
        if (!t.enc.length) return row;
        const out = { ...row };
        for (const col of t.enc) {
          const v = row[col];
          if (typeof v === 'string' && v) {
            const aad = `${t.name}.${col}.${String(row.id)}`;
            out[col] = to.encrypt(this.ctx.secrets.decrypt(v, aad), aad);
          }
        }
        return out;
      });
    }
    return { etag: s.etag, tables, settings: s.settings, master_key_id: to.keyId };
  }

  routes(app: FastifyInstance): void {
    const ctx = this.ctx;
    /** The region a request comes from (its token), or an answer sent already. */
    const regionOf = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
      if (!ctx.license.allows('multi_region')) return void reply.status(402).send({ error: { code: 'enterprise_required', feature: 'multi_region', message: 'Several regions need a Control Tower Enterprise license on the control plane.' } });
      const auth = String(req.headers.authorization ?? '');
      const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
      const region = token ? await ctx.db.read.selectFrom('regions').select(['id', 'name']).where('token_hash', '=', sha256(token)).executeTakeFirst() : undefined;
      if (!region) return void reply.status(401).send({ error: { code: 'unknown_region', message: 'Unknown or revoked region token.' } });
      return region;
    };
    const hub = ctx.regionHub;
    if (hub) {
      // A region waits here for the console's questions…
      app.get('/cp/v1/link/next', async (req, reply) => {
        const r = await regionOf(req, reply);
        if (!r) return reply;
        // A region that hangs up (it stopped) ends its poll at once, so the console knows it's gone.
        const closed = new Promise<void>((resolve) => reply.raw.once('close', () => resolve()));
        const requests = await hub.next(r.name, undefined, closed);
        if (reply.raw.destroyed) return reply;
        return requests.length ? { requests } : reply.status(204).send();
      });
      // …sends its answers…
      app.post('/cp/v1/link/res', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
        const r = await regionOf(req, reply);
        if (!r) return reply;
        hub.answer(((req.body as { responses?: unknown[] } | undefined)?.responses ?? []) as import('./hub.js').RpcResponse[]);
        return { ok: true };
      });
      // …and its live traffic, every second: shown on the control plane's live map like its own.
      app.post('/cp/v1/link/live', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
        const r = await regionOf(req, reply);
        if (!r) return reply;
        const b = (req.body ?? {}) as { frames?: import('@controltower/shared').WsServerMessage[]; approvals?: boolean; topology?: boolean };
        for (const m of b.frames ?? []) {
          if (m?.type !== 'tick' && m?.type !== 'events') continue;
          ctx.live.receive(m);
          ctx.liveRelay?.(m);
        }
        if (b.approvals) ctx.approvalsVersion.bump();
        if (b.topology) ctx.viewsVersion.bump();
        return { ok: true };
      });
    }
    // A region asks for the configuration (with the etag it has: 304 when nothing changed) and says how it is.
    app.get('/cp/v1/config', async (req, reply) => {
      if (!ctx.license.allows('multi_region')) return reply.status(402).send({ error: { code: 'enterprise_required', feature: 'multi_region', message: 'Several regions need a Control Tower Enterprise license on the control plane.' } });
      const auth = String(req.headers.authorization ?? '');
      const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
      const region = token ? await ctx.db.read.selectFrom('regions').selectAll().where('token_hash', '=', sha256(token)).executeTakeFirst() : undefined;
      if (!region) return reply.status(401).send({ error: { code: 'unknown_region', message: 'Unknown or revoked region token.' } });
      const h = (k: string) => (typeof req.headers[k] === 'string' ? (req.headers[k] as string).slice(0, 200) : null);
      if (h('x-ct-region') && h('x-ct-region') !== region.name) return reply.status(409).send({ error: { code: 'wrong_region', message: `This token is region ${region.name}'s, not ${h('x-ct-region')}'s.` } });
      const snap = await this.snapshot();
      const applied = h('x-ct-applied-etag');
      await ctx.db.write
        .updateTable('regions')
        .set({ last_seen: Date.now(), last_instance: h('x-ct-instance'), last_version: h('x-ct-version'), last_error: h('x-ct-region-error'), ...(applied ? { applied_etag: applied, applied_at: applied !== region.applied_etag ? Date.now() : region.applied_at } : {}) })
        .where('id', '=', region.id)
        .execute();
      if (req.headers['if-none-match'] === snap.etag) return reply.status(304).header('etag', snap.etag).send();
      const body = JSON.stringify(this.forRegion(snap, Buffer.from(ctx.secrets.decrypt(region.master_key_enc, `regions.master_key_enc.${region.id}`), 'base64')));
      return reply.header('etag', snap.etag).header('content-type', 'application/json').header('x-ct-signature', sign(token, body)).send(body);
    });
  }
}

const keyOf = (key: readonly string[], row: Row) => key.map((k) => String(row[k] ?? '')).join('\u0000');
