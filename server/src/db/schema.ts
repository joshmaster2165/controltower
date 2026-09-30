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
  /** admin (everything), approver (sees everything, decides approvals), viewer (sees everything). */
  role?: string;
  /** Set when an admin made (or reset) the password: the person is asked to choose their own. */
  must_change_password?: Bool;
  /** Signs in through this identity provider, as this subject (the IdP's stable id for the person). */
  sso_provider_id?: string | null;
  sso_subject?: string | null;
  /** 0 active; 1 deactivated (by the IdP over SCIM); 2 in no group that gives a role. Only 0 signs in. */
  disabled?: Bool;
  display_name?: string | null;
  /** Provisioned by this identity provider over SCIM, with the IdP's id for the person. */
  scim_provider_id?: string | null;
  scim_external_id?: string | null;
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
  /** From the background health check: ok, down, missing (the provider no longer lists it), or unknown. */
  health?: string | null;
  health_detail?: string | null;
  health_checked_at?: number | null;
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
  /** JSON RouteConfig: fallback models, retries, caching. */
  config?: string | null;
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
  /** JSON array of region globs this key's calls may be served in (data residency); null = anywhere. */
  regions?: string | null;
  enabled: Bool;
  expires_at: number | null;
  created_by: string | null;
  demo: Bool;
  delegated_only: Generated<number>;
  /** Only tokens from a trusted issuer are accepted, not the secret (while the license includes it). */
  tokens_only: Generated<number>;
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
  /** The instance that served the call. */
  instance_id: string | null;
  /** Model calls other than chat: the endpoint called (images/generations, gemini:generateContent, …). */
  endpoint: string | null;
  /** JSON array of the tags the request carried. */
  tags: string | null;
  /** The end customer the agent was serving. */
  customer: string | null;
  /** Who presented the token the call was made with (issuer · subject), when it wasn't a key's secret. */
  principal: string | null;
  /** JSON: what a non-token call was billed on ({images, characters, seconds, queries}). */
  units: string | null;
  cache_hit: Bool | null;
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

/** An A2A push webhook relayed through Control Tower: `target_enc` is the caller's { url, token?, authentication? }. */
export interface A2aPushRelaysTable {
  id: string;
  a2a_agent_id: string;
  key_id: string;
  target_enc: string;
  secret_hash: string;
  flight_id: string | null;
  on_behalf_of: string | null;
  deliveries: Generated<number>;
  last_used_at: number | null;
  created_at: number;
}

/** A running Control Tower instance, and when it last said it was alive. */
export interface InstancesTable {
  id: string;
  host: string | null;
  version: string | null;
  started_at: number;
  last_seen: number;
}

/** Traffic by the hour per agent, destination, tool, chain and gate (text columns use '' for none). */
export interface TrafficHourlyTable {
  bucket: number;
  key_id: string;
  kind: string;
  deployment_id: string;
  mcp_server_id: string;
  tool: string;
  model_requested: string;
  on_behalf_of: string;
  rule_id: string;
  requests: number;
  errors: number;
  denied: number;
  rejected: number;
  ticketed: number;
  held: number;
  cost_nanousd: number;
  tokens: number;
  last_ts: number;
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
  traffic_hourly: TrafficHourlyTable;
  instances: InstancesTable;
  a2a_push_relays: A2aPushRelaysTable;
  mcp_servers: McpServersTable;
  http_apis: HttpApisTable;
  alert_channels: AlertChannelsTable;
  alert_rules: AlertRulesTable;
  alerts: AlertsTable;
  observed_targets: ObservedTargetsTable;
  observed_hourly: ObservedHourlyTable;
  paths: PathsTable;
  a2a_agents: A2aAgentsTable;
  customers: CustomersTable;
  export_destinations: ExportDestinationsTable;
  guardrail_services: GuardrailServicesTable;
  schema_migrations: SchemaMigrationsTable;
  audit_events: AuditEventsTable;
  audit_exports: AuditExportsTable;
  token_issuers: TokenIssuersTable;
  identity_providers: IdentityProvidersTable;
  scim_groups: ScimGroupsTable;
  scim_group_members: ScimGroupMembersTable;
  sso_used: SsoUsedTable;
}

/** Single sign-on requests already answered (SAML request ids): a response is accepted once. */
export interface SsoUsedTable {
  id: string;
  expires_at: number;
}

/** Groups an identity provider pushes over SCIM; their names map to roles through the provider's role map. */
export interface ScimGroupsTable {
  id: string;
  provider_id: string;
  display_name: string;
  external_id: string | null;
  created_at: number;
  updated_at: number;
}
export interface ScimGroupMembersTable {
  group_id: string;
  admin_id: string;
}

/** Who changed what in Control Tower, and who tried. Each row carries the hash of the one before it. */
export interface AuditEventsTable {
  seq: number;
  id: string;
  ts: number;
  /** person, admin_key, anonymous or system. */
  actor_type: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  /** keys.create, users.update, auth.sign_in, … */
  action: string;
  /** success, denied or failure. */
  outcome: string;
  status: number | null;
  target_type: string | null;
  target_id: string | null;
  /** JSON: the route and the request, secrets removed. */
  detail: string | null;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  prev_hash: string;
  hash: string;
}

/** OpenID Connect providers people sign in with (Okta, Entra ID, Google, Auth0, Keycloak, …). */
export interface IdentityProvidersTable {
  id: string;
  name: string;
  kind: string;
  issuer: string;
  client_id: string;
  /** Encrypted (AAD: identity_providers.client_secret_enc.<id>). */
  client_secret_enc: string | null;
  scopes: string;
  /** JSON array of email domains allowed to sign in; empty allows any the IdP vouches for. */
  allowed_domains: string;
  /** The ID-token claim listing the person's groups (e.g. "groups"). */
  groups_claim: string | null;
  /** JSON {admin: [groups], approver: [groups], viewer: [groups]}. */
  role_map: string;
  /** Role for someone in none of the mapped groups; "none" refuses them. */
  default_role: string;
  /** Create the person on first sign-in. */
  create_users: Bool;
  /** How Control Tower authenticates to the token endpoint: client_secret_basic, client_secret_post or none (PKCE only). */
  token_auth: string;
  /** kind "saml": the IdP's single sign-on URL, its signing certificate (PEM, public), and its entity ID. */
  saml_entry_point: string | null;
  saml_idp_cert: string | null;
  saml_idp_issuer: string | null;
  /** The attribute (SAML) or claim holding the email, when not the usual ones. */
  email_attribute: string | null;
  /** SCIM: the provisioning token's hash (the token is shown once) and its last four characters. */
  scim_token_hash: string | null;
  scim_token_last4: string | null;
  enabled: Bool;
  last_status: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/** Guardrail services outside Control Tower that inspect gates can ask (Presidio, Lakera, Bedrock, Azure, …). */
export interface GuardrailServicesTable {
  id: string;
  name: string;
  kind: string;
  /** Encrypted JSON config, secrets included (AAD: guardrail_services.config_enc.<id>). */
  config_enc: string;
  target_hint: string;
  enabled: Bool;
  last_status: string | null;
  last_error: string | null;
  last_checked_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Where flight records are sent (OpenTelemetry, Datadog, Splunk, S3, webhooks). */
export interface ExportDestinationsTable {
  id: string;
  name: string;
  kind: string;
  /** Encrypted JSON config, secrets included (AAD: export_destinations.config_enc.<id>). */
  config_enc: string;
  target_hint: string;
  enabled: Bool;
  last_status: string | null;
  last_error: string | null;
  last_sent_at: number | null;
  sent_count: number;
  dropped_count: number;
  /** What goes to it: calls (flight records), the audit log (Enterprise), or both. */
  send_flights: Bool;
  send_audit: Bool;
  created_at: number;
  updated_at: number;
}

/**
 * How far each destination has got through the audit log. Shipping reads from the log itself, so it survives
 * restarts and outages; with several instances, the one holding the lease sends.
 */
export interface AuditExportsTable {
  destination_id: string;
  /** The last event delivered. */
  last_seq: number;
  sent_count: number;
  /** Events retention removed before they could be sent. */
  skipped_count: number;
  last_status: string | null;
  last_error: string | null;
  last_sent_at: number | null;
  lease_owner: string | null;
  lease_until: number;
}

/** End customers agents serve: named, blocked, budgeted (spend comes from flights). */
export interface CustomersTable {
  id: string;
  name: string | null;
  blocked: Bool;
  note: string | null;
  created_at: number;
  updated_at: number;
}

// Re-exported so call sites can use Generated/ColumnType if they need them later.
export type { ColumnType, Generated };

/**
 * Identity providers whose tokens agents may present instead of a key's secret (Enterprise). Rules map a
 * token's claims to the key whose permissions apply; the first rule that matches wins.
 */
export interface TokenIssuersTable {
  id: string;
  name: string;
  /** The token's `iss`, exactly. */
  issuer: string;
  /** Where its signing keys are; discovered from the issuer's OpenID configuration when null. */
  jwks_uri: string | null;
  /** Signing keys given directly (a JWKS document), for issuers Control Tower can't reach. */
  jwks_json: string | null;
  /** JSON array: a token's `aud` must include one of these. */
  audiences: string;
  /** JSON array of {claims: {name: pattern}, key_id}. */
  rules: string;
  /** The claim that names who presented the token, recorded with each call (default `sub`). */
  principal_claim: string;
  /** Tokens valid for longer than this (exp − iat) are refused. */
  max_lifetime_s: number | null;
  enabled: Bool;
  last_status: string | null;
  last_error: string | null;
  accepted_count: number;
  refused_count: number;
  last_refusal: string | null;
  last_refusal_at: number | null;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}
