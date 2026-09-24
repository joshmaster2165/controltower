import type { FastifyInstance, FastifyReply } from 'fastify';
import { ulid } from 'ulid';
import type { AppContext } from '../context.js';
import { requireAdmin } from './auth.js';

/**
 * Airspace views: named slices of the organization — Engineering, Marketing,
 * Support — each a set of teams. Opening a view shows only its agents and what
 * they reach, with its own traffic and counters, so a large organization is
 * read one part at a time. Views are shared (like the map's arrangement): they
 * are part of how the organization documents itself.
 */
export interface AirspaceView {
  id: string;
  name: string;
  color: string;
  teams: string[];
}

const KEY = 'airspace.views';
const COLORS = ['#1f5eff', '#1a9e6b', '#d9860b', '#8b5cf6', '#d3374e', '#0e7490', '#c026d3', '#475569'];

export async function loadViews(ctx: AppContext): Promise<AirspaceView[]> {
  const row = await ctx.db.read.selectFrom('settings').select('value').where('key', '=', KEY).executeTakeFirst();
  if (!row) return [];
  try {
    const v = JSON.parse(row.value) as unknown;
    return Array.isArray(v) ? (v as AirspaceView[]) : [];
  } catch {
    return [];
  }
}

async function saveViews(ctx: AppContext, views: AirspaceView[]): Promise<void> {
  const now = Date.now();
  const value = JSON.stringify(views);
  await ctx.db.write
    .insertInto('settings')
    .values({ key: KEY, value, updated_at: now })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now }))
    .execute();
  ctx.viewsVersion.bump();
}

type Input = { name?: unknown; color?: unknown; teams?: unknown };

/** A clean view from a request body, or the reason it is not one. */
function parse(b: Input, views: AirspaceView[], current?: AirspaceView): Omit<AirspaceView, 'id'> | string {
  const name = b.name === undefined && current ? current.name : typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 60) return 'name is required (at most 60 characters)';
  if (views.some((v) => v.id !== current?.id && v.name.toLowerCase() === name.toLowerCase())) return `a view named "${name}" already exists`;
  const teamsIn = b.teams === undefined && current ? current.teams : b.teams;
  if (!Array.isArray(teamsIn) || !teamsIn.length || teamsIn.length > 500 || teamsIn.some((t) => typeof t !== 'string' || !t.trim() || t.length > 100)) return 'teams must be a list of team names';
  const color = b.color === undefined ? (current?.color ?? COLORS[views.length % COLORS.length]!) : b.color;
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return 'color must be a hex colour like #1f5eff';
  return { name, color, teams: [...new Set((teamsIn as string[]).map((t) => t.trim()))].sort() };
}

export async function viewRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireAdmin(ctx);
  const invalid = (reply: FastifyReply, message: string) => reply.status(400).send({ error: { code: 'invalid', message } });

  app.get('/admin/api/airspace/views', { preHandler: guard }, async () => ({ views: await loadViews(ctx) }));

  app.post('/admin/api/airspace/views', { preHandler: guard }, async (req, reply) => {
    const views = await loadViews(ctx);
    if (views.length >= 200) return invalid(reply, 'at most 200 views');
    const v = parse((req.body ?? {}) as Input, views);
    if (typeof v === 'string') return invalid(reply, v);
    const view = { id: `view_${ulid()}`, ...v };
    await saveViews(ctx, [...views, view]);
    return reply.status(201).send(view);
  });

  app.patch('/admin/api/airspace/views/:id', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const views = await loadViews(ctx);
    const current = views.find((v) => v.id === id);
    if (!current) return reply.status(404).send({ error: { code: 'not_found', message: 'no such view' } });
    const v = parse((req.body ?? {}) as Input, views, current);
    if (typeof v === 'string') return invalid(reply, v);
    const view = { id, ...v };
    await saveViews(ctx, views.map((x) => (x.id === id ? view : x)));
    return view;
  });

  app.delete('/admin/api/airspace/views/:id', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const views = await loadViews(ctx);
    if (!views.some((v) => v.id === id)) return reply.status(404).send({ error: { code: 'not_found', message: 'no such view' } });
    await saveViews(ctx, views.filter((v) => v.id !== id));
    return { ok: true };
  });
}
