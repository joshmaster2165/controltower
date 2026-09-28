import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PageHeader } from '../components/PageHeader';
import { api, ApiError } from '../api';

type Kind = 'otlp' | 'datadog' | 'splunk' | 's3' | 'webhook';

interface Destination {
  id: string;
  name: string;
  kind: Kind;
  enabled: boolean;
  target_hint: string;
  config: Record<string, unknown>;
  secrets_set: string[];
  queued: number;
  sent: number;
  dropped: number;
  last_status: string | null;
  last_error: string | null;
  last_sent_at: number | null;
}

/** The fields each destination asks for; `secret` fields are stored encrypted and never shown again. */
const FIELDS: Record<Kind, Array<{ key: string; label: string; placeholder?: string; secret?: boolean; required?: boolean; options?: string[] }>> = {
  otlp: [
    { key: 'endpoint', label: 'OTLP/HTTP endpoint', placeholder: 'http://otel-collector:4318', required: true },
    { key: 'signal', label: 'Send as', options: ['traces', 'logs'] },
    { key: 'auth', label: 'Authorization header (optional)', placeholder: 'Bearer …', secret: true },
  ],
  datadog: [
    { key: 'api_key', label: 'API key', secret: true, required: true },
    { key: 'site', label: 'Site', placeholder: 'datadoghq.com, datadoghq.eu, us5.datadoghq.com…' },
    { key: 'service', label: 'Service', placeholder: 'controltower' },
    { key: 'ddtags', label: 'Tags', placeholder: 'env:prod,team:platform' },
  ],
  splunk: [
    { key: 'url', label: 'HTTP Event Collector URL', placeholder: 'https://splunk.example.com:8088', required: true },
    { key: 'token', label: 'HEC token', secret: true, required: true },
    { key: 'index', label: 'Index (optional)' },
    { key: 'sourcetype', label: 'Source type', placeholder: 'controltower:flight' },
  ],
  s3: [
    { key: 'bucket', label: 'Bucket', required: true },
    { key: 'region', label: 'Region', placeholder: 'us-east-1' },
    { key: 'prefix', label: 'Prefix', placeholder: 'controltower/' },
    { key: 'access_key_id', label: 'Access key ID', required: true },
    { key: 'secret_access_key', label: 'Secret access key', secret: true, required: true },
    { key: 'endpoint', label: 'Endpoint (S3-compatible stores: R2, MinIO…)', placeholder: 'leave empty for AWS' },
  ],
  webhook: [
    { key: 'url', label: 'URL', placeholder: 'https://siem.example.com/ingest', required: true },
    { key: 'secret', label: 'Signing secret (optional)', secret: true },
  ],
};
const KIND_LABEL: Record<Kind, string> = { otlp: 'OpenTelemetry', datadog: 'Datadog', splunk: 'Splunk', s3: 'S3 archive', webhook: 'Webhook' };

/** Turn form values into a destination's config (an OTLP authorization header goes in `headers`). */
function toConfig(kind: Kind, v: Record<string, string>): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const f of FIELDS[kind]) {
    const x = (v[f.key] ?? '').trim();
    if (!x) continue;
    if (kind === 'otlp' && f.key === 'auth') c.headers = { authorization: x };
    else c[f.key] = x;
  }
  return c;
}

/**
 * Where every flight is sent as it completes: the customer's own tracing, logs, SIEM or archive. Metadata
 * only — who called what, what the gates decided, cost and timings — never a prompt or an answer.
 */
export function ExportsPage() {
  const [rows, setRows] = useState<Destination[]>([]);
  const [kind, setKind] = useState<Kind | null>(null);
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => void api.get<{ destinations: Destination[] }>('/admin/api/exports').then((d) => setRows(d.destinations)), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
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

  const test = (body: Record<string, unknown>) =>
    run(async () => {
      const r = await api.post<{ ok: boolean; error?: string }>('/admin/api/exports/test', body);
      if (r.ok) setNotice('An example record was delivered.');
      else setErr(`Not delivered: ${r.error}`);
    });

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!kind) return;
    void run(async () => {
      await api.post('/admin/api/exports', { name: name || KIND_LABEL[kind], kind, config: toConfig(kind, values) });
      setKind(null);
      setValues({});
      setName('');
      setNotice('Saved. Calls from now on are sent to it.');
    });
  };

  return (
    <div className="page">
      <PageHeader
        title="Exports"
        description="Every call, sent as it completes to your own tracing, logs, SIEM or archive: who called what, what the gates decided, what it cost and how long it took. Never a prompt or an answer."
        actions={
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <button key={k} className={`btn sm ${kind === k ? 'primary' : ''}`} onClick={() => (setKind(kind === k ? null : k), setValues(k === 'otlp' ? { signal: 'traces' } : {}), setErr(null))}>
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
              Name
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={KIND_LABEL[kind]} />
            </label>
            {FIELDS[kind].map((f) => (
              <label key={f.key}>
                {f.label}
                {f.options ? (
                  <select className="input" value={values[f.key] ?? f.options[0]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                    {f.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input className="input" type={f.secret ? 'password' : 'text'} autoComplete="off" required={f.required} value={values[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                )}
              </label>
            ))}
          </fieldset>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary sm" type="submit" disabled={busy}>
              Save
            </button>
            <button className="btn sm" type="button" disabled={busy} onClick={() => void test({ kind, config: toConfig(kind, values) })}>
              Send a test record
            </button>
            <button className="btn ghost sm" type="button" onClick={() => setKind(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Destination</th>
              <th>Sends to</th>
              <th className="num">Sent</th>
              <th className="num">Waiting</th>
              <th className="num">Dropped</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td>
                  <span className="strong">{d.name}</span>
                  <span className="sub">{KIND_LABEL[d.kind] ?? d.kind}</span>
                </td>
                <td className="mono">
                  {d.target_hint}
                  {d.secrets_set.length > 0 && <span className="sub">{d.secrets_set.join(', ')} set</span>}
                </td>
                <td className="num mono">{d.sent.toLocaleString()}</td>
                <td className="num mono">{d.queued.toLocaleString()}</td>
                <td className={`num mono ${d.dropped ? '' : 'muted'}`}>{d.dropped.toLocaleString()}</td>
                <td>
                  {!d.enabled ? (
                    <span className="status">paused</span>
                  ) : d.last_status === 'error' ? (
                    <span className="status error" title={d.last_error ?? ''}>
                      failing
                    </span>
                  ) : d.last_status === 'ok' ? (
                    <span className="status ok">delivering</span>
                  ) : (
                    <span className="status">waiting for calls</span>
                  )}
                  {d.last_status === 'error' && d.last_error && <span className="sub">{d.last_error.slice(0, 80)}</span>}
                </td>
                <td>
                  <div className="row-actions">
                    <button className="btn sm" disabled={busy} onClick={() => void test({ id: d.id })}>
                      Test
                    </button>
                    <button className="btn sm" onClick={() => void run(() => api.patch(`/admin/api/exports/${d.id}`, { enabled: !d.enabled }))}>
                      {d.enabled ? 'Pause' : 'Resume'}
                    </button>
                    <button className="btn sm danger" onClick={() => void run(() => api.del(`/admin/api/exports/${d.id}`))}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="table-empty">
                  <b>Nothing exported yet</b>
                  Add a destination above: an OpenTelemetry collector, Datadog, Splunk, an S3 bucket, or any webhook.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
