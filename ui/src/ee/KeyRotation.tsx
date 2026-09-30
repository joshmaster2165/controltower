import { useState } from 'react';
import { api, ApiError, type KeyRow } from '../api';

const OVERLAPS: Array<[number, string]> = [
  [0, 'stops at once'],
  [600, 'works 10 more minutes'],
  [3600, 'works 1 more hour'],
  [86_400, 'works 1 more day'],
  [604_800, 'works 7 more days'],
];
const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** One line for a key's rotation, under its secret. */
export function rotationSummary(k: KeyRow): string | null {
  const r = k.rotation;
  const parts: string[] = [];
  if (r?.every_days) parts.push(`rotates every ${r.every_days} d${r.next_at ? `, next ${when(r.next_at)}` : ''}`);
  else if (r?.last_rotated_at) parts.push(`rotated ${when(r.last_rotated_at)}`);
  if (k.old_secret_valid_until) parts.push(`old secret works until ${when(k.old_secret_valid_until)}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * A key's rotation (Enterprise): a new secret now, the old one kept for an overlap; on a schedule, delivered to
 * the secret manager the agent reads from; and stopping the old secret early.
 */
export function KeyRotationPanel({ k, onChange, onClose }: { k: KeyRow; onChange: () => void; onClose: () => void }) {
  const r = k.rotation;
  const [overlap, setOverlap] = useState(r?.overlap_s ?? 3600);
  const [deliverTo, setDeliverTo] = useState(r?.deliver_to ?? '');
  const [every, setEvery] = useState(r?.every_days ? String(r.every_days) : '');
  const [shown, setShown] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rotation-panel">
      <div className="rotation-row">
        <b>Rotate now</b>
        <label>
          The old secret
          <select className="input" value={overlap} onChange={(e) => setOverlap(Number(e.target.value))}>
            {OVERLAPS.map(([s, l]) => (
              <option key={s} value={s}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="grow">
          Deliver the new secret to (optional)
          <input className="input mono" value={deliverTo} placeholder="secret://vault/agents/invoice-bot#api_key" onChange={(e) => setDeliverTo(e.target.value)} />
        </label>
        <button
          className="btn sm primary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const res = await api.post<{ key?: string; delivered_to?: string; old_valid_until: number | null }>(`/admin/api/keys/${k.id}/rotate`, { overlap_s: overlap, deliver_to: deliverTo.trim() || null });
              setShown(res.key ?? null);
              setMsg(`${res.delivered_to ? `New secret written to ${res.delivered_to}.` : 'New secret below: it is shown only now.'} ${res.old_valid_until ? `The old one works until ${when(res.old_valid_until)}.` : 'The old one stopped.'}`);
            })
          }
        >
          Rotate now
        </button>
      </div>
      {shown && (
        <div className="notice-row">
          <code className="mono" style={{ userSelect: 'all' }}>{shown}</code>
          <button className="btn sm ghost" onClick={() => setShown(null)}>
            Done
          </button>
        </div>
      )}
      <div className="rotation-row">
        <b>On a schedule</b>
        <label>
          Every (days)
          <input className="input" inputMode="numeric" style={{ width: 90 }} value={every} placeholder="never" onChange={(e) => setEvery(e.target.value.replace(/\D/g, ''))} />
        </label>
        <span className="muted" style={{ alignSelf: 'end', paddingBottom: 8, fontSize: 12.5 }}>
          delivered to the secret manager above, where the agent reads it; the old secret for the overlap chosen
        </span>
        <button
          className="btn sm"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.put(`/admin/api/keys/${k.id}/rotation`, { every_days: every ? Number(every) : null, overlap_s: overlap, deliver_to: deliverTo.trim() || null });
              setMsg(every ? `Rotates every ${every} days.` : 'No schedule.');
            })
          }
        >
          Save schedule
        </button>
      </div>
      {r?.error && <div className="error">Last rotation failed: {r.error}</div>}
      {err && <div className="error">{err}</div>}
      {msg && <div className="muted" style={{ fontSize: 13 }}>{msg}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        {k.old_secret_valid_until && (
          <button className="btn sm danger" disabled={busy} onClick={() => void run(async () => (await api.post(`/admin/api/keys/${k.id}/rotate/end-overlap`), setMsg('The old secret no longer works.')))}>
            Stop the old secret now
          </button>
        )}
        <button className="btn sm ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
