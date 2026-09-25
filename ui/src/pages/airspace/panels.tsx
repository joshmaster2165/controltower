import { useState, type ReactNode } from 'react';
import { formatUsd } from '@controltower/shared';
import { useStore } from '../../store';
import type { FocusSummary, HoverInfo } from '../../airspace/scene';
import { hex } from '../../airspace/colors';
import { api, type Rule, type Topology, type Zone } from '../../api';
import { Icon } from '../../components/Icon';
import { CodeBlock } from '../../components/CodeBlock';
import { SWATCHES, STATE_LABEL, KIND_LABEL, kindLabel, ago, bringPos } from './shared';

/** Which provider catalogue entry a directly-called model API corresponds to. */
export const PROVIDER_FOR_SYSTEM: Record<string, { id: string; kind: string; name: string }> = {
  OpenAI: { id: 'openai', kind: 'openai', name: 'OpenAI' },
  Anthropic: { id: 'anthropic', kind: 'anthropic', name: 'Anthropic' },
  'Google Gemini': { id: 'gemini', kind: 'gemini', name: 'Google Gemini' },
  'Vertex AI': { id: 'vertex', kind: 'vertex', name: 'Google Vertex AI' },
  'AWS Bedrock': { id: 'bedrock', kind: 'bedrock', name: 'AWS Bedrock' },
  'Azure OpenAI': { id: 'azure-openai', kind: 'azure-openai', name: 'Azure OpenAI' },
  Mistral: { id: 'mistral', kind: 'openai-compatible', name: 'Mistral' },
  Groq: { id: 'groq', kind: 'openai-compatible', name: 'Groq' },
  'Together AI': { id: 'together', kind: 'openai-compatible', name: 'Together AI' },
  DeepSeek: { id: 'deepseek', kind: 'openai-compatible', name: 'DeepSeek' },
  xAI: { id: 'xai', kind: 'openai-compatible', name: 'xAI' },
  OpenRouter: { id: 'openrouter', kind: 'openai-compatible', name: 'OpenRouter' },
};

/**
 * "Why is this outside, and how do I bring it in?" for one observed system —
 * the concrete steps depend on what it is.
 */
export function BringInside({ rect, stationId, topology, onClose }: { rect: [number, number, number, number]; stationId: string; topology: Topology; onClose: () => void }) {
  const setRoute = useStore((st) => st.setRoute);
  const t = topology.observed?.targets.find((o) => o.id === stationId);
  if (!t) return null;
  const callers = (topology.observed?.edges ?? [])
    .filter((e) => e.target_id === stationId)
    .map((e) => ({ name: topology.keys.find((k) => k.id === e.key_id)?.name ?? e.key_id, calls: e.count_24h }))
    .sort((a, b) => b.calls - a.calls);
  const name = t.system ?? t.target;
  const origin = location.origin;
  const provider = t.system ? PROVIDER_FOR_SYSTEM[t.system] : undefined;
  const connected = provider ? topology.providers.some((p) => (provider.kind === 'openai-compatible' ? p.slug === provider.id || p.name === provider.name : p.kind === provider.kind)) : false;

  let body: ReactNode;
  if (t.kind === 'model' || t.bypass) {
    body = (
      <>
        <p className="bi-why">
          These agents call <b>{name}</b> directly, so their prompts skip your gates, budgets, inspection and cost tracking.
        </p>
        <ol className="bi-steps">
          <li className={connected ? 'done' : ''}>
            {connected ? (
              <>
                <b>{provider?.name ?? name} is connected</b> in Control Tower.
              </>
            ) : (
              <>
                <b>Connect {provider?.name ?? name}</b> as a provider (the same API key the agents use today).
                <button className="btn sm" onClick={() => setRoute('providers', provider?.id ?? null)}>
                  Connect {provider?.name ?? 'provider'}
                </button>
              </>
            )}
          </li>
          <li>
            <b>Point each agent's SDK at Control Tower</b> and swap its provider key for its Control Tower key. The code is otherwise unchanged:
            <CodeBlock title="OpenAI-compatible SDKs" code={`# each agent uses its own Control Tower key
base_url = "${origin}/v1"
api_key  = "ct_sk_…"`} />
            <span className="bi-note">Anthropic SDKs and Claude Code: base URL <code>{origin}</code> with the key in <code>x-api-key</code>.</span>
          </li>
          <li>
            <b>Close the side door</b> once traffic flows through the tower: revoke the old provider key, or block <code>{t.target}</code> at your network egress.
          </li>
        </ol>
      </>
    );
  } else if (t.kind === 'database' || t.kind === 'queue') {
    body = (
      <>
        <p className="bi-why">
          Agents reach <b>{name}</b> with their own code, so Control Tower only sees what they report.
        </p>
        <ol className="bi-steps">
          <li>
            <b>Expose it as an MCP tool server.</b>{' '}
            {t.kind === 'database' ? 'Use a database MCP server — ideally read-only, or with separate read and write tools.' : 'Wrap publishing and consuming as tools.'} Serve it over HTTP (stdio servers can sit behind a bridge such as <code>supergateway</code>).
          </li>
          <li>
            <b>Register it in Control Tower</b> — it then appears on the map with each of its tools.
            <button className="btn sm" onClick={() => setRoute('mcp', `new:${name}`)}>
              Register an MCP server
            </button>
          </li>
          <li>
            <b>Switch the agents to the tools</b> via <code>{origin}/mcp</code> with their Control Tower key. Now you can block, require approval or inspect each call — for example, approval for writes.
          </li>
        </ol>
      </>
    );
  } else {
    // SaaS and plain HTTP services: route their REST API through /http/<slug>.
    const base = /^https?:\/\//.test(t.target) ? t.target : `https://${t.target}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'api';
    body = (
      <>
        <p className="bi-why">
          Agents call <b>{name}</b>'s API with their own code and credentials, so Control Tower only sees what they report.
        </p>
        <ol className="bi-steps">
          <li>
            <b>Register it as an HTTP API</b> with its base URL and credentials (stored encrypted — the agents stop needing them).
            <button className="btn sm" onClick={() => setRoute('http', `new:${encodeURIComponent(name)}|${encodeURIComponent(base)}`)}>
              Register {name}
            </button>
          </li>
          <li>
            <b>Point the agents at Control Tower</b>: same paths, a new base URL, and their Control Tower key.
            <CodeBlock title="Base URL" code={`- ${base}
+ ${origin}/http/${slug}
  x-ct-key: ct_sk_…   # the agent's own key`} />
          </li>
          <li>
            <b>Gate it.</b> Reads, writes and deletes show up as separate routes on the map — for example, require approval for <code>DELETE</code>. Then revoke the credentials the agents used to hold.
          </li>
        </ol>
        {t.kind === 'saas' && <p className="bi-note">Prefer tools? If {name} publishes an MCP server, register that under MCP servers instead.</p>}
      </>
    );
  }

  return (
    <div className="popover composer bring-inside" style={bringPos(rect)}>
      <div className="bi-h">
        <span className={`bi-badge ${t.bypass ? 'bypass' : ''}`}>{t.bypass ? 'Bypasses the gateway' : 'Outside the gateway'}</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="t" style={{ marginBottom: 2 }}>
        Bring {name} inside
      </div>
      <div className="dim mono" style={{ marginBottom: 8 }}>
        {t.target}
      </div>
      {callers.length > 0 && (
        <div className="bi-callers">
          {callers.map((c) => (
            <span key={c.name} className="route-chip">
              {c.name} · {c.calls.toLocaleString()}
            </span>
          ))}
          <span className="dim">calls in 24 h</span>
        </div>
      )}
      {body}
    </div>
  );
}

/** First-run checklist: each step ticks itself off from real data. */
export function GettingStarted({ topology, rules, onGate, demo }: { topology: Topology; rules: number; onGate: () => void; demo: boolean }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem('ct.onboarding.dismissed') === '1';
    } catch {
      return false;
    }
  });
  const agents = topology.keys.filter((k) => k.name !== 'playground' && !k.demo).length;
  const steps: Array<{ label: string; hint: string; done: boolean; href?: string; action?: () => void }> = [
    { label: 'Connect a provider', hint: 'OpenAI, Anthropic, Bedrock, a local model…', done: topology.providers.some((p) => !p.demo), href: '#/welcome' },
    { label: 'Create an agent key', hint: 'One per agent, so it shows up here by name', done: agents > 0, href: '#/welcome' },
    { label: 'Point the agent here', hint: 'Two environment variables — models are added on first use', done: (topology.edges ?? []).some((e) => topology.keys.some((k) => k.id === e.key_id && !k.demo && k.name !== 'playground')), href: '#/welcome' },
    { label: 'Put a gate on a path', hint: 'Block, require approval or inspect', done: rules > 0, action: onGate },
  ];
  const done = steps.filter((x) => x.done).length;
  // Once most of it is done, it shrinks to a pill so it does not sit on the map.
  // While the demo fleet is flying the user is exploring: start as a pill.
  const [open, setOpen] = useState(done < 3 && !demo);
  if (hidden || done === steps.length) return null;
  if (!open) {
    return (
      <button className="onboarding-pill" onClick={() => setOpen(true)} title="Show the getting-started checklist">
        <span className="ring" style={{ ['--p' as string]: `${(done / steps.length) * 100}%` }} /> Get started · {done} of {steps.length}
      </button>
    );
  }
  const dismiss = () => {
    try {
      localStorage.setItem('ct.onboarding.dismissed', '1');
    } catch {
      /* private mode */
    }
    setHidden(true);
  };
  return (
    <div className="onboarding card" role="region" aria-label="Get started">
      <div className="onboarding-h">
        <b>Get started</b>
        <span className="dim">
          {done} of {steps.length}
        </span>
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Minimise" title="Minimise">
          <Icon name="chevrons-left" size={14} className="rot-down" />
        </button>
        <button className="icon-btn" onClick={dismiss} aria-label="Dismiss" title="Don't show again">
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="onboarding-bar">
        <div style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      <ol>
        {steps.map((x) => {
          const body = (
            <>
              <span className={`step-dot ${x.done ? 'done' : ''}`}>{x.done && <Icon name="check" size={11} />}</span>
              <span className="step-text">
                <span className="step-label">{x.label}</span>
                {!x.done && <span className="step-hint">{x.hint}</span>}
              </span>
            </>
          );
          return (
            <li key={x.label} className={x.done ? 'done' : ''}>
              {x.done ? <div className="step">{body}</div> : x.href ? <a className="step" href={x.href}>{body}</a> : <button className="step" onClick={x.action}>{body}</button>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function Tooltip({ hover }: { hover: HoverInfo }) {
  const pos = { left: hover.x, top: hover.y };
  if (hover.observedLine) {
    const o = hover.observedLine;
    return (
      <div className="tooltip" style={pos}>
        <div className="t">
          {o.agent} → {o.system ?? o.target}
        </div>
        <div className="r">
          <span>24h calls{o.writes24h ? ' · writes' : ''}</span>
          <b>
            {o.count24h.toLocaleString()}
            {o.writes24h ? ` · ${o.writes24h.toLocaleString()}` : ''}
          </b>
        </div>
        {o.errors24h > 0 && (
          <div className="r">
            <span>errors</span>
            <b>{o.errors24h.toLocaleString()}</b>
          </div>
        )}
        <div className="r">
          <span>last seen</span>
          <b>{ago(o.lastSeen)}</b>
        </div>
        <div className="note">{o.bypass ? 'A model provider called directly — this traffic bypasses the gateway, its gates and its budgets.' : 'Reported by the agent (SDK / OpenTelemetry). Not proxied, so Control Tower can see it but cannot block it.'}</div>
      </div>
    );
  }
  if (hover.station?.kind === 'observed') {
    const s = hover.station;
    return (
      <div className="tooltip" style={pos}>
        <div className="t" style={{ color: hex(s.color) }}>
          {s.label}
        </div>
        <div className="r">
          <span>{s.obs?.target !== s.label ? s.obs?.target : 'observed system'}</span>
          <b>{STATE_LABEL[s.state]}</b>
        </div>
        <div className="r">
          <span>24h calls · errors</span>
          <b>
            {s.observed24h.toLocaleString()} · {(s.obs?.errors24h ?? 0).toLocaleString()}
          </b>
        </div>
        {s.obs && (
          <div className="r">
            <span>last seen</span>
            <b>{ago(s.obs.lastSeen)}</b>
          </div>
        )}
        <div className="note">
          {s.obs?.bypass ? 'Agents call this model provider directly — bypassing gates, budgets and cost tracking.' : 'Seen, not enforced: agents report these calls; they do not pass through Control Tower.'} <b>Click to bring it inside.</b>
        </div>
      </div>
    );
  }
  if (hover.station) {
    const s = hover.station;
    return (
      <div className="tooltip" style={pos}>
        <div className="t" style={{ color: hex(s.color) }}>
          {s.label}
        </div>
        <div className="r">
          <span>{kindLabel(s)}</span>
          <b>{STATE_LABEL[s.state]}</b>
        </div>
        <div className="r">
          <span>last minute</span>
          <b>{s.rpm} flights</b>
        </div>
        <div className="r">
          <span>24h requests</span>
          <b>{s.requests24h.toLocaleString()}</b>
        </div>
        <div className="r">
          <span>24h spend</span>
          <b>{formatUsd(s.cost24h)}</b>
        </div>
        {s.observed24h > 0 && (
          <div className="r">
            <span>24h observed calls</span>
            <b>{s.observed24h.toLocaleString()}</b>
          </div>
        )}
        {(s.denied24h > 0 || s.errors24h > 0) && (
          <div className="r">
            <span>blocked · errors</span>
            <b>
              {s.denied24h} · {s.errors24h}
            </b>
          </div>
        )}
        <div className="r">
          <span>click to trace connections</span>
        </div>
      </div>
    );
  }
  if (hover.tool) {
    const t = hover.tool;
    return (
      <div className="tooltip" style={pos}>
        <div className="t">
          {t.server} · {t.name}
        </div>
        <div className="r">
          <span>operation</span>
          <b>{t.op === 'admin' ? 'destructive' : t.op}</b>
        </div>
        <div className="r">
          <span>last minute</span>
          <b>{t.rpm} calls</b>
        </div>
        <div className="r">
          <span>24h calls</span>
          <b>{t.count24h.toLocaleString()}</b>
        </div>
        {t.gates.map((g) => (
          <div className="r" key={g.id}>
            <span>gate</span>
            <b>{g.effect.replace('_', ' ')}</b>
          </div>
        ))}
      </div>
    );
  }
  if (hover.lane) {
    const l = hover.lane;
    return (
      <div className="tooltip" style={pos}>
        <div className="t">
          {l.fromLabel} → {l.toLabel}
        </div>
        <div className="r">
          <span>state</span>
          <b>{STATE_LABEL[l.state]}</b>
        </div>
        <div className="r">
          <span>last minute</span>
          <b>{l.rpm} flights</b>
        </div>
        <div className="r">
          <span>24h requests · spend</span>
          <b>
            {l.requests.toLocaleString()} · {formatUsd(l.cost)}
          </b>
        </div>
        {l.gate && (
          <div className="r">
            <span>gate</span>
            <b>{l.gate.rule.effect.replace('_', ' ')}</b>
          </div>
        )}
      </div>
    );
  }
  if (hover.gate) {
    return (
      <div className="tooltip" style={pos}>
        <div className="t">{hover.gate.rule.name}</div>
        <div className="r">
          <span>effect</span>
          <b>{hover.gate.rule.effect.replace('_', ' ')}</b>
        </div>
        <div className="r">
          <span>triggered (last min)</span>
          <b>{hover.gate.hits}</b>
        </div>
        <div className="r">
          <span>click to edit</span>
        </div>
      </div>
    );
  }
  if (hover.hub) {
    return (
      <div className="tooltip" style={pos}>
        <div className="t">Control Tower</div>
        <div className="r">
          <span>active links</span>
          <b>{hover.hub.active}</b>
        </div>
        <div className="r">
          <span>flights / min</span>
          <b>{hover.hub.rpm}</b>
        </div>
        <div className="r">
          <span>holding</span>
          <b>{hover.hub.held}</b>
        </div>
      </div>
    );
  }
  if (hover.zone) {
    return (
      <div className="tooltip" style={pos}>
        <div className="t" style={{ color: hover.zone.color }}>
          {hover.zone.name}
        </div>
        <div className="r">
          <span>click to manage gates</span>
        </div>
      </div>
    );
  }
  return null;
}

export function FocusPanel({ summary, onClose, onPick }: { summary: FocusSummary; onClose: () => void; onPick: (id: string) => void }) {
  const s = summary.station;
  const title = s.kind === 'agent' ? 'Reaches' : 'Used by';
  const maxReq = Math.max(1, ...summary.links.map((l) => l.requests));
  return (
    <div className="tower-drawer">
      <div className="card focus-panel">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="hint" style={{ textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 11, fontWeight: 600 }}>
              {kindLabel(s)} · {STATE_LABEL[s.state]}
            </div>
            <div style={{ fontWeight: 600, fontSize: 16, marginTop: 2 }}>{s.label}</div>
            <div className="hint">{s.sub}</div>
          </div>
          <button className="btn sm ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="focus-stats">
          <div>
            <div className="label">Last min</div>
            <div className="value">{s.rpm}</div>
          </div>
          <div>
            <div className="label">24h requests</div>
            <div className="value">{s.requests24h.toLocaleString()}</div>
          </div>
          <div>
            <div className="label">24h spend</div>
            <div className="value">{formatUsd(s.cost24h)}</div>
          </div>
        </div>
        <div className="focus-title">
          {title} · {summary.links.length}
        </div>
        {summary.links.length === 0 && <div className="hint">No connections in the last 24 hours.</div>}
        {summary.links.map((l) => (
          <div key={`${l.id}:${l.relation ?? ''}`} className="focus-link" onClick={() => onPick(l.id)} role="button" tabIndex={0}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <i className="swatch" style={{ background: hex(l.color) }} />
              <span className="name">{l.label}</span>
              <span className="kind">{l.relation ? `${l.relation === 'calls' ? 'calls' : 'called by'} · agent` : KIND_LABEL[l.kind]}</span>
              {l.observed && <span className={`obs-tag ${l.bypass ? 'bypass' : ''}`}>{l.bypass ? 'bypasses gateway' : 'not enforced'}</span>}
              {l.live && <span className="live-dot" title="active in the last minute" />}
              <span className="num">{l.requests.toLocaleString()}</span>
            </div>
            <div className="bar">
              <div style={{ width: `${(l.requests / maxReq) * 100}%` }} />
            </div>
            {(l.denied > 0 || l.errors > 0 || l.cost > 0) && (
              <div className="meta">
                {formatUsd(l.cost)}
                {l.denied > 0 && <span className="bad"> · {l.denied} blocked</span>}
                {l.errors > 0 && <span className="bad"> · {l.errors} errors</span>}
              </div>
            )}
            {l.tools.length > 0 && (
              <div className="tools">
                {l.tools.map((t) => (
                  <span key={t.name} className="tag">
                    {t.name} · {t.requests.toLocaleString()}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        <div className="hint" style={{ marginTop: 10 }}>
          Click a connection to trace it · Esc to clear
        </div>
      </div>
    </div>
  );
}

export function ZoneCreatePopover({ x, y, count, onCancel, onCreate }: { x: number; y: number; count: number; onCancel: () => void; onCreate: (name: string, color: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(SWATCHES[0]!);
  return (
    <form
      className="popover"
      style={{ left: Math.min(x, window.innerWidth - 340), top: Math.min(y, window.innerHeight - 260) }}
      onSubmit={(e) => {
        e.preventDefault();
        if (name) void onCreate(name, color);
      }}
    >
      <div className="t">New zone · {count} station{count === 1 ? '' : 's'}</div>
      <div className="field">
        <label>Name</label>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Finance agents" />
      </div>
      <div className="field">
        <label>Colour</label>
        <div className="swatches">
          {SWATCHES.map((c) => (
            <i key={c} className={c === color ? 'sel' : ''} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
      </div>
      <div className="row">
        <button className="btn sm primary" disabled={!name} type="submit">
          Create zone
        </button>
        <button className="btn sm ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ZonePopover({ x, y, zone, zones, rules, onClose, onChanged }: { x: number; y: number; zone: Zone; zones: Zone[]; rules: Rule[]; onClose: () => void; onChanged: () => void }) {
  const [target, setTarget] = useState(zones.find((z) => z.id !== zone.id)?.id ?? '');
  const [effect, setEffect] = useState<Rule['effect']>('require_approval');
  const [name, setName] = useState(zone.name);
  const own = rules.filter((r) => r.from_zone === zone.id || r.to_zone === zone.id);
  const addGate = async () => {
    await api.post('/admin/api/rules', { from_zone: zone.id, to_zone: target || null, effect, config: effect === 'require_approval' ? { hold_ms: 20000 } : {} });
    onChanged();
    onClose();
  };
  const rename = async () => {
    if (name.trim() && name !== zone.name) await api.patch(`/admin/api/zones/${zone.id}`, { name: name.trim() });
    onChanged();
  };
  const remove = async () => {
    if (!confirm(`Delete zone "${zone.name}" and its gates?`)) return;
    await api.del(`/admin/api/zones/${zone.id}`);
    onChanged();
    onClose();
  };
  return (
    <div className="popover" style={{ left: Math.min(x, window.innerWidth - 340), top: Math.min(y + 8, window.innerHeight - 320) }}>
      <div className="t" style={{ color: zone.color }}>
        {zone.name}
      </div>
      <div className="field">
        <label>Rename</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn sm" onClick={() => void rename()}>
            Save
          </button>
        </div>
      </div>
      <div className="field">
        <label>Add a gate from this zone to…</label>
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">anywhere</option>
          {zones
            .filter((z) => z.id !== zone.id)
            .map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
        </select>
        <select className="input" value={effect} onChange={(e) => setEffect(e.target.value as Rule['effect'])} style={{ marginTop: 6 }}>
          <option value="allow">allow (open gate)</option>
          <option value="deny">deny (barrier)</option>
          <option value="require_approval">require approval (checkpoint)</option>
        </select>
        <div className="row">
          <button className="btn sm primary" onClick={() => void addGate()}>
            Add gate
          </button>
        </div>
      </div>
      {own.length > 0 && (
        <div className="hint" style={{ marginBottom: 8 }}>
          {own.length} gate{own.length === 1 ? '' : 's'} touch this zone — click a gate marker on a lane to edit it.
        </div>
      )}
      <div className="row">
        <button className="btn sm danger" onClick={() => void remove()}>
          Delete zone
        </button>
        <button className="btn sm ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
