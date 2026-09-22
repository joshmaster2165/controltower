/**
 * Anthropic Messages ⇄ OpenAI Chat Completions.
 *
 * Used when an Anthropic-dialect client (Claude Code, the Anthropic SDK)
 * calls a deployment on an OpenAI-wire provider. Requests are converted
 * forward; JSON responses and SSE streams are synthesised back into the
 * Anthropic event format (message_start → content_block_* → message_delta →
 * message_stop).
 */

type Json = Record<string, unknown>;

interface AnMessage {
  role: 'user' | 'assistant';
  content: string | Array<Json>;
}

function blockText(b: Json): string {
  return typeof b.text === 'string' ? b.text : '';
}

/** Anthropic messages request → OpenAI chat request. */
export function anRequestToOa(body: Json): Json {
  const out: Json = { model: body.model, stream: body.stream === true };
  const messages: Json[] = [];
  const sys = body.system;
  if (typeof sys === 'string' && sys) messages.push({ role: 'system', content: sys });
  else if (Array.isArray(sys)) messages.push({ role: 'system', content: (sys as Json[]).map(blockText).join('\n') });

  for (const m of (body.messages as AnMessage[] | undefined) ?? []) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'user') {
      const parts: Json[] = [];
      const toolResults: Json[] = [];
      for (const b of m.content) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') {
          const src = b.source as { type: string; media_type?: string; data?: string; url?: string };
          const url = src.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : src.url;
          parts.push({ type: 'image_url', image_url: { url } });
        } else if (b.type === 'tool_result') {
          const c = b.content;
          const text = typeof c === 'string' ? c : Array.isArray(c) ? (c as Json[]).map(blockText).join('\n') : '';
          toolResults.push({ role: 'tool', tool_call_id: b.tool_use_id, content: text });
        }
      }
      // Tool results must directly follow the assistant tool_calls message.
      messages.push(...toolResults);
      if (parts.length) messages.push({ role: 'user', content: parts.length === 1 && parts[0]!.type === 'text' ? parts[0]!.text : parts });
    } else {
      let text = '';
      const toolCalls: Json[] = [];
      for (const b of m.content) {
        if (b.type === 'text') text += b.text as string;
        else if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
      }
      const am: Json = { role: 'assistant', content: text || null };
      if (toolCalls.length) am.tool_calls = toolCalls;
      messages.push(am);
    }
  }
  out.messages = messages;
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences)) out.stop = body.stop_sequences;
  if (body.stream === true) out.stream_options = { include_usage: true };
  const tools = (body.tools as Array<{ name: string; description?: string; input_schema?: Json }> | undefined) ?? [];
  if (tools.length) {
    out.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } } }));
    const tc = body.tool_choice as { type?: string; name?: string } | undefined;
    if (tc?.type === 'any') out.tool_choice = 'required';
    else if (tc?.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc?.type === 'none') delete out.tools;
  }
  const md = body.metadata as { user_id?: string } | undefined;
  if (md?.user_id) out.user = md.user_id;
  return out;
}

function finishToStop(r: string | null | undefined): string {
  switch (r) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

function oaUsageToAn(u: Json | undefined): Json {
  const prompt = (u?.prompt_tokens as number) ?? 0;
  const cached = ((u?.prompt_tokens_details as Json | undefined)?.cached_tokens as number) ?? 0;
  return {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: (u?.completion_tokens as number) ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

/** OpenAI chat completion → Anthropic message. */
export function oaResponseToAnthropic(res: Json, requestedModel: string): Json {
  const choice = ((res.choices as Json[] | undefined) ?? [])[0] ?? {};
  const msg = (choice.message as Json | undefined) ?? {};
  const content: Json[] = [];
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of (msg.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }> | undefined) ?? []) {
    let input: unknown = {};
    try {
      input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      input = { _raw: tc.function.arguments };
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  return {
    id: (res.id as string) ?? 'msg_ct',
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: finishToStop(choice.finish_reason as string),
    stop_sequence: null,
    usage: oaUsageToAn(res.usage as Json | undefined),
  };
}

/**
 * Stateful OpenAI chunk → Anthropic SSE translator. Feed parsed OpenAI
 * chunks; get back Anthropic `event:`/`data:` frames.
 */
export class OaToAnthropicStream {
  private started = false;
  private id = 'msg_ct';
  private blockIndex = -1;
  private textOpen = false;
  private toolBlocks = new Map<number, number>(); // oa tool index → an block index
  private outputTokens = 0;
  private usage: Json | undefined;
  private stopReason: string | undefined;
  private inputEstimate: number;

  constructor(
    private readonly model: string,
    inputEstimate: number,
  ) {
    this.inputEstimate = inputEstimate;
  }

  private frame(type: string, payload: Json): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  }

  private ensureStart(frames: string[], id?: string): void {
    if (this.started) return;
    this.started = true;
    if (id) this.id = id;
    frames.push(
      this.frame('message_start', {
        message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: this.inputEstimate, output_tokens: 0 } },
      }),
    );
  }

  private closeBlock(frames: string[]): void {
    if (this.blockIndex >= 0 && (this.textOpen || this.toolBlocks.size)) {
      frames.push(this.frame('content_block_stop', { index: this.blockIndex }));
    }
    this.textOpen = false;
  }

  feed(chunk: Json): { frames: string[]; hasContent: boolean } {
    const frames: string[] = [];
    let hasContent = false;
    this.ensureStart(frames, chunk.id as string | undefined);
    if (chunk.usage) this.usage = chunk.usage as Json;
    const choice = ((chunk.choices as Json[] | undefined) ?? [])[0];
    if (!choice) return { frames, hasContent };
    const delta = (choice.delta as Json | undefined) ?? {};

    if (typeof delta.content === 'string' && delta.content) {
      if (!this.textOpen) {
        this.closeBlock(frames);
        this.blockIndex++;
        this.textOpen = true;
        frames.push(this.frame('content_block_start', { index: this.blockIndex, content_block: { type: 'text', text: '' } }));
      }
      frames.push(this.frame('content_block_delta', { index: this.blockIndex, delta: { type: 'text_delta', text: delta.content } }));
      this.outputTokens += Math.max(1, Math.round((delta.content as string).length / 4));
      hasContent = true;
    }
    for (const tc of (delta.tool_calls as Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined) ?? []) {
      let bi = this.toolBlocks.get(tc.index);
      if (bi == null) {
        this.closeBlock(frames);
        this.blockIndex++;
        bi = this.blockIndex;
        this.toolBlocks.set(tc.index, bi);
        frames.push(this.frame('content_block_start', { index: bi, content_block: { type: 'tool_use', id: tc.id ?? `toolu_${tc.index}`, name: tc.function?.name ?? '', input: {} } }));
      }
      if (tc.function?.arguments) {
        frames.push(this.frame('content_block_delta', { index: bi, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } }));
        hasContent = true;
      }
    }
    if (choice.finish_reason) this.stopReason = finishToStop(choice.finish_reason as string);
    return { frames, hasContent };
  }

  /** Call once the upstream stream is done. */
  finish(): string[] {
    const frames: string[] = [];
    this.ensureStart(frames);
    if (this.blockIndex >= 0) frames.push(this.frame('content_block_stop', { index: this.blockIndex }));
    const u = this.usage ? oaUsageToAn(this.usage) : { output_tokens: this.outputTokens };
    frames.push(this.frame('message_delta', { delta: { stop_reason: this.stopReason ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: u.output_tokens, ...(this.usage ? { input_tokens: u.input_tokens, cache_read_input_tokens: u.cache_read_input_tokens } : {}) } }));
    frames.push(this.frame('message_stop', {}));
    return frames;
  }
}
