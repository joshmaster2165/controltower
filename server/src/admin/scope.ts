import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import type { KeyRecord } from '../registry.js';

/**
 * What a person may see and do beyond their role (Enterprise: organisations and teams). Admins, approvers and
 * viewers see everything; a *member* sees only their teams. Memberships add rights to anyone: a team member
 * decides the team's held calls; a team admin also manages its keys, budgets and members; an organisation admin
 * does that for every team in it, and adds teams.
 */
export interface Scope {
  /** Sees every agent. */
  all: boolean;
  /** Teams (by name, the keys' `team` label) whose agents they see, when not all. */
  teams: ReadonlySet<string>;
  /** Teams whose keys, budgets and members they manage (every team for an admin). */
  manage: ReadonlySet<string> | 'all';
  /** Teams whose held calls they decide (every team for an admin or approver). */
  approve: ReadonlySet<string> | 'all';
  /** Organisations (by id) they administer. */
  orgAdmin: ReadonlySet<string> | 'all';
}

const none = new Set<string>();
export const ADMIN_SCOPE: Scope = { all: true, teams: none, manage: 'all', approve: 'all', orgAdmin: 'all' };
/** Someone who sees nothing and may do nothing (a member whose memberships the license no longer covers). */
export const EMPTY_SCOPE: Scope = { all: false, teams: none, manage: none, approve: none, orgAdmin: none };

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireAdmin. */
    scope?: Scope;
  }
}

export const scopeOf = (req: FastifyRequest): Scope => req.scope ?? ADMIN_SCOPE;
const has = (s: ReadonlySet<string> | 'all', team: string | undefined | null) => s === 'all' || (!!team && s.has(team));

/** Whether they see this agent (and its calls, spend and approvals). */
export const seesTeam = (scope: Scope, team: string | undefined | null) => scope.all || (!!team && scope.teams.has(team));
export const seesKey = (scope: Scope, k: Pick<KeyRecord, 'team'> | undefined) => !!k && seesTeam(scope, k.team);
/** Whether they manage keys, budgets and members of this team. */
export const managesTeam = (scope: Scope, team: string | undefined | null) => has(scope.manage, team);
/** Whether they decide held calls of this team's agents. */
export const approvesTeam = (scope: Scope, team: string | undefined | null) => has(scope.approve, team);
/** Whether they have any rights beyond reading (so a scoped change may reach its handler). */
export const hasScopedRights = (s: Scope) => s.manage === 'all' || s.approve === 'all' || s.manage.size > 0 || s.approve.size > 0 || s.orgAdmin === 'all' || s.orgAdmin.size > 0;

/** The ids of the keys they see; undefined when they see all (no filter needed). */
export function visibleKeyIds(ctx: AppContext, scope: Scope): string[] | undefined {
  if (scope.all) return undefined;
  return [...ctx.registry.keysById.values()].filter((k) => seesKey(scope, k)).map((k) => k.id);
}

/** An id list safe for SQL `IN` (never empty: an empty scope matches nothing). */
export const inList = (ids: string[]) => (ids.length ? ids : ['\u0000none']);
