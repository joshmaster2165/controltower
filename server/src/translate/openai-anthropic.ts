/**
 * OpenAI Chat Completions ⇄ Anthropic Messages.
 *
 * Used when an OpenAI-dialect client (any OpenAI SDK) calls a Claude
 * deployment. Requests are converted forward; responses and SSE streams are
 * converted back into OpenAI shape. Only the fields agents actually use are
 * mapped; unknown fields are dropped rather than guessed.
 */

type Json = Record<string, unknown>;

interface OaMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content?: string | Array<Json> | null;
  name?: string;
  tool_calls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface AnBlock {
  type: string;
  [k: string]: unknown;
}

function parseDataUrl(url: string): { media_type: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(url);
  return m ? { media_type: m[1]!, data: m[2]! } : null;
}

function oaContentToBlocks(content: OaMessage['content']): AnBlock[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const out: AnBlock[] = [];
  for (const part of content) {
    const t = part.type as string;
    if (t === 'text' && typeof part.text === 'string') out.push({ type: 'text', text: part.text });
    else if (t === 'image_url') {
      const url = (part.image_url as { url?: string } | undefined)?.url ?? '';
      const d = parseDataUrl(url);
      out.push(d ? { type: 'image', source: { type: 'base64', media_type: d.media_type, data: d.data } } : { type: 'image', source: { type: 'url', url } });
    } else if (t === 'input_text' && typeof part.text === 'string') out.push({ type: 'text', text: part.text });
  }
  return out;
}

function safeJson(s: string): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

/** OpenAI chat request → Anthropic messages request. */
export function oaRequestToAnthropic(body: Json): Json {
  const msgs = (body.messages as OaMessage[] | undefined) ?? [];
  const system: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: AnBlock[] }> = [];
  const push = (role: 'user' | 'assistant', blocks: AnBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const m of msgs) {
    switch (m.role) {
      case 'system':
      case 'developer':
        if (typeof m.content === 'string') system.push(m.content);
        else if (Array.isArray(m.content)) system.push(m.content.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n'));
        break;
      case 'user':
        push('user', oaContentToBlocks(m.content));
        break;
      case 'assistant': {
        const blocks = oaContentToBlocks(m.content);
        for (const tc of m.tool_calls ?? []) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) });
        }
        push('assistant', blocks);
        break;
      }
      case 'tool':
        push('user', [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id ?? '',
            content: typeof m.content === 'string' ? m.content : oaContentToBlocks(m.content),
          },
        ]);
        break;
    }
  }
  // Anthropic requires the conversation to start with a user turn.
  if (messages.length === 0 || messages[0]!.role !== 'user') messages.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });

  const out: Json = {
    model: body.model,
    messages,
    max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : 4096,
    stream: body.stream === true,
  };
  if (system.length) out.system = system.join('\n\n');
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (typeof body.stop === 'string') out.stop_sequences = [body.stop];
  else if (Array.isArray(body.stop)) out.stop_sequences = body.stop;
  if (body.user && typeof body.user === 'string') out.metadata = { user_id: body.user };

  const tools = (body.tools as Array<{ type?: string; function?: { name: string; description?: string; parameters?: Json } }> | undefined) ?? [];
  const anTools = tools
    .filter((t) => t.function)
    .map((t) => ({ name: t.function!.name, description: t.function!.description ?? '', input_schema: t.function!.parameters ?? { type: 'object', properties: {} } }));
  const tc = body.tool_choice;
  if (anTools.length && tc !== 'none') {
    out.tools = anTools;
    if (tc === 'required') out.tool_choice = { type: 'any' };
    else if (tc && typeof tc === 'object' && (tc as { function?: { name?: string } }).function?.name) out.tool_choice = { type: 'tool', name: (tc as { function: { name: string } }).function.name };
    else if (body.parallel_tool_calls === false) out.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
  }
  const ct = body.ct as { thinking?: { budget_tokens: number } } | undefined;
  if (ct?.thinking) out.thinking = { type: 'enabled', budget_tokens: ct.thinking.budget_tokens };
  else if (typeof body.reasoning_effort === 'string' && body.reasoning_effort !== 'none') {
    const budget = { low: 1024, medium: 4096, high: 16000 }[body.reasoning_effort] ?? 4096;
    out.thinking = { type: 'enabled', budget_tokens: budget };
    if ((out.max_tokens as number) <= budget) out.max_tokens = budget + 4096;
  }
  return out;
}

function stopReason(r: string | null | undefined): string {
  switch (r) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function anUsageToOa(u: Json | undefined): Json | undefined {
  if (!u) return undefined;
  const input = (u.input_tokens as number) ?? 0;
  const cacheRead = (u.cache_read_input_tokens as number) ?? 0;
  const cacheWrite = (u.cache_creation_input_tokens as number) ?? 0;
  const output = (u.output_tokens as number) ?? 0;
  return {
    prompt_tokens: input + cacheRead + cacheWrite,
    completion_tokens: output,
    total_tokens: input + cacheRead + cacheWrite + output,
    prompt_tokens_details: { cached_tokens: cacheRead },
  };
}

/** Anthropic messages response → OpenAI chat completion. */
export function anthropicResponseToOa(res: Json, requestedModel: string): Json {
  const blocks = (res.content as AnBlock[] | undefined) ?? [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text as string).join('');
  const toolCalls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id as string, type: 'function', function: { name: b.name as string, arguments: JSON.stringify(b.input ?? {}) } }));
  const message: Json = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: (res.id as string) ?? 'msg',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, message, finish_reason: stopReason(res.stop_reason as string) }],
    usage: anUsageToOa(res.usage as Json | undefined),
  };
}

/**
 * Stateful Anthropic SSE → OpenAI chunk translator. Feed parsed Anthropic
 * events; get back OpenAI `data:` frames (as strings).
 */
export class AnthropicToOaStream {
  private id = 'msg';
  private created = Math.floor(Date.now() / 1000);
  private toolIndexByBlock = new Map<number, number>();
  private nextToolIndex = 0;
  private sentRole = false;
  private usage: Json | undefined;
  private finish: string | undefined;

  constructor(
    private readonly model: string,
    private readonly includeUsage: boolean,
  ) {}

  private chunk(delta: Json, finish: string | null = null, extra: Json = {}): string {
    return `data: ${JSON.stringify({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  }

  /** Returns frames to write and whether any carry content. */
  feed(ev: Json): { frames: string[]; hasContent: boolean; usageOnlyIndex?: number } {
    const frames: string[] = [];
    let hasContent = false;
    switch (ev.type) {
      case 'message_start': {
        const m = ev.message as Json;
        this.id = (m.id as string) ?? this.id;
        this.usage = anUsageToOa(m.usage as Json | undefined);
        frames.push(this.chunk({ role: 'assistant', content: '' }));
        this.sentRole = true;
        break;
      }
      case 'content_block_start': {
        const cb = ev.content_block as AnBlock;
        const idx = ev.index as number;
        if (cb.type === 'tool_use') {
          const ti = this.nextToolIndex++;
          this.toolIndexByBlock.set(idx, ti);
          frames.push(this.chunk({ tool_calls: [{ index: ti, id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } }] }));
          hasContent = true;
        }
        break;
      }
      case 'content_block_delta': {
        const d = ev.delta as Json;
        const idx = ev.index as number;
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          frames.push(this.chunk({ content: d.text }));
          hasContent = true;
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const ti = this.toolIndexByBlock.get(idx) ?? 0;
          frames.push(this.chunk({ tool_calls: [{ index: ti, function: { arguments: d.partial_json } }] }));
          hasContent = true;
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          frames.push(this.chunk({ reasoning_content: d.thinking }));
        }
        break;
      }
      case 'message_delta': {
        const d = ev.delta as Json | undefined;
        if (d?.stop_reason) this.finish = stopReason(d.stop_reason as string);
        const u = ev.usage as Json | undefined;
        if (u && this.usage) {
          this.usage = { ...this.usage, completion_tokens: u.output_tokens ?? this.usage.completion_tokens };
          const pt = (this.usage.prompt_tokens as number) ?? 0;
          this.usage.total_tokens = pt + ((this.usage.completion_tokens as number) ?? 0);
        }
        break;
      }
      case 'message_stop': {
        if (!this.sentRole) frames.push(this.chunk({ role: 'assistant', content: '' }));
        frames.push(this.chunk({}, this.finish ?? 'stop'));
        if (this.includeUsage) {
          frames.push(`data: ${JSON.stringify({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [], usage: this.usage ?? null })}\n\n`);
        }
        frames.push('data: [DONE]\n\n');
        break;
      }
      default:
        break; // ping, content_block_stop
    }
    return { frames, hasContent };
  }
}
