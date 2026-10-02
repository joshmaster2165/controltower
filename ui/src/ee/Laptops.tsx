import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { CodeBlock } from '../components/CodeBlock';
import { api, ApiError } from '../api';
import { ago } from '../format';
import { EnterpriseNotice } from './LicensePage';
import type { DeviceSession } from './DevicePage';

interface Rule {
  client: string;
  team_id: string | null;
  key_id: string;
}
interface Overview {
  sessions: DeviceSession[];
  rules: Array<Rule & { id: string; team: string | null; key: string | null }>;
  settings: { session_days: number; idle_days: number; token_ttl_s: number };
  url: string;
  public_url_set: boolean;
}
interface RolloutFile {
  name: string;
  platform: 'macos' | 'windows' | 'linux' | 'any';
  use: string;
  content: string;
  mime: string;
}

const CLIENTS: Array<{ id: string; label: string }> = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'claude-desktop', label: 'Claude Desktop' },
  { id: 'codex', label: 'Codex' },
];
const RULE_CLIENTS = [{ id: '*', label: 'Any tool' }, ...CLIENTS, { id: 'other', label: 'Other (ct-auth by hand)' }];
const PLATFORMS: Array<{ id: RolloutFile['platform']; label: string; steps: string[] }> = [
  {
    id: 'macos',
    label: 'macOS',
    steps: [
      'Jamf Pro: add install-ct-auth-macos.sh as a script in a policy, and upload controltower.mobileconfig under Configuration Profiles.',
      'Intune: Devices › macOS › Scripts for the .sh (run as root), and Configuration › Templates › Custom for the .mobileconfig.',
      'Kandji: a Custom Script for the .sh and a Custom Profile for the .mobileconfig.',
    ],
  },
  {
    id: 'windows',
    label: 'Windows',
    steps: [
      'Intune: Devices › Windows › Scripts › add install-controltower-windows.ps1. Run it as SYSTEM (not the signed-in user), in 64-bit PowerShell.',
      'Group Policy: import controltower-windows.reg as registry preferences for Claude Code and Claude Desktop, and copy ct-auth.ps1 to C:\\Program Files\\ControlTower yourself.',
    ],
  },
  { id: 'linux', label: 'Linux', steps: ['Run install-controltower-linux.sh as root from your configuration management (Ansible, Puppet, Chef, a golden image).'] },
  { id: 'any', label: 'Single files', steps: ['The same settings as separate files, for your own packaging, and the helper itself.'] },
];

function download(f: RolloutFile) {
  const url = URL.createObjectURL(new Blob([f.content], { type: f.mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = f.name.replace(/\//g, '-');
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Laptops (Enterprise): people sign in on their computers, and Claude Code, Claude Desktop and Codex call the gateway
 * as them. Rules pick the key each tool's calls are made as; the rollout files go to Jamf, Intune, Kandji or Group
 * Policy; every signed-in computer can be signed out from here.
 */
export function LaptopsPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [keys, setKeys] = useState<Array<{ id: string; name: string; team?: string | null; demo?: boolean; built_in?: boolean }>>([]);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [unlicensed, setUnlicensed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [clients, setClients] = useState<string[]>(CLIENTS.map((c) => c.id));
  const [mcp, setMcp] = useState(true);
  const [lockdown, setLockdown] = useState(true);
  const [files, setFiles] = useState<RolloutFile[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [settings, setSettings] = useState<{ session_days: string; idle_days: string } | null>(null);
  // How people sign in: approving each computer in Control Tower, or with the identity provider directly.
  const [mode, setMode] = useState<'controltower' | 'idp'>('controltower');
  const [issuers, setIssuers] = useState<Array<{ id: string; name: string; issuer: string; audiences: string[]; principal_claim: string; rules: unknown[] }>>([]);
  const [issuerId, setIssuerId] = useState('');
  const [clientId, setClientId] = useState('');
  const [idpInfo, setIdpInfo] = useState<{ id: string; name: string; principal_claim: string; rules: number; people: boolean } | null>(null);
  const [idpRefresh, setIdpRefresh] = useState(0);

  const load = useCallback(() => {
    void api
      .get<Overview>('/admin/api/devices')
      .then((d) => {
        setData(d);
        setRules((r) => r ?? d.rules.map(({ client, team_id, key_id }) => ({ client, team_id, key_id })));
        setUrl((u) => u || d.url);
        setSettings((s) => s ?? { session_days: String(d.settings.session_days), idle_days: String(d.settings.idle_days) });
      })
      .catch((e) => (e instanceof ApiError && e.code === 'enterprise_required' ? setUnlicensed(true) : setErr(e instanceof ApiError ? e.message : String(e))));
  }, []);
  useEffect(() => {
    load();
    void api.get<{ keys: typeof keys }>('/admin/api/keys').then((d) => setKeys(d.keys.filter((k) => !k.built_in && !k.demo)));
    void api.get<{ teams: typeof teams }>('/admin/api/teams').then((d) => setTeams(d.teams)).catch(() => undefined);
    void api.get<{ issuers: typeof issuers }>('/admin/api/token-issuers').then((d) => setIssuers(d.issuers)).catch(() => undefined);
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!url || !clients.length) return setFiles([]);
    if (mode === 'idp' && (!issuerId || !clientId)) return setFiles([]);
    const q = new URLSearchParams({ url, clients: clients.join(','), mcp: mcp ? '1' : '0', lockdown: lockdown ? '1' : '0', ...(mode === 'idp' ? { idp_issuer_id: issuerId, idp_client_id: clientId } : {}) });
    const t = setTimeout(() => {
      void api
        .get<{ files: RolloutFile[]; warnings?: string[]; idp?: { id: string; name: string; principal_claim: string; rules: number; people: boolean } }>(`/admin/api/devices/rollout?${q}`)
        .then((d) => {
          setFiles(d.files);
          setWarnings(d.warnings ?? []);
          setIdpInfo(d.idp ?? null);
          setErr(null);
        })
        .catch((e) => {
          setFiles([]);
          setErr(e instanceof ApiError ? e.message : String(e));
        });
    }, 300);
    return () => clearTimeout(t);
  }, [url, clients, mcp, lockdown, mode, issuerId, clientId, idpRefresh]);

  const run = async (fn: () => Promise<void>, done?: string) => {
    setErr(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  const saved = useMemo(() => JSON.stringify(data?.rules.map(({ client, team_id, key_id }) => ({ client, team_id, key_id })) ?? []), [data]);
  const dirty = !!rules && JSON.stringify(rules) !== saved;
  const active = (data?.sessions ?? []).filter((s) => s.status === 'active');
  const listed = showAll ? (data?.sessions ?? []) : active;

  if (unlicensed)
    return (
      <div className="page">
        <PageHeader title="Laptops" description="People sign in on their computers, and Claude Code, Claude Desktop and Codex call the gateway as them." />
        <EnterpriseNotice feature="Laptop sign-in" />
      </div>
    );

  const setRule = (i: number, patch: Partial<Rule>) => setRules((r) => r!.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: -1 | 1) =>
    setRules((r) => {
      const next = [...r!];
      const [x] = next.splice(i, 1);
      next.splice(i + d, 0, x!);
      return next;
    });

  return (
    <div className="page laptops-page">
      <PageHeader
        title="Laptops"
        meta={data ? `${active.length} signed in` : undefined}
        description="People sign in on their computers with ct-auth, and Claude Code, Claude Desktop and Codex call the gateway as them: each call is theirs in Flights and the Ledger, under the key a rule picks. Roll it out with Jamf, Intune, Kandji or Group Policy."
      />
      {err && <div className="error">{err}</div>}
      {notice && (
        <div className="notice-row">
          <span>{notice}</span>
          <button className="btn sm ghost" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <section className="card laptops-section">
        <h2>1 · Which key each tool’s calls are made as</h2>
        <p className="hint">For people who sign in with Control Tower: the first rule that matches the person (one of their teams, or everyone) and the tool decides. The key’s models, tools, limits, budget and gates apply; who made each call is recorded too. (Signing in with your identity provider, its issuer’s rules under Agent identity decide instead.)</p>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th>Tool</th>
              <th>People</th>
              <th>Key</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(rules ?? []).map((r, i) => (
              <tr key={i}>
                <td className="mono">{i + 1}</td>
                <td>
                  <select className="input" value={r.client} onChange={(e) => setRule(i, { client: e.target.value })} aria-label="Tool">
                    {RULE_CLIENTS.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select className="input" value={r.team_id ?? ''} onChange={(e) => setRule(i, { team_id: e.target.value || null })} aria-label="People">
                    <option value="">Everyone</option>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        Team {t.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select className="input" value={r.key_id} onChange={(e) => setRule(i, { key_id: e.target.value })} aria-label="Key">
                    <option value="">Choose a key…</option>
                    {keys.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.name}
                        {k.team ? ` (${k.team})` : ''}
                      </option>
                    ))}
                  </select>
                </td>
                <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                  <button className="btn sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                    ↑
                  </button>{' '}
                  <button className="btn sm" disabled={i === (rules?.length ?? 0) - 1} onClick={() => move(i, 1)} aria-label="Move down">
                    ↓
                  </button>{' '}
                  <button className="btn sm" onClick={() => setRules((x) => x!.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {rules?.length === 0 && (
              <tr>
                <td colSpan={5} className="hint" style={{ padding: 16 }}>
                  No rules yet: nobody can sign in a computer. Create a key for each tool (say <span className="mono">claude-code</span>, with the models it may use and a budget), then add a rule.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn" onClick={() => setRules((r) => [...(r ?? []), { client: '*', team_id: null, key_id: '' }])}>
            Add a rule
          </button>
          <button className="btn primary" disabled={!dirty || rules!.some((r) => !r.key_id)} onClick={() => void run(() => api.put('/admin/api/devices/rules', { rules }).then(() => setRules(null)), 'Rules saved. They apply at each computer’s next token (within the hour).')}>
            Save rules
          </button>
        </div>
      </section>

      <section className="card laptops-section">
        <h2>2 · Roll it out</h2>
        <p className="hint">These files install ct-auth and set up each tool to use Control Tower, every person signing in as themselves. They hold no secret: the address below, and how people sign in, is all they carry.</p>
        <fieldset className="field laptops-mode">
          <legend>How people sign in</legend>
          <label className="check">
            <input type="radio" name="signin" checked={mode === 'controltower'} onChange={() => setMode('controltower')} />
            <span>
              <b>With Control Tower</b>
              <span className="hint">Each person approves their computer in the console. They need a Control Tower account (single sign-on, the member role), and the rules above pick the key.</span>
            </span>
          </label>
          <label className="check">
            <input type="radio" name="signin" checked={mode === 'idp'} onChange={() => setMode('idp')} />
            <span>
              <b>With your identity provider</b>
              <span className="hint">People sign in to Okta, Entra ID… directly, with no Control Tower account. A trusted issuer under Agent identity checks their tokens, and its rules pick the key.</span>
            </span>
          </label>
        </fieldset>
        {mode === 'idp' && (
          <div className="laptops-options">
            <div className="field" style={{ flex: '1 1 240px' }}>
              <label htmlFor="idp-issuer">Identity provider (a trusted issuer)</label>
              <select id="idp-issuer" className="input" value={issuerId} onChange={(e) => setIssuerId(e.target.value)}>
                <option value="">Choose…</option>
                {issuers.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.issuer})
                  </option>
                ))}
              </select>
              {issuers.length === 0 && (
                <span className="hint">
                  None yet: add your identity provider under <a href="#/agent-identity">Agent identity</a>, with rules from its groups to keys.
                </span>
              )}
            </div>
            <div className="field" style={{ flex: '1 1 240px' }}>
              <label htmlFor="idp-client">Client ID of the laptop app</label>
              <input id="idp-client" className="input mono" value={clientId} onChange={(e) => setClientId(e.target.value.trim())} placeholder="0oa1b2c3d4… or an Entra application ID" />
              <span className="hint">A public client with the device authorization grant turned on, and the same ID among the issuer’s accepted audiences.</span>
            </div>
            {idpInfo && (
              <p className="hint" style={{ flex: "1 1 100%", margin: 0 }}>
                {idpInfo.name}: {idpInfo.rules} {idpInfo.rules === 1 ? 'rule' : 'rules'} pick the key; calls are recorded under the token’s <span className="mono">{idpInfo.principal_claim}</span>
                {idpInfo.principal_claim === 'sub' && <span className="laptops-warn"> (set “Who presented it” to email, or preferred_username for Entra ID, to see people by name)</span>}.
                {idpInfo.people ? (
                  ' Each person uses a seat while seen in the last 30 days.'
                ) : (
                  <>
                    {' '}
                    <span className="laptops-warn">Its tokens aren’t marked as people yet, so people signing in with it use no seat.</span>{' '}
                    <button className="btn sm" onClick={() => void run(() => api.patch(`/admin/api/token-issuers/${idpInfo.id}`, { people: true }).then(() => setIdpRefresh((n) => n + 1)), `${idpInfo.name}'s tokens now count as people.`)}>
                      Count them as people
                    </button>
                  </>
                )}
              </p>
            )}
          </div>
        )}
        <div className="laptops-options">
          <div className="field" style={{ flex: '1 1 320px' }}>
            <label htmlFor="rollout-url">The address laptops reach Control Tower at</label>
            <input id="rollout-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value.trim())} />
            {url && !url.startsWith('https://') && <span className="hint laptops-warn">Use https for laptops: tokens go over this connection.</span>}
            {data && !data.public_url_set && <span className="hint">Set CT_PUBLIC_URL on the server so the sign-in page links use this address too.</span>}
          </div>
          <fieldset className="field laptops-clients">
            <legend>Tools</legend>
            {CLIENTS.map((c) => (
              <label key={c.id} className="check">
                <input type="checkbox" checked={clients.includes(c.id)} onChange={(e) => setClients((x) => (e.target.checked ? [...x, c.id] : x.filter((y) => y !== c.id)))} /> {c.label}
              </label>
            ))}
          </fieldset>
          <fieldset className="field laptops-clients">
            <legend>Options</legend>
            <label className="check">
              <input type="checkbox" checked={mcp} onChange={(e) => setMcp(e.target.checked)} /> Give them Control Tower’s MCP tools
            </label>
            <label className="check">
              <input type="checkbox" checked={lockdown} onChange={(e) => setLockdown(e.target.checked)} /> Lock down: no other provider or MCP server
            </label>
          </fieldset>
        </div>
        {warnings.map((w) => (
          <div key={w} className="notice-row laptops-warning">
            <span>{w}</span>
          </div>
        ))}
        {PLATFORMS.map((p) => {
          const these = files.filter((f) => f.platform === p.id);
          if (!these.length) return null;
          return (
            <div key={p.id} className="laptops-platform">
              <h3>{p.label}</h3>
              <ul className="hint">
                {p.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              <table className="table">
                <tbody>
                  {these.map((f) => (
                    <tr key={f.name}>
                      <td className="mono" style={{ width: 280 }}>
                        {f.name}
                      </td>
                      <td className="hint">{f.use}</td>
                      <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                        <button className="btn sm" onClick={() => setShown((s) => (s === f.name ? null : f.name))}>
                          {shown === f.name ? 'Hide' : 'Show'}
                        </button>{' '}
                        <button className="btn sm primary" onClick={() => download(f)}>
                          Download
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {these.some((f) => f.name === shown) && <CodeBlock title={shown!} code={these.find((f) => f.name === shown)!.content} />}
            </div>
          );
        })}
        <div className="laptops-platform">
          <h3>Try it on your own computer first</h3>
          <CodeBlock title="macOS or Linux" code={`curl -fsSL ${url}/device/ct-auth.sh -o ct-auth && chmod +x ct-auth\n./ct-auth login --url ${url} --client claude-code`} />
        </div>
      </section>

      <section className="card laptops-section">
        <h2>
          3 · Signed-in computers <span className="hint">({active.length} active)</span>
        </h2>
        <table className="table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Tool</th>
              <th>Computer</th>
              <th>Key</th>
              <th>Last used</th>
              <th>Ends</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {listed.map((s) => (
              <tr key={s.id} className={s.status === 'active' ? '' : 'dim'}>
                <td>{s.person}</td>
                <td>{s.client_name}</td>
                <td>
                  {s.device_name}
                  {s.last_ip && <div className="hint mono">{s.last_ip}</div>}
                </td>
                <td className="mono">{s.key?.name ?? '—'}</td>
                <td>{ago(s.last_used_at)}</td>
                <td>{s.status === 'active' ? new Date(s.ends_at).toLocaleDateString() : <span className="tag">{s.status === 'revoked' ? `signed out${s.revoked_by ? ` by ${s.revoked_by}` : ''}` : 'expired'}</span>}</td>
                <td style={{ textAlign: 'right' }}>
                  {s.status === 'active' && (
                    <button className="btn sm" onClick={() => void run(() => api.del(`/admin/api/devices/${s.id}`), `Signed out ${s.client_name} on ${s.device_name}. Its token stopped working at once.`)}>
                      Sign out
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {listed.length === 0 && (
              <tr>
                <td colSpan={7} className="hint" style={{ padding: 16 }}>
                  No computer is signed in yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <label className="check hint" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show signed-out and expired too
        </label>
      </section>

      {settings && data && (
        <section className="card laptops-section">
          <h2>4 · How long a sign-in lasts</h2>
          <div className="laptops-options">
            <div className="field">
              <label htmlFor="session-days">Sign in again after (days)</label>
              <input id="session-days" className="input" type="number" min={1} max={365} value={settings.session_days} onChange={(e) => setSettings({ ...settings, session_days: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="idle-days">…or after unused for (days)</label>
              <input id="idle-days" className="input" type="number" min={1} max={365} value={settings.idle_days} onChange={(e) => setSettings({ ...settings, idle_days: e.target.value })} />
            </div>
            <div className="field" style={{ alignSelf: 'end' }}>
              <button className="btn" onClick={() => void run(() => api.put('/admin/api/devices/settings', { session_days: Number(settings.session_days), idle_days: Number(settings.idle_days) }), 'Saved.')}>
                Save
              </button>
            </div>
          </div>
          <p className="hint">
            Access tokens last {Math.round(data.settings.token_ttl_s / 60)} minutes; each new one checks the person is still active and the rules still let them in. Removing or deactivating a person (here or by SCIM) signs out their computers at once.
          </p>
        </section>
      )}
    </div>
  );
}
