import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { api, ApiError } from '../api';
import { ago } from '../format';
import { EnterpriseNotice } from './LicensePage';

interface Region {
  id: string;
  name: string;
  status: 'waiting' | 'in_sync' | 'behind' | 'unreachable';
  last_seen: number | null;
  instance: string | null;
  version: string | null;
  applied_at: number | null;
  error: string | null;
}
const STATUS: Record<Region['status'], { label: string; cls: string }> = {
  waiting: { label: 'waiting for it to start', cls: '' },
  in_sync: { label: 'in sync', cls: 'ok' },
  behind: { label: 'catching up', cls: 'ticketed' },
  unreachable: { label: 'not heard from', cls: 'error' },
};

/**
 * Regions of a multi-region deployment (Enterprise). This install is the control plane: each region takes its
 * configuration from here, keeps serving on it when this is out of reach, and keeps its calls to itself.
 */
export function RegionsPage() {
  const [regions, setRegions] = useState<Region[]>([]);
  const [cpUrl, setCpUrl] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [env, setEnv] = useState<{ name: string; env: Record<string, string> } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlicensed, setUnlicensed] = useState(false);

  const load = useCallback(() => {
    void api
      .get<{ regions: Region[]; control_plane_url: string | null }>('/admin/api/regions')
      .then((d) => (setRegions(d.regions), setCpUrl(d.control_plane_url)))
      .catch((e) => (e instanceof ApiError && e.code === 'enterprise_required' ? setUnlicensed(true) : setErr(e instanceof ApiError ? e.message : String(e))));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setErr(null);
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
  const envText = (e: Record<string, string>) => Object.entries(e).map(([k, v]) => `${k}=${v}`).join('\n');

  if (unlicensed)
    return (
      <div className="page">
        <PageHeader title="Regions" description="Serve agents from several regions, configured from one place." />
        <EnterpriseNotice feature="The multi-region control plane" />
      </div>
    );

  return (
    <div className="page">
      <PageHeader
        title="Regions"
        description="This install is the control plane. Each region runs its own Control Tower with its own database: it takes its configuration from here — keys, models, providers, gates, tool servers — and serves its own agents, whose calls stay in the region. If this control plane is out of reach, regions keep serving on the configuration they last received."
      />
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      {!cpUrl && <div className="notice-row">Set CT_PUBLIC_URL on this server to the URL regions reach it at: it goes into what each region is given.</div>}

      <form
        className="card teams-create"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await api.post<{ name: string; env: Record<string, string> }>('/admin/api/regions', { name });
            setEnv(r);
            setName('');
          });
        }}
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="input" aria-label="Region name" placeholder="Region name, e.g. eu-west" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
          <button className="btn sm" type="submit" disabled={busy || !name.trim()}>
            + Region
          </button>
        </div>
      </form>

      {env && (
        <section className="card issuer-card region-env">
          <div className="strong">Start {env.name}'s servers with these settings</div>
          <p className="sub">Shown only now. Keep them in your secret store; every server of the region uses the same ones, with its own database (CT_DATABASE_URL) and Redis (CT_REDIS_URL).</p>
          <pre className="code mono" style={{ userSelect: 'all' }}>{envText(env.env)}</pre>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(envText(env.env)).catch(() => undefined)}>
              Copy
            </button>
            <button className="btn sm ghost" onClick={() => setEnv(null)}>
              Done
            </button>
          </div>
        </section>
      )}

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Region</th>
              <th>Configuration</th>
              <th>Last heard from</th>
              <th>Version</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {regions.map((r) => (
              <tr key={r.id}>
                <td className="strong mono">{r.name}</td>
                <td>
                  <span className={`status ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                  {r.applied_at && <span className="sub">applied {ago(r.applied_at)}</span>}
                  {r.error && <span className="sub" style={{ color: 'var(--danger)', whiteSpace: 'normal' }}>{r.error}</span>}
                </td>
                <td className="muted">
                  {r.last_seen ? ago(r.last_seen) : '—'}
                  {r.instance && <span className="sub mono">{r.instance}</span>}
                </td>
                <td className="mono muted">{r.version ?? '—'}</td>
                <td>
                  <div className="row-actions">
                    <button className="btn sm" disabled={busy} title="A new token for this region (the old one stops at once)" onClick={() => void run(async () => setEnv(await api.post(`/admin/api/regions/${r.id}/token`)))}>
                      New token
                    </button>
                    <button className="btn sm danger" disabled={busy} onClick={() => void run(async () => void (await api.del(`/admin/api/regions/${r.id}`)))}>
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {regions.length === 0 && (
              <tr>
                <td colSpan={5} className="table-empty">
                  <b>No regions yet</b>
                  Add one above; it gets its own token and master key, shown once, to start its servers with.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
