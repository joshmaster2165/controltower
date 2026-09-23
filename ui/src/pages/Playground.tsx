import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUsd } from '@controltower/shared';
import { getCsrf } from '../api';
import { useStore } from '../store';
import { PageHeader } from '../components/PageHeader';
import { CodeBlock } from '../components/CodeBlock';
import { Icon } from '../components/Icon';

interface Result {
  text: string;
  flightId: string | null;
  status: number | null;
  ttftMs: number | null;
  totalMs: number | null;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
  error: string | null;
}

export function PlaygroundPage() {
  const topology = useStore((s) => s.topology);
  const models = useMemo(() => {
    if (!topology) return [] as string[];
    const names = new Set<string>();
    for (const a of topology.aliases) names.add(a.name);
    for (const d of topology.deployments) if (d.enabled && d.public_name) names.add(d.public_name);
    return [...names].sort();
  }, [topology]);

  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('Give me three creative names for an AI agent control plane, one line each.');
  const [stream, setStream] = useState(true);
  const [maxTokens, setMaxTokens] = useState(300);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!model && models[0]) setModel(models[0]);
  }, [models, model]);

  const send = async () => {
    setBusy(true);
    const t0 = performance.now();
    const res: Result = { text: '', flightId: null, status: null, ttftMs: null, totalMs: null, usage: null, error: null };
    setResult({ ...res });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const r = await fetch('/admin/api/playground/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ct-csrf': getCsrf() ?? '' },
        credentials: 'same-origin',
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          stream,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
          ...(stream ? { stream_options: { include_usage: true } } : {}),
        }),
      });
      res.status = r.status;
      res.flightId = r.headers.get('x-ct-flight-id');
      if (!r.ok || !stream || !r.headers.get('content-type')?.includes('text/event-stream')) {
        const j = (await r.json()) as { error?: { message?: string }; choices?: Array<{ message?: { content?: string } }>; usage?: Result['usage'] };
        if (j.error) res.error = j.error.message ?? 'error';
        res.text = j.choices?.[0]?.message?.content ?? '';
        res.usage = j.usage ?? null;
        res.ttftMs = Math.round(performance.now() - t0);
        res.totalMs = res.ttftMs;
        setResult({ ...res });
        return;
      }
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const j = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }>; usage?: Result['usage']; error?: { message?: string } };
              if (j.error) res.error = j.error.message ?? 'error';
              const delta = j.choices?.[0]?.delta?.content;
              if (delta) {
                if (res.ttftMs == null) res.ttftMs = Math.round(performance.now() - t0);
                res.text += delta;
              }
              if (j.usage) res.usage = j.usage;
            } catch {
              /* ignore */
            }
          }
          setResult({ ...res });
        }
      }
      res.totalMs = Math.round(performance.now() - t0);
      setResult({ ...res });
    } catch (err) {
      res.error = (err as Error).message;
      setResult({ ...res });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const origin = location.origin;
  const curl = `curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ct_sk_..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"hello"}]}'`;
  const py = `from openai import OpenAI
client = OpenAI(base_url="${origin}/v1", api_key="ct_sk_...")
r = client.chat.completions.create(model="${model}", messages=[{"role": "user", "content": "hello"}])
print(r.choices[0].message.content)`;
  const ts = `import OpenAI from "openai";
const client = new OpenAI({ baseURL: "${origin}/v1", apiKey: "ct_sk_..." });
const r = await client.chat.completions.create({ model: "${model}", messages: [{ role: "user", content: "hello" }] });`;

  return (
    <div className="page">
      <PageHeader
        title="Playground"
        description={
          <>
            Send a request through the real pipeline — gates, budgets and all. It shows up on the Airspace as the <code>playground</code> agent.
          </>
        }
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
        <div className="card">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 12 }}>
            <div className="field">
              <label>Model</label>
              <select className="input mono" value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Max tokens</label>
              <input className="input" type="number" min={1} value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} />
            </div>
          </div>
          <div className="field">
            <label>Message</label>
            <textarea className="input" rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: 'var(--text-dim)' }}>
              <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} /> stream
            </label>
            <div style={{ flex: 1 }} />
            {busy && (
              <button className="btn ghost" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            )}
            <button className="btn primary" onClick={() => void send()} disabled={busy || !model}>
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
        <div className="card" style={{ minHeight: 260, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', gap: 14, fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 10, flexWrap: 'wrap' }}>
            <span>
              status <b style={{ color: 'var(--text)' }}>{result?.status ?? '—'}</b>
            </span>
            <span>
              TTFT <b style={{ color: 'var(--text)' }}>{result?.ttftMs != null ? `${result.ttftMs} ms` : '—'}</b>
            </span>
            <span>
              total <b style={{ color: 'var(--text)' }}>{result?.totalMs != null ? `${result.totalMs} ms` : '—'}</b>
            </span>
            <span>
              tokens{' '}
              <b style={{ color: 'var(--text)' }}>
                {result?.usage ? `${result.usage.prompt_tokens ?? '?'} → ${result.usage.completion_tokens ?? '?'}` : '—'}
              </b>
            </span>
            {result?.flightId && (
              <span className="mono" style={{ color: 'var(--text-faint)' }}>
                flight …{result.flightId.slice(-8)}
              </span>
            )}
          </div>
          {result?.error && <div className="error" style={{ marginBottom: 8 }}>{result.error}</div>}
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'var(--font)', fontSize: 14, flex: 1 }}>{result?.text || <span style={{ color: 'var(--text-faint)' }}>Response will appear here.</span>}</pre>
        </div>
      </div>
      <div className="section-title">
        <h2>Use it from code</h2>
        <span className="count">point any OpenAI SDK at this gateway with an agent key</span>
      </div>
      <div className="grid cols-3">
        <CodeBlock title="curl" code={curl} />
        <CodeBlock title="Python" code={py} />
        <CodeBlock title="TypeScript" code={ts} />
      </div>
      <div className="hint" style={{ marginTop: 10 }}>The playground uses a system key that only works from inside the console; create an agent key on the Keys page for your own code.</div>
      <div style={{ display: 'none' }}>{formatUsd(0)}</div>
    </div>
  );
}
