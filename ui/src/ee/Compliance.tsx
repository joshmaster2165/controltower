import { useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../api';
import { EnterpriseNotice } from './LicensePage';

type CheckStatus = 'met' | 'partial' | 'gap';
type ReqStatus = CheckStatus | 'organizational';
interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  summary: string;
  facts: Record<string, string | number | boolean>;
  next?: string;
}
interface Requirement {
  ref: string;
  title: string;
  asks: string;
  note?: string;
  status: ReqStatus;
  results: Check[];
}
interface Report {
  framework: { id: string; name: string; version: string; scope: string };
  period_days: number;
  generated_at: string;
  summary: Record<ReqStatus, number>;
  requirements: Requirement[];
}
interface Answer {
  demo?: boolean;
  frameworks: Array<{ id: string; name: string; version: string }>;
  report: Report;
  checks: Check[];
}

const STATUS: Record<ReqStatus, { label: string; cls: string }> = {
  met: { label: 'Met', cls: 'ok' },
  partial: { label: 'Partly met', cls: 'warn' },
  gap: { label: 'Gap', cls: 'error' },
  organizational: { label: 'Organisation’s', cls: '' },
};
const PERIODS = [30, 90, 180, 365];
/** A preview: at a word, with an ellipsis when cut (click the row for all of it). */
const clip = (s: string, n = 220) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, '')}…`);

/**
 * Compliance (Enterprise): the EU AI Act, the NIST AI RMF and ISO/IEC 42001, each requirement checked against what
 * Control Tower records here, and an evidence pack to hand an auditor.
 */
export function CompliancePage() {
  const [framework, setFramework] = useState('eu-ai-act');
  const [days, setDays] = useState(90);
  const [data, setData] = useState<Answer | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [unlicensed, setUnlicensed] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    api
      .get<Answer>(`/admin/api/compliance?framework=${framework}&days=${days}`)
      .then((d) => {
        setData(d);
        setErr(null);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.code === 'enterprise_required') setUnlicensed(true);
        else setErr(e instanceof ApiError ? e.message : String(e));
      });
  }, [framework, days]);

  const header = (
    <PageHeader
      title="Compliance"
      description="Your AI coding assistants and agents, checked against the EU AI Act, the NIST AI RMF and ISO/IEC 42001 from what Control Tower records, with an evidence pack for your assessor. Evidence for an assessment, not a certification."
      actions={
        data ? (
          <>
            <a className="btn" href={`/admin/api/compliance/evidence?framework=${framework}&days=${days}&format=md`} download>
              <Icon name="download" size={15} /> Evidence pack
            </a>
            <a className="btn" href={`/admin/api/compliance/evidence?framework=${framework}&days=${days}&format=json`} download>
              <Icon name="download" size={15} /> JSON
            </a>
          </>
        ) : undefined
      }
    />
  );
  if (unlicensed)
    return (
      <div className="page">
        {header}
        <EnterpriseNotice feature="Compliance evidence" />
      </div>
    );

  const r = data?.report;
  return (
    <div className="page compliance">
      {header}
      <div className="toolbar" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <div className="seg" role="radiogroup" aria-label="Framework">
          {(data?.frameworks ?? [{ id: 'eu-ai-act', name: 'EU AI Act' }, { id: 'nist-ai-rmf', name: 'NIST AI RMF' }, { id: 'iso-42001', name: 'ISO/IEC 42001' }]).map((f) => (
            <button key={f.id} role="radio" aria-checked={framework === f.id} className={framework === f.id ? 'on' : ''} onClick={() => setFramework(f.id)}>
              {f.name}
            </button>
          ))}
        </div>
        <div className="seg" role="radiogroup" aria-label="Period">
          {PERIODS.map((d) => (
            <button key={d} role="radio" aria-checked={days === d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      {!r && !err && <div className="muted">Checking…</div>}
      {r && (
        <>
          {data?.demo && <div className="notice-row laptops-warning" style={{ marginBottom: 12 }}><span>This installation has demo data in it, and so do these results and the evidence pack. Clear the demo (Get started) before using them as evidence.</span></div>}
          <div className="card compliance-summary" style={{ padding: 16, marginBottom: 14, display: 'grid', gap: 10 }}>
            <div className="sub">
              <b>{r.framework.version}.</b> {r.framework.scope}
            </div>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              {(['met', 'partial', 'gap', 'organizational'] as ReqStatus[]).map((s) => (
                <div key={s} className="compliance-count">
                  <span className={`status ${STATUS[s].cls}`}>{STATUS[s].label}</span> <b>{r.summary[s]}</b>
                </div>
              ))}
            </div>
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="table compliance-table">
              <thead>
                <tr>
                  <th style={{ width: 120 }}>Requirement</th>
                  <th>What it asks, and what Control Tower shows</th>
                  <th style={{ width: 130 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {r.requirements.map((q) => (
                  <tr key={q.ref} className="clickable" onClick={() => setOpen(open === q.ref ? null : q.ref)}>
                    <td className="mono strong">{q.ref}</td>
                    <td>
                      <span className="strong">{q.title}</span>
                      <span className="sub">{q.asks}</span>
                      {open === q.ref && (
                        <div className="compliance-detail" style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                          {q.results.map((c) => (
                            <div key={c.id}>
                              <span className={`status ${STATUS[c.status].cls}`}>{c.title}</span>
                              <div className="sub">{c.summary}</div>
                              {c.next && <div className="sub laptops-warn">To do: {c.next}</div>}
                            </div>
                          ))}
                          {q.note && <div className="sub">{q.note}</div>}
                        </div>
                      )}
                      {open !== q.ref && q.results.length > 0 && <span className="sub">{clip(q.results.map((c) => c.summary).join(' '))}</span>}
                      {open !== q.ref && !q.results.length && q.note && <span className="sub">{q.note}</span>}
                    </td>
                    <td>
                      <span className={`status ${STATUS[q.status].cls}`}>{STATUS[q.status].label}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sub" style={{ marginTop: 10 }}>
            Each download is recorded in the audit log with its SHA-256, so a copy handed to an assessor can be checked against it.
          </p>
        </>
      )}
    </div>
  );
}
