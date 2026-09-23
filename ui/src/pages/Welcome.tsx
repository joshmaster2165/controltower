import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useStore } from '../store';
import { PageHeader } from '../components/PageHeader';
import { Monogram } from '../components/Monogram';
import { Icon } from '../components/Icon';
import { ConnectAgent } from '../components/ConnectAgent';

/** The providers most people start with; the full catalogue is one click further. */
const STARTERS: Array<{ id: string; name: string; kind: string }> = [
  { id: 'openai', name: 'OpenAI', kind: 'openai' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic' },
  { id: 'gemini', name: 'Google Gemini', kind: 'gemini' },
  { id: 'azure-openai', name: 'Azure OpenAI', kind: 'azure-openai' },
  { id: 'bedrock', name: 'AWS Bedrock', kind: 'bedrock' },
  { id: 'ollama', name: 'Ollama (local)', kind: 'openai-compatible' },
];

/**
 * First run: three steps from an empty install to your own agent on the map.
 * Each step ticks itself off from real data, so it doubles as a checklist.
 */
export function WelcomePage() {
  const topology = useStore((s) => s.topology);
  const status = useStore((s) => s.status);
  const setRoute = useStore((s) => s.setRoute);
  const refreshTopology = useStore((s) => s.refreshTopology);
  const setDemo = useStore((s) => s.setDemo);
  const [name, setName] = useState('my-agent');
  const [created, setCreated] = useState<{ id: string; name: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);

  const providers = (topology?.providers ?? []).filter((p) => !p.demo);
  const agents = (topology?.keys ?? []).filter((k) => !k.demo && k.name !== 'playground');
  const talking = new Set((topology?.edges ?? []).map((e) => e.key_id));
  const liveAgent = agents.find((k) => talking.has(k.id));
  const step1 = providers.length > 0;
  const step2 = agents.length > 0 || created !== null;
  const step3 = liveAgent !== undefined;

  const createKey = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.post<{ id: string; name: string; key: string }>('/admin/api/keys', { name: name.trim() || 'my-agent' });
      setCreated(r);
      await refreshTopology();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };
  const toggleDemo = async () => {
    if (status?.demo && !confirm('Stop the demo fleet and remove all demo data (agents, models, tool servers, gates and their traffic)? Your own setup is not touched.')) return;
    setDemoBusy(true);
    setDemoError(null);
    try {
      await setDemo(!status?.demo);
    } catch (err) {
      setDemoError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setDemoBusy(false);
    }
  };

  return (
    <div className="page welcome">
      <PageHeader title="Get started" description="Three steps from an empty install to your own agent on the map — about five minutes, and no code changes for most agents." />

      <div className="welcome-grid">
        <ol className="welcome-steps">
          <li className={step1 ? 'done' : 'current'}>
            <div className="ws-head">
              <span className="ws-dot">{step1 ? <Icon name="check" size={12} /> : '1'}</span>
              <h2>Connect a model provider</h2>
              {step1 && <span className="ws-done">{providers.map((p) => p.name).join(', ')}</span>}
            </div>
            <p>Paste the API key your agents use today; it is stored encrypted. Models are added automatically the first time an agent asks for one.</p>
            <div className="starter-grid">
              {STARTERS.map((s) => (
                <button key={s.id} type="button" className="starter" onClick={() => setRoute('providers', s.id)}>
                  <Monogram name={s.name} kind={s.kind} size={26} />
                  <span>{s.name}</span>
                </button>
              ))}
            </div>
            <div className="ws-more">
              <a href="#/providers">All providers</a> · <a href="#/models">Import a LiteLLM config</a>
            </div>
          </li>

          <li className={step2 ? 'done' : step1 ? 'current' : ''}>
            <div className="ws-head">
              <span className="ws-dot">{step2 && !created ? <Icon name="check" size={12} /> : '2'}</span>
              <h2>Create a key for your agent and point it here</h2>
              {step2 && !created && <span className="ws-done">{agents.length} agent{agents.length === 1 ? '' : 's'}</span>}
            </div>
            <p>One key per agent: it names the agent on the map and in the ledger. Then set two environment variables where the agent runs.</p>
            {!created ? (
              <form className="ws-form" onSubmit={createKey}>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Agent name" placeholder="my-agent" />
                <button className="btn primary" type="submit">
                  Create key
                </button>
                {error && <span className="error">{error}</span>}
              </form>
            ) : (
              <>
                <div className="keybox">{created.key}</div>
                <p className="hint" style={{ margin: '6px 0 12px' }}>
                  Shown once — copy it now. Snippets below already contain it.
                </p>
                <ConnectAgent keyId={created.id} secret={created.key} />
              </>
            )}
          </li>

          <li className={step3 ? 'done' : step2 ? 'current' : ''}>
            <div className="ws-head">
              <span className="ws-dot">{step3 ? <Icon name="check" size={12} /> : '3'}</span>
              <h2>See it on the map, then put a gate on it</h2>
              {liveAgent && <span className="ws-done">{liveAgent.name} is talking</span>}
            </div>
            <p>Every call your agent makes becomes a flight on the Airspace. Click any line or tool to block it, hold it for approval, or inspect it.</p>
            <button type="button" className="btn" onClick={() => setRoute('airspace')}>
              <Icon name="map" size={15} /> Open the Airspace
            </button>
          </li>
        </ol>

        <aside className="card welcome-demo">
          <b>{status?.demo ? 'A demo fleet is flying' : 'Just looking around?'}</b>
          <p>
            {status?.demo
              ? 'Six synthetic agents are calling stand-in models, tool servers and an API so every feature has something to show. Nothing leaves this machine.'
              : 'Fill the map with a synthetic fleet — stand-in models, tool servers, gates and approvals — without connecting anything. Nothing leaves this machine.'}
          </p>
          <button type="button" className={`btn ${status?.demo ? '' : 'primary'}`} onClick={() => void toggleDemo()} disabled={demoBusy}>
            {demoBusy ? 'Working…' : status?.demo ? 'Stop demo and clear it' : 'Start the demo fleet'}
          </button>
          {demoError && <p className="error">{demoError}</p>}
        </aside>
      </div>
    </div>
  );
}
