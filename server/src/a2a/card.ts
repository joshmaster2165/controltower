/**
 * A2A (Agent2Agent) — the parts of the protocol Control Tower needs to stand
 * in front of a remote agent: finding its JSON-RPC endpoint in its Agent Card,
 * publishing a card that points callers at Control Tower instead, and knowing
 * what each JSON-RPC method does. Both the current specification (1.0:
 * `supportedInterfaces`, PascalCase methods such as `SendMessage`) and 0.3
 * (`url` / `preferredTransport`, methods such as `message/send`) are handled;
 * Control Tower forwards the method name the caller used, unchanged.
 */
type Json = Record<string, unknown>;

export const CARD_PATH = '/.well-known/agent-card.json';
/** The 0.2 path, still served by some agents. */
export const LEGACY_CARD_PATH = '/.well-known/agent.json';

export interface MethodInfo {
  /** The 1.0 name, used as the row on the map and in gates: `<slug>__SendMessage`. */
  name: string;
  op: 'read' | 'write';
  /** Answered with a Server-Sent Events stream. */
  stream?: boolean;
  /** Carries a message for the agent: inspect gates read it. */
  message?: boolean;
  /** Answers with an Agent Card, rewritten to point at Control Tower. */
  card?: boolean;
}

const M = (name: string, op: 'read' | 'write', extra: Partial<MethodInfo> = {}): MethodInfo => ({ name, op, ...extra });
/** Every A2A JSON-RPC method, by the names of both versions. Others are refused. */
export const METHODS: Record<string, MethodInfo> = {
  SendMessage: M('SendMessage', 'write', { message: true }),
  'message/send': M('SendMessage', 'write', { message: true }),
  SendStreamingMessage: M('SendStreamingMessage', 'write', { message: true, stream: true }),
  'message/stream': M('SendStreamingMessage', 'write', { message: true, stream: true }),
  GetTask: M('GetTask', 'read'),
  'tasks/get': M('GetTask', 'read'),
  ListTasks: M('ListTasks', 'read'),
  'tasks/list': M('ListTasks', 'read'),
  CancelTask: M('CancelTask', 'write'),
  'tasks/cancel': M('CancelTask', 'write'),
  SubscribeToTask: M('SubscribeToTask', 'read', { stream: true }),
  'tasks/resubscribe': M('SubscribeToTask', 'read', { stream: true }),
  'tasks/subscribe': M('SubscribeToTask', 'read', { stream: true }),
  CreateTaskPushNotificationConfig: M('CreateTaskPushNotificationConfig', 'write'),
  'tasks/pushNotificationConfig/set': M('CreateTaskPushNotificationConfig', 'write'),
  GetTaskPushNotificationConfig: M('GetTaskPushNotificationConfig', 'read'),
  'tasks/pushNotificationConfig/get': M('GetTaskPushNotificationConfig', 'read'),
  ListTaskPushNotificationConfigs: M('ListTaskPushNotificationConfigs', 'read'),
  'tasks/pushNotificationConfig/list': M('ListTaskPushNotificationConfigs', 'read'),
  DeleteTaskPushNotificationConfig: M('DeleteTaskPushNotificationConfig', 'write'),
  'tasks/pushNotificationConfig/delete': M('DeleteTaskPushNotificationConfig', 'write'),
  GetExtendedAgentCard: M('GetExtendedAgentCard', 'read', { card: true }),
  'agent/getAuthenticatedExtendedCard': M('GetExtendedAgentCard', 'read', { card: true }),
};

/** Where to fetch a card: the URL as given if it names a file, else the well-known paths under it. */
export function cardCandidates(url: string): string[] {
  const u = url.trim().replace(/\/+$/, '');
  if (/\.json(\?.*)?$/.test(u)) return [u];
  return [`${u}${CARD_PATH}`, `${u}${LEGACY_CARD_PATH}`];
}

/** The agent's JSON-RPC endpoint, from its card; A2A over gRPC or HTTP+JSON only is not served. */
export function jsonRpcEndpoint(card: Json, cardUrl: string): { url: string; version: string } | { error: string } {
  const abs = (u: unknown) => {
    try {
      return new URL(String(u), cardUrl).toString();
    } catch {
      return undefined;
    }
  };
  // 1.0: supportedInterfaces, in the agent's order of preference.
  const ifaces = Array.isArray(card.supportedInterfaces) ? (card.supportedInterfaces as Json[]) : [];
  const v1 = ifaces.find((i) => String(i.protocolBinding ?? '').toUpperCase() === 'JSONRPC');
  if (v1 && abs(v1.url)) return { url: abs(v1.url)!, version: String(v1.protocolVersion ?? '1.0') };
  // 0.3: url with preferredTransport, plus additionalInterfaces.
  const preferred = String(card.preferredTransport ?? 'JSONRPC').toUpperCase();
  if (card.url && preferred === 'JSONRPC' && abs(card.url)) return { url: abs(card.url)!, version: String(card.protocolVersion ?? '0.3') };
  const extra = (Array.isArray(card.additionalInterfaces) ? (card.additionalInterfaces as Json[]) : []).find((i) => String(i.transport ?? '').toUpperCase() === 'JSONRPC');
  if (extra && abs(extra.url)) return { url: abs(extra.url)!, version: String(card.protocolVersion ?? '0.3') };
  const offered = [...ifaces.map((i) => String(i.protocolBinding)), card.url ? preferred : ''].filter(Boolean);
  return { error: offered.length ? `the agent offers ${[...new Set(offered)].join(', ')} but not JSON-RPC, which is what Control Tower serves` : 'the Agent Card names no endpoint' };
}

/**
 * The card Control Tower publishes for an agent: the agent's own, pointing at Control Tower
 * (`<base>/a2a/<slug>`) and asking for a Control Tower key. Signatures are dropped: the card
 * is no longer the one the agent signed.
 */
export function publishedCard(card: Json, endpoint: string, version: string): Json {
  const out: Json = { ...card };
  delete out.signatures;
  const description = 'A Control Tower API key (ct_sk_…), as a bearer token.';
  if (Array.isArray(card.supportedInterfaces) || version.startsWith('1')) {
    // 1.0
    out.supportedInterfaces = [{ url: endpoint, protocolBinding: 'JSONRPC', protocolVersion: version }];
    out.securitySchemes = { controltower: { httpAuthSecurityScheme: { scheme: 'Bearer', description } } };
    out.securityRequirements = [{ schemes: { controltower: { list: [] } } }];
    delete out.security;
    delete out.additionalInterfaces;
    if (out.url !== undefined) out.url = endpoint;
  } else {
    // 0.3
    out.url = endpoint;
    out.preferredTransport = 'JSONRPC';
    out.additionalInterfaces = [{ url: endpoint, transport: 'JSONRPC' }];
    out.securitySchemes = { controltower: { type: 'http', scheme: 'bearer', description } };
    out.security = [{ controltower: [] }];
  }
  return out;
}

export function skillsOf(card: Json | undefined): Array<{ id: string; name: string; description: string }> {
  const skills = Array.isArray(card?.skills) ? (card!.skills as Json[]) : [];
  return skills.map((s) => ({ id: String(s.id ?? s.name ?? ''), name: String(s.name ?? s.id ?? ''), description: String(s.description ?? '') }));
}
