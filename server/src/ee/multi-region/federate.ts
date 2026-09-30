import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { ADMIN_SCOPE, scopeOf, serializeScope } from '../../admin/scope.js';

/**
 * The control plane's console across regions (Enterprise): the same question put to every region, as the person
 * asking (within their teams), and the answers merged with the control plane's own. A region that isn't reachable
 * is named, never silently missing: the console says whose calls it can't show.
 */
export interface RegionAnswer<T = any> {
  region: string;
  ok: boolean;
  status?: number;
  body?: T;
  error?: string;
}
/** Per region, for the console: answered, or why not. */
export type RegionsNote = Record<string, 'ok' | 'unreachable' | 'error'>;

/** Regions heard from in the last half minute (they poll every few seconds). */
async function regionNames(ctx: AppContext): Promise<Array<{ name: string; online: boolean }>> {
  const rows = await ctx.db.read.selectFrom('regions').select(['name', 'last_seen']).execute();
  const now = Date.now();
  return rows.map((r) => ({ name: r.name, online: !!r.last_seen && now - Number(r.last_seen) < 30_000 }));
}

export async function askRegions<T = any>(ctx: AppContext, req: FastifyRequest | undefined, method: 'GET' | 'POST', url: string, body?: unknown, only?: string): Promise<RegionAnswer<T>[]> {
  const hub = ctx.regionHub;
  if (!hub || !ctx.license.allows('multi_region')) return [];
  const regions = (await regionNames(ctx)).filter((r) => !only || r.name === only);
  // Without a person asking (a scheduled job): as an admin.
  const scope = serializeScope(req ? scopeOf(req) : ADMIN_SCOPE);
  return Promise.all(
    regions.map(async (r): Promise<RegionAnswer<T>> => {
      if (!r.online || hub.connected(r.name) === false) return { region: r.name, ok: false, error: 'unreachable' };
      try {
        const a = await hub.request(r.name, { method, url, ...(body !== undefined ? { body } : {}), scope, acting: req?.admin?.email ?? 'control plane' });
        return { region: r.name, ok: a.status < 400, status: a.status, body: a.body as T };
      } catch (err) {
        return { region: r.name, ok: false, error: (err as Error).message };
      }
    }),
  );
}

export const note = (answers: RegionAnswer[]): RegionsNote => Object.fromEntries(answers.map((a) => [a.region, a.ok ? 'ok' : a.error === 'unreachable' ? 'unreachable' : 'error']));

/** The first region that has something (a flight, an approval), for a question about one item. */
export async function findInRegions<T = any>(ctx: AppContext, req: FastifyRequest, url: string): Promise<RegionAnswer<T> | undefined> {
  return (await askRegions<T>(ctx, req, 'GET', url)).find((a) => a.ok);
}
