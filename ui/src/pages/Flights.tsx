import { useEffect, useState } from 'react';
import { formatUsd } from '@controltower/shared';
import { api, type FlightRow } from '../api';
import { useStore } from '../store';

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export function FlightsPage() {
  const [rows, setRows] = useState<FlightRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const counters = useStore((s) => s.counters);

  const load = async () => {
    setBusy(true);
    try {
      const q = status ? `?status=${status}&limit=100` : '?limit=100';
      const r = await api.get<{ flights: FlightRow[] }>(`/admin/api/flights${q}`);
      setRows(r.flights);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Refresh a little after activity so the table follows the map.
  useEffect(() => {
    const t = setTimeout(() => void load(), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counters.flights]);

  return (
    <div className="page">
      <h1>Flights</h1>
      <p className="sub">Every request through the gateway, with tokens, cost, latency and the decision that was made.</p>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, alignItems: 'center' }}>
        <select className="input" style={{ width: 200 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
          <option value="denied">denied</option>
          <option value="rejected">rejected</option>
          <option value="ticketed">ticketed</option>
          <option value="client_aborted">client_aborted</option>
        </select>
        <button className="btn sm" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Agent</th>
              <th>Model</th>
              <th>Status</th>
              <th>Tokens in / out</th>
              <th>Cost</th>
              <th>TTFT</th>
              <th>Total</th>
              <th>Overhead</th>
              <th>Flight</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id}>
                <td className="mono">{fmtTime(f.ts)}</td>
                <td>
                  {f.key_name}
                  {f.team && <span className="tag" style={{ marginLeft: 6 }}>{f.team}</span>}
                </td>
                <td className="mono">{f.model_requested}</td>
                <td>
                  <span className={`status ${f.status ?? ''}`}>
                    {f.status ?? '…'}
                    {f.error_code && <span style={{ color: 'var(--text-faint)' }}> · {f.error_code}</span>}
                  </span>
                </td>
                <td className="mono">
                  {f.in_tokens ?? '—'} / {f.out_tokens ?? '—'}
                  {f.usage_source && f.usage_source !== 'provider' && <span style={{ color: 'var(--text-faint)' }}> ~</span>}
                </td>
                <td className="mono">{formatUsd(f.cost_nanousd)}</td>
                <td className="mono">{f.ttft_ms ?? '—'}</td>
                <td className="mono">{f.duration_ms ?? '—'} ms</td>
                <td className="mono">{f.overhead_ms ?? '—'} ms</td>
                <td className="mono" style={{ color: 'var(--text-faint)' }}>
                  {f.id.slice(-8)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} style={{ color: 'var(--text-dim)', padding: 24, textAlign: 'center' }}>
                  No flights yet. Send a request to <code>/v1/chat/completions</code> with an API key, or start with <code>CT_DEMO=1</code>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
