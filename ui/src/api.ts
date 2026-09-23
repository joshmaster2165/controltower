/** Thin fetch wrapper for /admin/api with CSRF on mutations. */

let csrf: string | null = null;
export function setCsrf(v: string | null): void {
  csrf = v;
}
export function getCsrf(): string | null {
  return csrf;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['x-ct-csrf'] = csrf;
  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(path, init);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`, json);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body?: unknown) => call<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => call<T>('PATCH', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => call<T>('PUT', path, body ?? {}),
  del: <T>(path: string) => call<T>('DELETE', path),
};

export interface Status {
  version: string;
  setup_complete: boolean;
  demo: boolean;
  mode: 'on' | 'off';
  uptime_s: number;
  shutting_down: boolean;
  db: { pending_events: number; wal_bytes: number; backpressure: boolean };
  providers: { total: number; ok: number; down: number };
  held: number;
  topology_version: number;
}

export interface Me {
  setup_complete: boolean;
  email?: string;
  csrf?: string;
}

export interface TopologyKey {
  id: string;
  name: string;
  agent_id?: string;
  team?: string;
  project?: string;
  tags: string[];
  enabled: boolean;
  demo: boolean;
}
export interface TopologyProvider {
  id: string;
  kind: string;
  name: string;
  slug: string;
  health: string;
  demo: boolean;
}
export interface TopologyDeployment {
  id: string;
  provider_id: string;
  upstream_model: string;
  public_name?: string;
  enabled: boolean;
  cooling_until?: number;
  ewma_ttft_ms?: number;
  demo: boolean;
}
export interface TopologyAlias {
  id: string;
  name: string;
  strategy: string;
  targets: Array<{ deploymentId: string; priority: number; weight: number }>;
}
export interface TopologyLane {
  key_id: string;
  deployment_id: string;
  kind: string;
  requests: number;
  errors: number;
  denied: number;
  held: number;
  cost_nanousd: number;
  in_tokens: number;
  out_tokens: number;
  avg_ms: number | null;
}
export interface TopologyMcpTool {
  name: string;
  /** read | write | admin (destructive) | unknown */
  op: 'read' | 'write' | 'admin' | 'unknown';
}
export interface TopologyMcpServer {
  id: string;
  slug: string;
  name: string;
  health: string;
  enabled: boolean;
  tools: TopologyMcpTool[];
  demo: boolean;
}
/** Who talked to what in the last 24h: agent → model deployment or tool server (and tool). */
export interface TopologyEdge {
  key_id: string;
  target_id: string;
  tool?: string;
  requests: number;
  errors: number;
  denied: number;
  cost_nanousd: number;
  last_ts: number;
}
export interface Topology {
  version: number;
  keys: TopologyKey[];
  providers: TopologyProvider[];
  deployments: TopologyDeployment[];
  aliases: TopologyAlias[];
  mcp_servers: TopologyMcpServer[];
  edges: TopologyEdge[];
  lanes: TopologyLane[];
}

export interface FlightRow {
  id: string;
  ts: number;
  key_id: string;
  key_name: string;
  agent_id: string | null;
  team: string | null;
  project: string | null;
  kind: string;
  dialect: string;
  model_requested: string;
  alias_id: string | null;
  deployment_id: string | null;
  provider_id: string | null;
  provider_kind: string | null;
  status: string | null;
  http_status: number | null;
  decision: string | null;
  stream: number;
  in_tokens: number | null;
  out_tokens: number | null;
  usage_source: string | null;
  cost_nanousd: number | null;
  cost_confidence: string | null;
  ttfb_ms: number | null;
  ttft_ms: number | null;
  duration_ms: number | null;
  overhead_ms: number | null;
  error_code: string | null;
  error_message: string | null;
}

export interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  agent_id?: string;
  team?: string;
  project?: string;
  tags: string[];
  allowed_models: string[];
  allowed_mcp: string[];
  limits: { rpm?: number; tpm?: number; maxParallel?: number };
  enabled: boolean;
  expires_at?: number;
  demo: boolean;
  created_at: number;
  last_used_at?: number;
}

export interface Zone {
  id: string;
  name: string;
  color: string;
  stations: string[];
  match: Record<string, unknown>;
  position?: Record<string, unknown>;
  demo: boolean;
}

export interface Rule {
  id: string;
  name: string;
  from_zone: string | null;
  to_zone: string | null;
  target_kind: 'model' | 'tool' | 'any';
  match: Record<string, unknown>;
  effect: 'allow' | 'deny' | 'require_approval' | 'allow_with_limits' | 'inspect';
  config: { reason?: string; hold_ms?: number; binding?: string; bind_fields?: string[]; window?: { uses?: number; ttl_ms?: number } } & InspectConfig;
  priority: number;
  enabled: boolean;
  revision: number;
  demo: boolean;
}

export interface InspectConfig {
  detectors?: string[] | undefined;
  keywords?: string[] | undefined;
  patterns?: Array<{ name: string; regex: string }> | undefined;
  action?: 'block' | 'mask' | 'flag' | undefined;
  direction?: 'input' | 'output' | 'both' | undefined;
}

export interface DetectorInfo {
  id: string;
  category: 'secret' | 'pii' | 'injection';
  label: string;
}

export interface PolicyBundle {
  version: number;
  enforcement: boolean;
  zones: Zone[];
  rules: Rule[];
  rule_stats: Record<string, { approved: number; denied: number }>;
}

export interface Approval {
  id: string;
  flight_id: string;
  key_id: string;
  key_name: string;
  rule_id: string | null;
  summary: string;
  target: { kind: string; name: string; deployment_id?: string; provider?: string; zone_from?: string; zone_to?: string };
  args_preview: Record<string, unknown> | null;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  waiters: number;
  requested_at: number;
  expires_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  note: string | null;
  grant_id: string | null;
  demo: boolean;
}

export type AlertTrigger = 'blocked' | 'held' | 'approved' | 'rejected' | 'unanswered' | 'allowed' | 'scope_mismatch' | 'masked' | 'flagged';

export const ALERT_TRIGGERS: Array<{ id: AlertTrigger; label: string; hint: string }> = [
  { id: 'blocked', label: 'Blocked', hint: 'the gate refused a request' },
  { id: 'held', label: 'Held for approval', hint: 'a request is waiting in the Tower' },
  { id: 'approved', label: 'Approved', hint: 'someone approved a held request' },
  { id: 'rejected', label: 'Rejected', hint: 'an approver denied a held request' },
  { id: 'unanswered', label: 'Not answered', hint: 'nobody answered before the hold ran out' },
  { id: 'allowed', label: 'Allowed', hint: 'an allow gate let a request through' },
  { id: 'scope_mismatch', label: 'Approval misused', hint: 'an approval was replayed with different arguments' },
  { id: 'masked', label: 'Masked', hint: 'an inspect gate masked sensitive content' },
  { id: 'flagged', label: 'Flagged', hint: 'an inspect gate found sensitive content and let it through' },
];

export interface AlertItem {
  id: string;
  alert_rule_id: string;
  rule_id: string | null;
  trigger: AlertTrigger | 'mixed';
  title: string;
  detail: {
    gate: { id: string; name: string; effect: string } | null;
    agents: Array<{ name: string; count: number }>;
    destinations: Array<{ name: string; count: number }>;
    reason: string | null;
    flights: string[];
    digest: boolean;
    window_s: number;
  };
  count: number;
  first_at: number;
  last_at: number;
  deliveries: Array<{ channel_id: string; name: string; kind: string; ok: boolean; status?: number; error?: string; attempts: number; pending?: boolean }>;
  read: boolean;
  demo: boolean;
}

export interface AlertRule {
  id: string;
  name: string;
  rule_id: string | null;
  gate_name: string | null;
  triggers: AlertTrigger[];
  threshold: number;
  window_s: number;
  cooldown_s: number;
  channels: string[];
  enabled: boolean;
  demo: boolean;
  last_fired_at: number | null;
  fired_24h: number;
}

export interface AlertChannel {
  id: string;
  name: string;
  kind: 'slack' | 'webhook';
  target_hint: string;
  has_secret: boolean;
  enabled: boolean;
  last_status: 'ok' | 'error' | null;
  last_error: string | null;
  last_sent_at: number | null;
}
