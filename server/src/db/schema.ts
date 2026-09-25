/**
 * Kysely database types. Timestamps are epoch milliseconds (INTEGER).
 * JSON columns are TEXT and parsed at the registry layer. Booleans are 0/1.
 */
import type { ColumnType, Generated } from 'kysely';

type Json = string;
type Bool = number;

export interface SettingsTable {
  key: string;
  value: string;
  updated_at: number;
}

export interface AdminsTable {
  id: string;
  email: string;
  password_hash: string;
  created_at: number;
}

export interface SessionsTable {
  id: string;
  admin_id: string;
  csrf: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
}

export interface ProvidersTable {
  id: string;
  kind: string;
  name: string;
  slug: string;
  base_url: string | null;
  creds_enc: string | null;
  extra: Json;
  health: string;
  health_detail: string | null;
  stream_usage_supported: Bool | null;
  demo: Bool;
  created_at: number;
  updated_at: number;
  /** 'config' when declared in a --config file (replaced on every boot). */
  source?: string | null;
}

export interface DeploymentsTable {
  id: string;
  provider_id: string;
  upstream_model: string;
  public_name: string | null;
  caps: Json;
  pricing_override: Json | null;
  weight: number;
  enabled: Bool;
  cooling_until: number | null;
  ewma_ttft_ms: number | null;
  demo: Bool;
  created_at: number;
  updated_at: number;
  /** 'config' when declared in a --config file (replaced on every boot). */
  source?: string | null;
}

export interface AliasesTable {
  id: string;
  name: string;
  strategy: string;
  fallback_on: Json;
  demo: Bool;
  created_at: number;
  /** 'config' when declared in a --config file (replaced on every boot). */
  source?: string | null;
}

export interface AliasTargetsTable {
  alias_id: string;
  deployment_id: string;
  priority: number;
  weight: number;
}

export interface ApiKeysTable {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  last4: string;
  agent_id: string | null;
  team: string | null;
  project: string | null;
  tags: Json;
  allowed_models: Json;
  allowed_mcp: Json;
  limits: Json;
  enabled: Bool;
  expires_at: number | null;
  created_by: string | null;
  demo: Bool;
  delegated_only: Generated<number>;
  created_at: number;
  last_used_at: number | null;
}

export interface BudgetsTable {
  id: string;
  scope_type: string;
  scope_id: string;
  limit_nanousd: number;
  period: string;
  hard: Bool;
  resets_at: number | null;
  spent_nanousd: number;
}

export interface FlightsTable {
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
  mcp_server_id: string | null;
  tool: string | null;
  on_behalf_of: string | null;
  /** The call whose delegation token this call presented: the call that led to it. */
  parent_flight_id: string | null;
  status: string | null;
  http_status: number | null;
  decision: string | null;
  rule_id: string | null;
  approval_id: string | null;
  stream: Bool;
  in_tokens: number | null;
  out_tokens: number | null;
  cache_r: number | null;
  cache_w: number | null;
  reasoning_tokens: number | null;
  usage_source: string | null;
  cost_nanousd: number | null;
  cost_confidence: string | null;
  ttfb_ms: number | null;
  ttft_ms: number | null;
  duration_ms: number | null;
  overhead_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  completed_at: number | null;
}

export interface FlightEventsTable {
  flight_id: string;
  seq: number;
  ts: number;
  type: string;
  payload: Json;
}

export interface UsageRollupTable {
  bucket: string;
  key_id: string;
  deployment_id: string;
  alias_id: string;
  kind: string;
  requests: number;
  errors: number;
  denied: number;
  held: number;
  in_tokens: number;
  out_tokens: number;
  cache_r: number;
  cache_w: number;
  cost_nanousd: number;
  lat_sum_ms: number;
  lat_count: number;
  lat_hist: Json;
}

export interface ZonesTable {
  id: string;
  name: string;
  color: string;
  selector: Json;
  position: Json | null;
  demo: Bool;
  created_at: number;
  updated_at: number;
}

export interface RulesTable {
  id: string;
  name: string;
  from_zone: string | null;
  to_zone: string | null;
  target_kind: string;
  match: Json;
  effect: string;
  config: Json;
  priority: number;
  enabled: Bool;
  revision: number;
  demo: Bool;
  created_at: number;
  updated_at: number;
}

export interface ApprovalsTable {
  id: string;
  flight_id: string;
  key_id: string;
  key_name: string;
  rule_id: string | null;
  rule_revision: number | null;
  summary: string;
  target: Json;
  args_preview: Json | null;
  arg_hash: string | null;
  scope_hash: string;
  dedupe_key: string;
  status: string;
  waiters: number;
  requested_at: number;
  expires_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  note: string | null;
  grant_id: string | null;
  demo: Bool;
  /** When the agent stops waiting (the latest of the calls held on this card). */
  hold_until: number | null;
}

export interface TicketsTable {
  id: string;
  approval_id: string;
  key_id: string;
  expires_at: number;
  created_at: number;
}

export interface GrantsTable {
  id: string;
  approval_id: string;
  key_id: string;
  scope_hash: string;
  uses_allowed: number;
  uses_consumed: number;
  not_before: number;
  expires_at: number;
  revoked_at: number | null;
  consumed_by_session: string | null;
  last_used_at: number | null;
  created_at: number;
  /** 1: an approval window — new calls from this agent through this gate use it without a ticket. */
  is_window: Generated<number>;
  rule_id: string | null;
  rule_revision: number | null;
  target_name: string | null;
  /** 1: any arguments; 0: only the arguments on the card. */
  any_args: Generated<number>;
  /** For a window on calls made on someone's behalf: that chain (JSON, origin first); it covers only calls for the same chain. */
  chain: string | null;
}

export interface HttpApisTable {
  id: string;
  slug: string;
  name: string;
  base_url: string;
  auth_enc: string | null;
  timeout_ms: number;
  enabled: number;
  health: string;
  health_detail: string | null;
  last_checked_at: number | null;
  demo: number;
  agent_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface McpServersTable {
  id: string;
  slug: string;
  name: string;
  url: string;
  transport: string;
  auth_enc: string | null;
  timeout_ms: number;
  enabled: Bool;
  health: string;
  health_detail: string | null;
  tools_cache: Json;
  tools_hash: string | null;
  last_checked_at: number | null;
  demo: Bool;
  agent_id: string | null;
  created_at: number;
  updated_at: number;
  /** 'config' when declared in a --config file (replaced on every boot). */
  source?: string | null;
}

export interface AlertChannelsTable {
  id: string;
  name: string;
  kind: string;
  config_enc: string;
  target_hint: string;
  enabled: Bool;
  last_status: string | null;
  last_error: string | null;
  last_sent_at: number | null;
  created_at: number;
  updated_at: number;
  /** 'config' when declared in a --config file (replaced on every boot). */
  source?: string | null;
}

export interface AlertRulesTable {
  id: string;
  name: string;
  kind: string;
  params: Json;
  rule_id: string | null;
  triggers: Json;
  threshold: number;
  window_s: number;
  cooldown_s: number;
  channels: Json;
  enabled: Bool;
  demo: Bool;
  last_fired_at: number | null;
  created_at: number;
  updated_at: number;
  /** 'config' when declared in a --config file (replaced on every boot). */
  source?: string | null;
}

export interface AlertsTable {
  id: string;
  alert_rule_id: string;
  rule_id: string | null;
  trigger: string;
  title: string;
  detail: Json;
  count: number;
  first_at: number;
  last_at: number;
  deliveries: Json;
  read_at: number | null;
  demo: Bool;
}

export interface ObservedTargetsTable {
  target: string;
  kind: string;
  system: string | null;
  bypass: Bool;
  first_seen: number;
  last_seen: number;
}

export interface ObservedHourlyTable {
  bucket: number;
  key_id: string;
  target: string;
  count: number;
  errors: number;
  writes: number;
  dur_ms_sum: number;
  last_seen: number;
}

export interface A2aAgentsTable {
  id: string;
  slug: string;
  name: string;
  card_url: string;
  endpoint: string | null;
  protocol_version: string | null;
  auth_enc: string | null;
  agent_id: string | null;
  card_cache: string | null;
  timeout_ms: Generated<number>;
  enabled: Generated<number>;
  health: Generated<string>;
  health_detail: string | null;
  last_checked_at: number | null;
  demo: Generated<number>;
  created_at: number;
  updated_at: number;
}

export interface PathsTable {
  agent: string;
  target: string;
  tool: string;
  first_seen: number;
  last_seen: number;
}

export interface SchemaMigrationsTable {
  version: number;
  name: string;
  applied_at: number;
}

export interface Database {
  settings: SettingsTable;
  admins: AdminsTable;
  sessions: SessionsTable;
  providers: ProvidersTable;
  deployments: DeploymentsTable;
  aliases: AliasesTable;
  alias_targets: AliasTargetsTable;
  api_keys: ApiKeysTable;
  budgets: BudgetsTable;
  flights: FlightsTable;
  flight_events: FlightEventsTable;
  usage_hourly: UsageRollupTable;
  usage_daily: UsageRollupTable;
  zones: ZonesTable;
  rules: RulesTable;
  approvals: ApprovalsTable;
  tickets: TicketsTable;
  grants: GrantsTable;
  mcp_servers: McpServersTable;
  http_apis: HttpApisTable;
  alert_channels: AlertChannelsTable;
  alert_rules: AlertRulesTable;
  alerts: AlertsTable;
  observed_targets: ObservedTargetsTable;
  observed_hourly: ObservedHourlyTable;
  paths: PathsTable;
  a2a_agents: A2aAgentsTable;
  schema_migrations: SchemaMigrationsTable;
}

// Re-exported so call sites can use Generated/ColumnType if they need them later.
export type { ColumnType, Generated };
