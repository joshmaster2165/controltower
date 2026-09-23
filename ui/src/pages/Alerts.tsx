import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, ALERT_TRIGGERS, type AlertChannel, type AlertItem, type AlertRule, type AlertTrigger, type Rule } from '../api';
import { useStore } from '../store';

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function dur(s: number): string {
  if (s === 0) return 'no pause';
  if (s % 3600 === 0) return `${s / 3600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}

const TRIGGER_LABEL = Object.fromEntries(ALERT_TRIGGERS.map((t) => [t.id, t.label])) as Record<AlertTrigger, string>;

export function triggerTone(t: string): 'danger' | 'warn' | 'ok' {
  return t === 'blocked' || t === 'rejected' || t === 'scope_mismatch' || t === 'mixed' ? 'danger' : t === 'held' || t === 'unanswered' || t === 'masked' || t === 'flagged' ? 'warn' : 'ok';
}

/** What a gate most likely wants to hear about. */
export function defaultTriggers(effect: Rule['effect'] | undefined): AlertTrigger[] {
  if (effect === 'deny') return ['blocked'];
  if (effect === 'require_approval') return ['held', 'unanswered'];
  if (effect === 'inspect') return ['blocked', 'masked', 'flagged'];
  if (effect === 'allow' || effect === 'allow_with_limits') return ['allowed'];
  return ['blocked', 'held'];
}

export function conditionText(r: Pick<AlertRule, 'threshold' | 'window_s'>): string {
  return r.threshold <= 1 ? 'every time' : `${r.threshold}× within ${dur(r.window_s)}`;
}

export function notifyText(r: Pick<AlertRule, 'channels'>, channels: AlertChannel[]): string {
  const names = r.channels.map((id) => channels.find((c) => c.id === id)?.name).filter(Boolean);
  return ['Console', ...names].join(', ');
}

export function BellIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.75a4 4 0 0 0-4 4v2.1c0 .5-.17 1-.48 1.4L2.6 10.5c-.4.52-.03 1.25.62 1.25h9.56c.65 0 1.02-.73.62-1.25l-.92-1.25c-.31-.4-.48-.9-.48-1.4v-2.1a4 4 0 0 0-4-4Z" fill="currentColor" />
      <path d="M6.3 13.2a1.8 1.8 0 0 0 3.4 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// ------------------------------------------------------------ rule form

interface RuleFormProps {
  /** Fixes the gate (used from the map). Omit to let the user choose. */
  gate?: Rule | undefined;
  gates: Rule[];
  channels: AlertChannel[];
  existing?: AlertRule | undefined;
  compact?: boolean;
  onDone: () => void;
  onCancel: () => void;
}

export function AlertRuleForm({ gate, gates, channels, existing, compact, onDone, onCancel }: RuleFormProps) {
  const [gateId, setGateId] = useState<string>(existing ? (existing.rule_id ?? '') : (gate?.id ?? ''));
  const chosen = gate ?? gates.find((g) => g.id === gateId);
  const [triggers, setTriggers] = useState<AlertTrigger[]>(existing?.triggers ?? defaultTriggers(chosen?.effect));
  const [mode, setMode] = useState<'every' | 'burst'>(existing && existing.threshold > 1 ? 'burst' : 'every');
  const [threshold, setThreshold] = useState(String(existing && existing.threshold > 1 ? existing.threshold : 5));
  const [windowMin, setWindowMin] = useState(String(Math.max(1, Math.round((existing?.window_s ?? 300) / 60))));
  const [cooldown, setCooldown] = useState(String(existing?.cooldown_s ?? 300));
  const [picked, setPicked] = useState<string[]>(existing?.channels ?? channels.filter((c) => c.enabled).map((c) => c.id));
  const [name, setName] = useState(existing?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = <T,>(xs: T[], x: T): T[] => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

  const save = async () => {
    if (!triggers.length) {
      setErr('Pick at least one event to alert on.');
      return;
    }
    setBusy(true);
    setErr(null);
    const body = {
      ...(name.trim() ? { name: name.trim() } : {}),
      rule_id: (gate?.id ?? gateId) || null,
      triggers,
      threshold: mode === 'every' ? 1 : Math.max(2, Number(threshold) || 2),
      window_s: Math.max(1, Number(windowMin) || 5) * 60,
      cooldown_s: Number(cooldown),
      channels: picked,
    };
    try {
      if (existing) await api.patch(`/admin/api/alert-rules/${existing.id}`, body);
      else await api.post('/admin/api/alert-rules', body);
      await useStore.getState().refreshAlerts();
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const shown = chosen?.effect === 'deny' ? ALERT_TRIGGERS.filter((t) => ['blocked', 'scope_mismatch'].includes(t.id))
    : chosen?.effect === 'require_approval' ? ALERT_TRIGGERS.filter((t) => ['held', 'approved', 'rejected', 'unanswered', 'scope_mismatch'].includes(t.id))
    : chosen?.effect === 'allow' ? ALERT_TRIGGERS.filter((t) => t.id === 'allowed')
    : chosen?.effect === 'inspect' ? ALERT_TRIGGERS.filter((t) => ['blocked', 'masked', 'flagged'].includes(t.id))
    : ALERT_TRIGGERS;

  return (
    <div className={`alert-form ${compact ? 'compact' : ''}`}>
      {!gate && (
        <div className="field">
          <label>Gate</label>
          <select
            className="input"
            value={gateId}
            onChange={(e) => {
              setGateId(e.target.value);
              if (!existing) setTriggers(defaultTriggers(gates.find((g) => g.id === e.target.value)?.effect));
            }}
          >
            <option value="">Any gate</option>
            {gates.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label>Alert when</label>
        <div className="chips">
          {shown.map((t) => (
            <button key={t.id} type="button" title={t.hint} className={`chip ${triggerTone(t.id)} ${triggers.includes(t.id) ? 'on' : ''}`} onClick={() => setTriggers(toggle(triggers, t.id))}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>How often</label>
        <div className="seg">
          <button type="button" className={mode === 'every' ? 'on' : ''} onClick={() => setMode('every')}>
            Every time
          </button>
          <button type="button" className={mode === 'burst' ? 'on' : ''} onClick={() => setMode('burst')}>
            When it repeats
          </button>
        </div>
        {mode === 'burst' && (
          <div className="inline-fields">
            <input className="input" type="number" min={2} value={threshold} onChange={(e) => setThreshold(e.target.value)} aria-label="Times" />
            <span>times within</span>
            <input className="input" type="number" min={1} value={windowMin} onChange={(e) => setWindowMin(e.target.value)} aria-label="Minutes" />
            <span>min</span>
          </div>
        )}
      </div>
      <div className="field">
        <label>After an alert, stay quiet for</label>
        <select className="input" value={cooldown} onChange={(e) => setCooldown(e.target.value)}>
          <option value="0">No pause (alert on every match)</option>
          <option value="60">1 minute</option>
          <option value="300">5 minutes</option>
          <option value="900">15 minutes</option>
          <option value="3600">1 hour</option>
          <option value="86400">1 day</option>
        </select>
        {cooldown !== '0' && <div className="hint">Anything that happens meanwhile is sent as one summary when the pause ends.</div>}
      </div>
      <div className="field">
        <label>Notify</label>
        <label className="check disabled">
          <input type="checkbox" checked readOnly disabled /> Console inbox
        </label>
        {channels.map((c) => (
          <label key={c.id} className="check">
            <input type="checkbox" checked={picked.includes(c.id)} onChange={() => setPicked(toggle(picked, c.id))} /> {c.name}
            <span className="dim"> · {c.kind === 'slack' ? 'Slack' : 'Webhook'}</span>
          </label>
        ))}
        {channels.length === 0 && (
          <div className="hint">
            Connect Slack or a webhook on the <a href="#/alerts">Alerts</a> page to be notified outside the console.
          </div>
        )}
      </div>
      {!compact && (
        <div className="field">
          <label>Name (optional)</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={chosen ? `Alert on “${chosen.name}”` : 'Alert on any gate'} />
        </div>
      )}
      {err && <div className="error" style={{ marginBottom: 8 }}>{err}</div>}
      <div className="row">
        <button className="btn sm primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : existing ? 'Save alert' : 'Add alert'}
        </button>
        <button className="btn sm ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ inbox

function AlertRow({ a, fresh }: { a: AlertItem; fresh: boolean }) {
  const setRoute = useStore((s) => s.setRoute);
  const tone = triggerTone(a.trigger);
  const d = a.detail;
  return (
    <div className={`alert-row ${fresh ? 'unread' : ''}`}>
      <span className={`alert-ico ${tone}`}>
        <BellIcon size={13} />
      </span>
      <div className="body">
        <div className="title">{a.title}</div>
        <div className="meta">
          <span title={new Date(a.last_at).toLocaleString()}>{timeAgo(a.last_at)}</span>
          {a.count > 1 && <span>{a.count} events</span>}
          {d.agents.length > 0 && <span>{d.agents.map((x) => (x.count > 1 ? `${x.name} ×${x.count}` : x.name)).join(', ')}</span>}
          {d.reason && <span className="reason">“{d.reason}”</span>}
          {a.demo && <span>demo</span>}
        </div>
        {a.deliveries.length > 0 && (
          <div className="deliveries">
            {a.deliveries.map((x) => (
              <span key={x.channel_id} className={`dl ${x.pending ? 'pending' : x.ok ? 'ok' : 'bad'}`} title={x.error ?? (x.status ? `HTTP ${x.status}` : undefined)}>
                {x.name} {x.pending ? '· sending' : x.ok ? '· sent' : `· failed${x.status ? ` (${x.status})` : x.error ? ` (${x.error})` : ''}`}
              </span>
            ))}
          </div>
        )}
      </div>
      {a.trigger === 'held' && (
        <button className="btn sm" onClick={() => setRoute('tower')}>
          Open Tower
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------ channels

function ChannelForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState<'slack' | 'webhook'>('slack');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post('/admin/api/alert-channels', { kind, name: name.trim() || undefined, url: url.trim(), secret: kind === 'webhook' ? secret.trim() || undefined : undefined });
      await useStore.getState().refreshAlerts();
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button type="button" className={kind === 'slack' ? 'on' : ''} onClick={() => setKind('slack')}>
          Slack
        </button>
        <button type="button" className={kind === 'webhook' ? 'on' : ''} onClick={() => setKind('webhook')}>
          Webhook
        </button>
      </div>
      <div className="field">
        <label>Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'slack' ? '#security-alerts' : 'PagerDuty / SIEM'} />
      </div>
      <div className="field">
        <label>{kind === 'slack' ? 'Incoming webhook URL' : 'Endpoint URL'}</label>
        <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={kind === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://example.com/hooks/control-tower'} />
        <div className="hint">
          {kind === 'slack'
            ? 'Create one under Slack → Apps → Incoming Webhooks. Mattermost and Rocket.Chat webhooks work too.'
            : 'Receives a JSON POST per alert. Stored encrypted; only the host is shown afterwards.'}
        </div>
      </div>
      {kind === 'webhook' && (
        <div className="field">
          <label>Signing secret (optional)</label>
          <input className="input mono" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="whsec_…" />
          <div className="hint">
            Adds <code>x-ct-signature: t=…,v1=…</code> — HMAC-SHA256 of <code>{'{t}.{body}'}</code> with this secret.
          </div>
        </div>
      )}
      {err && <div className="error" style={{ marginBottom: 8 }}>{err}</div>}
      <div className="row">
        <button className="btn sm primary" disabled={busy || !url.trim()} onClick={() => void save()}>
          {busy ? 'Adding…' : 'Add channel'}
        </button>
        <button className="btn sm ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ChannelRow({ c }: { c: AlertChannel }) {
  const [test, setTest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useStore((s) => s.refreshAlerts);
  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      const d = await api.post<{ ok: boolean; status?: number; error?: string }>(`/admin/api/alert-channels/${c.id}/test`);
      setTest(d.ok ? 'Test message delivered.' : `Failed: ${d.error ?? `HTTP ${d.status}`}`);
    } catch (e) {
      setTest(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
      void refresh();
    }
  };
  const remove = async () => {
    if (!confirm(`Remove channel "${c.name}"? Alert rules using it keep notifying the console.`)) return;
    await api.del(`/admin/api/alert-channels/${c.id}`);
    void refresh();
  };
  const toggle = async () => {
    await api.patch(`/admin/api/alert-channels/${c.id}`, { enabled: !c.enabled });
    void refresh();
  };
  return (
    <div className={`channel ${c.enabled ? '' : 'off'}`}>
      <div className="h">
        <span className={`kind ${c.kind}`}>{c.kind === 'slack' ? 'Slack' : 'Webhook'}</span>
        <b>{c.name}</b>
        <span className="spacer" />
        {c.last_status && <span className={`status ${c.last_status === 'ok' ? 'ok' : 'error'}`}>{c.last_status === 'ok' ? 'delivering' : 'failing'}</span>}
      </div>
      <div className="dim mono">
        {c.target_hint}
        {c.has_secret ? ' · signed' : ''}
        {c.last_sent_at ? ` · last sent ${timeAgo(c.last_sent_at)}` : ''}
      </div>
      {c.last_status === 'error' && c.last_error && <div className="error" style={{ fontSize: 12 }}>{c.last_error}</div>}
      {test && <div className="hint">{test}</div>}
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn sm" disabled={busy} onClick={() => void runTest()}>
          {busy ? 'Sending…' : 'Send test'}
        </button>
        <button className="btn sm ghost" onClick={() => void toggle()}>
          {c.enabled ? 'Pause' : 'Resume'}
        </button>
        <button className="btn sm ghost danger-text" onClick={() => void remove()}>
          Remove
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ page

const NO_RULES: Rule[] = [];

export function AlertsPage() {
  const alerts = useStore((s) => s.alerts);
  const rules = useStore((s) => s.alertRules);
  const channels = useStore((s) => s.alertChannels);
  const policy = useStore((s) => s.policy);
  const gates = policy?.rules ?? NO_RULES;
  const refresh = useStore((s) => s.refreshAlerts);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [editing, setEditing] = useState<AlertRule | 'new' | null>(null);
  const [addingChannel, setAddingChannel] = useState(false);
  // Remember what was unread when the page opened, then mark it read.
  const unreadAtOpen = useRef<Set<string> | null>(null);
  if (unreadAtOpen.current === null && alerts.length) unreadAtOpen.current = new Set(alerts.filter((a) => !a.read).map((a) => a.id));

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const unreadCount = alerts.filter((a) => !a.read).length;
  useEffect(() => {
    if (!unreadCount) return;
    const t = setTimeout(() => {
      void api.post('/admin/api/alerts/read', {}).then(() => refresh());
    }, 1500);
    return () => clearTimeout(t);
  }, [unreadCount, refresh]);

  const isFresh = (a: AlertItem) => !a.read || !!unreadAtOpen.current?.has(a.id);
  const shown = useMemo(() => (filter === 'unread' ? alerts.filter(isFresh) : alerts), [alerts, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleRule = async (r: AlertRule) => {
    await api.patch(`/admin/api/alert-rules/${r.id}`, { enabled: !r.enabled });
    void refresh();
  };
  const removeRule = async (r: AlertRule) => {
    if (!confirm(`Delete alert "${r.name}"?`)) return;
    await api.del(`/admin/api/alert-rules/${r.id}`);
    void refresh();
  };

  return (
    <div className="page alerts-page">
      <h1>Alerts</h1>
      <p className="sub">Get told when a gate does its job — or when agents keep hitting it. Alerts are set per gate (here, or by clicking a gate on the Airspace), always land in this inbox, and can also go to Slack or any webhook. They carry names and counts, never request contents.</p>
      <div className="alerts-grid">
        <section>
          <div className="section-h">
            <h2>Activity</h2>
            <div className="seg sm">
              <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
                All
              </button>
              <button className={filter === 'unread' ? 'on' : ''} onClick={() => setFilter('unread')}>
                New
              </button>
            </div>
          </div>
          <div className="card alert-list">
            {shown.map((a) => (
              <AlertRow key={a.id} a={a} fresh={isFresh(a)} />
            ))}
            {shown.length === 0 && (
              <div className="empty">
                <BellIcon size={20} />
                <div>{alerts.length ? 'Nothing new.' : 'No alerts yet. Add an alert rule to a gate and it will show up here the moment it triggers.'}</div>
              </div>
            )}
          </div>
        </section>
        <section>
          <div className="section-h">
            <h2>Alert rules</h2>
            {editing === null && (
              <button className="btn sm primary" onClick={() => setEditing('new')}>
                New alert
              </button>
            )}
          </div>
          {editing !== null && (
            <div className="card" style={{ marginBottom: 10 }}>
              <AlertRuleForm gates={gates} channels={channels} existing={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
            </div>
          )}
          <div className="card rule-list">
            {rules.map((r) => (
              <div key={r.id} className={`rule-item ${r.enabled ? '' : 'off'}`}>
                <div className="h">
                  <b>{r.name}</b>
                  {r.demo && <span className="tag">demo</span>}
                  <span className="spacer" />
                  {r.fired_24h > 0 && <span className="dim">{r.fired_24h} in 24h</span>}
                </div>
                <div className="dim">
                  {r.rule_id ? (r.gate_name ?? 'deleted gate') : 'Any gate'} · {r.triggers.map((t) => TRIGGER_LABEL[t] ?? t).join(', ')} · {conditionText(r)}
                  {r.cooldown_s ? ` · quiet ${dur(r.cooldown_s)}` : ''}
                </div>
                <div className="dim">
                  Notifies {notifyText(r, channels)}
                  {r.last_fired_at ? ` · last fired ${timeAgo(r.last_fired_at)}` : ' · never fired'}
                </div>
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="btn sm ghost" onClick={() => setEditing(r)}>
                    Edit
                  </button>
                  <button className="btn sm ghost" onClick={() => void toggleRule(r)}>
                    {r.enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button className="btn sm ghost danger-text" onClick={() => void removeRule(r)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
            {rules.length === 0 && <div className="empty">No alert rules. Click a gate on the Airspace and choose “Add alert”, or use New alert.</div>}
          </div>

          <div className="section-h" style={{ marginTop: 22 }}>
            <h2>Channels</h2>
            {!addingChannel && (
              <button className="btn sm" onClick={() => setAddingChannel(true)}>
                Add channel
              </button>
            )}
          </div>
          {addingChannel && <ChannelForm onDone={() => setAddingChannel(false)} onCancel={() => setAddingChannel(false)} />}
          <div className="card channel-list">
            <div className="channel">
              <div className="h">
                <span className="kind console">Console</span>
                <b>This inbox</b>
                <span className="spacer" />
                <span className="status ok">always on</span>
              </div>
              <div className="dim">Every alert is recorded here and shown as a notification to anyone signed in.</div>
            </div>
            {channels.map((c) => (
              <ChannelRow key={c.id} c={c} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ toasts

export function AlertToasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const setRoute = useStore((s) => s.setRoute);
  useEffect(() => {
    if (!toasts.length) return;
    const timers = toasts.map((t) => setTimeout(() => dismiss(t.id), 9000));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismiss]);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${triggerTone(t.trigger)}`}>
          <span className={`alert-ico ${triggerTone(t.trigger)}`}>
            <BellIcon size={13} />
          </span>
          <div className="body">
            <div className="title">{t.title}</div>
            <div className="meta">
              {t.detail.gate ? `Gate: ${t.detail.gate.name}` : 'Alert'}
              {t.count > 1 ? ` · ${t.count} events` : ''}
              {t.repeats ? ` · ${t.repeats + 1} alerts` : ''}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <button
                className="btn sm"
                onClick={() => {
                  dismiss(t.id);
                  setRoute(t.trigger === 'held' ? 'tower' : 'alerts');
                }}
              >
                {t.trigger === 'held' ? 'Open Tower' : 'View alerts'}
              </button>
            </div>
          </div>
          <button className="x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
