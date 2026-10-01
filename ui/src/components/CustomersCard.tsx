import { useCallback, useEffect, useState } from 'react';
import { formatUsd } from '@controltower/shared';

/** formatUsd takes nanodollars; these lists carry dollars. */
const usd = (dollars: number, compact = false) => formatUsd(Math.round(dollars * 1e9), { compact });
import { api, ApiError } from '../api';

interface Customer {
  id: string;
  name: string | null;
  blocked: boolean;
  requests: number;
  cost_usd: number;
  agents: number;
  last_ts: number;
  budget: { limit_usd: number; spent_usd: number; period: string; hard: boolean } | null;
}
interface Tag {
  tag: string;
  requests: number;
  errors: number;
  cost_usd: number;
}

/** The ledger windows these lists support (a customer's month is more useful than its hour). */
const apiWindow = (w: string) => (w === '1h' ? '24h' : w);

/**
 * Spend by the end customer agents served (the x-ct-customer header, or the request's user field): block a
 * customer, or give it a monthly budget.
 */
export function CustomersCard({ window }: { window: string }) {
  const [rows, setRows] = useState<Customer[]>([]);
  const [budgetFor, setBudgetFor] = useState<string | null>(null);
  const [limit, setLimit] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => void api.get<{ customers: Customer[] }>(`/admin/api/customers?window=${apiWindow(window)}`).then((d) => setRows(d.customers)), [window]);
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card-head" style={{ padding: '12px 14px 0' }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Customers</h3>
        <span className="hint">From the x-ct-customer header, or the request's user field</span>
      </div>
      {err && <div className="error" style={{ padding: '8px 14px' }}>{err}</div>}
      <table className="table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Requests</th>
            <th>Agents</th>
            <th>Spend</th>
            <th>Budget</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td>
                <span className="strong">{c.name ?? c.id}</span>
                {c.name && <span className="sub mono">{c.id}</span>}
                {c.blocked && <span className="status error" style={{ marginLeft: 6 }}>blocked</span>}
              </td>
              <td className="mono">{c.requests.toLocaleString()}</td>
              <td className="mono">{c.agents}</td>
              <td className="mono num">{usd(c.cost_usd)}</td>
              <td className="mono">
                {budgetFor === c.id ? (
                  <form
                    style={{ display: 'flex', gap: 6 }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(() => api.put(`/admin/api/budgets/customer/${encodeURIComponent(c.id)}`, { limit_usd: Number(limit), period: 'monthly', hard: true })).then(() => setBudgetFor(null));
                    }}
                  >
                    <input className="input" style={{ width: 90 }} type="number" min={0} step="0.01" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="USD / month" autoFocus />
                    <button className="btn sm primary" type="submit" disabled={!(Number(limit) > 0)}>
                      Set
                    </button>
                  </form>
                ) : c.budget ? (
                  `${usd(c.budget.spent_usd, true)} / ${usd(c.budget.limit_usd, true)}`
                ) : (
                  <span className="muted">none</span>
                )}
              </td>
              <td>
                <div className="row-actions">
                  {c.budget ? (
                    <button className="btn sm" onClick={() => void act(() => api.del(`/admin/api/budgets/customer/${encodeURIComponent(c.id)}`))}>
                      Remove budget
                    </button>
                  ) : (
                    <button className="btn sm" onClick={() => (setBudgetFor(budgetFor === c.id ? null : c.id), setLimit(''))}>
                      Budget
                    </button>
                  )}
                  <button className={`btn sm ${c.blocked ? '' : 'danger'}`} onClick={() => void act(() => api.put(`/admin/api/customers/${encodeURIComponent(c.id)}`, { blocked: !c.blocked }))}>
                    {c.blocked ? 'Unblock' : 'Block'}
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="hint" style={{ padding: 20, textAlign: 'center' }}>
                No calls named a customer in this window. Agents serving your customers can send <code>x-ct-customer: &lt;id&gt;</code>.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Spend by the tags requests carried (x-ct-tags). */
export function TagsCard({ window }: { window: string }) {
  const [rows, setRows] = useState<Tag[]>([]);
  useEffect(() => {
    const load = () => void api.get<{ tags: Tag[] }>(`/admin/api/ledger/tags?window=${apiWindow(window)}`).then((d) => setRows(d.tags));
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [window]);
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card-head" style={{ padding: '12px 14px 0' }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Spend by tag</h3>
        <span className="hint">From the x-ct-tags header</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Tag</th>
            <th>Requests</th>
            <th>Errors</th>
            <th>Spend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.tag}>
              <td>
                <span className="tag">{t.tag}</span>
              </td>
              <td className="mono">{t.requests.toLocaleString()}</td>
              <td className="mono">{t.errors}</td>
              <td className="mono num">{usd(t.cost_usd)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="hint" style={{ padding: 20, textAlign: 'center' }}>
                No tagged calls in this window. Send <code>x-ct-tags: nightly-report</code> to see spend per job.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface PersonSpend {
  who: string;
  requests: number;
  errors: number;
  denied: number;
  cost_usd: number;
  in_tokens: number;
  out_tokens: number;
  last_ts: number;
  keys: Array<{ key_id: string; key_name: string; requests: number; cost_usd: number }>;
}

/**
 * Spend by who made the calls: people signed in on their laptops (Claude Code, Claude Desktop, Codex) and workloads
 * presenting an identity provider's token. Several people can share a key; this splits its spend between them.
 */
export function PeopleCard({ window }: { window: string }) {
  const [rows, setRows] = useState<PersonSpend[]>([]);
  useEffect(() => {
    const load = () => void api.get<{ people: PersonSpend[] }>(`/admin/api/ledger/people?window=${apiWindow(window)}`).then((d) => setRows(d.people)).catch(() => undefined);
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [window]);
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card-head" style={{ padding: '12px 14px 0' }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Spend by person</h3>
        <span className="hint">People signed in on their computers, and workloads with your identity provider's tokens</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Who</th>
            <th>Keys</th>
            <th>Requests</th>
            <th>Tokens</th>
            <th>Spend</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 200).map((p) => (
            <tr key={p.who}>
              <td>{p.who}</td>
              <td className="hint">{p.keys.map((k) => k.key_name).join(', ')}</td>
              <td className="mono">
                {p.requests.toLocaleString()}
                {p.errors + p.denied > 0 && <span className="hint"> · {p.errors + p.denied} failed or refused</span>}
              </td>
              <td className="mono">{(p.in_tokens + p.out_tokens).toLocaleString()}</td>
              <td className="mono num">{usd(p.cost_usd)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="hint" style={{ padding: 20, textAlign: 'center' }}>
                No calls by a signed-in person in this window. People appear here once they use Claude Code, Claude Desktop or Codex signed in through Laptops.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
