import { useState } from 'react';
import { api, ApiError } from '../../api';

interface Changes {
  create: string[];
  update: string[];
  unchanged: string[];
  remove: string[];
}
interface Plan {
  mode: 'merge' | 'replace';
  errors: string[];
  warnings: string[];
  zones: Changes;
  gates: Changes;
  applied: boolean;
}

const EXAMPLE = `zones:
  - name: AI Labs sandbox
    members: [agent:labs-prototype]
gates:
  - name: AI Labs may not merge code
    from: AI Labs sandbox
    target: tool
    match: { servers: [github], tools: [github__merge_pr] }
    effect: deny`;

function ChangeList({ title, c }: { title: string; c: Changes }) {
  const rows: Array<[string, string[], string]> = [
    ['add', c.create, 'ok'],
    ['change', c.update, 'info'],
    ['remove', c.remove, 'danger'],
  ];
  return (
    <div className="pi-changes">
      <h3>
        {title} <span className="hint">· {c.unchanged.length} unchanged</span>
      </h3>
      {rows.every(([, xs]) => !xs.length) ? (
        <div className="hint">No changes.</div>
      ) : (
        rows.map(([label, xs, tone]) =>
          xs.map((x) => (
            <div key={`${label}:${x}`} className={`pi-row ${tone}`}>
              <span className="pi-tag">{label}</span> {x}
            </div>
          )),
        )
      )}
    </div>
  );
}

/**
 * Policy as code, the other direction: paste or upload a policy YAML (as
 * exported from Airspace → Export), see exactly which zones and gates it adds,
 * changes or removes, then apply it.
 */
export function PolicyImport({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const [yaml, setYaml] = useState('');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const run = async (apply: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const p = await api.post<Plan>('/admin/api/policy/import', { yaml, mode, apply });
      setPlan(p);
      if (p.applied) {
        const n = (c: Changes) => c.create.length + c.update.length + c.remove.length;
        setDone(`Applied: ${n(p.zones)} zone and ${n(p.gates)} gate change${n(p.zones) + n(p.gates) === 1 ? '' : 's'}. The map shows the new policy now.`);
        onApplied();
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const edit = (next: () => void) => {
    next();
    setPlan(null);
    setDone(null);
  };

  const changes = plan ? [plan.zones, plan.gates].reduce((n, c) => n + c.create.length + c.update.length + c.remove.length, 0) : 0;
  const removals = plan ? plan.zones.remove.length + plan.gates.remove.length : 0;

  return (
    <div className="pi-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card pi" role="dialog" aria-label="Import policy">
        <div className="section-h">
          <h2>Import policy</h2>
          <button className="btn sm ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          Zones and gates as YAML, referenced by name — the format <b>Export → Policy as YAML</b> writes, so a policy can live in Git and move between installs. Nothing changes until you press Apply.
        </p>
        <textarea className="input mono" rows={11} value={yaml} onChange={(e) => edit(() => setYaml(e.target.value))} placeholder={EXAMPLE} spellCheck={false} aria-label="Policy YAML" />
        <div className="pi-modes" role="radiogroup" aria-label="Import mode">
          <label className={mode === 'merge' ? 'on' : ''}>
            <input type="radio" name="pi-mode" checked={mode === 'merge'} onChange={() => edit(() => setMode('merge'))} />
            <b>Merge</b>
            <span>Add and update zones and gates by name; keep everything else.</span>
          </label>
          <label className={mode === 'replace' ? 'on' : ''}>
            <input type="radio" name="pi-mode" checked={mode === 'replace'} onChange={() => edit(() => setMode('replace'))} />
            <b>Replace</b>
            <span>Make the policy match the file exactly: zones and gates it leaves out are removed.</span>
          </label>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" disabled={busy || !yaml.trim()} onClick={() => void run(false)}>
            {busy && !plan ? 'Reading…' : 'Preview'}
          </button>
          <label className="btn">
            Upload file
            <input type="file" accept=".yaml,.yml,.json,text/yaml" style={{ display: 'none' }} onChange={(e) => void e.target.files?.[0]?.text().then((t) => edit(() => setYaml(t)))} />
          </label>
          {plan && !plan.applied && (
            <button className={`btn ${removals ? 'danger' : 'primary'}`} disabled={busy || plan.errors.length > 0 || changes === 0} onClick={() => void run(true)}>
              {busy ? 'Applying…' : removals ? `Apply — removes ${removals}` : `Apply ${changes} change${changes === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
        {err && <div className="error" style={{ marginTop: 10 }}>{err}</div>}
        {done && <div className="import-done" style={{ marginTop: 10 }}>{done}</div>}
        {plan && !plan.applied && (
          <div className="pi-plan">
            {plan.errors.length > 0 && (
              <div className="error">
                <b>Fix these before applying:</b>
                <ul>{plan.errors.map((e) => <li key={e}>{e}</li>)}</ul>
              </div>
            )}
            {plan.warnings.map((w) => (
              <div key={w} className="hint warn-text">{w}</div>
            ))}
            <div className="pi-cols">
              <ChangeList title="Zones" c={plan.zones} />
              <ChangeList title="Gates" c={plan.gates} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
