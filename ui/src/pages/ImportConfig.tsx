import { useState } from 'react';
import { api, ApiError } from '../api';

interface Cred {
  field: string;
  label: string;
  secret: boolean;
  from: 'literal' | 'env' | 'default_env' | 'missing';
  env?: string | null;
  required: boolean;
}

interface Plan {
  providers: Array<{ ref: string; catalog_id: string; name: string; slug: string; base_url: string | null; creds: Cred[] }>;
  deployments: Array<{ ref: string; provider_ref: string; upstream_model: string; public_name: string | null; group: string; weight: number; priced: boolean }>;
  aliases: Array<{ name: string; strategy: string; targets: Array<{ deployment_ref: string; priority: number; weight: number; via_fallback: string | null }> }>;
  mcp_servers: Array<{ name: string; slug: string; url: string }>;
  warnings: string[];
  skipped: Array<{ name: string; reason: string }>;
  missing: Array<{ provider_ref: string; provider: string; field: string; label: string; env: string | null }>;
}

const STRATEGY_LABEL: Record<string, string> = { priority: 'in order', weighted: 'weighted', 'least-latency': 'fastest first', 'least-cost': 'cheapest first' };

function source(c: Cred): string {
  if (c.from === 'literal') return 'from the file';
  if (c.from === 'env') return `from $${c.env}`;
  if (c.from === 'default_env') return `from $${c.env} (default)`;
  return c.env ? `$${c.env} is not set here` : 'not in the file';
}

/**
 * Paste a config.yaml, see exactly what it becomes, fill in any
 * secrets this server cannot resolve, then import in one step.
 */
export function ImportConfig({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [yaml, setYaml] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const preview = async () => {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      setPlan(await api.post<Plan>('/admin/api/import/config/plan', { yaml }));
    } catch (e) {
      setPlan(null);
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ providers: number; deployments: number; aliases: number; mcp_servers: number }>('/admin/api/import/config/apply', { yaml, secrets });
      setDone(`Imported ${r.providers} provider${r.providers === 1 ? '' : 's'}, ${r.deployments} model deployment${r.deployments === 1 ? '' : 's'}, ${r.aliases} alias${r.aliases === 1 ? '' : 'es'}${r.mcp_servers ? ` and ${r.mcp_servers} MCP server${r.mcp_servers === 1 ? '' : 's'}` : ''}. Use “Test” on the Providers page to check each connection.`);
      setPlan(null);
      setYaml('');
      setSecrets({});
      onImported();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const loadFile = async (f: File | undefined) => {
    if (!f) return;
    setYaml(await f.text());
    setPlan(null);
  };

  const dep = (ref: string) => plan?.deployments.find((d) => d.ref === ref);
  const prov = (ref: string) => plan?.providers.find((p) => p.ref === ref);
  const stillMissing = plan?.missing.filter((m) => !secrets[`${m.provider_ref}.${m.field}`]?.trim()) ?? [];
  const singles = plan?.deployments.filter((d) => d.public_name) ?? [];

  return (
    <div className="card import-card">
      <div className="section-h">
        <h2>Import a config file</h2>
        <button className="btn sm ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        Paste a <code>config.yaml</code> (the format <code>--config</code> takes). Models become providers and deployments; model groups and fallbacks become aliases; <code>mcp_servers</code> become MCP servers. Nothing is created until you press Import. <code>os.environ/…</code> references are read from this server's environment; anything it can't find, you enter below.
      </p>
      {!plan && (
        <>
          <textarea
            className="input mono"
            rows={12}
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            placeholder={'model_list:\n  - model_name: gpt-4o\n    params:\n      model: openai/gpt-4o\n      api_key: os.environ/OPENAI_API_KEY'}
            spellCheck={false}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={busy || !yaml.trim()} onClick={() => void preview()}>
              {busy ? 'Reading…' : 'Preview import'}
            </button>
            <label className="btn">
              Upload file
              <input type="file" accept=".yaml,.yml,text/yaml" style={{ display: 'none' }} onChange={(e) => void loadFile(e.target.files?.[0])} />
            </label>
          </div>
        </>
      )}
      {err && <div className="error" style={{ marginTop: 10 }}>{err}</div>}
      {done && <div className="import-done" style={{ marginTop: 10 }}>{done}</div>}

      {plan && (
        <div className="import-plan">
          <div className="import-summary">
            <span><b>{plan.providers.length}</b> providers</span>
            <span><b>{plan.deployments.length}</b> deployments</span>
            <span><b>{plan.aliases.length}</b> aliases</span>
            {plan.mcp_servers.length > 0 && <span><b>{plan.mcp_servers.length}</b> MCP servers</span>}
            {plan.skipped.length > 0 && <span className="warn-text"><b>{plan.skipped.length}</b> skipped</span>}
          </div>

          <h3>Providers</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Credentials</th>
              </tr>
            </thead>
            <tbody>
              {plan.providers.map((p) => (
                <tr key={p.ref}>
                  <td>
                    <b>{p.name}</b>
                    <div className="dim mono">{p.base_url ?? p.slug}</div>
                  </td>
                  <td>{p.catalog_id}</td>
                  <td>
                    {p.creds.length === 0 && <span className="dim">none needed</span>}
                    {p.creds.map((c) => (
                      <div key={c.field} className="cred-row">
                        <span>{c.label}</span>
                        {c.from === 'missing' && c.required ? (
                          <input
                            className="input sm mono"
                            type={c.secret ? 'password' : 'text'}
                            placeholder={c.env ? `$${c.env} is not set — enter it` : 'Enter it'}
                            value={secrets[`${p.ref}.${c.field}`] ?? ''}
                            onChange={(e) => setSecrets({ ...secrets, [`${p.ref}.${c.field}`]: e.target.value })}
                            autoComplete="off"
                          />
                        ) : (
                          <span className={`src ${c.from}`}>{source(c)}</span>
                        )}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Models</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Name agents use</th>
                <th>Serves</th>
              </tr>
            </thead>
            <tbody>
              {plan.aliases.map((a) => (
                <tr key={a.name}>
                  <td>
                    <b>{a.name}</b>
                    <div className="dim">alias · {STRATEGY_LABEL[a.strategy] ?? a.strategy}</div>
                  </td>
                  <td>
                    {a.targets.map((t) => {
                      const d = dep(t.deployment_ref);
                      return (
                        <div key={t.deployment_ref} className="dim">
                          {t.priority + 1}. {prov(d?.provider_ref ?? '')?.name} · <span className="mono">{d?.upstream_model}</span>
                          {t.via_fallback ? ` (fallback via ${t.via_fallback})` : ''}
                        </div>
                      );
                    })}
                  </td>
                </tr>
              ))}
              {singles.map((d) => (
                <tr key={d.ref}>
                  <td>
                    <b>{d.public_name}</b>
                    <div className="dim">model{d.priced ? ' · custom pricing' : ''}</div>
                  </td>
                  <td className="dim">
                    {prov(d.provider_ref)?.name} · <span className="mono">{d.upstream_model}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {plan.mcp_servers.length > 0 && (
            <>
              <h3>MCP servers</h3>
              <ul className="plain">
                {plan.mcp_servers.map((m) => (
                  <li key={m.slug}>
                    <b>{m.name}</b> <span className="dim mono">{m.url}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {(plan.skipped.length > 0 || plan.warnings.length > 0) && (
            <>
              <h3>Worth knowing</h3>
              <ul className="plain notes">
                {plan.skipped.map((s) => (
                  <li key={s.name}>
                    <b>Skipped {s.name}:</b> {s.reason}
                  </li>
                ))}
                {plan.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </>
          )}

          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn primary" disabled={busy || stillMissing.length > 0 || (!plan.deployments.length && !plan.mcp_servers.length)} onClick={() => void apply()}>
              {busy ? 'Importing…' : 'Import'}
            </button>
            <button className="btn ghost" onClick={() => setPlan(null)}>
              Back to the file
            </button>
            {stillMissing.length > 0 && <span className="dim">Enter {stillMissing.length} missing credential{stillMissing.length === 1 ? '' : 's'} to continue.</span>}
          </div>
        </div>
      )}
    </div>
  );
}
