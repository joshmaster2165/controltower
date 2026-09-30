import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PageHeader } from '../components/PageHeader';
import { api, ApiError } from '../api';
import { ago } from '../format';
import { EnterpriseNotice } from './LicensePage';

type Kind = 'aws' | 'vault' | 'gcp' | 'azure';
interface Manager {
  id: string;
  name: string;
  kind: Kind;
  target_hint: string;
  refresh_s: number;
  config: Record<string, unknown>;
  secrets_set: string[];
}
interface RefState {
  ref: string;
  manager: string;
  used_by: string[];
  status: 'ok' | 'error' | 'reading';
  error: string | null;
  read_at: number | null;
  changed_at: number | null;
}

const KIND_LABEL: Record<Kind, string> = { aws: 'AWS Secrets Manager', vault: 'HashiCorp Vault', gcp: 'Google Secret Manager', azure: 'Azure Key Vault' };
const SUGGESTED_NAME: Record<Kind, string> = { aws: 'aws', vault: 'vault', gcp: 'gcp', azure: 'keyvault' };
const EXAMPLE: Record<Kind, string> = { aws: 'prod/openai#api_key', vault: 'ai/openai#api_key', gcp: 'openai-api-key', azure: 'openai-api-key' };

interface Field {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
  options?: Array<[string, string]>;
  when?: (v: Record<string, string>) => boolean;
  wide?: boolean;
}
const FIELDS: Record<Kind, Field[]> = {
  aws: [
    { key: 'region', label: 'Region', placeholder: 'us-east-1', required: true },
    { key: 'access_key_id', label: 'Access key ID (empty: the role Control Tower runs with)', secret: true },
    { key: 'secret_access_key', label: 'Secret access key', secret: true, when: (v) => !!v.access_key_id },
    { key: 'endpoint', label: 'Endpoint (a VPC endpoint; optional)', placeholder: 'https://secretsmanager.us-east-1.amazonaws.com' },
  ],
  vault: [
    { key: 'address', label: 'Address', placeholder: 'https://vault.acme.internal:8200', required: true },
    { key: 'mount', label: 'KV v2 mount', placeholder: 'secret' },
    { key: 'namespace', label: 'Namespace (Vault Enterprise; optional)' },
    { key: 'auth', label: 'Sign in with', options: [['token', 'A token'], ['approle', 'AppRole'], ['kubernetes', 'Kubernetes service account']] },
    { key: 'token', label: 'Token', secret: true, when: (v) => (v.auth ?? 'token') === 'token' },
    { key: 'role_id', label: 'Role ID', when: (v) => v.auth === 'approle' },
    { key: 'secret_id', label: 'Secret ID', secret: true, when: (v) => v.auth === 'approle' },
    { key: 'role', label: 'Vault role', when: (v) => v.auth === 'kubernetes' },
    { key: 'jwt_path', label: 'Service account token file', placeholder: '/var/run/secrets/kubernetes.io/serviceaccount/token', when: (v) => v.auth === 'kubernetes' },
  ],
  gcp: [
    { key: 'project', label: 'Project', placeholder: 'acme-prod', required: true },
    { key: 'service_account_json', label: 'Service account key (JSON; empty: the service account Control Tower runs as)', secret: true, wide: true },
  ],
  azure: [
    { key: 'vault_url', label: 'Vault URL', placeholder: 'https://acme.vault.azure.net', required: true },
    { key: 'tenant_id', label: 'Tenant ID (with a client secret)' },
    { key: 'client_id', label: 'Client ID (or a user-assigned identity)' },
    { key: 'client_secret', label: 'Client secret (empty: managed identity)', secret: true },
  ],
};

/**
 * Credentials kept in your secret manager instead of Control Tower's database: a provider's key, a tool
 * server's token or an export's HEC token can be a reference, secret://<manager>/<path>#<field>, read into
 * memory and read again every few minutes so rotations reach Control Tower. Enterprise.
 */
export function SecretManagersPage() {
  const [managers, setManagers] = useState<Manager[]>([]);
  const [refs, setRefs] = useState<RefState[]>([]);
  const [kind, setKind] = useState<Kind | null>(null);
  const [name, setName] = useState('');
  const [refresh, setRefresh] = useState('300');
  const [values, setValues] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlicensed, setUnlicensed] = useState(false);
  const [probe, setProbe] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    void api
      .get<{ managers: Manager[]; refs: RefState[] }>('/admin/api/secret-managers')
      .then((d) => (setManagers(d.managers), setRefs(d.refs)))
      .catch((e) => (e instanceof ApiError && e.code === 'enterprise_required' ? setUnlicensed(true) : setErr(e instanceof ApiError ? e.message : String(e))));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

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

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!kind) return;
    const config = Object.fromEntries(FIELDS[kind].filter((f) => !f.when || f.when(values)).map((f) => [f.key, (values[f.key] ?? '').trim()]).filter(([, v]) => v));
    void run(async () => {
      await api.post('/admin/api/secret-managers', { name: name.trim() || SUGGESTED_NAME[kind], kind, config, refresh_s: Number(refresh) || 300 });
      setNotice(`Saved. Use it anywhere a credential goes: secret://${name.trim() || SUGGESTED_NAME[kind]}/${EXAMPLE[kind]}`);
      setKind(null);
      setValues({});
      setName('');
    });
  };

  const test = (m: Manager) =>
    run(async () => {
      const path = (probe[m.id] ?? '').trim();
      const r = await api.post<{ ok: boolean; message: string }>(`/admin/api/secret-managers/${m.id}/test`, path ? { ref: path.startsWith('secret://') ? path : `secret://${m.name}/${path}` } : {});
      if (r.ok) setNotice(`${m.name}: ${r.message}.`);
      else setErr(`${m.name}: ${r.message}`);
    });

  if (unlicensed)
    return (
      <div className="page">
        <PageHeader title="Secret managers" description="Keep credentials in your secret manager, not in Control Tower." />
        <EnterpriseNotice feature="Secret managers" />
      </div>
    );

  return (
    <div className="page">
      <PageHeader
        title="Secret managers"
        description="Keep credentials in your secret manager instead of Control Tower's database. Anywhere a credential goes — a provider's API key, a tool server's token, an export's token — write a reference: secret://<manager>/<path>#<field>. Values are held in memory only, and read again every few minutes, so a key rotated in the manager reaches Control Tower without touching it."
        actions={
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <button key={k} className={`btn sm ${kind === k ? 'primary' : ''}`} onClick={() => (setKind(kind === k ? null : k), setValues(k === 'vault' ? { auth: 'token' } : {}), setName(''), setErr(null))}>
                + {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        }
      />
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      {notice && (
        <div className="notice-row">
          <span>{notice}</span>
          <button className="btn sm ghost" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {kind && (
        <form className="card routing-editor" style={{ padding: 16, marginBottom: 14 }} onSubmit={save}>
          <fieldset>
            <legend>{KIND_LABEL[kind]}</legend>
            <label>
              Name (references use it)
              <input className="input mono" value={name} placeholder={SUGGESTED_NAME[kind]} onChange={(e) => setName(e.target.value.toLowerCase())} />
            </label>
            {FIELDS[kind]
              .filter((f) => !f.when || f.when(values))
              .map((f) => (
                <label key={f.key} style={f.wide ? { gridColumn: '1 / -1' } : undefined}>
                  {f.label}
                  {f.options ? (
                    <select className="input" value={values[f.key] ?? f.options[0]![0]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                      {f.options.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  ) : f.wide ? (
                    <textarea className="input mono" rows={3} value={values[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                  ) : (
                    <input className="input" type={f.secret ? 'password' : 'text'} autoComplete="off" required={f.required} value={values[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                  )}
                </label>
              ))}
            <label>
              Read again every (seconds)
              <input className="input" inputMode="numeric" value={refresh} onChange={(e) => setRefresh(e.target.value.replace(/\D/g, ''))} />
            </label>
          </fieldset>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary sm" type="submit" disabled={busy}>
              Save
            </button>
            <button className="btn ghost sm" type="button" onClick={() => setKind(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="card" style={{ padding: 0, marginBottom: 14 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Manager</th>
              <th>Where</th>
              <th>Read again</th>
              <th>Check it (optionally, read a secret)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {managers.map((m) => (
              <tr key={m.id}>
                <td>
                  <span className="strong mono">{m.name}</span>
                  <span className="sub">{KIND_LABEL[m.kind]}</span>
                </td>
                <td className="mono">
                  {m.target_hint}
                  {m.secrets_set.length > 0 && <span className="sub">{m.secrets_set.join(', ')} set</span>}
                </td>
                <td className="muted">every {m.refresh_s >= 60 ? `${Math.round(m.refresh_s / 60)} min` : `${m.refresh_s} s`}</td>
                <td>
                  <input className="input mono" style={{ minWidth: 200 }} aria-label={`Secret to read from ${m.name}`} value={probe[m.id] ?? ''} placeholder={EXAMPLE[m.kind]} onChange={(e) => setProbe({ ...probe, [m.id]: e.target.value })} />
                </td>
                <td>
                  <div className="row-actions">
                    <button className="btn sm" disabled={busy} onClick={() => void test(m)}>
                      Test
                    </button>
                    <button className="btn sm danger" onClick={() => void run(() => api.del(`/admin/api/secret-managers/${m.id}`))}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {managers.length === 0 && (
              <tr>
                <td colSpan={5} className="table-empty">
                  <b>No secret managers yet</b>
                  Add AWS Secrets Manager, HashiCorp Vault, Google Secret Manager or Azure Key Vault above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <section className="card" style={{ padding: 0 }}>
        <div className="issuer-head" style={{ padding: '12px 16px 8px' }}>
          <div>
            <div className="strong">References in use</div>
            <div className="sub">Credentials read from a manager, what uses them, and the last read. Values are never shown.</div>
          </div>
          <button className="btn sm" disabled={busy || !refs.length} onClick={() => void run(async () => (await api.post('/admin/api/secret-managers/refresh'), setNotice('Every reference was read again.')))}>
            Read all again
          </button>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Reference</th>
              <th>Used by</th>
              <th>Status</th>
              <th>Read</th>
              <th>Last changed</th>
            </tr>
          </thead>
          <tbody>
            {refs.map((r) => (
              <tr key={r.ref}>
                <td className="mono">{r.ref}</td>
                <td>{r.used_by.join(', ')}</td>
                <td>
                  <span className={`status ${r.status === 'ok' ? 'ok' : r.status === 'error' ? 'error' : ''}`}>{r.status === 'ok' ? 'read' : r.status === 'error' ? "can't be read" : 'reading'}</span>
                  {r.error && <span className="sub" style={{ whiteSpace: 'normal' }}>{r.error}{r.status === 'error' ? ' — the last value read is still used' : ''}</span>}
                </td>
                <td className="muted">{r.read_at ? ago(r.read_at) : '—'}</td>
                <td className="muted">{r.changed_at ? ago(r.changed_at) : '—'}</td>
              </tr>
            ))}
            {refs.length === 0 && (
              <tr>
                <td colSpan={5} className="table-empty">
                  <b>No references yet</b>
                  Put secret://&lt;manager&gt;/&lt;path&gt;#&lt;field&gt; in a credential field: a provider's API key, an MCP server's token, an export's token.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
