import { useMemo, useState } from 'react';
import { api, ApiError, type AirspaceView, type Topology } from '../../api';
import { agentGroups } from '../../airspace/groups';
import { SWATCHES } from './shared';

/**
 * Create or edit a view: a name, a colour and the teams it covers. Every open
 * console sees the change; the view is then a link of its own under Airspace.
 */
export function ViewEditor({ view, topology, onClose, onSaved }: { view: AirspaceView | null; topology: Topology; onClose: () => void; onSaved: (v: AirspaceView | null) => void }) {
  const [name, setName] = useState(view?.name ?? '');
  const [color, setColor] = useState(view?.color ?? SWATCHES[(topology.views?.length ?? 0) % SWATCHES.length]!);
  const [teams, setTeams] = useState<Set<string>>(new Set(view?.teams ?? []));
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Every team with how many agents (copies of one agent counted once) and keys it has.
  const all = useMemo(() => {
    const groups = agentGroups(topology.keys);
    const by = new Map<string, { agents: Set<string>; keys: number }>();
    for (const k of topology.keys) {
      if (!k.team) continue;
      const t = by.get(k.team) ?? by.set(k.team, { agents: new Set(), keys: 0 }).get(k.team)!;
      t.agents.add(k.agent_id && groups.has(k.agent_id) ? `g:${k.agent_id}` : k.id);
      t.keys++;
    }
    // Teams the view names that have no keys today stay listed, so saving doesn't drop them.
    for (const t of view?.teams ?? []) if (!by.has(t)) by.set(t, { agents: new Set(), keys: 0 });
    return [...by].map(([team, c]) => ({ team, agents: c.agents.size, keys: c.keys })).sort((a, b) => a.team.localeCompare(b.team));
  }, [topology.keys, view]);
  const shown = all.filter((t) => t.team.toLowerCase().includes(filter.trim().toLowerCase()));

  const toggle = (team: string) =>
    setTeams((s) => {
      const n = new Set(s);
      if (n.has(team)) n.delete(team);
      else n.add(team);
      return n;
    });

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = { name, color, teams: [...teams] };
      const saved = view ? await api.patch<AirspaceView>(`/admin/api/airspace/views/${view.id}`, body) : await api.post<AirspaceView>('/admin/api/airspace/views', body);
      onSaved(saved);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!view || !confirm(`Delete the view "${view.name}"? Its teams, agents and gates are not changed.`)) return;
    setBusy(true);
    try {
      await api.del(`/admin/api/airspace/views/${view.id}`);
      onSaved(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="pi-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card view-editor" role="dialog" aria-label={view ? `Edit view ${view.name}` : 'New view'}>
        <div className="section-h">
          <h2>{view ? 'Edit view' : 'New view'}</h2>
          <button className="btn sm ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          A view is one part of the organization on its own map — its agents, what they reach, its traffic and what is waiting for approval. Views are shared with everyone and listed under Airspace.
        </p>
        <div className="field">
          <label htmlFor="view-name">Name</label>
          <input id="view-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Engineering" autoFocus maxLength={60} />
        </div>
        <div className="field">
          <label>Colour</label>
          <div className="swatches">
            {SWATCHES.map((c) => (
              <button key={c} type="button" className={`swatch ${c === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Colour ${c}`} aria-pressed={c === color} />
            ))}
          </div>
        </div>
        <div className="field">
          <label>
            Teams <span className="hint">· {teams.size} selected</span>
          </label>
          {all.length > 8 && <input className="input sm" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter teams" aria-label="Filter teams" style={{ marginBottom: 6 }} />}
          <div className="view-teams">
            {all.length === 0 && <div className="hint">No keys have a team yet. Set Team on the keys (Keys → a key) to group agents.</div>}
            {shown.map((t) => (
              <label key={t.team} className={teams.has(t.team) ? 'on' : ''}>
                <input type="checkbox" checked={teams.has(t.team)} onChange={() => toggle(t.team)} />
                <span className="name">{t.team}</span>
                <span className="hint">
                  {t.agents} agent{t.agents === 1 ? '' : 's'} · {t.keys} key{t.keys === 1 ? '' : 's'}
                </span>
              </label>
            ))}
          </div>
        </div>
        {err && <div className="error" style={{ marginBottom: 10 }}>{err}</div>}
        <div className="row">
          <button className="btn primary" disabled={busy || !name.trim() || teams.size === 0} onClick={() => void save()}>
            {view ? 'Save' : 'Create view'}
          </button>
          {view && (
            <button className="btn danger" disabled={busy} onClick={() => void remove()} style={{ marginLeft: 'auto' }}>
              Delete view
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
