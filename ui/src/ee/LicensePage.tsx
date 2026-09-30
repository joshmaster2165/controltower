import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PageHeader } from '../components/PageHeader';
import { api, ApiError } from '../api';

export interface LicenseInfo {
  status: 'none' | 'valid' | 'expiring' | 'grace' | 'expired' | 'invalid';
  reason?: string;
  source: 'env' | 'console' | null;
  editable: boolean;
  store_url: string | null;
  seats_used?: number;
  /** Requests this license year against the allowance (warns; never limits). */
  usage?: { allowance: number; used: number; share: number; period_start: number; period_end: number; projected: number | null; level: 'ok' | 'warn' | 'over'; by_month: Array<{ month: string; requests: number }> };
  license?: { id: string; customer: string; email: string; plan: 'enterprise' | 'trial'; seats: number; requests_per_year: number; features: string[]; issued_at: number; expires_at: number };
}

/** [feature, label, available yet]. Features still being built are shown as coming, never as on. */
const FEATURES: Array<[string, string, boolean]> = [
  ['sso', 'Single sign-on (OIDC and SAML) and SCIM provisioning', true],
  ['audit', 'Tamper-evident audit log, with export', true],
  ['siem_export', 'The audit log sent to your SIEM', true],
  ['jwt_auth', 'Agents authenticate with your IdP’s JWTs', true],
  ['secret_managers', 'Secret managers and key rotation', true],
  ['orgs', 'Organisations and team admins', true],
  ['multi_region', 'Multi-region control plane', false],
];
const date = (ms: number) => new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
const days = (ms: number) => Math.max(0, Math.ceil((ms - Date.now()) / 86_400_000));
const STATUS: Record<LicenseInfo['status'], { label: string; cls: string }> = {
  none: { label: 'No license', cls: '' },
  valid: { label: 'Active', cls: 'ok' },
  expiring: { label: 'Ending soon', cls: 'ticketed' },
  grace: { label: 'Ended: grace period', cls: 'ticketed' },
  expired: { label: 'Ended', cls: 'error' },
  invalid: { label: 'Not valid', cls: 'error' },
};

/** Shown where an Enterprise feature would be, without a license. */
export function EnterpriseNotice({ feature }: { feature: string }) {
  const [store, setStore] = useState<string | null>(null);
  useEffect(() => {
    void api.get<LicenseInfo>('/admin/api/license').then((l) => setStore(l.store_url)).catch(() => undefined);
  }, []);
  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 8 }}>
      <div>
        <span className="tag">Enterprise</span> <b>{feature}</b> is part of Control Tower Enterprise.
      </div>
      <div className="hint">Add a license under License, or start a 30-day trial: no card needed.</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <a className="btn primary" href="#/license">
          License
        </a>
        {store && (
          <a className="btn" href={store} target="_blank" rel="noreferrer">
            Plans and free trial
          </a>
        )}
      </div>
    </div>
  );
}

const short = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
function usageLine(u: NonNullable<LicenseInfo['usage']>): string {
  return `${short(u.used)} of ${short(u.allowance)} requests used this license year (${Math.round(u.share * 100)}%), which renews ${date(u.period_end)}.`;
}

/** Requests this license year against the allowance: a bar, the pace, and each month. */
function UsageCard({ u }: { u: NonNullable<LicenseInfo['usage']> }) {
  const max = Math.max(...u.by_month.map((m) => m.requests), 1);
  const pct = Math.min(100, u.share * 100);
  return (
    <section className="card usage-card" aria-label="Requests this license year">
      <div className="issuer-head">
        <div>
          <div className="strong">Requests this license year</div>
          <div className="sub">
            {date(u.period_start)} – {date(u.period_end)} · every call through the gateway counts; going over never slows or stops anything
          </div>
        </div>
        <div className={`usage-figure ${u.level}`}>
          {u.used.toLocaleString()} <span className="sub">of {u.allowance.toLocaleString()}</span>
        </div>
      </div>
      <div className={`usage-bar ${u.level}`} role="meter" aria-valuemin={0} aria-valuemax={u.allowance} aria-valuenow={u.used} aria-label="Requests used">
        <span style={{ width: `${pct}%` }} />
        <i style={{ left: '80%' }} title="80%" />
      </div>
      <div className="sub" style={{ marginTop: 6 }}>
        {Math.round(u.share * 100)}% used
        {u.projected !== null ? ` · at this pace, about ${short(u.projected)} by ${date(u.period_end)}${u.projected > u.allowance ? ' — more than the allowance: talk to us about capacity at renewal' : ''}` : ''}
      </div>
      {u.by_month.length > 0 && (
        <div className="usage-months">
          {u.by_month.map((m) => (
            <div key={m.month} title={`${m.month}: ${m.requests.toLocaleString()} requests`}>
              <span style={{ height: `${Math.max(2, (m.requests / max) * 100)}%` }} />
              <small>{new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString([], { month: 'short', timeZone: 'UTC' })}</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** A line at the top of every page while a license is ending or has ended, or its requests pass 80%. */
export function LicenseBanner() {
  const [l, setL] = useState<LicenseInfo | null>(null);
  useEffect(() => {
    void api.get<LicenseInfo>('/admin/api/license').then(setL).catch(() => undefined);
  }, []);
  if (!l?.license) return null;
  // Past 80% of the year's requests: said once at the top, never enforced.
  if (l.status === 'valid' && l.usage && l.usage.level !== 'ok') {
    return (
      <div className="role-banner" role="status">
        {usageLine(l.usage)} Traffic is never limited: talk to us about capacity at renewal. <a href="#/license">License</a>
      </div>
    );
  }
  if (l.status !== 'expiring' && l.status !== 'grace' && l.status !== 'expired') return null;
  const end = l.license.expires_at;
  const text =
    l.status === 'expiring'
      ? `Your Control Tower Enterprise license ends on ${date(end)} (${days(end)} days). Renew to keep single sign-on, the audit log and the other Enterprise features.`
      : l.status === 'grace'
        ? `Your Enterprise license ended on ${date(end)}. Enterprise features stay on for ${days(end + 14 * 86_400_000)} more days while it renews.`
        : `Your Enterprise license ended on ${date(end)}. Enterprise features are off; everything else, including gateway traffic, is unaffected.`;
  return (
    <div className="role-banner" role="status">
      {text} <a href="#/license">License</a>
    </div>
  );
}

/** The Enterprise license: what it covers, until when, and adding or replacing one. Admins change it. */
export function LicensePage() {
  const [l, setL] = useState<LicenseInfo | null>(null);
  const [key, setKey] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => void api.get<LicenseInfo>('/admin/api/license').then(setL), []);
  useEffect(() => {
    load();
  }, [load]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      setL(await api.put<LicenseInfo>('/admin/api/license', { key }));
      setKey('');
      load();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : String(e2));
    }
  };
  if (!l) return null;
  const s = STATUS[l.status];
  const lic = l.license;
  const on = (f: string) => !!lic && (lic.features.includes('*') || lic.features.includes(f)) && ['valid', 'expiring', 'grace'].includes(l.status);
  return (
    <div className="page">
      <PageHeader
        title="License"
        description="Control Tower is free and open source. Enterprise adds single sign-on, SCIM, the audit log, secret managers, organisations and more, with support, under a license key checked on this server: no connection needed."
        actions={
          l.store_url ? (
            <a className="btn" href={l.store_url} target="_blank" rel="noreferrer">
              Plans and free trial
            </a>
          ) : undefined
        }
      />
      <div className="card" style={{ padding: 16, marginBottom: 14, display: 'grid', gap: 10 }}>
        <div>
          <span className={`status ${s.cls}`}>{s.label}</span>
          {l.reason && <span className="sub"> {l.reason}</span>}
        </div>
        {lic && (
          <table className="table">
            <tbody>
              <tr>
                <td className="muted">Licensed to</td>
                <td>
                  <span className="strong">{lic.customer}</span> <span className="sub">{lic.email}</span>
                </td>
              </tr>
              <tr>
                <td className="muted">Plan</td>
                <td>{lic.plan === 'trial' ? 'Enterprise trial' : 'Enterprise'}</td>
              </tr>
              <tr>
                <td className="muted">Single sign-on seats</td>
                <td>
                  {l.seats_used ?? 0} of {lic.seats} used
                </td>
              </tr>
              <tr>
                <td className="muted">Requests a year</td>
                <td>
                  {lic.requests_per_year ? lic.requests_per_year.toLocaleString() : 'Unlimited'}
                  {l.usage && <span className="sub">{Math.round(l.usage.share * 100)}% used this license year</span>}
                </td>
              </tr>
              <tr>
                <td className="muted">Until</td>
                <td>
                  {date(lic.expires_at)} {l.status === 'valid' || l.status === 'expiring' ? <span className="sub">{days(lic.expires_at)} days</span> : null}
                </td>
              </tr>
              <tr>
                <td className="muted">From</td>
                <td className="muted">{l.source === 'env' ? 'CT_LICENSE_KEY on the server' : 'Added in the console'}</td>
              </tr>
            </tbody>
          </table>
        )}
        {l.usage && <UsageCard u={l.usage} />}
      </div>
      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div className="strong" style={{ marginBottom: 8 }}>
          Enterprise features
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          {FEATURES.map(([id, label, available]) => (
            <div key={id}>
              <span className={`status ${available && on(id) ? 'ok' : ''}`}>{label}</span>
              {!available && <span className="tag muted" style={{ marginLeft: 8 }}>coming</span>}
            </div>
          ))}
        </div>
      </div>
      {l.editable ? (
        <form className="card" style={{ padding: 16, display: 'grid', gap: 8 }} onSubmit={(e) => void save(e)}>
          <label htmlFor="license-key" className="strong">
            {lic ? 'Replace the license key' : 'Add a license key'}
          </label>
          <textarea id="license-key" className="input mono" rows={3} value={key} onChange={(e) => setKey(e.target.value)} placeholder="ctl1.…" />
          {err && <div className="error">{err}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" type="submit" disabled={!key.trim()}>
              Save
            </button>
            {lic && (
              <button className="btn ghost" type="button" onClick={() => void api.del<LicenseInfo>('/admin/api/license').then(setL)}>
                Remove license
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className="hint">The license comes from CT_LICENSE_KEY on the server; change it there.</div>
      )}
    </div>
  );
}
