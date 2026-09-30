import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { api, ApiError } from '../api';
import { useStore } from '../store';
import { EnterpriseNotice } from './LicensePage';

interface Member {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'member';
  source: string;
}
interface Team {
  id: string;
  name: string;
  org_id: string | null;
  org_name: string | null;
  idp_groups: { admin: string[]; member: string[] };
  keys: number;
  members: Member[];
  budget: { limit_usd: number; spent_usd: number; period: string } | null;
  may_manage: boolean;
  may_budget: boolean;
}
interface Org {
  id: string;
  name: string;
  teams: Array<{ id: string; name: string }>;
  members: Member[];
  may_manage: boolean;
}

const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/** People in a team or organisation, and (for its admins) adding and removing them. */
function Members({ members, mayManage, onAdd, onRemove, busy }: { members: Member[]; mayManage: boolean; onAdd: (email: string, role: 'admin' | 'member') => void; onRemove: (m: Member) => void; busy: boolean }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  return (
    <div className="members">
      {members.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No one yet.</div>}
      {members.map((m) => (
        <div key={m.id} className="member-row">
          <span className={`tag ${m.role === 'admin' ? '' : 'muted'}`}>{m.role}</span>
          <span>{m.name ? `${m.name} · ` : ''}{m.email}</span>
          {m.source === 'idp' && <span className="sub" title="Set by the groups this person is in at your identity provider">from identity-provider groups</span>}
          {mayManage && m.source !== 'idp' && (
            <button className="link-btn" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => onRemove(m)}>
              remove
            </button>
          )}
        </div>
      ))}
      {mayManage && (
        <form
          className="member-add"
          onSubmit={(e) => {
            e.preventDefault();
            onAdd(email.trim(), role);
            setEmail('');
          }}
        >
          <input className="input" type="email" required aria-label="Email" placeholder="dana@acme.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select className="input" aria-label="As" value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member')}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <button className="btn sm" type="submit" disabled={busy}>
            Add
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * Organisations and teams (Enterprise). A team is the team label its keys carry, with admins who manage its keys,
 * budgets and people, and members who decide its agents' held calls. An organisation groups teams under admins of
 * its own. Members of a team see only their teams' agents everywhere in the console.
 */
export function TeamsPage() {
  const me = useStore((s) => s.me);
  const isAdmin = (me?.role ?? 'admin') === 'admin';
  const [teams, setTeams] = useState<Team[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlicensed, setUnlicensed] = useState(false);
  const [newOrg, setNewOrg] = useState('');
  const [newTeam, setNewTeam] = useState({ name: '', org_id: '' });
  const [groups, setGroups] = useState<Record<string, { admin: string; member: string }>>({});

  const load = useCallback(() => {
    void api
      .get<{ teams: Team[]; unassigned_labels: string[] }>('/admin/api/teams')
      .then((d) => (setTeams(d.teams), setLabels(d.unassigned_labels)))
      .catch((e) => (e instanceof ApiError && e.code === 'enterprise_required' ? setUnlicensed(true) : setErr(e instanceof ApiError ? e.message : String(e))));
    void api.get<{ orgs: Org[] }>('/admin/api/orgs').then((d) => setOrgs(d.orgs)).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    setNotice(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
      load();
    }
  };
  const add = (path: string) => (email: string, role: 'admin' | 'member') =>
    void run(async () => {
      const r = await api.put<{ email: string; created?: boolean; password?: string }>(path, { email, role });
      setNotice(r.created ? `${r.email} is new to Control Tower: their one-time password is ${r.password} (shown only now). They choose their own at first sign-in, or use single sign-on.` : `${r.email} added as ${role}.`);
    });
  const orgAdminOfSome = me?.scope ? me.scope.org_admin === 'all' || me.scope.org_admin.length > 0 : isAdmin;
  const adminOrgs = orgs.filter((o) => o.may_manage);

  if (unlicensed)
    return (
      <div className="page">
        <PageHeader title="Teams" description="Organisations and teams, with admins of their own." />
        <EnterpriseNotice feature="Organisations and team admins" />
      </div>
    );

  return (
    <div className="page">
      <PageHeader
        title="Teams"
        description="A team is the team label its keys carry, with people of its own: its admins manage its keys, budgets and people; its members decide its agents' held calls. An organisation groups teams under admins of its own. Someone whose role is member sees only their teams' agents, calls and spend."
      />
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      {notice && (
        <div className="notice-row">
          <span style={{ userSelect: 'text' }}>{notice}</span>
          <button className="btn sm ghost" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {(isAdmin || orgAdminOfSome) && (
        <div className="card teams-create">
          {isAdmin && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => (await api.post('/admin/api/orgs', { name: newOrg }), setNewOrg('')));
              }}
            >
              <input className="input" aria-label="New organisation" placeholder="New organisation, e.g. Finance" value={newOrg} onChange={(e) => setNewOrg(e.target.value)} />
              <button className="btn sm" type="submit" disabled={busy || !newOrg.trim()}>
                + Organisation
              </button>
            </form>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => (await api.post('/admin/api/teams', { name: newTeam.name, org_id: newTeam.org_id || null }), setNewTeam({ name: '', org_id: '' })));
            }}
          >
            <input className="input" aria-label="New team" placeholder="New team (its keys' team label), e.g. payments" value={newTeam.name} onChange={(e) => setNewTeam({ ...newTeam, name: e.target.value })} />
            <select className="input" aria-label="In organisation" value={newTeam.org_id} onChange={(e) => setNewTeam({ ...newTeam, org_id: e.target.value })}>
              {isAdmin && <option value="">No organisation</option>}
              {(isAdmin ? orgs : adminOrgs).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <button className="btn sm" type="submit" disabled={busy || !newTeam.name.trim() || (!isAdmin && !newTeam.org_id)}>
              + Team
            </button>
          </form>
          {labels.length > 0 && (
            <div className="muted" style={{ fontSize: 13 }}>
              Keys carry these team labels that aren't teams yet:{' '}
              {labels.map((l) => (
                <button key={l} className="link-btn" style={{ marginRight: 8 }} disabled={busy} onClick={() => void run(async () => void (await api.post('/admin/api/teams', { name: l, org_id: null })))}>
                  make “{l}” a team
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {orgs.length > 0 && <h3 className="section-title">Organisations</h3>}
      {orgs.map((o) => (
        <section key={o.id} className="card issuer-card">
          <div className="issuer-head">
            <div>
              <div className="strong">{o.name}</div>
              <div className="sub">{o.teams.length ? `Teams: ${o.teams.map((t) => t.name).join(', ')}` : 'No teams yet'}</div>
            </div>
            {isAdmin && (
              <button className="btn sm danger" disabled={busy} onClick={() => void run(async () => void (await api.del(`/admin/api/orgs/${o.id}`)))}>
                Delete
              </button>
            )}
          </div>
          <Members members={o.members} mayManage={o.may_manage} busy={busy} onAdd={add(`/admin/api/orgs/${o.id}/members`)} onRemove={(m) => void run(async () => void (await api.del(`/admin/api/orgs/${o.id}/members/${m.id}`)))} />
        </section>
      ))}

      <h3 className="section-title">Teams</h3>
      {teams.map((t) => {
        const g = groups[t.id] ?? { admin: t.idp_groups.admin.join(', '), member: t.idp_groups.member.join(', ') };
        const mayEdit = isAdmin || (t.org_id !== null && adminOrgs.some((o) => o.id === t.org_id));
        return (
          <section key={t.id} className="card issuer-card">
            <div className="issuer-head">
              <div>
                <div className="strong">{t.name}</div>
                <div className="sub">
                  {t.org_name ? `${t.org_name} · ` : ''}
                  {t.keys} {t.keys === 1 ? 'key' : 'keys'}
                  {t.budget ? ` · ${usd(t.budget.spent_usd)} of ${usd(t.budget.limit_usd)} ${t.budget.period}` : ''}
                </div>
              </div>
              {mayEdit && (
                <button className="btn sm danger" disabled={busy} onClick={() => void run(async () => void (await api.del(`/admin/api/teams/${t.id}`)))}>
                  Delete
                </button>
              )}
            </div>
            <Members members={t.members} mayManage={t.may_manage} busy={busy} onAdd={add(`/admin/api/teams/${t.id}/members`)} onRemove={(m) => void run(async () => void (await api.del(`/admin/api/teams/${t.id}/members/${m.id}`)))} />
            {mayEdit && (
              <form
                className="idp-groups"
                onSubmit={(e) => {
                  e.preventDefault();
                  const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
                  void run(async () => (await api.patch(`/admin/api/teams/${t.id}`, { idp_groups: { admin: list(g.admin), member: list(g.member) } }), setNotice(`${t.name}: groups saved. They apply at each sign-in and SCIM change.`)));
                }}
              >
                <span className="muted">From your identity provider's groups:</span>
                <label>
                  admins
                  <input className="input" value={g.admin} placeholder="e.g. Payments Leads" onChange={(e) => setGroups({ ...groups, [t.id]: { ...g, admin: e.target.value } })} />
                </label>
                <label>
                  members
                  <input className="input" value={g.member} placeholder="e.g. Payments" onChange={(e) => setGroups({ ...groups, [t.id]: { ...g, member: e.target.value } })} />
                </label>
                <button className="btn sm" type="submit" disabled={busy}>
                  Save groups
                </button>
              </form>
            )}
          </section>
        );
      })}
      {teams.length === 0 && (
        <div className="card table-empty" style={{ padding: 28 }}>
          <b>No teams yet</b>
          {isAdmin ? 'Add one above, or make one from a team label your keys already carry.' : 'Ask an admin to add you to a team.'}
        </div>
      )}
    </div>
  );
}
