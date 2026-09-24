import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, ALERT_TRIGGERS, type AlertChannel, type AlertItem, type AlertKind, type AlertParams, type AlertRule, type AlertTrigger, type Rule } from '../api';
import { useStore } from '../store';
import { PageHeader } from '../components/PageHeader';

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
  if (['blocked', 'rejected', 'scope_mismatch', 'mixed', 'outage', 'failed', 'budget_exceeded'].includes(t)) return 'danger';
  if (['held', 'unanswered', 'masked', 'flagged', 'slow', 'budget_warning'].includes(t)) return 'warn';
  return 'ok';
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

function ruleScope(r: AlertRule): string {
  const n = r.params?.targets?.length ?? 0;
  switch (r.kind ?? 'gate') {
    case 'gate':
      return r.rule_id ? (r.gate_name ?? 'deleted gate') : 'Any gate';
    case 'health':
      return n ? `${n} model${n === 1 ? '' : 's'} or server${n === 1 ? '' : 's'}` : 'All models and tool servers';
    case 'errors':
    case 'latency':
      return `${n ? `${n} selected` : 'All agents'}${r.kind === 'latency' ? `, over ${Math.round((r.params?.slow_ms ?? 30_000) / 1000)} s` : ''}`;
    case 'budget':
      return `All budgets, warn at ${r.params?.warn_pct ?? 80}%`;
    case 'digest':
      return `Daily at ${String(r.params?.hour ?? 8).padStart(2, '0')}:00 UTC`;
  }
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

export const ALERT_KINDS: Array<{ id: AlertKind; label: string; hint: string }> = [
  { id: 'gate', label: 'A gate', hint: 'requests blocked, held, masked or flagged at a gate' },
  { id: 'health', label: 'Provider outage', hint: 'a model or MCP server keeps failing upstream (timeouts, 5xx)' },
  { id: 'errors', label: 'Failed requests', hint: 'agents are getting errors, after any fallbacks' },
  { id: 'latency', label: 'Slow requests', hint: 'requests take longer than a limit' },
  { id: 'budget', label: 'Budget', hint: 'a key, team or project budget is nearly or fully used' },
  { id: 'digest', label: 'Daily summary', hint: 'traffic, spend, enforcement and failures, once a day' },
];

const KIND_DEFAULTS: Record<AlertKind, { triggers: AlertTrigger[]; threshold: number; windowMin: number; cooldown: number }> = {
  gate: { triggers: ['blocked', 'held'], threshold: 1, windowMin: 5, cooldown: 300 },
  health: { triggers: ['outage', 'recovered'], threshold: 5, windowMin: 1, cooldown: 900 },
  errors: { triggers: ['failed'], threshold: 5, windowMin: 5, cooldown: 900 },
  latency: { triggers: ['slow'], threshold: 3, windowMin: 10, cooldown: 900 },
  budget: { triggers: ['budget_warning', 'budget_exceeded'], threshold: 1, windowMin: 5, cooldown: 0 },
  digest: { triggers: ['daily'], threshold: 1, windowMin: 1440, cooldown: 0 },
};

const KIND_TRIGGERS: Record<AlertKind, AlertTrigger[]> = {
  gate: ['blocked', 'held', 'approved', 'rejected', 'unanswered', 'allowed', 'scope_mismatch', 'masked', 'flagged'],
  health: ['outage', 'recovered'],
  errors: ['failed'],
  latency: ['slow'],
  budget: ['budget_warning', 'budget_exceeded'],
  digest: ['daily'],
};

export function kindLabel(k: AlertKind | undefined): string {
  return ALERT_KINDS.find((x) => x.id === (k ?? 'gate'))?.label ?? 'Alert';
}

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
  const topology = useStore((s) => s.topology);
  const [kind, setKind] = useState<AlertKind>(gate ? 'gate' : (existing?.kind ?? 'gate'));
  const [gateId, setGateId] = useState<string>(existing ? (existing.rule_id ?? '') : (gate?.id ?? ''));
  const chosen = gate ?? gates.find((g) => g.id === gateId);
  const [triggers, setTriggers] = useState<AlertTrigger[]>(existing?.triggers ?? defaultTriggers(chosen?.effect));
  const [mode, setMode] = useState<'every' | 'burst'>(existing && existing.threshold > 1 ? 'burst' : 'every');
  const [threshold, setThreshold] = useState(String(existing && existing.threshold > 1 ? existing.threshold : 5));
  const [windowMin, setWindowMin] = useState(String(Math.max(1, Math.round((existing?.window_s ?? 300) / 60))));
  const [cooldown, setCooldown] = useState(String(existing?.cooldown_s ?? 300));
  const [targets, setTargets] = useState<string[]>(existing?.params?.targets ?? []);
  const [slowS, setSlowS] = useState(String(Math.round((existing?.params?.slow_ms ?? 30_000) / 1000)));
  const [warnPct, setWarnPct] = useState(String(existing?.params?.warn_pct ?? 80));
  const [hour, setHour] = useState(String(existing?.params?.hour ?? 8));
  const [picked, setPicked] = useState<string[]>(existing?.channels ?? channels.filter((c) => c.enabled).map((c) => c.id));
  const [name, setName] = useState(existing?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = <T,>(xs: T[], x: T): T[] => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

  const switchKind = (k: AlertKind) => {
    setKind(k);
    const d = KIND_DEFAULTS[k];
    setTriggers(k === 'gate' ? defaultTriggers(chosen?.effect) : d.triggers);
    setThreshold(String(d.threshold > 1 ? d.threshold : 5));
    setMode(d.threshold > 1 ? 'burst' : 'every');
    setWindowMin(String(d.windowMin));
    setCooldown(String(d.cooldown));
    setTargets([]);
  };

  const windowed = kind === 'gate' || kind === 'health' || kind === 'errors' || kind === 'latency';
  const alwaysBurst = kind === 'health' || kind === 'errors' || kind === 'latency';

  const save = async () => {
    if (!triggers.length) {
      setErr('Pick at least one event to alert on.');
      return;
    }
    setBusy(true);
    setErr(null);
    const params: AlertParams = {};
    if (targets.length) params.targets = targets;
    if (kind === 'latency') params.slow_ms = Math.max(1, Number(slowS) || 30) * 1000;
    if (kind === 'budget') params.warn_pct = Math.min(99, Math.max(1, Number(warnPct) || 80));
    if (kind === 'digest') params.hour = Number(hour);
    const burst = alwaysBurst || (kind === 'gate' && mode === 'burst');
    const body = {
      ...(name.trim() ? { name: name.trim() } : {}),
      kind,
      rule_id: kind === 'gate' ? (gate?.id ?? gateId) || null : null,
      triggers,
      threshold: windowed && burst ? Math.max(1, Number(threshold) || 1) : 1,
      window_s: kind === 'digest' ? 86_400 : Math.max(1, Number(windowMin) || 5) * 60,
      cooldown_s: windowed ? Number(cooldown) : 0,
      channels: picked,
      params,
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

  const gateTriggers =
    chosen?.effect === 'deny' ? ['blocked', 'scope_mismatch']
    : chosen?.effect === 'require_approval' ? ['held', 'approved', 'rejected', 'unanswered', 'scope_mismatch']
    : chosen?.effect === 'allow' ? ['allowed']
    : chosen?.effect === 'inspect' ? ['blocked', 'masked', 'flagged']
    : KIND_TRIGGERS.gate;
  const shown = ALERT_TRIGGERS.filter((t) => (kind === 'gate' ? gateTriggers : KIND_TRIGGERS[kind]).includes(t.id));

  // What a health / errors / latency rule can be narrowed to.
  const targetOptions: Array<{ id: string; label: string }> =
    kind === 'health'
      ? [...(topology?.deployments ?? []).map((d) => ({ id: d.id, label: d.public_name ?? d.upstream_model })), ...(topology?.mcp_servers ?? []).map((m) => ({ id: m.id, label: m.name }))]
      : kind === 'errors' || kind === 'latency'
        ? [...(topology?.keys ?? []).map((k) => ({ id: k.id, label: k.name })), ...(topology?.deployments ?? []).map((d) => ({ id: d.id, label: d.public_name ?? d.upstream_model }))]
        : [];

  return (
    <div className={`alert-form ${compact ? 'compact' : ''}`}>
      {!gate && (
        <div className="field">
          <label>What to watch</label>
          <select className="input" value={kind} onChange={(e) => switchKind(e.target.value as AlertKind)}>
            {ALERT_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          <div className="hint">{ALERT_KINDS.find((k) => k.id === kind)!.hint}</div>
        </div>
      )}
      {kind === 'gate' && !gate && (
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
      {targetOptions.length > 0 && (
        <div className="field">
          <label>{kind === 'health' ? 'Models and tool servers' : 'Agents and models'}</label>
          <div className="chips">
            <button type="button" className={`chip ok ${targets.length === 0 ? 'on' : ''}`} onClick={() => setTargets([])}>
              All
            </button>
            {targetOptions.map((t) => (
              <button key={t.id} type="button" className={`chip ok ${targets.includes(t.id) ? 'on' : ''}`} onClick={() => setTargets(toggle(targets, t.id))}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {kind === 'latency' && (
        <div className="field">
          <label>Slower than</label>
          <div className="inline-fields" style={{ marginTop: 0 }}>
            <input className="input" type="number" min={1} value={slowS} onChange={(e) => setSlowS(e.target.value)} aria-label="Seconds" />
            <span>seconds, end to end</span>
          </div>
        </div>
      )}
      {kind === 'budget' && (
        <div className="field">
          <label>Warn at</label>
          <div className="inline-fields" style={{ marginTop: 0 }}>
            <input className="input" type="number" min={1} max={99} value={warnPct} onChange={(e) => setWarnPct(e.target.value)} aria-label="Percent" />
            <span>% of the limit</span>
          </div>
          <div className="hint">Covers every key, team and project that has a budget. Each alert is sent once per budget period.</div>
        </div>
      )}
      {kind === 'digest' && (
        <div className="field">
          <label>Send at</label>
          <select className="input" value={hour} onChange={(e) => setHour(e.target.value)}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00 UTC
              </option>
            ))}
          </select>
          <div className="hint">Covers the previous 24 hours. Skipped on days with no traffic.</div>
        </div>
      )}
      {shown.length > 1 && (
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
      )}
      {windowed && (
        <div className="field">
          <label>{kind === 'health' ? 'Failures needed' : kind === 'errors' ? 'Failures needed' : kind === 'latency' ? 'Slow requests needed' : 'How often'}</label>
          {kind === 'gate' && (
            <div className="seg">
              <button type="button" className={mode === 'every' ? 'on' : ''} onClick={() => setMode('every')}>
                Every time
              </button>
              <button type="button" className={mode === 'burst' ? 'on' : ''} onClick={() => setMode('burst')}>
                When it repeats
              </button>
            </div>
          )}
          {(alwaysBurst || mode === 'burst') && (
            <div className="inline-fields" style={alwaysBurst ? { marginTop: 0 } : undefined}>
              <input className="input" type="number" min={1} value={threshold} onChange={(e) => setThreshold(e.target.value)} aria-label="Times" />
              <span>{kind === 'health' ? `failure${threshold === '1' ? '' : 's'} per model within` : 'times within'}</span>
              <input className="input" type="number" min={1} value={windowMin} onChange={(e) => setWindowMin(e.target.value)} aria-label="Minutes" />
              <span>min</span>
            </div>
          )}
          {kind === 'health' && <div className="hint">Counts timeouts, network errors and 5xx answers — not rate limits or bad requests.</div>}
        </div>
      )}
      {windowed && (
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
      )}
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
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind !== 'gate' ? kindLabel(kind) : chosen ? `Alert on “${chosen.name}”` : 'Alert on any gate'} />
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
        {d.lines && d.lines.length > 0 && (
          <div className="alert-lines">
            {d.lines.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}
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
        <button className="btn sm" onClick={() => setRoute('tower', d.approval?.id ?? null)}>
          {d.approval ? 'Review' : 'Open Tower'}
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------ channels

function ChannelForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState<'slack' | 'webhook' | 'email'>('slack');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [to, setTo] = useState('');
  const [smtpDefault, setSmtpDefault] = useState(false);
  const [ownSmtp, setOwnSmtp] = useState(true);
  const [smtp, setSmtp] = useState({ host: '', port: '587', secure: false, user: '', pass: '', from: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void api.get<{ smtp_default: boolean }>('/admin/api/alert-channels').then((r) => {
      setSmtpDefault(r.smtp_default);
      setOwnSmtp(!r.smtp_default);
    });
  }, []);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body =
        kind === 'email'
          ? { kind, name: name.trim() || undefined, to: to.split(/[,;\s]+/).filter(Boolean), smtp: ownSmtp ? { ...smtp, port: Number(smtp.port) } : undefined }
          : { kind, name: name.trim() || undefined, url: url.trim(), secret: kind === 'webhook' ? secret.trim() || undefined : undefined };
      await api.post('/admin/api/alert-channels', body);
      await useStore.getState().refreshAlerts();
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const ready = kind === 'email' ? to.trim() && (!ownSmtp || (smtp.host.trim() && smtp.from.trim())) : url.trim();
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="seg" style={{ marginBottom: 12 }}>
        {(['slack', 'webhook', 'email'] as const).map((k) => (
          <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
            {k === 'slack' ? 'Slack' : k === 'webhook' ? 'Webhook' : 'Email'}
          </button>
        ))}
      </div>
      <div className="field">
        <label>Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'slack' ? '#security-alerts' : kind === 'email' ? 'Security on-call' : 'PagerDuty / SIEM'} />
      </div>
      {kind === 'email' ? (
        <>
          <div className="field">
            <label>Recipients</label>
            <input className="input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="oncall@example.com, security@example.com" />
            <div className="hint">Held requests arrive with a <b>Review &amp; approve</b> button that opens the request in the console; approving always happens signed in.</div>
          </div>
          {smtpDefault && (
            <label className="check" style={{ marginBottom: 10 }}>
              <input type="checkbox" checked={!ownSmtp} onChange={(e) => setOwnSmtp(!e.target.checked)} /> Send through this server&apos;s SMTP settings (<code>CT_SMTP_URL</code>)
            </label>
          )}
          {ownSmtp && (
            <div className="smtp-fields">
              <div className="field">
                <label>SMTP host</label>
                <input className="input mono" value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} placeholder="smtp.example.com" />
              </div>
              <div className="field">
                <label>Port</label>
                <input className="input mono" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} />
              </div>
              <div className="field">
                <label>Username</label>
                <input className="input" value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} autoComplete="off" />
              </div>
              <div className="field">
                <label>Password</label>
                <input className="input" type="password" value={smtp.pass} onChange={(e) => setSmtp({ ...smtp, pass: e.target.value })} autoComplete="new-password" />
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>From</label>
                <input className="input" value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} placeholder="Control Tower <tower@example.com>" />
              </div>
              <label className="check" style={{ gridColumn: '1 / -1' }}>
                <input type="checkbox" checked={smtp.secure} onChange={(e) => setSmtp({ ...smtp, secure: e.target.checked, port: e.target.checked ? '465' : '587' })} /> TLS from the start (port 465); otherwise STARTTLS when offered
              </label>
              <div className="hint" style={{ gridColumn: '1 / -1' }}>Stored encrypted with the master key; the password is never shown again.</div>
            </div>
          )}
        </>
      ) : (
        <div className="field">
          <label>{kind === 'slack' ? 'Incoming webhook URL' : 'Endpoint URL'}</label>
          <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={kind === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://example.com/hooks/control-tower'} />
          <div className="hint">
            {kind === 'slack'
              ? 'Create one under Slack → Apps → Incoming Webhooks. Mattermost and Rocket.Chat webhooks work too.'
              : 'Receives a JSON POST per alert. Stored encrypted; only the host is shown afterwards.'}
          </div>
        </div>
      )}
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
        <button className="btn sm primary" disabled={busy || !ready} onClick={() => void save()}>
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
        <span className={`kind ${c.kind}`}>{c.kind === 'slack' ? 'Slack' : c.kind === 'email' ? 'Email' : 'Webhook'}</span>
        <b>{c.name}</b>
        <span className="spacer" />
        {c.last_status && <span className={`status ${c.last_status === 'ok' ? 'ok' : 'error'}`}>{c.last_status === 'ok' ? 'delivering' : 'failing'}</span>}
      </div>
      <div className="dim mono">
        {c.target_hint}
        {c.has_secret ? ' · signed' : ''}
        {c.kind === 'email' ? (c.smtp ? ` · via ${c.smtp.host}` : ' · via CT_SMTP_URL') : ''}
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
      <PageHeader
        title="Alerts"
        meta={unreadCount ? `${unreadCount} new` : undefined}
        description="Hear about gates doing their job, providers going down, agents failing or slowing, and budgets running low — in this inbox, Slack or any webhook. Alerts carry names and counts, never request contents."
      />
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
                  <span className="tag" style={{ marginRight: 6 }}>{kindLabel(r.kind)}</span>
                  {ruleScope(r)} · {r.triggers.map((t) => TRIGGER_LABEL[t] ?? t).join(', ')}
                  {r.kind === 'gate' || r.kind === 'health' || r.kind === 'errors' || r.kind === 'latency' ? ` · ${conditionText(r)}` : ''}
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
              {t.detail.gate ? `Gate: ${t.detail.gate.name}` : kindLabel(t.detail.kind)}
              {t.count > 1 ? ` · ${t.count} events` : ''}
              {t.repeats ? ` · ${t.repeats + 1} alerts` : ''}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <button
                className="btn sm"
                onClick={() => {
                  dismiss(t.id);
                  if (t.trigger === 'held') setRoute('tower', t.detail.approval?.id ?? null);
                  else setRoute('alerts');
                }}
              >
                {t.trigger === 'held' ? (t.detail.approval ? 'Review & approve' : 'Open Tower') : 'View alerts'}
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
