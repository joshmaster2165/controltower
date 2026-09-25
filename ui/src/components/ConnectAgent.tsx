import { useEffect, useState } from 'react';
import { api, type KeyRow } from '../api';
import { useStore } from '../store';
import { CodeBlock } from './CodeBlock';
import { ago } from '../format';

type Tab = 'openai' | 'anthropic' | 'desktop' | 'codex' | 'mcp' | 'curl' | 'http';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'openai', label: 'OpenAI SDKs' },
  { id: 'anthropic', label: 'Claude Code · Anthropic' },
  { id: 'desktop', label: 'Claude Desktop' },
  { id: 'codex', label: 'Codex' },
  { id: 'mcp', label: 'MCP clients' },
  { id: 'http', label: 'REST APIs' },
  { id: 'curl', label: 'Test with curl' },
];

/**
 * How to point one agent at Control Tower — copy-paste, with its key filled
 * in — and a live check that turns green on the agent's first request.
 */
export function ConnectAgent({ keyId, secret }: { keyId: string; secret: string }) {
  const [tab, setTab] = useState<Tab>('openai');
  const [firstUse, setFirstUse] = useState<number | null>(null);
  const topology = useStore((s) => s.topology);
  const setRoute = useStore((s) => s.setRoute);
  const origin = location.origin;
  const model =
    topology?.deployments.find((d) => !d.demo && d.enabled)?.public_name ?? topology?.deployments.find((d) => d.enabled)?.public_name ?? 'gpt-4.1-mini';
  // Codex speaks the Responses API; any model works (non-OpenAI ones are translated).
  const codexModel = topology?.deployments.find((d) => d.enabled && /^(gpt|o\d)/.test(d.public_name ?? d.upstream_model))?.public_name ?? 'gpt-5';

  // Watch for the first request made with this key.
  useEffect(() => {
    if (firstUse) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await api.get<{ keys: KeyRow[] }>('/admin/api/keys');
        const k = r.keys.find((x) => x.id === keyId);
        if (!stop && k?.last_used_at) setFirstUse(k.last_used_at);
      } catch {
        // keep waiting
      }
    };
    const t = setInterval(() => void tick(), 2000);
    void tick();
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [keyId, firstUse]);

  return (
    <div className="connect-agent">
      <div className="seg">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'openai' && (
        <>
          <p className="connect-note">No code changes: the official OpenAI SDKs for Python and Node read these variables, as do most frameworks built on them — including the OpenAI Agents SDK and Codex, whose Responses API calls go through too. Set them where the agent runs.</p>
          <CodeBlock
            title="Environment"
            code={`export OPENAI_BASE_URL=${origin}/v1
export OPENAI_API_KEY=${secret}`}
          />
          <CodeBlock
            title="…or in code (Python)"
            code={`from openai import OpenAI
client = OpenAI(base_url="${origin}/v1", api_key="${secret}")`}
          />
        </>
      )}
      {tab === 'anthropic' && (
        <>
          <p className="connect-note">Claude Code and the Anthropic SDKs read these variables. Model names stay as they are — Claude models are added the first time they are used.</p>
          <CodeBlock
            title="Claude Code"
            code={`export ANTHROPIC_BASE_URL=${origin}
export ANTHROPIC_AUTH_TOKEN=${secret}
claude`}
          />
          <CodeBlock
            title="Anthropic SDKs (Python, TypeScript)"
            code={`export ANTHROPIC_BASE_URL=${origin}
export ANTHROPIC_API_KEY=${secret}`}
          />
        </>
      )}
      {tab === 'desktop' && (
        <>
          <p className="connect-note">
            In Claude Desktop, turn on <b>Help → Troubleshooting → Enable Developer Mode</b>, then open <b>Developer → Configure Third-Party Inference…</b> and enter these. The model picker shows the Claude models this key may use.
          </p>
          <CodeBlock
            title="Connection"
            code={`Inference provider   Gateway
Gateway base URL     ${origin}
Gateway API key      ${secret}
Gateway auth scheme  bearer`}
          />
          <CodeBlock
            title="Connectors → add (Streamable HTTP)"
            code={`Name     controltower
URL      ${origin}/mcp
Header   Authorization: Bearer ${secret}`}
          />
        </>
      )}
      {tab === 'codex' && (
        <>
          <p className="connect-note">For the Codex CLI and Codex in the ChatGPT desktop app — both read this file. Any model works: Claude and Gemini models are translated to the Responses API Codex speaks.</p>
          <CodeBlock
            title="~/.codex/config.toml"
            code={`model = "${codexModel}"
model_provider = "controltower"

[model_providers.controltower]
name = "Control Tower"
base_url = "${origin}/v1"
env_key = "CONTROLTOWER_API_KEY"
wire_api = "responses"

[mcp_servers.controltower]
url = "${origin}/mcp"
bearer_token_env_var = "CONTROLTOWER_API_KEY"`}
          />
          <CodeBlock title="~/.codex/.env (or export it in your shell)" code={`CONTROLTOWER_API_KEY=${secret}`} />
        </>
      )}
      {tab === 'mcp' && (
        <>
          <p className="connect-note">One endpoint for every registered tool server. Tools this key may not use are simply not listed.</p>
          <CodeBlock
            title="Claude Code"
            code={`claude mcp add --transport http controltower ${origin}/mcp \\
  --header "Authorization: Bearer ${secret}"`}
          />
          <CodeBlock
            title="Cursor / Claude Desktop — mcp.json"
            code={`{
  "mcpServers": {
    "controltower": {
      "url": "${origin}/mcp",
      "headers": { "Authorization": "Bearer ${secret}" }
    }
  }
}`}
          />
        </>
      )}
      {tab === 'http' && (
        <>
          <p className="connect-note">
            For plain REST APIs registered under <b>HTTP APIs</b>: swap the API's host for <code>{origin}/http/&lt;name&gt;</code> and send this key instead of the API's own credentials.
          </p>
          <CodeBlock
            title="curl"
            code={`curl ${origin}/http/<name>/<path> \\
  -H "x-ct-key: ${secret}"`}
          />
        </>
      )}
      {tab === 'curl' && (
        <>
          <p className="connect-note">Send one request now to see the agent appear on the map.</p>
          <CodeBlock
            title="curl"
            code={`curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ${secret}" \\
  -H "content-type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"Hello from my agent"}]}'`}
          />
        </>
      )}

      <div className={`connect-status ${firstUse ? 'ok' : ''}`} role="status">
        <i />
        {firstUse ? (
          <>
            <b>Connected.</b> First request {ago(firstUse)}.
            <button type="button" className="btn sm" onClick={() => setRoute('airspace')}>
              See it on the map
            </button>
          </>
        ) : (
          <>Waiting for this agent's first request…</>
        )}
      </div>
    </div>
  );
}
