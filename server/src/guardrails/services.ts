import crypto from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { Hash } from '@smithy/hash-node';
import type { HttpRequest } from '@smithy/types';
import { readBodyText, sendUpstream } from '../providers/http.js';
import type { ProviderRecord } from '../registry.js';
import { buildHeaders, buildUrl } from '../providers/openai-compat.js';

/**
 * Guardrail services outside Control Tower, asked by inspect gates alongside the built-in detectors:
 *   presidio           Microsoft Presidio's analyzer: PII entities, with offsets (so they can be masked)
 *   lakera             Lakera Guard: prompt attacks, PII, moderated content
 *   bedrock            Amazon Bedrock Guardrails (ApplyGuardrail): the guardrail's own policies
 *   azure              Azure AI Content Safety: harm categories, and Prompt Shields for injection
 *   openai_moderation  OpenAI's moderation endpoint, through a connected OpenAI provider
 *   webhook            Any URL: it is sent the texts and answers allow, block or mask
 * A service is given the texts in what an agent sends or gets back (never keys or protocol fields) and
 * answers: clean, flagged (with what it found), or — where it can say exactly what — the texts masked.
 */
export const GUARDRAIL_KINDS = ['presidio', 'lakera', 'bedrock', 'azure', 'openai_moderation', 'webhook'] as const;
export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number];

export interface GuardrailConfig {
  // presidio
  analyzer_url?: string;
  language?: string;
  entities?: string[];
  score_threshold?: number;
  // lakera
  api_key?: string;
  url?: string;
  project_id?: string;
  // bedrock
  guardrail_id?: string;
  guardrail_version?: string;
  region?: string;
  access_key_id?: string;
  secret_access_key?: string;
  session_token?: string;
  endpoint?: string;
  // azure
  severity_threshold?: number;
  prompt_shields?: boolean;
  // openai_moderation
  provider?: string;
  model?: string;
  // webhook
  secret?: string;
  headers?: Record<string, string>;
}

export const GUARDRAIL_SECRET_FIELDS = ['api_key', 'secret_access_key', 'session_token', 'secret', 'headers'] as const;

export interface ServiceResult {
  verdict: 'clean' | 'flagged' | 'error';
  /** What was found, as counts: `presidio:EMAIL_ADDRESS`, `lakera:prompt_attack`, … */
  findings: Record<string, number>;
  /** The texts with what was found masked, one for each text given — when the service can say exactly what. */
  masked?: string[] | undefined;
  reason?: string | undefined;
}

export interface CheckContext {
  direction: 'input' | 'output';
  /** Who is calling and where to, for services that decide by it (webhooks). Never a key. */
  agent?: { name: string; agent_id?: string | undefined; team?: string | undefined } | undefined;
  target?: string | undefined;
  /** Providers by slug: OpenAI moderation goes through one Control Tower is connected to. */
  provider?: (slug: string) => ProviderRecord | undefined;
}

export function configProblem(kind: GuardrailKind, c: GuardrailConfig): string | undefined {
  const url = (u: string | undefined, what: string) => (!u || !/^https?:\/\//.test(u) ? `${what} must be an http(s) URL` : undefined);
  switch (kind) {
    case 'presidio':
      return url(c.analyzer_url, 'analyzer_url');
    case 'lakera':
      return !c.api_key ? 'api_key is required' : c.url ? url(c.url, 'url') : undefined;
    case 'bedrock':
      return !c.guardrail_id ? 'guardrail_id is required' : !c.access_key_id || !c.secret_access_key ? 'access_key_id and secret_access_key are required' : c.endpoint ? url(c.endpoint, 'endpoint') : undefined;
    case 'azure':
      return url(c.endpoint, 'endpoint') ?? (!c.api_key ? 'api_key is required' : undefined);
    case 'openai_moderation':
      return !c.provider && !c.api_key ? 'provider (a connected OpenAI provider) or api_key is required' : undefined;
    case 'webhook':
      return url(c.url, 'url');
  }
}

export function targetHint(kind: GuardrailKind, c: GuardrailConfig): string {
  const host = (u?: string) => {
    try {
      return u ? new URL(u).host : '';
    } catch {
      return '';
    }
  };
  switch (kind) {
    case 'presidio':
      return host(c.analyzer_url);
    case 'lakera':
      return host(c.url ?? 'https://api.lakera.ai');
    case 'bedrock':
      return `${c.guardrail_id}${c.guardrail_version ? ` v${c.guardrail_version}` : ''} · ${c.region ?? 'us-east-1'}`;
    case 'azure':
      return host(c.endpoint);
    case 'openai_moderation':
      return c.provider ? `via ${c.provider}` : 'api.openai.com';
    case 'webhook':
      return host(c.url);
  }
}

const TIMEOUT_MS = 10_000;

async function call(url: string, method: 'POST' | 'GET', headers: Record<string, string>, body: string | undefined): Promise<{ status: number; json: any; text: string }> {
  const r = await sendUpstream('guardrail', { url, method, headers, ...(body !== undefined ? { body } : {}) }, AbortSignal.timeout(TIMEOUT_MS), { headersTimeoutMs: TIMEOUT_MS });
  if (!r.ok) throw new Error(r.err.message);
  const text = await readBodyText(r.res.body, 4 * 1024 * 1024);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (r.res.status < 200 || r.res.status >= 300) throw new Error(`HTTP ${r.res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  return { status: r.res.status, json, text };
}

const add = (f: Record<string, number>, k: string, n = 1) => (f[k] = (f[k] ?? 0) + n);

/** Ask a service about the texts. Failures come back as verdict "error", never as a throw. */
export async function checkService(kind: GuardrailKind, c: GuardrailConfig, texts: string[], ctx: CheckContext): Promise<ServiceResult> {
  try {
    const nonEmpty = texts.some((t) => t.trim());
    if (!nonEmpty) return { verdict: 'clean', findings: {} };
    switch (kind) {
      case 'presidio':
        return await presidio(c, texts);
      case 'lakera':
        return await lakera(c, texts, ctx);
      case 'bedrock':
        return await bedrock(c, texts, ctx);
      case 'azure':
        return await azure(c, texts, ctx.direction);
      case 'openai_moderation':
        return await openaiModeration(c, texts, ctx);
      case 'webhook':
        return await webhook(c, texts, ctx);
    }
  } catch (err) {
    return { verdict: 'error', findings: {}, reason: (err as Error).message.slice(0, 300) };
  }
}

/** Presidio: one analysis per text; entities come back with offsets, so they can be masked exactly. */
async function presidio(c: GuardrailConfig, texts: string[]): Promise<ServiceResult> {
  const findings: Record<string, number> = {};
  const masked: string[] = [];
  const base = c.analyzer_url!.replace(/\/+$/, '');
  for (const text of texts) {
    if (!text.trim()) {
      masked.push(text);
      continue;
    }
    const r = await call(`${base}/analyze`, 'POST', { 'content-type': 'application/json' }, JSON.stringify({ text, language: c.language ?? 'en', ...(c.entities?.length ? { entities: c.entities } : {}), ...(c.score_threshold != null ? { score_threshold: c.score_threshold } : {}) }));
    const ents = (Array.isArray(r.json) ? r.json : []) as Array<{ entity_type: string; start: number; end: number; score: number }>;
    // Overlapping entities: keep the widest, from the end so offsets stay valid.
    const spans = ents.filter((e) => e.end > e.start).sort((a, b) => a.start - b.start || b.end - a.end);
    const kept: typeof spans = [];
    for (const s of spans) if (!kept.length || s.start >= kept.at(-1)!.end) kept.push(s);
    let out = text;
    for (const s of [...kept].reverse()) out = `${out.slice(0, s.start)}<${s.entity_type}>${out.slice(s.end)}`;
    for (const s of kept) add(findings, `presidio:${s.entity_type}`);
    masked.push(out);
  }
  return Object.keys(findings).length ? { verdict: 'flagged', findings, masked, reason: 'Presidio found personal data' } : { verdict: 'clean', findings };
}

async function lakera(c: GuardrailConfig, texts: string[], ctx: CheckContext): Promise<ServiceResult> {
  const role = ctx.direction === 'input' ? 'user' : 'assistant';
  const r = await call(c.url ?? 'https://api.lakera.ai/v2/guard', 'POST', { 'content-type': 'application/json', authorization: `Bearer ${c.api_key}` }, JSON.stringify({ messages: texts.filter((t) => t.trim()).map((content) => ({ role, content })), breakdown: true, ...(c.project_id ? { project_id: c.project_id } : {}) }));
  const j = r.json as { flagged?: boolean; breakdown?: Array<{ detector_type?: string; detected?: boolean }> };
  if (!j || typeof j.flagged !== 'boolean') throw new Error('Lakera answered without a verdict');
  if (!j.flagged) return { verdict: 'clean', findings: {} };
  const findings: Record<string, number> = {};
  for (const b of j.breakdown ?? []) if (b.detected && b.detector_type) add(findings, `lakera:${b.detector_type.replace(/^.*\//, '')}`);
  if (!Object.keys(findings).length) add(findings, 'lakera:flagged');
  return { verdict: 'flagged', findings, reason: 'Lakera Guard flagged it' };
}

/** Bedrock ApplyGuardrail, SigV4-signed. Masks exactly only when it was given one text and answers with one. */
async function bedrock(c: GuardrailConfig, texts: string[], ctx: CheckContext): Promise<ServiceResult> {
  const region = c.region || 'us-east-1';
  const base = (c.endpoint ?? `https://bedrock-runtime.${region}.amazonaws.com`).replace(/\/+$/, '');
  const u = new URL(`${base}/guardrail/${encodeURIComponent(c.guardrail_id!)}/version/${encodeURIComponent(c.guardrail_version ?? 'DRAFT')}/apply`);
  const body = JSON.stringify({ source: ctx.direction === 'input' ? 'INPUT' : 'OUTPUT', content: texts.map((text) => ({ text: { text } })) });
  const signer = new SignatureV4({ credentials: { accessKeyId: c.access_key_id!, secretAccessKey: c.secret_access_key!, ...(c.session_token ? { sessionToken: c.session_token } : {}) }, region, service: 'bedrock', sha256: Hash.bind(null, 'sha256') });
  const req: HttpRequest = { method: 'POST', protocol: u.protocol, hostname: u.hostname, ...(u.port ? { port: Number(u.port) } : {}), path: u.pathname, query: {}, headers: { host: u.host, 'content-type': 'application/json' }, body };
  const signed = await signer.sign(req);
  const r = await call(u.toString(), 'POST', signed.headers, body);
  const j = r.json as { action?: string; outputs?: Array<{ text?: string }>; assessments?: Array<Record<string, any>> };
  if (!j?.action) throw new Error('Bedrock answered without an action');
  if (j.action !== 'GUARDRAIL_INTERVENED') return { verdict: 'clean', findings: {} };
  const findings: Record<string, number> = {};
  for (const a of j.assessments ?? []) {
    for (const t of a.topicPolicy?.topics ?? []) add(findings, `bedrock:topic:${t.name}`);
    for (const f of a.contentPolicy?.filters ?? []) add(findings, `bedrock:${String(f.type).toLowerCase()}`);
    for (const w of [...(a.wordPolicy?.customWords ?? []), ...(a.wordPolicy?.managedWordLists ?? [])]) add(findings, `bedrock:word:${w.match ?? 'match'}`);
    for (const e of a.sensitiveInformationPolicy?.piiEntities ?? []) add(findings, `bedrock:${e.type}`);
    for (const e of a.sensitiveInformationPolicy?.regexes ?? []) add(findings, `bedrock:${e.name ?? 'regex'}`);
  }
  if (!Object.keys(findings).length) add(findings, 'bedrock:intervened');
  const masked = texts.length === 1 && j.outputs?.length === 1 && typeof j.outputs[0]!.text === 'string' ? [j.outputs[0]!.text] : undefined;
  return { verdict: 'flagged', findings, masked, reason: 'Bedrock Guardrails intervened' };
}

/** Azure AI Content Safety: harm categories at or above a severity, and (optionally) Prompt Shields. */
async function azure(c: GuardrailConfig, texts: string[], direction: 'input' | 'output'): Promise<ServiceResult> {
  const base = c.endpoint!.replace(/\/+$/, '');
  const h = { 'content-type': 'application/json', 'ocp-apim-subscription-key': c.api_key! };
  const threshold = c.severity_threshold ?? 4;
  const findings: Record<string, number> = {};
  for (const text of texts) {
    if (!text.trim()) continue;
    const r = await call(`${base}/contentsafety/text:analyze?api-version=2024-09-01`, 'POST', h, JSON.stringify({ text: text.slice(0, 10_000) }));
    for (const a of (r.json?.categoriesAnalysis ?? []) as Array<{ category: string; severity: number }>) if (a.severity >= threshold) add(findings, `azure:${a.category.toLowerCase()}`);
  }
  if (c.prompt_shields) {
    // What an agent sends is its prompt; what comes back (tool results, answers) is read as documents.
    const nonEmpty = texts.filter((t) => t.trim());
    const body = direction === 'input' ? { userPrompt: nonEmpty.join('\n').slice(0, 10_000), documents: [] } : { userPrompt: '', documents: nonEmpty.map((d) => d.slice(0, 10_000)) };
    const r = await call(`${base}/contentsafety/text:shieldPrompt?api-version=2024-09-01`, 'POST', h, JSON.stringify(body));
    if (r.json?.userPromptAnalysis?.attackDetected) add(findings, 'azure:prompt_attack');
    for (const d of (r.json?.documentsAnalysis ?? []) as Array<{ attackDetected?: boolean }>) if (d.attackDetected) add(findings, 'azure:document_attack');
  }
  return Object.keys(findings).length ? { verdict: 'flagged', findings, reason: 'Azure AI Content Safety flagged it' } : { verdict: 'clean', findings };
}

/** OpenAI moderation, through a connected OpenAI provider (its key) or a key of its own. */
async function openaiModeration(c: GuardrailConfig, texts: string[], ctx: CheckContext): Promise<ServiceResult> {
  const p = c.provider ? ctx.provider?.(c.provider) : undefined;
  if (c.provider && !p) throw new Error(`no connected provider "${c.provider}"`);
  const url = p ? buildUrl(p, 'moderations') : `${(c.url ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/moderations`;
  const headers = p ? buildHeaders(p) : { 'content-type': 'application/json', authorization: `Bearer ${c.api_key}` };
  const r = await call(url, 'POST', headers, JSON.stringify({ model: c.model ?? 'omni-moderation-latest', input: texts.filter((t) => t.trim()) }));
  const results = (r.json?.results ?? []) as Array<{ flagged?: boolean; categories?: Record<string, boolean> }>;
  if (!Array.isArray(r.json?.results)) throw new Error('the moderation endpoint answered without results');
  const findings: Record<string, number> = {};
  for (const x of results) if (x.flagged) for (const [cat, on] of Object.entries(x.categories ?? {})) if (on) add(findings, `openai:${cat}`);
  if (results.some((x) => x.flagged) && !Object.keys(findings).length) add(findings, 'openai:flagged');
  return Object.keys(findings).length ? { verdict: 'flagged', findings, reason: 'OpenAI moderation flagged it' } : { verdict: 'clean', findings };
}

/**
 * A guardrail of your own. It receives `{direction, texts, agent, target}` (signed with x-ct-signature when a
 * secret is set) and answers `{action: "allow" | "block" | "mask", reason?, findings?: {label: count}, texts?}`
 * — `texts` being the masked texts, one for each sent.
 */
async function webhook(c: GuardrailConfig, texts: string[], ctx: CheckContext): Promise<ServiceResult> {
  const body = JSON.stringify({ type: 'controltower.guardrail', direction: ctx.direction, texts, agent: ctx.agent, target: ctx.target });
  const h: Record<string, string> = { 'content-type': 'application/json', ...(c.headers ?? {}) };
  if (c.secret) {
    const ts = Math.floor(Date.now() / 1000);
    h['x-ct-signature'] = `t=${ts},v1=${crypto.createHmac('sha256', c.secret).update(`${ts}.${body}`).digest('hex')}`;
  }
  const r = await call(c.url!, 'POST', h, body);
  const j = r.json as { action?: string; reason?: string; findings?: Record<string, number>; texts?: unknown };
  if (!j || !['allow', 'block', 'mask'].includes(String(j.action))) throw new Error('the guardrail answered without an action (allow, block or mask)');
  if (j.action === 'allow') return { verdict: 'clean', findings: {} };
  const findings: Record<string, number> = {};
  for (const [k, n] of Object.entries(j.findings ?? {})) if (typeof n === 'number' && n > 0) findings[`webhook:${k.slice(0, 60)}`] = n;
  if (!Object.keys(findings).length) add(findings, 'webhook:flagged');
  const masked = j.action === 'mask' && Array.isArray(j.texts) && j.texts.length === texts.length && j.texts.every((t) => typeof t === 'string') ? (j.texts as string[]) : undefined;
  return { verdict: 'flagged', findings, masked, reason: j.reason ? String(j.reason).slice(0, 300) : 'The guardrail service flagged it' };
}
