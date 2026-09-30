import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { ADMIN_SCOPE, EMPTY_SCOPE, type Scope } from '../admin/scope.js';
import type { Role } from '../admin/auth.js';

/**
 * Organisations and teams (Enterprise). A team is the `team` label keys already carry, given members and admins;
 * an organisation groups teams under admins of its own. Memberships decide what a person may see and change
 * beyond their role (see Scope). Held in memory, reloaded on every change (and on every instance).
 */
export interface Org {
  id: string;
  name: string;
}
export interface Team {
  id: string;
  name: string;
  orgId: string | undefined;
  idpGroups: { admin: string[]; member: string[] };
}
export interface Membership {
  adminId: string;
  scopeType: 'org' | 'team';
  scopeId: string;
  role: 'admin' | 'member';
  source: string;
}

export class Orgs {
  orgs = new Map<string, Org>();
  teams = new Map<string, Team>();
  teamsByName = new Map<string, Team>();
  private byPerson = new Map<string, Membership[]>();
  private all: Membership[] = [];

  constructor(private readonly deps: { db: Kysely<Database>; allowed: () => boolean }) {}

  async reload(): Promise<void> {
    const [orgs, teams, members] = await Promise.all([
      this.deps.db.selectFrom('orgs').selectAll().execute(),
      this.deps.db.selectFrom('teams').selectAll().execute(),
      this.deps.db.selectFrom('memberships').selectAll().execute(),
    ]);
    this.orgs = new Map(orgs.map((o) => [o.id, { id: o.id, name: o.name }]));
    this.teams = new Map(
      teams.map((t) => {
        const g = JSON.parse(t.idp_groups || '{}') as { admin?: string[]; member?: string[] };
        return [t.id, { id: t.id, name: t.name, orgId: t.org_id ?? undefined, idpGroups: { admin: g.admin ?? [], member: g.member ?? [] } }];
      }),
    );
    this.teamsByName = new Map([...this.teams.values()].map((t) => [t.name, t]));
    this.all = members.map((m) => ({ adminId: m.admin_id, scopeType: m.scope_type, scopeId: m.scope_id, role: m.role, source: m.source }));
    this.byPerson = new Map();
    for (const m of this.all) (this.byPerson.get(m.adminId) ?? this.byPerson.set(m.adminId, []).get(m.adminId)!).push(m);
  }

  get licensed(): boolean {
    return this.deps.allowed();
  }

  membershipsOf(adminId: string): Membership[] {
    return this.byPerson.get(adminId) ?? [];
  }

  membersOf(scopeType: 'org' | 'team', scopeId: string): Membership[] {
    return this.all.filter((m) => m.scopeType === scopeType && m.scopeId === scopeId);
  }

  teamsOfOrg(orgId: string): Team[] {
    return [...this.teams.values()].filter((t) => t.orgId === orgId);
  }

  /** What a signed-in person may see and do, from their role and memberships. */
  scopeFor(p: { adminId: string; role: Role }): Scope {
    if (p.role === 'admin') return ADMIN_SCOPE;
    const everything = p.role !== 'member';
    // Without the license, memberships give nothing: members see nothing, the others keep their role.
    if (!this.deps.allowed()) return everything ? { ...EMPTY_SCOPE, all: true, approve: p.role === 'approver' ? 'all' : new Set() } : EMPTY_SCOPE;
    const teams = new Set<string>();
    const manage = new Set<string>();
    const approve = new Set<string>();
    const orgAdmin = new Set<string>();
    const add = (t: Team, role: 'admin' | 'member') => {
      teams.add(t.name);
      approve.add(t.name);
      if (role === 'admin') manage.add(t.name);
    };
    for (const m of this.membershipsOf(p.adminId)) {
      if (m.scopeType === 'team') {
        const t = this.teams.get(m.scopeId);
        if (t) add(t, m.role);
      } else if (this.orgs.has(m.scopeId)) {
        if (m.role === 'admin') orgAdmin.add(m.scopeId);
        for (const t of this.teamsOfOrg(m.scopeId)) add(t, m.role);
      }
    }
    return { all: everything, teams, manage, approve: p.role === 'approver' ? 'all' : approve, orgAdmin };
  }
}

/**
 * Team memberships from identity-provider groups: a team lists the groups that make people its admins or members,
 * and each sign-in (and each SCIM group change) sets that person's memberships from their groups. Memberships
 * added in the console are left alone. Returns whether anything changed.
 */
export async function syncIdpTeams(db: Kysely<Database>, orgs: Orgs, adminId: string, groups: string[]): Promise<boolean> {
  if (!orgs.licensed) return false;
  const want = new Map<string, 'admin' | 'member'>();
  for (const t of orgs.teams.values()) {
    if (t.idpGroups.admin.some((g) => groups.includes(g))) want.set(t.id, 'admin');
    else if (t.idpGroups.member.some((g) => groups.includes(g))) want.set(t.id, 'member');
  }
  const have = orgs.membershipsOf(adminId).filter((m) => m.scopeType === 'team');
  const fromIdp = new Map(have.filter((m) => m.source === 'idp').map((m) => [m.scopeId, m.role]));
  const fromConsole = new Set(have.filter((m) => m.source !== 'idp').map((m) => m.scopeId));
  const stale = [...fromIdp.keys()].filter((id) => !want.has(id));
  const add = [...want].filter(([id, role]) => !fromConsole.has(id) && fromIdp.get(id) !== role);
  if (!stale.length && !add.length) return false;
  await db.transaction().execute(async (trx) => {
    if (stale.length) await trx.deleteFrom('memberships').where('admin_id', '=', adminId).where('scope_type', '=', 'team').where('source', '=', 'idp').where('scope_id', 'in', stale).execute();
    for (const [id, role] of add)
      await trx
        .insertInto('memberships')
        .values({ admin_id: adminId, scope_type: 'team', scope_id: id, role, source: 'idp', created_at: Date.now() })
        .onConflict((oc) => oc.columns(['admin_id', 'scope_type', 'scope_id']).doUpdateSet({ role }))
        .execute();
  });
  await orgs.reload();
  return true;
}
