import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { formatUsd } from '@controltower/shared';
import { api, ApiError } from '../api';
import { useStore } from '../store';

type Scope = 'team' | 'project' | 'key';
type Period = 'daily' | 'weekly' | 'monthly' | 'total';

interface Budget {
  scope_type: Scope;
  scope_id: string;
  name: string;
  keys: number;
  limit_usd: number;
  spent_usd: number;
  reserved_usd: number;
  period: Period;
  hard: boolean;
  resets_at: number | null;
}
interface Budgets {
  budgets: Budget[];
  teams: string[];
  projects: string[];
}
interface Form {
  scope: Scope;
  id: string;
  limit: string;
  period: Period;
  hard: boolean;
  editing: boolean;
}

const HUE = '#1f5eff';
const SCOPE_LABEL: Record<Scope, string> = { team: 'Team', project: 'Project', key: 'Agent' };
const EMPTY: Form = { scope: 'team', id: '', limit: '', period: 'monthly', hard: true, editing: false };

export function Meter({ label, sub, spent, limit, hard, actions }: { label: string; sub?: string | undefined; spent: number; limit: number; hard: boolean; actions?: ReactNode }) {
  const ratio = limit > 0 ? spent / limit : 0;
  const fill = ratio >= 1 ? '#d3374e' : ratio >= 0.8 ? '#d9860b' : HUE;
  return (
    <div className="meter">
      <div className="meter-top">
        <span className="meter-name">{label}</span>
        <span className="mono meter-amount">
          {formatUsd(spent, { compact: true })} / {formatUsd(limit, { compact: true })}
        </span>
      </div>
      <div className="meter-sub">
        <span>{[sub, hard ? 'hard' : 'soft'].filter(Boolean).join(' · ')}</span>
        {actions}
      </div>
      <div className="meter-bar" role="meter" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div style={{ width: `${Math.min(100, ratio * 100)}%`, background: fill }} />
      </div>
    </div>
  );
}

/**
 * Budgets for agents, teams and projects. A team or project budget covers
 * every key with that label; a call is refused (hard) or flagged (soft) once
 * any budget that covers it is used up.
 */
export function BudgetsCard() {
  const topology = useStore((s) => s.topology);
  const [data, setData] = useState<Budgets | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get<Budgets>('/admin/api/budgets').then(setData, () => undefined), []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setErr(null);
    try {
      await api.put(`/admin/api/budgets/${form.scope}/${encodeURIComponent(form.id.trim())}`, { limit_usd: Number(form.limit), period: form.period, hard: form.hard });
      setForm(null);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (b: Budget) => {
    if (!confirm(`Remove the ${b.period} budget for ${SCOPE_LABEL[b.scope_type].toLowerCase()} "${b.name}"?`)) return;
    await api.del(`/admin/api/budgets/${b.scope_type}/${encodeURIComponent(b.scope_id)}`);
    await load();
  };

  const keys = topology?.keys ?? [];
  const options = form?.scope === 'team' ? (data?.teams ?? []) : form?.scope === 'project' ? (data?.projects ?? []) : [];
  const budgets = data?.budgets ?? [];

  return (
    <div className="card budgets-card">
      <div className="budgets-h">
        <b>Budgets</b>
        {!form && (
          <button className="btn sm" onClick={() => setForm({ ...EMPTY, id: data?.teams[0] ?? '' })}>
            Add budget
          </button>
        )}
      </div>

      {form && (
        <div className="budget-form">
          <div className="seg sm" role="radiogroup" aria-label="Budget for">
            {(['team', 'project', 'key'] as const).map((s) => (
              <button key={s} className={form.scope === s ? 'on' : ''} disabled={form.editing} onClick={() => setForm({ ...form, scope: s, id: s === 'key' ? (keys[0]?.id ?? '') : s === 'team' ? (data?.teams[0] ?? '') : (data?.projects[0] ?? '') })}>
                {SCOPE_LABEL[s]}
              </button>
            ))}
          </div>
          <div className="field">
            <label>{form.scope === 'key' ? 'Agent' : SCOPE_LABEL[form.scope]}</label>
            {form.scope === 'key' ? (
              <select className="input" value={form.id} disabled={form.editing} onChange={(e) => setForm({ ...form, id: e.target.value })}>
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <input className="input" list="budget-scope-options" value={form.id} disabled={form.editing} placeholder={form.scope === 'team' ? 'e.g. support' : 'e.g. zendesk-triage'} onChange={(e) => setForm({ ...form, id: e.target.value })} />
                <datalist id="budget-scope-options">
                  {options.map((o) => (
                    <option key={o} value={o} />
                  ))}
                </datalist>
              </>
            )}
          </div>
          <div className="budget-row">
            <div className="field">
              <label>Limit (USD)</label>
              <input className="input" type="number" min="0" step="any" value={form.limit} onChange={(e) => setForm({ ...form, limit: e.target.value })} placeholder="500" />
            </div>
            <div className="field">
              <label>Resets</label>
              <select className="input" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value as Period })}>
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
                <option value="monthly">monthly</option>
                <option value="total">never</option>
              </select>
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={form.hard} onChange={(e) => setForm({ ...form, hard: e.target.checked })} /> Refuse calls once it is used up (otherwise alert only)
          </label>
          <div className="hint" style={{ margin: '6px 0 10px' }}>
            {form.scope === 'key' ? 'Counts' : `Covers every key with this ${form.scope}, now and later, and counts`} what was already spent in the current period (UTC).
          </div>
          {err && <div className="error" style={{ marginBottom: 8 }}>{err}</div>}
          <div className="row">
            <button className="btn sm primary" disabled={busy || !form.id.trim() || !(Number(form.limit) > 0)} onClick={() => void save()}>
              {busy ? 'Saving…' : form.editing ? 'Save budget' : 'Add budget'}
            </button>
            <button className="btn sm ghost" onClick={() => { setForm(null); setErr(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {budgets.length === 0 && !form && <div className="hint">No budgets yet. Cap an agent, a team or a project — per day, week, month or in total.</div>}
      <div className="budget-list">
        {budgets.map((b) => (
          <Meter
            key={`${b.scope_type}:${b.scope_id}`}
            label={b.scope_type === 'key' ? b.name : `${SCOPE_LABEL[b.scope_type]} ${b.name}`}
            sub={`${b.period === 'total' ? 'never resets' : b.period}${b.scope_type === 'key' ? '' : ` · ${b.keys} key${b.keys === 1 ? '' : 's'}`}`}
            spent={(b.spent_usd + b.reserved_usd) * 1e9}
            limit={b.limit_usd * 1e9}
            hard={b.hard}
            actions={
              <span className="budget-actions">
                <button className="btn sm ghost" onClick={() => setForm({ scope: b.scope_type, id: b.scope_id, limit: String(b.limit_usd), period: b.period, hard: b.hard, editing: true })}>
                  Edit
                </button>
                <button className="btn sm ghost danger-text" onClick={() => void remove(b)}>
                  Remove
                </button>
              </span>
            }
          />
        ))}
      </div>
    </div>
  );
}
