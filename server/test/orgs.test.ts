import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { Orgs, syncIdpTeams } from '../src/ee/orgs.js';
import { roleMay } from '../src/admin/auth.js';
import { ADMIN_SCOPE, EMPTY_SCOPE, approvesTeam, managesTeam, seesTeam } from '../src/admin/scope.js';

async function setup(licensed = true) {
  const db = openSqlite('', { memory: true });
  const now = Date.now();
  await db.write.insertInto('orgs').values([{ id: 'o_fin', name: 'Finance', created_at: now, updated_at: now }]).execute();
  await db.write
    .insertInto('teams')
    .values([
      { id: 't_pay', name: 'payments', org_id: 'o_fin', idp_groups: JSON.stringify({ admin: ['Payments Leads'], member: ['Payments'] }), created_at: now, updated_at: now },
      { id: 't_tax', name: 'tax', org_id: 'o_fin', idp_groups: '{}', created_at: now, updated_at: now },
      { id: 't_web', name: 'web', org_id: null, idp_groups: '{}', created_at: now, updated_at: now },
    ])
    .execute();
  await db.write
    .insertInto('memberships')
    .values([
      { admin_id: 'u_pay_admin', scope_type: 'team', scope_id: 't_pay', role: 'admin', source: 'console', created_at: now },
      { admin_id: 'u_tax_member', scope_type: 'team', scope_id: 't_tax', role: 'member', source: 'console', created_at: now },
      { admin_id: 'u_cfo', scope_type: 'org', scope_id: 'o_fin', role: 'admin', source: 'console', created_at: now },
    ])
    .execute();
  let on = licensed;
  const orgs = new Orgs({ db: db.write, allowed: () => on });
  await orgs.reload();
  return { db, orgs, license: (v: boolean) => (on = v) };
}

describe('organisations and teams', () => {
  it('a member sees only their teams; memberships give rights by role', async () => {
    const { orgs } = await setup();
    const payAdmin = orgs.scopeFor({ adminId: 'u_pay_admin', role: 'member' });
    expect(payAdmin.all).toBe(false);
    expect([...payAdmin.teams]).toEqual(['payments']);
    expect(managesTeam(payAdmin, 'payments')).toBe(true);
    expect(managesTeam(payAdmin, 'tax')).toBe(false);
    expect(seesTeam(payAdmin, 'web')).toBe(false);
    const taxMember = orgs.scopeFor({ adminId: 'u_tax_member', role: 'member' });
    expect(approvesTeam(taxMember, 'tax')).toBe(true);
    expect(managesTeam(taxMember, 'tax')).toBe(false);
    // An organisation's admin manages every team in it, and nothing outside it.
    const cfo = orgs.scopeFor({ adminId: 'u_cfo', role: 'member' });
    expect([...cfo.teams].sort()).toEqual(['payments', 'tax']);
    expect(managesTeam(cfo, 'tax')).toBe(true);
    expect(seesTeam(cfo, 'web')).toBe(false);
    expect(cfo.orgAdmin).toEqual(new Set(['o_fin']));
    // A viewer who is a team admin sees everything and manages that team.
    const viewer = orgs.scopeFor({ adminId: 'u_pay_admin', role: 'viewer' });
    expect(viewer.all).toBe(true);
    expect(managesTeam(viewer, 'payments')).toBe(true);
    expect(managesTeam(viewer, 'web')).toBe(false);
    expect(orgs.scopeFor({ adminId: 'x', role: 'approver' }).approve).toBe('all');
    expect(orgs.scopeFor({ adminId: 'x', role: 'admin' })).toBe(ADMIN_SCOPE);
    expect(seesTeam(orgs.scopeFor({ adminId: 'nobody', role: 'member' }), 'payments')).toBe(false);
  });

  it('without the license, members see nothing and the other roles keep theirs', async () => {
    const { orgs, license } = await setup();
    license(false);
    expect(orgs.scopeFor({ adminId: 'u_pay_admin', role: 'member' })).toEqual(EMPTY_SCOPE);
    const viewer = orgs.scopeFor({ adminId: 'u_pay_admin', role: 'viewer' });
    expect(viewer.all).toBe(true);
    expect(managesTeam(viewer, 'payments')).toBe(false);
  });

  it('what a member may reach: their teams\' data, not settings or people', () => {
    const rights = { ...EMPTY_SCOPE, manage: new Set(['payments']), teams: new Set(['payments']) };
    expect(roleMay('member', 'GET', '/admin/api/flights', rights)).toBe(true);
    expect(roleMay('member', 'GET', '/admin/api/topology', rights)).toBe(true);
    expect(roleMay('member', 'GET', '/admin/api/users', rights)).toBe(false);
    expect(roleMay('member', 'GET', '/admin/api/audit', rights)).toBe(false);
    expect(roleMay('member', 'GET', '/admin/api/alerts', rights)).toBe(false);
    expect(roleMay('member', 'POST', '/admin/api/providers', rights)).toBe(false);
    expect(roleMay('member', 'POST', '/admin/api/keys', rights)).toBe(true);
    expect(roleMay('member', 'POST', '/admin/api/keys', EMPTY_SCOPE)).toBe(false);
    expect(roleMay('viewer', 'POST', '/admin/api/keys', rights)).toBe(true);
    expect(roleMay('viewer', 'POST', '/admin/api/rules', rights)).toBe(false);
    expect(roleMay('viewer', 'GET', '/admin/api/secret-managers')).toBe(false);
    expect(roleMay('viewer', 'GET', '/admin/api/token-issuers')).toBe(false);
  });

  it('team memberships follow identity-provider groups, leaving console ones alone', async () => {
    const { orgs } = await setup();
    expect(await syncIdpTeams((orgs as unknown as { deps: { db: never } }).deps.db, orgs, 'u_new', ['Payments'])).toBe(true);
    expect(orgs.membershipsOf('u_new')).toMatchObject([{ scopeId: 't_pay', role: 'member', source: 'idp' }]);
    await syncIdpTeams((orgs as unknown as { deps: { db: never } }).deps.db, orgs, 'u_new', ['Payments', 'Payments Leads']);
    expect(orgs.membershipsOf('u_new')).toMatchObject([{ scopeId: 't_pay', role: 'admin' }]);
    await syncIdpTeams((orgs as unknown as { deps: { db: never } }).deps.db, orgs, 'u_new', []);
    expect(orgs.membershipsOf('u_new')).toEqual([]);
    // A membership added in the console isn't removed by groups.
    await syncIdpTeams((orgs as unknown as { deps: { db: never } }).deps.db, orgs, 'u_pay_admin', []);
    expect(orgs.membershipsOf('u_pay_admin')).toMatchObject([{ scopeId: 't_pay', role: 'admin', source: 'console' }]);
  });
});
