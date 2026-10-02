import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PageHeader } from '../components/PageHeader';
import { api, ApiError } from '../api';
import { ago } from '../format';
import { EnterpriseNotice } from './LicensePage';

interface Rule {
  claims: Record<string, string>;
  key_id: string;
  key_name?: string | null;
}
interface Issuer {
  id: string;
  name: string;
  issuer: string;
  jwks_uri: string | null;
  jwks_keys: number | null;
  audiences: string[];
  rules: Rule[];
  principal_claim: string;
  max_lifetime_s: number | null;
  people: boolean;
  people_seen: number;
  enabled: boolean;
  keys_status: 'ok' | 'error' | null;
  keys_error: string | null;
  accepted: number;
  refused: number;
  last_refusal: string | null;
  last_refusal_at: number | null;
  last_used_at: number | null;
}
interface KeyRow {
  id: string;
  name: string;
  built_in?: boolean;
}

/** Where tokens usually come from, and the claims that name a workload there. */
const PRESETS: Array<{ id: string; label: string; issuer: string; audience: string; claim: string; example: string; principal?: string }> = [
  { id: 'kubernetes', label: 'Kubernetes', issuer: 'https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE', audience: 'controltower', claim: 'sub', example: 'system:serviceaccount:prod:invoice-bot' },
  { id: 'github', label: 'GitHub Actions', issuer: 'https://token.actions.githubusercontent.com', audience: 'controltower', claim: 'repository', example: 'acme/*' },
  { id: 'entra', label: 'Microsoft Entra ID', issuer: 'https://login.microsoftonline.com/<tenant-id>/v2.0', audience: 'api://controltower', claim: 'azp', example: '<client application id>' },
  { id: 'okta', label: 'Okta', issuer: 'https://acme.okta.com/oauth2/<authorization server id>', audience: 'api://controltower', claim: 'cid', example: '<client id>' },
  { id: 'auth0', label: 'Auth0', issuer: 'https://acme.us.auth0.com/', audience: 'https://controltower.acme.com', claim: 'azp', example: '<client id>' },
  { id: 'google', label: 'Google Cloud', issuer: 'https://accounts.google.com', audience: 'https://controltower.acme.com', claim: 'email', example: 'invoice-bot@acme-prod.iam.gserviceaccount.com', principal: 'email' },
  { id: 'other', label: 'Other', issuer: 'https://', audience: '', claim: 'sub', example: '' },
];

interface Draft {
  id?: string;
  name: string;
  issuer: string;
  audiences: string;
  keysFrom: 'discover' | 'uri' | 'jwks';
  jwks_uri: string;
  jwks: string;
  principal_claim: string;
  max_lifetime_s: string;
  people: boolean;
  rules: Array<{ claims: Array<[string, string]>; key_id: string }>;
}
const emptyDraft = (p = PRESETS[0]!): Draft => ({
  name: p.id === 'other' ? '' : p.label,
  issuer: p.id === 'other' ? '' : p.issuer,
  audiences: p.audience,
  keysFrom: 'discover',
  jwks_uri: '',
  jwks: '',
  principal_claim: p.principal ?? 'sub',
  max_lifetime_s: '86400',
  people: false,
  rules: [{ claims: [[p.claim, p.example.startsWith('<') ? '' : p.example]], key_id: '' }],
});
const toDraft = (i: Issuer): Draft => ({
  id: i.id,
  name: i.name,
  issuer: i.issuer,
  audiences: i.audiences.join(', '),
  keysFrom: i.jwks_keys !== null ? 'jwks' : i.jwks_uri ? 'uri' : 'discover',
  jwks_uri: i.jwks_uri ?? '',
  jwks: '',
  principal_claim: i.principal_claim,
  max_lifetime_s: i.max_lifetime_s ? String(i.max_lifetime_s) : '',
  people: i.people,
  rules: i.rules.map((r) => ({ claims: Object.entries(r.claims), key_id: r.key_id })),
});

/**
 * Agents authenticate with tokens from your identity provider (Kubernetes service accounts, GitHub Actions,
 * Entra ID, Okta, Auth0, Google…) instead of a key's secret. Rules map a token's claims to the key whose
 * permissions apply. Enterprise.
 */
export function AgentIdentityPage() {
  const [issuers, setIssuers] = useState<Issuer[]>([]);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preset, setPreset] = useState(PRESETS[0]!.id);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlicensed, setUnlicensed] = useState(false);
  const [token, setToken] = useState('');
  const [check, setCheck] = useState<{ ok: boolean; reason?: string; key?: { name: string | null }; principal?: string; expires_at?: number } | null>(null);

  const load = useCallback(() => {
    void api
      .get<{ issuers: Issuer[] }>('/admin/api/token-issuers')
      .then((d) => setIssuers(d.issuers))
      .catch((e) => (e instanceof ApiError && e.code === 'enterprise_required' ? setUnlicensed(true) : setErr(e instanceof ApiError ? e.message : String(e))));
    void api.get<{ keys: KeyRow[] }>('/admin/api/keys').then((d) => setKeys(d.keys.filter((k) => !k.built_in)));
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
    if (!draft) return;
    const body: Record<string, unknown> = {
      name: draft.name,
      issuer: draft.issuer.trim(),
      audiences: draft.audiences.split(',').map((a) => a.trim()).filter(Boolean),
      principal_claim: draft.principal_claim.trim() || 'sub',
      max_lifetime_s: draft.max_lifetime_s.trim() ? Number(draft.max_lifetime_s) : null,
      people: draft.people,
      rules: draft.rules.map((r) => ({ claims: Object.fromEntries(r.claims.filter(([k, v]) => k.trim() && v.trim())), key_id: r.key_id })),
      jwks_uri: draft.keysFrom === 'uri' ? draft.jwks_uri.trim() : null,
      ...(draft.keysFrom === 'jwks' ? (draft.jwks.trim() ? { jwks: draft.jwks.trim() } : {}) : { jwks: null }),
    };
    void run(async () => {
      if (draft.id) await api.patch(`/admin/api/token-issuers/${draft.id}`, body);
      else await api.post('/admin/api/token-issuers', body);
      setDraft(null);
      setNotice('Saved. Agents can use tokens from it now.');
    });
  };

  const setRule = (i: number, fn: (r: Draft['rules'][number]) => Draft['rules'][number]) => draft && setDraft({ ...draft, rules: draft.rules.map((r, j) => (j === i ? fn(r) : r)) });

  if (unlicensed)
    return (
      <div className="page">
        <PageHeader title="Agent identity" description="Agents authenticate with tokens from your identity provider instead of a key's secret." />
        <EnterpriseNotice feature="JWT authentication for agents" />
      </div>
    );

  return (
    <div className="page">
      <PageHeader
        title="Agent identity"
        description="Agents authenticate with tokens from your identity provider (Kubernetes service accounts, GitHub Actions, Entra ID, Okta, Auth0, Google) instead of a key's secret: nothing long-lived to hand out, leak or rotate. Each rule maps a token's claims to the key whose models, tools, limits and gates apply; the first rule that matches wins."
        actions={
          !draft && (
            <button className="btn primary" onClick={() => (setDraft(emptyDraft(PRESETS.find((p) => p.id === preset))), setErr(null))}>
              + Token issuer
            </button>
          )
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

      {draft && (
        <form className="card routing-editor" style={{ padding: 16, marginBottom: 14 }} onSubmit={save}>
          {!draft.id && (
            <div className="seg-row" role="group" aria-label="Where tokens come from">
              {PRESETS.map((p) => (
                <button key={p.id} type="button" className={`btn sm ${preset === p.id ? 'primary' : ''}`} onClick={() => (setPreset(p.id), setDraft(emptyDraft(p)))}>
                  {p.label}
                </button>
              ))}
            </div>
          )}
          <fieldset>
            <legend>Issuer</legend>
            <label>
              Name
              <input className="input" required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label>
              Issuer (the tokens' iss)
              <input className="input" required value={draft.issuer} placeholder={PRESETS.find((p) => p.id === preset)?.issuer} onChange={(e) => setDraft({ ...draft, issuer: e.target.value })} />
            </label>
            <label>
              Audiences accepted (aud)
              <input className="input" required value={draft.audiences} placeholder="controltower" onChange={(e) => setDraft({ ...draft, audiences: e.target.value })} />
            </label>
            <label>
              Signing keys
              <select className="input" value={draft.keysFrom} onChange={(e) => setDraft({ ...draft, keysFrom: e.target.value as Draft['keysFrom'] })}>
                <option value="discover">From the issuer's OpenID configuration</option>
                <option value="uri">From a JWKS URL</option>
                <option value="jwks">Given here (public keys, JWKS)</option>
              </select>
            </label>
            {draft.keysFrom === 'uri' && (
              <label>
                JWKS URL
                <input className="input" required value={draft.jwks_uri} placeholder="https://…/keys" onChange={(e) => setDraft({ ...draft, jwks_uri: e.target.value })} />
              </label>
            )}
            <label>
              Who presented it (claim)
              <input className="input" value={draft.principal_claim} placeholder="sub" onChange={(e) => setDraft({ ...draft, principal_claim: e.target.value })} />
            </label>
            <label>
              Longest token lifetime (seconds)
              <input className="input" inputMode="numeric" value={draft.max_lifetime_s} placeholder="no limit" onChange={(e) => setDraft({ ...draft, max_lifetime_s: e.target.value.replace(/\D/g, '') })} />
            </label>
            <label className="check" style={{ gridColumn: '1 / -1' }}>
              <input type="checkbox" checked={draft.people} onChange={(e) => setDraft({ ...draft, people: e.target.checked })} /> Its tokens are people, not workloads (people signing in on their computers, for{' '}
              <a href="#/laptops">Laptops</a>): each person uses a seat, counted while seen in the last 30 days
            </label>
            {draft.keysFrom === 'jwks' && (
              <label style={{ gridColumn: '1 / -1' }}>
                Public keys (JWKS){draft.id ? ' — leave empty to keep the ones saved' : ''}
                <textarea className="input mono" rows={4} value={draft.jwks} placeholder='{"keys": [{"kty": "RSA", "kid": "…", "n": "…", "e": "AQAB"}]}' onChange={(e) => setDraft({ ...draft, jwks: e.target.value })} />
              </label>
            )}
          </fieldset>
          <fieldset className="stack">
            <legend>Rules: a token whose claims match is used as the key</legend>
            {draft.rules.map((r, i) => (
              <div key={i} className="token-rule">
                <span className="muted">{i + 1}.</span>
                <div className="token-claims">
                  {r.claims.map(([k, v], j) => (
                    <div key={j} className="token-claim">
                      <input className="input mono" aria-label="Claim" value={k} placeholder="sub" onChange={(e) => setRule(i, (x) => ({ ...x, claims: x.claims.map((c, n) => (n === j ? [e.target.value, c[1]] : c)) }))} />
                      <span className="muted">=</span>
                      <input className="input mono" aria-label="Matches" value={v} placeholder="value, * for any characters" onChange={(e) => setRule(i, (x) => ({ ...x, claims: x.claims.map((c, n) => (n === j ? [c[0], e.target.value] : c)) }))} />
                      {r.claims.length > 1 && (
                        <button type="button" className="btn sm ghost" aria-label="Remove claim" onClick={() => setRule(i, (x) => ({ ...x, claims: x.claims.filter((_, n) => n !== j) }))}>
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                  <button type="button" className="link-btn" onClick={() => setRule(i, (x) => ({ ...x, claims: [...x.claims, ['', '']] }))}>
                    + and another claim
                  </button>
                </div>
                <span className="muted">→</span>
                <select className="input" aria-label="Key" required value={r.key_id} onChange={(e) => setRule(i, (x) => ({ ...x, key_id: e.target.value }))}>
                  <option value="">Choose a key…</option>
                  {keys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                    </option>
                  ))}
                </select>
                {draft.rules.length > 1 && (
                  <button type="button" className="btn sm ghost" onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })}>
                    Remove
                  </button>
                )}
              </div>
            ))}
            <div>
              <button type="button" className="btn sm" onClick={() => setDraft({ ...draft, rules: [...draft.rules, { claims: [['sub', '']], key_id: '' }] })}>
                + Rule
              </button>
            </div>
          </fieldset>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary sm" type="submit" disabled={busy}>
              Save
            </button>
            <button className="btn ghost sm" type="button" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {issuers.map((i) => (
        <section key={i.id} className="card issuer-card">
          <div className="issuer-head">
            <div>
              <div className="strong">
                {i.name} {!i.enabled && <span className="status">off</span>}
              </div>
              <div className="mono sub">{i.issuer}</div>
            </div>
            <div className="row-actions">
              <button className="btn sm" disabled={busy} onClick={() => void run(async () => {
                const r = await api.post<{ ok: boolean; message: string }>(`/admin/api/token-issuers/${i.id}/test`);
                if (r.ok) setNotice(`${i.name}: ${r.message}.`);
                else setErr(`${i.name}: ${r.message}`);
              })}>
                Fetch keys
              </button>
              <button className="btn sm" onClick={() => setDraft(toDraft(i))}>
                Edit
              </button>
              <button className="btn sm" onClick={() => void run(() => api.patch(`/admin/api/token-issuers/${i.id}`, { enabled: !i.enabled }))}>
                {i.enabled ? 'Turn off' : 'Turn on'}
              </button>
              <button className="btn sm danger" onClick={() => void run(() => api.del(`/admin/api/token-issuers/${i.id}`))}>
                Delete
              </button>
            </div>
          </div>
          <dl className="issuer-facts">
            <div>
              <dt>Audiences</dt>
              <dd className="mono">{i.audiences.join(', ')}</dd>
            </div>
            <div>
              <dt>Signing keys</dt>
              <dd>
                {i.jwks_keys !== null ? `${i.jwks_keys} given here` : i.keys_status === 'error' ? <span className="bad" title={i.keys_error ?? ''}>can't be fetched</span> : i.keys_status === 'ok' ? 'fetched' : 'fetched on first use'}
                <span className="sub">{i.jwks_uri ?? (i.jwks_keys === null ? 'from the OpenID configuration' : '')}</span>
              </dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd>
                {i.accepted.toLocaleString()} accepted · {i.refused.toLocaleString()} refused
                {i.people && ` · people: ${i.people_seen} using a seat`}
                {i.last_used_at && <span className="sub">last used {ago(i.last_used_at)}</span>}
              </dd>
            </div>
            {i.last_refusal && (
              <div>
                <dt>Last refused</dt>
                <dd>
                  {i.last_refusal}
                  {i.last_refusal_at && <span className="sub">{ago(i.last_refusal_at)}</span>}
                </dd>
              </div>
            )}
          </dl>
          <table className="table rules-table">
            <thead>
              <tr>
                <th>#</th>
                <th>A token whose claims match</th>
                <th>is used as the key</th>
              </tr>
            </thead>
            <tbody>
              {i.rules.map((r, n) => (
                <tr key={n}>
                  <td className="muted">{n + 1}</td>
                  <td className="mono">
                    {Object.entries(r.claims).map(([k, v]) => (
                      <div key={k}>
                        {k} = {v}
                      </div>
                    ))}
                  </td>
                  <td>{r.key_name ?? <span className="bad">a deleted key</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      {!draft && issuers.length === 0 && (
        <div className="card table-empty" style={{ padding: 28 }}>
          <b>No token issuers yet</b>
          Add one above: your Kubernetes cluster, GitHub Actions, Entra ID, Okta, Auth0, Google, or any issuer of signed JWTs.
        </div>
      )}

      {issuers.length > 0 && (
        <section className="card" style={{ padding: 16, marginTop: 14 }}>
          <div className="strong" style={{ marginBottom: 6 }}>
            Try a token
          </div>
          <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>
            Paste a token to see which key it would be used as, or why it would be refused. It isn't stored.
          </p>
          <form
            style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => setCheck(await api.post('/admin/api/token-issuers/check', { token })));
            }}
          >
            <textarea className="input mono" aria-label="Token" rows={2} style={{ flex: 1 }} value={token} placeholder="eyJhbGciOi…" onChange={(e) => (setToken(e.target.value), setCheck(null))} />
            <button className="btn sm" type="submit" disabled={busy || !token.trim()}>
              Check
            </button>
          </form>
          {check && (
            <div className={check.ok ? 'notice-row' : 'error'} style={{ marginTop: 10 }}>
              {check.ok ? (
                <span>
                  Accepted as <b>{check.key?.name}</b>, presented by <span className="mono">{check.principal}</span>
                  {check.expires_at ? `, until ${new Date(check.expires_at).toLocaleTimeString()}` : ''}.
                </span>
              ) : (
                <span>Refused: {check.reason}.</span>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
