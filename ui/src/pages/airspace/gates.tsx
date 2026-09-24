import { useEffect, useMemo, useState } from 'react';
import { formatUsd } from '@controltower/shared';
import { useStore } from '../../store';
import { api, ApiError, type AlertChannel, type AlertRule, type DetectorInfo, type InspectConfig, type Rule, type Topology, type Zone } from '../../api';
import { AlertRuleForm, BellIcon, conditionText, defaultTriggers, notifyText } from '../Alerts';
import { agentGroups, GROUP_PREFIX, groupStation, isGroup, isTeam, TEAM_PREFIX, teamStation } from '../../airspace/groups';
import { type GateDraft, panelPos } from './shared';

export function GatePopover({ x, y, rule, desc, stats, alerts, channels, onClose, onChanged, onSimulate }: { x: number; y: number; rule: Rule; desc: string; zones: Zone[]; stats: { approved: number; denied: number } | undefined; alerts: AlertRule[]; channels: AlertChannel[]; onClose: () => void; onChanged: () => void; onSimulate: (r: SimResult | null) => void }) {
  const [alertForm, setAlertForm] = useState<AlertRule | 'new' | null>(null);
  const [sim, setSim] = useState<SimResult | null>(null);
  const [simBusy, setSimBusy] = useState(false);
  const [simErr, setSimErr] = useState<string | null>(null);
  const [inspect, setInspect] = useState<InspectConfig>(rule.effect === 'inspect' ? { detectors: rule.config.detectors, keywords: rule.config.keywords, patterns: rule.config.patterns, action: rule.config.action ?? 'flag', direction: rule.config.direction ?? 'both' } : DEFAULT_INSPECT);
  const [effect, setEffect] = useState<Rule['effect']>(rule.effect);
  const [reason, setReason] = useState(rule.config.reason ?? '');
  const [hold, setHold] = useState(String(Math.round((rule.config.hold_ms ?? 20000) / 1000)));
  const total = (stats?.approved ?? 0) + (stats?.denied ?? 0);
  const rate = total ? (stats!.approved / total) * 100 : null;
  const save = async () => {
    await api.patch(`/admin/api/rules/${rule.id}`, { effect, config: { reason: reason || undefined, hold_ms: Math.max(0, Number(hold)) * 1000, ...(effect === 'inspect' ? inspect : {}) } });
    onChanged();
    onClose();
  };
  const toggle = async () => {
    await api.patch(`/admin/api/rules/${rule.id}`, { enabled: !rule.enabled });
    onChanged();
  };
  const changed = effect !== rule.effect;
  useEffect(() => () => onSimulate(null), [onSimulate]);
  useEffect(() => {
    setSim(null);
    onSimulate(null);
  }, [effect, onSimulate]);
  const runSimulation = async () => {
    setSimBusy(true);
    setSimErr(null);
    try {
      const body = changed ? { rule: { effect, config: { hold_ms: Math.max(0, Number(hold)) * 1000 } }, replace_rule_id: rule.id, hours: 24 } : { impact_of_rule_id: rule.id, hours: 24 };
      const r = await api.post<SimResult>('/admin/api/policy/simulate', body);
      setSim(r);
      onSimulate(r);
    } catch (e) {
      setSimErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSimBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete gate "${rule.name}"?`)) return;
    await api.del(`/admin/api/rules/${rule.id}`);
    onChanged();
    onClose();
  };
  return (
    <div className="popover composer" style={panelPos(x, y, 560)}>
      <div className="t">{rule.name}</div>
      <div className="hint" style={{ marginBottom: 8 }}>
        {desc}
        {rule.demo ? ' · demo' : ''}
      </div>
      <div className="field">
        <label>Effect</label>
        <select className="input" value={effect} onChange={(e) => setEffect(e.target.value as Rule['effect'])}>
          <option value="allow">allow (open gate)</option>
          <option value="deny">deny (barrier)</option>
          <option value="require_approval">require approval (checkpoint)</option>
          <option value="inspect">inspect content (guardrail)</option>
        </select>
      </div>
      {effect === 'require_approval' && (
        <div className="field">
          <label>Hold the request up to (seconds) before issuing a ticket</label>
          <input className="input" type="number" min={0} max={55} value={hold} onChange={(e) => setHold(e.target.value)} />
        </div>
      )}
      {effect === 'inspect' && <InspectFields value={inspect} onChange={setInspect} />}
      <div className="field">
        <label>Reason shown to the agent</label>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this gate exists" />
      </div>
      {effect !== 'inspect' && (
        <div className="gate-sim">
          <button className="btn sm" disabled={simBusy} onClick={() => void runSimulation()}>
            {simBusy ? 'Replaying…' : changed ? 'Simulate this change on last 24 h' : 'Impact in the last 24 h'}
          </button>
          {sim && <SimulationView r={sim} mode={changed ? 'draft' : 'impact'} />}
          {simErr && <div className="error">{simErr}</div>}
        </div>
      )}
      <GateAlerts rule={{ ...rule, effect }} alerts={alerts} channels={channels} form={alertForm} setForm={setAlertForm} />
      {rate != null && (
        <div className="hint" style={{ marginBottom: 8, color: rate >= 95 && total >= 20 ? 'var(--warn)' : undefined }}>
          {stats!.approved} approved / {stats!.denied} denied ({rate.toFixed(0)}%){rate >= 95 && total >= 20 ? ' — this gate is noise; consider auto-allow.' : ''}
        </div>
      )}
      <div className="row">
        <button className="btn sm primary" onClick={() => void save()}>
          Save
        </button>
        <button className="btn sm ghost" onClick={() => void toggle()}>
          {rule.enabled ? 'Disable' : 'Enable'}
        </button>
        <button className="btn sm danger" onClick={() => void remove()}>
          Delete
        </button>
        <button className="btn sm ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

export function GateAlerts({ rule, alerts, channels, form, setForm }: { rule: Rule; alerts: AlertRule[]; channels: AlertChannel[]; form: AlertRule | 'new' | null; setForm: (f: AlertRule | 'new' | null) => void }) {
  const refresh = useStore((s) => s.refreshAlerts);
  const labels: Record<string, string> = { blocked: 'blocked', held: 'held', approved: 'approved', rejected: 'rejected', unanswered: 'not answered', allowed: 'allowed', scope_mismatch: 'approval misused' };
  const remove = async (a: AlertRule) => {
    await api.del(`/admin/api/alert-rules/${a.id}`);
    void refresh();
  };
  const toggle = async (a: AlertRule) => {
    await api.patch(`/admin/api/alert-rules/${a.id}`, { enabled: !a.enabled });
    void refresh();
  };
  return (
    <div className="gate-alerts">
      <div className="gh">
        <BellIcon size={13} /> Alerts
      </div>
      {form === null && alerts.length === 0 && <div className="hint" style={{ marginBottom: 6 }}>Nobody is told when this gate triggers.</div>}
      {form === null &&
        alerts.map((a) => (
          <div key={a.id} className={`ar ${a.enabled ? '' : 'off'}`}>
            <div className="txt">
              <b>{a.triggers.map((t) => labels[t] ?? t).join(', ')}</b> · {conditionText(a)}
              <br />
              {notifyText(a, channels)}
            </div>
            <button className="btn sm ghost" onClick={() => setForm(a)}>
              Edit
            </button>
            <button className="btn sm ghost" onClick={() => void toggle(a)}>
              {a.enabled ? 'Pause' : 'Resume'}
            </button>
            <button className="btn sm ghost danger-text" aria-label="Remove alert" onClick={() => void remove(a)}>
              ×
            </button>
          </div>
        ))}
      {form === null && (
        <button className="btn sm" onClick={() => setForm('new')}>
          Add alert
        </button>
      )}
      {form !== null && <AlertRuleForm compact gate={rule} gates={[]} channels={channels} existing={form === 'new' ? undefined : form} onDone={() => setForm(null)} onCancel={() => setForm(null)} />}
    </div>
  );
}

export interface SimResult {
  window_hours: number;
  considered: number;
  changed: { to_deny: number; to_hold: number; to_allow: number };
  cost_avoided_nanousd: number;
  agents: Array<{ key_id: string; name: string; deny: number; hold: number; allow: number }>;
  destinations: Array<{ id: string; name: string; deny: number; hold: number; allow: number }>;
  lanes: Array<{ key_id: string; target_id: string; deny: number; hold: number; allow: number }>;
  samples: Array<{ ts: number; agent: string; destination: string; before: string; after: string }>;
  notes: string[];
}

/** What a draft gate would have done — or what an existing gate did — to recorded traffic. */
export function SimulationView({ r, mode = 'draft' }: { r: SimResult; mode?: 'draft' | 'impact' }) {
  const { to_deny, to_hold, to_allow } = r.changed;
  const none = to_deny + to_hold + to_allow === 0;
  const would = mode === 'draft';
  const list = (xs: Array<{ name: string; deny: number; hold: number; allow: number }>) =>
    xs
      .slice(0, 4)
      .map((x) => `${x.name} ${x.deny + x.hold + x.allow}`)
      .join(' · ');
  return (
    <div className="sim">
      <div className="sim-h">
        {would ? 'Replayed' : 'In'} the last {r.window_hours} h · {r.considered.toLocaleString('en-US')} requests{would ? '' : ' checked'}
      </div>
      {none ? (
        <div className="sim-none">{would ? 'No recorded request would have been treated differently.' : 'This gate did not change the outcome of any recorded request — a broader gate or no traffic covers this path.'}</div>
      ) : (
        <>
          <div className="sim-big">
            {to_deny > 0 && <span className="d">{to_deny.toLocaleString('en-US')} {would ? 'would be blocked' : 'blocked'}</span>}
            {to_hold > 0 && <span className="h">{to_hold.toLocaleString('en-US')} {would ? 'would wait for approval' : 'held for approval'}</span>}
            {to_allow > 0 && <span className="a">{to_allow.toLocaleString('en-US')} {would ? 'would be let through' : 'let through'}</span>}
          </div>
          {r.cost_avoided_nanousd > 0 && <div className="dim">{formatUsd(r.cost_avoided_nanousd)} of spend {would ? 'would not have happened' : 'was stopped'}.</div>}
          {r.agents.length > 0 && <div className="dim">Agents: {list(r.agents)}</div>}
          {r.destinations.length > 0 && <div className="dim">Targets: {list(r.destinations)}</div>}
          <div className="dim">Affected paths are highlighted on the map.</div>
        </>
      )}
      {r.notes.map((n, i) => (
        <div key={i} className="hint">
          {n}
        </div>
      ))}
    </div>
  );
}

let detectorCache: DetectorInfo[] | null = null;
export function useDetectors(): DetectorInfo[] {
  const [d, setD] = useState<DetectorInfo[]>(detectorCache ?? []);
  useEffect(() => {
    if (detectorCache) return;
    void api.get<{ detectors: DetectorInfo[] }>('/admin/api/guardrails/detectors').then((r) => {
      detectorCache = r.detectors;
      setD(r.detectors);
    });
  }, []);
  return d;
}

export const DEFAULT_INSPECT: InspectConfig = { detectors: ['secrets'], action: 'block', direction: 'input' };

export function inspectSummary(c: InspectConfig): string {
  const ids = c.detectors ?? [];
  const what = [
    ids.includes('secrets') ? 'secrets' : '',
    ids.includes('injection') ? 'prompt injection' : '',
    ids.some((d) => d !== 'secrets' && d !== 'injection') || ids.includes('pii') ? 'personal data' : '',
    c.keywords?.length ? 'keywords' : '',
  ].filter(Boolean);
  const verb = c.action === 'mask' ? 'mask' : c.action === 'block' ? 'block' : 'flag';
  const where = c.direction === 'input' ? 'in what agents send' : c.direction === 'output' ? 'in what comes back' : 'both ways';
  return `${verb} ${what.join(', ') || 'nothing yet'} ${where}`;
}

export function InspectFields({ value, onChange }: { value: InspectConfig; onChange: (v: InspectConfig) => void }) {
  const detectors = useDetectors();
  const ids = value.detectors ?? [];
  const pii = detectors.filter((d) => d.category === 'pii');
  const has = (id: string) => ids.includes(id);
  const toggle = (id: string) => onChange({ ...value, detectors: has(id) ? ids.filter((x) => x !== id) : [...ids, id] });
  const [kw, setKw] = useState((value.keywords ?? []).join(', '));
  return (
    <div className="inspect-fields">
      <div className="field">
        <label>Look for</label>
        <label className="check">
          <input type="checkbox" checked={has('secrets')} onChange={() => toggle('secrets')} /> Secrets & credentials
          <span className="dim">API keys, tokens, private keys, connection strings</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={has('injection')} onChange={() => toggle('injection')} /> Prompt injection
          <span className="dim">Instructions hidden in tool results and documents</span>
        </label>
        <div className="dim" style={{ margin: '4px 0 4px' }}>Personal data</div>
        <div className="chips">
          {pii.map((d) => (
            <button key={d.id} type="button" className={`chip warn ${has(d.id) ? 'on' : ''}`} onClick={() => toggle(d.id)}>
              {d.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Keywords (optional, comma-separated)</label>
        <input
          className="input"
          value={kw}
          placeholder="Project Falcon, acquisition"
          onChange={(e) => {
            setKw(e.target.value);
            onChange({ ...value, keywords: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) });
          }}
        />
      </div>
      <div className="field">
        <label>When found</label>
        <div className="seg">
          {(['mask', 'block', 'flag'] as const).map((a) => (
            <button key={a} type="button" className={value.action === a ? 'on' : ''} onClick={() => onChange({ ...value, action: a })}>
              {a === 'mask' ? 'Mask it' : a === 'block' ? 'Block' : 'Flag only'}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Check</label>
        <div className="seg">
          {(['input', 'output', 'both'] as const).map((d) => (
            <button key={d} type="button" className={value.direction === d ? 'on' : ''} onClick={() => onChange({ ...value, direction: d })}>
              {d === 'input' ? 'What agents send' : d === 'output' ? 'What comes back' : 'Both'}
            </button>
          ))}
        </div>
        {value.direction !== 'input' && <div className="hint">Tool results and complete model replies are checked before the agent sees them. Streamed model replies can only be checked after delivery, so there a match is flagged.</div>}
      </div>
    </div>
  );
}

export const EFFECTS: Array<{ id: Rule['effect']; label: string; hint: string; cls: string }> = [
  { id: 'deny', label: 'Block', hint: 'Requests on this path are refused with a 403 the agent can read.', cls: 'deny' },
  { id: 'require_approval', label: 'Require approval', hint: 'Requests wait at the gate until someone approves in the Tower.', cls: 'hold' },
  { id: 'inspect', label: 'Inspect', hint: 'Scan what passes for secrets, personal data or prompt injection — mask it, block it, or flag it. Runs alongside the other gates.', cls: 'inspect' },
  { id: 'allow', label: 'Allow', hint: 'Explicitly allow this path (takes precedence over broader gates below it).', cls: 'allow' },
];

export function GateComposer({ x, y, draft, topology, zones, channels, onClose, onCreated, onSimulate }: { x: number; y: number; draft: GateDraft; topology: Topology; zones: Zone[]; channels: AlertChannel[]; onClose: () => void; onCreated: () => void; onSimulate: (r: SimResult | null) => void }) {
  const [notify, setNotify] = useState(false);
  const [inspect, setInspect] = useState<InspectConfig>(DEFAULT_INSPECT);
  const [notifyChannels, setNotifyChannels] = useState<string[]>(channels.filter((c) => c.enabled).map((c) => c.id));
  const [from, setFrom] = useState(draft.from);
  const [to, setTo] = useState(draft.to);
  const [tool, setTool] = useState(draft.tool ?? '');
  const [effect, setEffect] = useState<Rule['effect']>('require_approval');
  const [reason, setReason] = useState('');
  const [hold, setHold] = useState('20');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const groups = useMemo(() => agentGroups(topology.keys), [topology.keys]);
  const teams = useMemo(() => [...new Set(topology.keys.map((k) => k.team).filter((t): t is string => !!t))].sort(), [topology.keys]);
  const singles = useMemo(() => topology.keys.filter((k) => !k.agent_id || !groups.has(k.agent_id)), [topology.keys, groups]);
  const server = to.startsWith('mcp:') ? topology.mcp_servers.find((m) => m.id === to.slice(4)) : undefined;
  const agentLabel = from === 'all' ? 'Any agent' : from.startsWith('zone:') ? `${zones.find((z) => z.id === from.slice(5))?.name ?? '?'} agents` : isGroup(from) ? `${from.slice(GROUP_PREFIX.length)} (every copy)` : isTeam(from) ? `team ${from.slice(TEAM_PREFIX.length)}` : (topology.keys.find((k) => k.id === from.slice(4))?.name ?? '?');
  const destLabel = !to
    ? 'anything'
    : to.startsWith('mcp:')
      ? `${server?.name ?? '?'}${tool ? ` → ${tool}` : ''}`
      : (() => {
          const d = topology.deployments.find((x) => x.id === to.slice(4));
          return d?.public_name ?? d?.upstream_model ?? '?';
        })();
  const verb = effect === 'deny' ? 'Block' : effect === 'require_approval' ? 'Require approval for' : effect === 'inspect' ? 'Inspect' : 'Allow';
  const sentence = effect === 'inspect' ? `Inspect ${agentLabel} → ${destLabel}: ${inspectSummary(inspect)}` : `${verb} ${agentLabel} → ${destLabel}`;

  const [sim, setSim] = useState<SimResult | null>(null);
  const [simBusy, setSimBusy] = useState(false);
  useEffect(() => () => onSimulate(null), [onSimulate]);
  // Any change to the draft makes a shown simulation stale.
  useEffect(() => {
    setSim(null);
    onSimulate(null);
  }, [from, to, tool, effect, onSimulate]);

  const buildBody = (): { body?: Record<string, unknown>; error?: string } => {
    if (from === 'all' && !to && effect !== 'inspect') return { error: 'Pick an agent or a destination — a gate on everything would stop all traffic.' };
    const match: Record<string, unknown> = {};
    const body: Record<string, unknown> = { name: sentence, effect, priority: 5, target_kind: 'any' };
    if (from.startsWith('key:')) match.keys = [from.slice(4)];
    if (isGroup(from)) match.groups = [from.slice(GROUP_PREFIX.length)];
    if (isTeam(from)) match.teams = [from.slice(TEAM_PREFIX.length)];
    if (from.startsWith('zone:')) body.from_zone = from.slice(5);
    if (to.startsWith('dep:')) {
      match.deployments = [to.slice(4)];
      body.target_kind = 'model';
    }
    if (to.startsWith('mcp:')) {
      match.mcp_servers = [to.slice(4)];
      body.target_kind = 'tool';
      if (tool && server) match.tools = [`${server.slug}__${tool}`];
    }
    body.match = match;
    const config: Record<string, unknown> = {};
    if (reason.trim()) config.reason = reason.trim();
    if (effect === 'require_approval') config.hold_ms = Math.max(0, Math.min(55, Number(hold) || 0)) * 1000;
    if (effect === 'inspect') {
      if (!(inspect.detectors?.length || inspect.keywords?.length)) return { error: 'Pick at least one thing to look for.' };
      Object.assign(config, inspect);
    }
    body.config = config;
    return { body };
  };

  const runSimulation = async () => {
    const { body, error } = buildBody();
    if (!body) {
      setErr(error ?? null);
      return;
    }
    setSimBusy(true);
    setErr(null);
    try {
      const r = await api.post<SimResult>('/admin/api/policy/simulate', { rule: body, hours: 24 });
      setSim(r);
      onSimulate(r);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSimBusy(false);
    }
  };

  const create = async () => {
    const { body, error } = buildBody();
    if (!body) {
      setErr(error ?? null);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const created = await api.post<{ id: string }>('/admin/api/rules', body);
      if (notify) {
        await api.post('/admin/api/alert-rules', { rule_id: created.id, triggers: defaultTriggers(effect), threshold: 1, cooldown_s: 300, channels: notifyChannels });
        void useStore.getState().refreshAlerts();
      }
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="popover composer" style={panelPos(x, y, 600)}>
      <div className="t">New gate</div>
      <div className="field">
        <label>From</label>
        <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="all">Any agent</option>
          {zones.length > 0 && (
            <optgroup label="Zones">
              {zones.map((z) => (
                <option key={z.id} value={`zone:${z.id}`}>
                  {z.name}
                </option>
              ))}
            </optgroup>
          )}
          {teams.length > 0 && (
            <optgroup label="Teams">
              {teams.map((t) => (
                <option key={t} value={teamStation(t)}>
                  {t}
                </option>
              ))}
            </optgroup>
          )}
          {groups.size > 0 && (
            <optgroup label="Agent groups">
              {[...groups].map(([agentId, keys]) => (
                <option key={agentId} value={groupStation(agentId)}>
                  {agentId} ×{keys.length}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Agents">
            {singles.map((k) => (
              <option key={k.id} value={`key:${k.id}`}>
                {k.name}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      <div className="field">
        <label>To</label>
        <select
          className="input"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setTool('');
          }}
        >
          <option value="">Anything</option>
          <optgroup label="Models">
            {topology.deployments.map((d) => (
              <option key={d.id} value={`dep:${d.id}`}>
                {d.public_name ?? d.upstream_model}
              </option>
            ))}
          </optgroup>
          {topology.mcp_servers.length > 0 && (
            <optgroup label="Tool servers and APIs">
              {topology.mcp_servers.map((m) => (
                <option key={m.id} value={`mcp:${m.id}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      {server && (
        <div className="field">
          <label>Tool</label>
          <select className="input" value={tool} onChange={(e) => setTool(e.target.value)}>
            <option value="">Any tool on {server.name}</option>
            {server.tools.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
                {t.op === 'admin' ? ' (destructive)' : t.op === 'write' ? ' (write)' : t.op === 'read' ? ' (read)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label>Effect</label>
        <div className="effects">
          {EFFECTS.map((e) => (
            <button key={e.id} type="button" className={`effect ${e.cls} ${effect === e.id ? 'on' : ''}`} onClick={() => setEffect(e.id)}>
              {e.label}
            </button>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 6 }}>{EFFECTS.find((e) => e.id === effect)!.hint}</div>
      </div>
      {effect === 'require_approval' && (
        <div className="field">
          <label>Hold the request up to (seconds) before issuing a ticket</label>
          <input className="input" type="number" min={0} max={55} value={hold} onChange={(e) => setHold(e.target.value)} />
        </div>
      )}
      {effect === 'inspect' && <InspectFields value={inspect} onChange={setInspect} />}
      <div className="field">
        <label>Reason shown to the agent (optional)</label>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this gate exists" />
      </div>
      <div className="field">
        <label className="check">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Alert me when this gate {effect === 'deny' ? 'blocks something' : effect === 'require_approval' ? 'holds a request' : effect === 'inspect' ? 'finds something' : 'lets something through'}
        </label>
        {notify &&
          channels.map((c) => (
            <label key={c.id} className="check" style={{ marginLeft: 22 }}>
              <input type="checkbox" checked={notifyChannels.includes(c.id)} onChange={() => setNotifyChannels(notifyChannels.includes(c.id) ? notifyChannels.filter((x) => x !== c.id) : [...notifyChannels, c.id])} /> {c.name}
            </label>
          ))}
        {notify && <div className="hint">Console inbox{channels.length ? ' plus the channels ticked above' : ''}; at most one alert per 5 min, the rest summarised. Fine-tune it by clicking the gate later.</div>}
      </div>
      <div className="summary">{sentence}</div>
      {sim && <SimulationView r={sim} />}
      {err && <div className="error" style={{ marginBottom: 8 }}>{err}</div>}
      <div className="row">
        <button className="btn sm primary" disabled={busy} onClick={() => void create()}>
          {busy ? 'Adding…' : 'Add gate'}
        </button>
        {effect !== 'inspect' && (
          <button className="btn sm" disabled={simBusy} onClick={() => void runSimulation()} title="Replay the last 24 hours of traffic through this gate">
            {simBusy ? 'Simulating…' : sim ? 'Simulate again' : 'Simulate on last 24 h'}
          </button>
        )}
        <button className="btn sm ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
