/**
 * OpenAI Chat Completions ⇄ Google Gemini generateContent.
 * Used by the Gemini and Vertex adapters, which are OpenAI-native from the
 * pipeline's point of view: requests arrive in OpenAI shape and the adapter
 * emits OpenAI-shaped SSE chunks synthesised from Gemini's stream.
 */

type Json = Record<string, unknown>;

interface OaMessage {
  role: string;
  content?: string | Json[] | null;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function safeJson(s: string): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

/** Gemini rejects several JSON-Schema keywords; strip them recursively. */
export function sanitizeSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(sanitizeSchema);
  if (!s || typeof s !== 'object') return s;
  const out: Json = {};
  for (const [k, v] of Object.entries(s as Json)) {
    if (['$schema', 'additionalProperties', '$id', 'strict', 'examples', 'default'].includes(k)) continue;
    out[k] = sanitizeSchema(v);
  }
  return out;
}

function partsFromContent(content: OaMessage['content']): Json[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  const parts: Json[] = [];
  for (const p of content) {
    if (p.type === 'text' && typeof p.text === 'string') parts.push({ text: p.text });
    else if (p.type === 'image_url') {
      const url = (p.image_url as { url?: string } | undefined)?.url ?? '';
      const m = /^data:([^;]+);base64,(.+)$/.exec(url);
      if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
      else parts.push({ fileData: { fileUri: url } });
    }
  }
  return parts;
}

export function oaRequestToGemini(body: Json): { request: Json; stream: boolean } {
  const msgs = (body.messages as OaMessage[] | undefined) ?? [];
  const system: string[] = [];
  const contents: Array<{ role: 'user' | 'model'; parts: Json[] }> = [];
  const toolNameById = new Map<string, string>();
  const push = (role: 'user' | 'model', parts: Json[]) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of msgs) {
    if (m.role === 'system' || m.role === 'developer') {
      if (typeof m.content === 'string') system.push(m.content);
      else if (Array.isArray(m.content)) system.push(m.content.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n'));
    } else if (m.role === 'user') push('user', partsFromContent(m.content));
    else if (m.role === 'assistant') {
      const parts = partsFromContent(m.content);
      for (const tc of m.tool_calls ?? []) {
        toolNameById.set(tc.id, tc.function.name);
        parts.push({ functionCall: { name: tc.function.name, args: safeJson(tc.function.arguments) } });
      }
      push('model', parts);
    } else if (m.role === 'tool') {
      const name = toolNameById.get(m.tool_call_id ?? '') ?? 'tool';
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      push('user', [{ functionResponse: { name, response: { result: safeJsonOrText(text) } } }]);
    }
  }
  if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: '(continue)' }] });

  const gen: Json = { candidateCount: 1 };
  const maxOut = typeof body.max_tokens === 'number' ? body.max_tokens : typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined;
  if (maxOut) gen.maxOutputTokens = maxOut;
  if (typeof body.temperature === 'number') gen.temperature = body.temperature;
  if (typeof body.top_p === 'number') gen.topP = body.top_p;
  if (typeof body.stop === 'string') gen.stopSequences = [body.stop];
  else if (Array.isArray(body.stop)) gen.stopSequences = body.stop;
  const rf = body.response_format as { type?: string } | undefined;
  if (rf?.type === 'json_object' || rf?.type === 'json_schema') gen.responseMimeType = 'application/json';

  const request: Json = { contents, generationConfig: gen };
  if (system.length) request.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  const tools = (body.tools as Array<{ function?: { name: string; description?: string; parameters?: Json } }> | undefined) ?? [];
  const decls = tools.filter((t) => t.function).map((t) => ({ name: t.function!.name, description: t.function!.description ?? '', parameters: sanitizeSchema(t.function!.parameters ?? { type: 'object', properties: {} }) }));
  const tc = body.tool_choice;
  if (decls.length && tc !== 'none') {
    request.tools = [{ functionDeclarations: decls }];
    if (tc === 'required') request.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    else if (tc && typeof tc === 'object' && (tc as { function?: { name?: string } }).function?.name) {
      request.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [(tc as { function: { name: string } }).function.name] } };
    }
  }
  return { request, stream: body.stream === true };
}

function safeJsonOrText(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function finishReason(r: string | undefined, hadToolCall: boolean): string {
  if (hadToolCall) return 'tool_calls';
  switch (r) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export function geminiUsageToOa(u: Json | undefined): Json | undefined {
  if (!u) return undefined;
  const prompt = (u.promptTokenCount as number) ?? 0;
  const out = (u.candidatesTokenCount as number) ?? 0;
  const cached = (u.cachedContentTokenCount as number) ?? 0;
  const thoughts = (u.thoughtsTokenCount as number) ?? 0;
  const res: Json = {
    prompt_tokens: prompt,
    completion_tokens: out + thoughts,
    total_tokens: prompt + out + thoughts,
    prompt_tokens_details: { cached_tokens: cached },
  };
  if (thoughts) res.completion_tokens_details = { reasoning_tokens: thoughts };
  return res;
}

let callSeq = 0;

export function geminiResponseToOa(res: Json, model: string): Json {
  const cand = ((res.candidates as Json[] | undefined) ?? [])[0];
  const parts = ((cand?.content as Json | undefined)?.parts as Json[] | undefined) ?? [];
  let text = '';
  const toolCalls: Json[] = [];
  for (const p of parts) {
    if (typeof p.text === 'string' && !p.thought) text += p.text;
    if (p.functionCall) {
      const fc = p.functionCall as { name: string; args?: unknown };
      toolCalls.push({ id: `call_${Date.now().toString(36)}${(callSeq++).toString(36)}`, type: 'function', function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) } });
    }
  }
  const message: Json = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: `chatcmpl-${(res.responseId as string) ?? Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason(cand?.finishReason as string | undefined, toolCalls.length > 0) }],
    usage: geminiUsageToOa(res.usageMetadata as Json | undefined),
  };
}

/** Stateful Gemini SSE chunk → OpenAI chunk translator. */
export class GeminiToOaStream {
  private id = `chatcmpl-${Date.now().toString(36)}`;
  private created = Math.floor(Date.now() / 1000);
  private sentRole = false;
  private toolIndex = 0;
  private sawToolCall = false;
  private finish: string | undefined;
  usage: Json | undefined;

  constructor(
    private readonly model: string,
    private readonly includeUsage: boolean,
  ) {}

  private chunk(delta: Json, finish: string | null = null): { text: string; parsed: Json } {
    const parsed = { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish }] };
    return { text: `data: ${JSON.stringify(parsed)}\n\n`, parsed };
  }

  feed(ev: Json): { frames: Array<{ text: string; parsed: Json; usageOnly?: boolean }>; hasContent: boolean } {
    const frames: Array<{ text: string; parsed: Json; usageOnly?: boolean }> = [];
    let hasContent = false;
    if (ev.responseId && !this.sentRole) this.id = `chatcmpl-${ev.responseId as string}`;
    if (!this.sentRole) {
      frames.push(this.chunk({ role: 'assistant', content: '' }));
      this.sentRole = true;
    }
    const cand = ((ev.candidates as Json[] | undefined) ?? [])[0];
    const parts = ((cand?.content as Json | undefined)?.parts as Json[] | undefined) ?? [];
    for (const p of parts) {
      if (typeof p.text === 'string' && p.text) {
        if (p.thought) frames.push(this.chunk({ reasoning_content: p.text }));
        else {
          frames.push(this.chunk({ content: p.text }));
          hasContent = true;
        }
      }
      if (p.functionCall) {
        const fc = p.functionCall as { name: string; args?: unknown };
        const idx = this.toolIndex++;
        this.sawToolCall = true;
        frames.push(this.chunk({ tool_calls: [{ index: idx, id: `call_${this.created.toString(36)}${idx}`, type: 'function', function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) } }] }));
        hasContent = true;
      }
    }
    if (cand?.finishReason) this.finish = finishReason(cand.finishReason as string, this.sawToolCall);
    const u = geminiUsageToOa(ev.usageMetadata as Json | undefined);
    if (u) this.usage = u;
    return { frames, hasContent };
  }

  finishFrames(): Array<{ text: string; parsed: Json; usageOnly?: boolean }> {
    const frames: Array<{ text: string; parsed: Json; usageOnly?: boolean }> = [];
    if (!this.sentRole) {
      frames.push(this.chunk({ role: 'assistant', content: '' }));
      this.sentRole = true;
    }
    frames.push(this.chunk({}, this.finish ?? 'stop'));
    if (this.includeUsage) {
      const parsed = { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [], usage: this.usage ?? null };
      frames.push({ text: `data: ${JSON.stringify(parsed)}\n\n`, parsed, usageOnly: true });
    }
    frames.push({ text: 'data: [DONE]\n\n', parsed: {} });
    return frames;
  }
}
