/**
 * The Responses API (/v1/responses — Codex, the OpenAI Agents SDK) for
 * providers that only speak Chat Completions or Anthropic Messages. Requests
 * are translated to Chat Completions (and from there, like any chat request,
 * to the provider); replies — JSON or streamed — are translated back into
 * Responses objects and events. Providers that speak the Responses API get
 * the request as it came.
 *
 * Translated: instructions, text and image input, function tools and their
 * calls and results, Codex's free-form ("custom") tools, tool_choice,
 * parallel_tool_calls, max_output_tokens, temperature, top_p, JSON-schema
 * output, usage. Dropped: reasoning items and settings, built-in tools
 * (web search, file search, computer use), store/include/prompt_cache_key.
 * previous_response_id needs server-side state and is refused.
 */
type Json = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

/** Text of a Responses content value: a string, or parts with text. */
function partsText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return str(content);
  return content
    .map((p) => {
      const x = p as Json;
      return typeof x.text === 'string' ? x.text : typeof x.output === 'string' ? x.output : '';
    })
    .join('');
}

function chatContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return str(content);
  const parts: Json[] = [];
  for (const p of content as Json[]) {
    if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') parts.push({ type: 'text', text: str(p.text) });
    else if (p.type === 'input_image') {
      const url = typeof p.image_url === 'string' ? p.image_url : (p.image_url as Json | undefined)?.url;
      if (typeof url === 'string') parts.push({ type: 'image_url', image_url: { url, ...(p.detail ? { detail: p.detail } : {}) } });
    }
  }
  // Plain text stays a string: the widest-supported shape.
  return parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('') : parts;
}

export class ResponsesTranslationError extends Error {}

/** The names of free-form ("custom") tools in a request, so calls to them go back in that shape. */
export function customToolNames(body: Json): Set<string> {
  const out = new Set<string>();
  for (const t of (body.tools as Json[] | undefined) ?? []) if (t.type === 'custom' && typeof t.name === 'string') out.add(t.name);
  return out;
}

export function responsesRequestToChat(body: Json): Json {
  if (body.previous_response_id) throw new ResponsesTranslationError('previous_response_id needs a provider that supports the Responses API: send the full conversation in input instead (store: false).');
  const messages: Json[] = [];
  if (typeof body.instructions === 'string' && body.instructions) messages.push({ role: 'system', content: body.instructions });
  const input = body.input;
  if (typeof input === 'string') messages.push({ role: 'user', content: input });
  else if (Array.isArray(input)) {
    for (const it of input as Json[]) {
      const type = it.type ?? (it.role ? 'message' : undefined);
      const last = messages[messages.length - 1];
      switch (type) {
        case 'message': {
          const role = it.role === 'developer' ? 'system' : str(it.role) || 'user';
          messages.push({ role, content: role === 'assistant' || role === 'system' ? partsText(it.content) : chatContent(it.content) });
          break;
        }
        case 'function_call':
        case 'custom_tool_call': {
          const call = { id: str(it.call_id ?? it.id), type: 'function', function: { name: str(it.name), arguments: type === 'custom_tool_call' ? JSON.stringify({ input: str(it.input) }) : str(it.arguments) || '{}' } };
          // Calls follow the assistant turn they belong to; several in a row are one turn.
          if (last && last.role === 'assistant' && !('tool_call_id' in last)) (last.tool_calls as Json[] | undefined) ? (last.tool_calls as Json[]).push(call) : (last.tool_calls = [call]);
          else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
          break;
        }
        case 'function_call_output':
        case 'custom_tool_call_output':
          messages.push({ role: 'tool', tool_call_id: str(it.call_id), content: partsText(it.output) });
          break;
        default:
          // reasoning, built-in tool calls and their results: nothing a chat model can take
          break;
      }
    }
  }

  const out: Json = { model: body.model, messages };
  const tools: Json[] = [];
  for (const t of (body.tools as Json[] | undefined) ?? []) {
    if (t.type === 'function') tools.push({ type: 'function', function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.parameters ?? { type: 'object', properties: {} } } });
    else if (t.type === 'custom')
      tools.push({
        type: 'function',
        function: {
          name: t.name,
          description: `${str(t.description)}${t.format ? `\n\nPut the whole input in the "input" field, exactly as the tool expects it (${str((t.format as Json).type ?? 'text')}).` : ''}`.trim(),
          parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
        },
      });
  }
  if (tools.length) out.tools = tools;
  const tc = body.tool_choice;
  if (tc && tools.length) out.tool_choice = typeof tc === 'string' ? tc : (tc as Json).type === 'function' || (tc as Json).type === 'custom' ? { type: 'function', function: { name: (tc as Json).name } } : 'auto';
  if (typeof body.parallel_tool_calls === 'boolean' && tools.length) out.parallel_tool_calls = body.parallel_tool_calls;
  if (typeof body.max_output_tokens === 'number') out.max_tokens = body.max_output_tokens;
  for (const k of ['temperature', 'top_p', 'user', 'stream'] as const) if (body[k] !== undefined) out[k] = body[k];
  if (body.stream) out.stream_options = { include_usage: true };
  const fmt = (body.text as Json | undefined)?.format as Json | undefined;
  if (fmt?.type === 'json_schema') out.response_format = { type: 'json_schema', json_schema: { name: fmt.name ?? 'output', schema: fmt.schema, ...(fmt.strict !== undefined ? { strict: fmt.strict } : {}) } };
  else if (fmt?.type === 'json_object') out.response_format = { type: 'json_object' };
  return out;
}

const rid = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

function usageOf(u: Json | undefined): Json | undefined {
  if (!u) return undefined;
  const input = Number(u.prompt_tokens ?? 0);
  const output = Number(u.completion_tokens ?? 0);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: Number((u.prompt_tokens_details as Json | undefined)?.cached_tokens ?? 0) },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: Number((u.completion_tokens_details as Json | undefined)?.reasoning_tokens ?? 0) },
    total_tokens: Number(u.total_tokens ?? input + output),
  };
}

function toolItem(call: { id: string; name: string; arguments: string }, custom: Set<string>, status: string): Json {
  if (custom.has(call.name)) {
    let input = call.arguments;
    try {
      input = str((JSON.parse(call.arguments) as Json).input);
    } catch {
      /* the model wrote the input bare */
    }
    return { type: 'custom_tool_call', id: rid('ctc'), call_id: call.id, name: call.name, input, status };
  }
  return { type: 'function_call', id: rid('fc'), call_id: call.id, name: call.name, arguments: call.arguments || '{}', status };
}

/** A Chat Completions reply as a Responses object. */
export function chatResponseToResponses(chat: Json, requestedModel: string, custom: Set<string> = new Set()): Json {
  const choice = ((chat.choices as Json[] | undefined) ?? [])[0] ?? {};
  const msg = (choice.message as Json | undefined) ?? {};
  const output: Json[] = [];
  const text = typeof msg.content === 'string' ? msg.content : partsText(msg.content);
  if (text) output.push({ type: 'message', id: rid('msg'), status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
  for (const tc of (msg.tool_calls as Json[] | undefined) ?? []) {
    const fn = (tc.function as Json | undefined) ?? {};
    output.push(toolItem({ id: str(tc.id) || rid('call'), name: str(fn.name), arguments: str(fn.arguments) }, custom, 'completed'));
  }
  const incomplete = choice.finish_reason === 'length';
  return {
    id: `resp_${str(chat.id) || rid('r')}`,
    object: 'response',
    created_at: Number(chat.created ?? Math.floor(Date.now() / 1000)),
    status: incomplete ? 'incomplete' : 'completed',
    ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    model: requestedModel,
    output,
    output_text: text,
    ...(chat.usage ? { usage: usageOf(chat.usage as Json) } : {}),
  };
}

/**
 * Chat Completions stream chunks → Responses stream events. Feed each parsed
 * chunk; call finish() once the upstream stream ends for the closing events.
 */
export class ChatToResponsesStream {
  private readonly id = rid('resp');
  private readonly created = Math.floor(Date.now() / 1000);
  private seq = 0;
  private started = false;
  private finished = false;
  private items: Json[] = [];
  private msg: { index: number; id: string; text: string } | null = null;
  private calls = new Map<number, { index: number; itemId: string; id: string; name: string; arguments: string; custom: boolean }>();
  private usage: Json | undefined;
  private incomplete = false;

  constructor(
    private readonly model: string,
    private readonly custom: Set<string> = new Set(),
  ) {}

  private ev(type: string, data: Json): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq++, ...data })}\n\n`;
  }

  private shell(status: string, output: Json[]): Json {
    return { id: this.id, object: 'response', created_at: this.created, status, model: this.model, output, ...(status !== 'in_progress' && this.usage ? { usage: this.usage } : {}), ...(this.incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) };
  }

  private start(out: string[]): void {
    if (this.started) return;
    this.started = true;
    out.push(this.ev('response.created', { response: this.shell('in_progress', []) }), this.ev('response.in_progress', { response: this.shell('in_progress', []) }));
  }

  private closeMessage(out: string[]): void {
    const m = this.msg;
    if (!m) return;
    this.msg = null;
    const part = { type: 'output_text', text: m.text, annotations: [] };
    const item = { type: 'message', id: m.id, status: 'completed', role: 'assistant', content: [part] };
    out.push(
      this.ev('response.output_text.done', { item_id: m.id, output_index: m.index, content_index: 0, text: m.text }),
      this.ev('response.content_part.done', { item_id: m.id, output_index: m.index, content_index: 0, part }),
      this.ev('response.output_item.done', { output_index: m.index, item }),
    );
    this.items[m.index] = item;
  }

  feed(chunk: Json): { frames: string[]; hasContent: boolean } {
    const out: string[] = [];
    let hasContent = false;
    this.start(out);
    if (chunk.usage) this.usage = usageOf(chunk.usage as Json);
    for (const choice of (chunk.choices as Json[] | undefined) ?? []) {
      const delta = (choice.delta as Json | undefined) ?? {};
      if (typeof delta.content === 'string' && delta.content) {
        hasContent = true;
        if (!this.msg) {
          const index = this.items.length;
          const id = rid('msg');
          this.msg = { index, id, text: '' };
          this.items.push({});
          out.push(
            this.ev('response.output_item.added', { output_index: index, item: { type: 'message', id, status: 'in_progress', role: 'assistant', content: [] } }),
            this.ev('response.content_part.added', { item_id: id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }),
          );
        }
        this.msg.text += delta.content;
        out.push(this.ev('response.output_text.delta', { item_id: this.msg.id, output_index: this.msg.index, content_index: 0, delta: delta.content }));
      }
      for (const tc of (delta.tool_calls as Json[] | undefined) ?? []) {
        hasContent = true;
        const n = Number(tc.index ?? 0);
        const fn = (tc.function as Json | undefined) ?? {};
        let call = this.calls.get(n);
        if (!call) {
          this.closeMessage(out);
          const name = str(fn.name);
          const custom = this.custom.has(name);
          const index = this.items.length;
          this.items.push({});
          call = { index, itemId: rid(custom ? 'ctc' : 'fc'), id: str(tc.id) || rid('call'), name, arguments: '', custom };
          this.calls.set(n, call);
          out.push(
            this.ev('response.output_item.added', {
              output_index: index,
              item: custom ? { type: 'custom_tool_call', id: call.itemId, call_id: call.id, name, input: '', status: 'in_progress' } : { type: 'function_call', id: call.itemId, call_id: call.id, name, arguments: '', status: 'in_progress' },
            }),
          );
        }
        if (typeof fn.arguments === 'string' && fn.arguments) {
          call.arguments += fn.arguments;
          // A custom tool's input is only known whole (it arrives wrapped in JSON).
          if (!call.custom) out.push(this.ev('response.function_call_arguments.delta', { item_id: call.itemId, output_index: call.index, delta: fn.arguments }));
        }
      }
      if (choice.finish_reason === 'length') this.incomplete = true;
    }
    return { frames: out, hasContent };
  }

  finish(): string[] {
    if (this.finished) return [];
    this.finished = true;
    const out: string[] = [];
    this.start(out);
    this.closeMessage(out);
    for (const call of [...this.calls.values()].sort((a, b) => a.index - b.index)) {
      const item = { ...toolItem({ id: call.id, name: call.name, arguments: call.arguments }, this.custom, 'completed'), id: call.itemId };
      if (!call.custom) out.push(this.ev('response.function_call_arguments.done', { item_id: call.itemId, output_index: call.index, arguments: call.arguments || '{}' }));
      out.push(this.ev('response.output_item.done', { output_index: call.index, item }));
      this.items[call.index] = item;
    }
    const status = this.incomplete ? 'incomplete' : 'completed';
    out.push(this.ev(`response.${status}`, { response: this.shell(status, this.items.filter((i) => Object.keys(i).length)) }));
    return out;
  }
}
