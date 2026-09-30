/**
 * Forward-only migrations, embedded as strings so they survive esbuild bundling.
 * Never edit a shipped migration; add a new one.
 */
export interface Migration {
  version: number;
  name: string;
  sqlite: string;
  /** The Postgres statements, when translating the SQLite ones (toPostgres) isn't enough. */
  postgres?: string;
}

/** SQLite DDL as Postgres: 64-bit integers (timestamps are milliseconds), doubles, no WITHOUT ROWID. */
export function toPostgres(sqlite: string): string {
  return sqlite
    .replace(/\bINTEGER\b/g, 'BIGINT')
    .replace(/\bREAL\b/g, 'DOUBLE PRECISION')
    .replace(/\)\s*WITHOUT ROWID/g, ')');
}

const rollupTable = (name: string) => `
CREATE TABLE ${name} (
  bucket        TEXT NOT NULL,
  key_id        TEXT NOT NULL DEFAULT '',
  deployment_id TEXT NOT NULL DEFAULT '',
  alias_id      TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT '',
  requests      INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  denied        INTEGER NOT NULL DEFAULT 0,
  held          INTEGER NOT NULL DEFAULT 0,
  in_tokens     INTEGER NOT NULL DEFAULT 0,
  out_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_r       INTEGER NOT NULL DEFAULT 0,
  cache_w       INTEGER NOT NULL DEFAULT 0,
  cost_nanousd  INTEGER NOT NULL DEFAULT 0,
  lat_sum_ms    INTEGER NOT NULL DEFAULT 0,
  lat_count     INTEGER NOT NULL DEFAULT 0,
  lat_hist      TEXT NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0,0,0]',
  PRIMARY KEY (bucket, key_id, deployment_id, alias_id, kind)
);
CREATE INDEX ${name}_bucket ON ${name}(bucket);
`;

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'init',
    sqlite: `
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE admins (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  admin_id     TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE providers (
  id                     TEXT PRIMARY KEY,
  kind                   TEXT NOT NULL,
  name                   TEXT NOT NULL,
  slug                   TEXT NOT NULL UNIQUE,
  base_url               TEXT,
  creds_enc              TEXT,
  extra                  TEXT NOT NULL DEFAULT '{}',
  health                 TEXT NOT NULL DEFAULT 'unknown',
  health_detail          TEXT,
  stream_usage_supported INTEGER,
  demo                   INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE TABLE deployments (
  id               TEXT PRIMARY KEY,
  provider_id      TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  upstream_model   TEXT NOT NULL,
  public_name      TEXT UNIQUE,
  caps             TEXT NOT NULL DEFAULT '{}',
  pricing_override TEXT,
  weight           INTEGER NOT NULL DEFAULT 100,
  enabled          INTEGER NOT NULL DEFAULT 1,
  cooling_until    INTEGER,
  ewma_ttft_ms     REAL,
  demo             INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX deployments_provider ON deployments(provider_id);

CREATE TABLE aliases (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  strategy    TEXT NOT NULL DEFAULT 'priority',
  fallback_on TEXT NOT NULL DEFAULT '["429","5xx","timeout","provider_auth"]',
  demo        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE alias_targets (
  alias_id      TEXT NOT NULL REFERENCES aliases(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  priority      INTEGER NOT NULL DEFAULT 0,
  weight        INTEGER NOT NULL DEFAULT 100,
  PRIMARY KEY (alias_id, deployment_id)
);

CREATE TABLE api_keys (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  key_hash       TEXT NOT NULL UNIQUE,
  key_prefix     TEXT NOT NULL,
  last4          TEXT NOT NULL,
  agent_id       TEXT,
  team           TEXT,
  project        TEXT,
  tags           TEXT NOT NULL DEFAULT '[]',
  allowed_models TEXT NOT NULL DEFAULT '["*"]',
  allowed_mcp    TEXT NOT NULL DEFAULT '["*"]',
  limits         TEXT NOT NULL DEFAULT '{}',
  enabled        INTEGER NOT NULL DEFAULT 1,
  expires_at     INTEGER,
  created_by     TEXT,
  demo           INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER
);

CREATE TABLE budgets (
  id            TEXT PRIMARY KEY,
  scope_type    TEXT NOT NULL,
  scope_id      TEXT NOT NULL,
  limit_nanousd INTEGER NOT NULL,
  period        TEXT NOT NULL DEFAULT 'monthly',
  hard          INTEGER NOT NULL DEFAULT 1,
  resets_at     INTEGER,
  spent_nanousd INTEGER NOT NULL DEFAULT 0,
  UNIQUE (scope_type, scope_id)
);

CREATE TABLE flights (
  id               TEXT PRIMARY KEY,
  ts               INTEGER NOT NULL,
  key_id           TEXT NOT NULL,
  key_name         TEXT NOT NULL,
  agent_id         TEXT,
  team             TEXT,
  project          TEXT,
  kind             TEXT NOT NULL,
  dialect          TEXT NOT NULL,
  model_requested  TEXT NOT NULL,
  alias_id         TEXT,
  deployment_id    TEXT,
  provider_id      TEXT,
  provider_kind    TEXT,
  mcp_server_id    TEXT,
  tool             TEXT,
  status           TEXT,
  http_status      INTEGER,
  decision         TEXT,
  rule_id          TEXT,
  approval_id      TEXT,
  stream           INTEGER NOT NULL DEFAULT 0,
  in_tokens        INTEGER,
  out_tokens       INTEGER,
  cache_r          INTEGER,
  cache_w          INTEGER,
  reasoning_tokens INTEGER,
  usage_source     TEXT,
  cost_nanousd     INTEGER,
  cost_confidence  TEXT,
  ttfb_ms          INTEGER,
  ttft_ms          INTEGER,
  duration_ms      INTEGER,
  overhead_ms      INTEGER,
  error_code       TEXT,
  error_message    TEXT,
  completed_at     INTEGER
);
CREATE INDEX flights_ts ON flights(ts);
CREATE INDEX flights_key_ts ON flights(key_id, ts);
CREATE INDEX flights_status_ts ON flights(status, ts);
CREATE INDEX flights_deploy_ts ON flights(deployment_id, ts);

CREATE TABLE flight_events (
  flight_id TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  type      TEXT NOT NULL,
  payload   TEXT NOT NULL,
  PRIMARY KEY (flight_id, seq)
);
CREATE INDEX flight_events_ts ON flight_events(ts);

${rollupTable('usage_hourly')}
${rollupTable('usage_daily')}
`,
  },
];

migrations.push({
  version: 2,
  name: 'policy',
  sqlite: `
CREATE TABLE zones (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#64d2ff',
  selector   TEXT NOT NULL DEFAULT '{"stations":[]}',
  position   TEXT,
  demo       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE rules (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  from_zone   TEXT REFERENCES zones(id) ON DELETE CASCADE,
  to_zone     TEXT REFERENCES zones(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL DEFAULT 'any',
  match       TEXT NOT NULL DEFAULT '{}',
  effect      TEXT NOT NULL,
  config      TEXT NOT NULL DEFAULT '{}',
  priority    INTEGER NOT NULL DEFAULT 100,
  enabled     INTEGER NOT NULL DEFAULT 1,
  revision    INTEGER NOT NULL DEFAULT 1,
  demo        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX rules_priority ON rules(priority);

CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,
  flight_id     TEXT NOT NULL,
  key_id        TEXT NOT NULL,
  key_name      TEXT NOT NULL,
  rule_id       TEXT,
  rule_revision INTEGER,
  summary       TEXT NOT NULL,
  target        TEXT NOT NULL DEFAULT '{}',
  args_preview  TEXT,
  arg_hash      TEXT,
  scope_hash    TEXT NOT NULL,
  dedupe_key    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  waiters       INTEGER NOT NULL DEFAULT 1,
  requested_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  resolved_by   TEXT,
  note          TEXT,
  grant_id      TEXT,
  demo          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX approvals_status ON approvals(status, requested_at);
CREATE INDEX approvals_dedupe ON approvals(dedupe_key, status);

CREATE TABLE tickets (
  id          TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  key_id      TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE grants (
  id                  TEXT PRIMARY KEY,
  approval_id         TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  key_id              TEXT NOT NULL,
  scope_hash          TEXT NOT NULL,
  uses_allowed        INTEGER NOT NULL DEFAULT 1,
  uses_consumed       INTEGER NOT NULL DEFAULT 0,
  not_before          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  revoked_at          INTEGER,
  consumed_by_session TEXT,
  last_used_at        INTEGER,
  created_at          INTEGER NOT NULL
);
CREATE INDEX grants_key ON grants(key_id, expires_at);
`,
});

migrations.push({
  version: 3,
  name: 'mcp',
  sqlite: `
CREATE TABLE mcp_servers (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  transport       TEXT NOT NULL DEFAULT 'streamable-http',
  auth_enc        TEXT,
  timeout_ms      INTEGER NOT NULL DEFAULT 120000,
  enabled         INTEGER NOT NULL DEFAULT 1,
  health          TEXT NOT NULL DEFAULT 'unknown',
  health_detail   TEXT,
  tools_cache     TEXT NOT NULL DEFAULT '[]',
  tools_hash      TEXT,
  last_checked_at INTEGER,
  demo            INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
`,
});

migrations.push({
  version: 4,
  name: 'alerts',
  sqlite: `
CREATE TABLE alert_channels (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  config_enc   TEXT NOT NULL,
  target_hint  TEXT NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_status  TEXT,
  last_error   TEXT,
  last_sent_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE alert_rules (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  rule_id       TEXT,
  triggers      TEXT NOT NULL DEFAULT '[]',
  threshold     INTEGER NOT NULL DEFAULT 1,
  window_s      INTEGER NOT NULL DEFAULT 300,
  cooldown_s    INTEGER NOT NULL DEFAULT 300,
  channels      TEXT NOT NULL DEFAULT '[]',
  enabled       INTEGER NOT NULL DEFAULT 1,
  demo          INTEGER NOT NULL DEFAULT 0,
  last_fired_at INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX alert_rules_rule ON alert_rules(rule_id);

CREATE TABLE alerts (
  id            TEXT PRIMARY KEY,
  alert_rule_id TEXT NOT NULL,
  rule_id       TEXT,
  trigger       TEXT NOT NULL,
  title         TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '{}',
  count         INTEGER NOT NULL DEFAULT 1,
  first_at      INTEGER NOT NULL,
  last_at       INTEGER NOT NULL,
  deliveries    TEXT NOT NULL DEFAULT '[]',
  read_at       INTEGER,
  demo          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX alerts_last_at ON alerts(last_at);
CREATE INDEX alerts_unread ON alerts(read_at, last_at);
`,
});

migrations.push({
  version: 5,
  name: 'alert_kinds',
  sqlite: `
ALTER TABLE alert_rules ADD COLUMN kind TEXT NOT NULL DEFAULT 'gate';
ALTER TABLE alert_rules ADD COLUMN params TEXT NOT NULL DEFAULT '{}';
`,
});

migrations.push({
  version: 6,
  name: 'observed',
  sqlite: `
CREATE TABLE observed_targets (
  target     TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  system     TEXT,
  bypass     INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

CREATE TABLE observed_hourly (
  bucket     INTEGER NOT NULL,
  key_id     TEXT NOT NULL,
  target     TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  errors     INTEGER NOT NULL DEFAULT 0,
  writes     INTEGER NOT NULL DEFAULT 0,
  dur_ms_sum INTEGER NOT NULL DEFAULT 0,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (bucket, key_id, target)
);
CREATE INDEX observed_hourly_bucket ON observed_hourly(bucket);
`,
});

// Plain HTTP APIs proxied at /http/<slug>/…. Their flights reuse the tool
// columns: flights.mcp_server_id holds the API id and flights.tool the route
// ("GET /v1/items/:id"), so maps, gates and rollups treat them like tool servers.
migrations.push({
  version: 7,
  name: 'http_apis',
  sqlite: `
CREATE TABLE http_apis (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  base_url        TEXT NOT NULL,
  auth_enc        TEXT,
  timeout_ms      INTEGER NOT NULL DEFAULT 30000,
  enabled         INTEGER NOT NULL DEFAULT 1,
  health          TEXT NOT NULL DEFAULT 'unknown',
  health_detail   TEXT,
  last_checked_at INTEGER,
  demo            INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
`,
});

// Rows declared in a config file (`--config config.yaml`) carry
// source='config': each boot replaces them, so the file stays the source of truth.
migrations.push({
  version: 8,
  name: 'config_source',
  sqlite: `
ALTER TABLE providers ADD COLUMN source TEXT;
ALTER TABLE deployments ADD COLUMN source TEXT;
ALTER TABLE aliases ADD COLUMN source TEXT;
ALTER TABLE mcp_servers ADD COLUMN source TEXT;
ALTER TABLE alert_channels ADD COLUMN source TEXT;
ALTER TABLE alert_rules ADD COLUMN source TEXT;
`,
});

// Every connection an agent has used — agent → model or tool server → tool — with when it was
// first and last used, so a connection never seen before stands out on the map. Filled from the
// flights already recorded, so an upgrade doesn't flag every existing connection as new.
migrations.push({
  version: 9,
  name: 'paths',
  sqlite: `
CREATE TABLE paths (
  agent      TEXT NOT NULL,
  target     TEXT NOT NULL,
  tool       TEXT NOT NULL DEFAULT '',
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (agent, target, tool)
);
INSERT INTO paths (agent, target, tool, first_seen, last_seen)
  SELECT COALESCE(agent_id, key_id), COALESCE(mcp_server_id, deployment_id), COALESCE(tool, ''), MIN(ts), MAX(ts)
  FROM flights
  WHERE key_id IS NOT NULL AND COALESCE(mcp_server_id, deployment_id) IS NOT NULL
  GROUP BY 1, 2, 3;
`,
});

// Agents calling agents: a tool server or HTTP API can front an agent (agent_id); a key can be
// limited to acting on behalf of others (delegated_only); a flight records whom it ran for.
migrations.push({
  version: 10,
  name: 'agent_to_agent',
  sqlite: `
ALTER TABLE mcp_servers ADD COLUMN agent_id TEXT;
ALTER TABLE http_apis ADD COLUMN agent_id TEXT;
ALTER TABLE api_keys ADD COLUMN delegated_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flights ADD COLUMN on_behalf_of TEXT;
`,
});

// Remote agents reached over A2A (Agent2Agent), served at /a2a/<slug>.
migrations.push({
  version: 11,
  name: 'a2a_agents',
  sqlite: `
CREATE TABLE a2a_agents (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  card_url        TEXT NOT NULL,
  endpoint        TEXT,
  protocol_version TEXT,
  auth_enc        TEXT,
  agent_id        TEXT,
  card_cache      TEXT,
  timeout_ms      INTEGER NOT NULL DEFAULT 120000,
  enabled         INTEGER NOT NULL DEFAULT 1,
  health          TEXT NOT NULL DEFAULT 'unknown',
  health_detail   TEXT,
  last_checked_at INTEGER,
  demo            INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
`,
});

// The call that led to each call, when agents call agents: a trace from one agent's call to the next.
migrations.push({
  version: 12,
  name: 'flights_parent',
  sqlite: `
ALTER TABLE flights ADD COLUMN parent_flight_id TEXT;
CREATE INDEX flights_parent ON flights(parent_flight_id) WHERE parent_flight_id IS NOT NULL;
`,
});

// Approval windows: "approve this and the next N calls" — a grant new calls use without a ticket,
// bound to the agent, the gate (at its revision) and the target; and how long a card's hold lasts.
migrations.push({
  version: 13,
  name: 'approval_windows',
  sqlite: `
ALTER TABLE grants ADD COLUMN is_window INTEGER NOT NULL DEFAULT 0;
ALTER TABLE grants ADD COLUMN rule_id TEXT;
ALTER TABLE grants ADD COLUMN rule_revision INTEGER;
ALTER TABLE grants ADD COLUMN target_name TEXT;
ALTER TABLE grants ADD COLUMN any_args INTEGER NOT NULL DEFAULT 0;
CREATE INDEX grants_window ON grants(key_id, rule_id, target_name) WHERE is_window = 1;
ALTER TABLE approvals ADD COLUMN hold_until INTEGER;
`,
});

// An approval window opened for calls made on someone's behalf covers only calls for that same chain.
migrations.push({
  version: 14,
  name: 'grant_chain',
  sqlite: `
ALTER TABLE grants ADD COLUMN chain TEXT;
`,
});

// Traffic by the hour, per agent, destination, tool, whom it was for and the gate that decided it: the map, the
// data-flow export and the lists of routes and methods count from this instead of every call of the last day.
migrations.push({
  version: 15,
  name: 'traffic_hourly',
  sqlite: `
CREATE TABLE traffic_hourly (
  bucket          INTEGER NOT NULL,
  key_id          TEXT NOT NULL,
  kind            TEXT NOT NULL,
  deployment_id   TEXT NOT NULL DEFAULT '',
  mcp_server_id   TEXT NOT NULL DEFAULT '',
  tool            TEXT NOT NULL DEFAULT '',
  model_requested TEXT NOT NULL DEFAULT '',
  on_behalf_of    TEXT NOT NULL DEFAULT '',
  rule_id         TEXT NOT NULL DEFAULT '',
  requests        INTEGER NOT NULL DEFAULT 0,
  errors          INTEGER NOT NULL DEFAULT 0,
  denied          INTEGER NOT NULL DEFAULT 0,
  rejected        INTEGER NOT NULL DEFAULT 0,
  ticketed        INTEGER NOT NULL DEFAULT 0,
  held            INTEGER NOT NULL DEFAULT 0,
  cost_nanousd    INTEGER NOT NULL DEFAULT 0,
  tokens          INTEGER NOT NULL DEFAULT 0,
  last_ts         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, key_id, kind, deployment_id, mcp_server_id, tool, model_requested, on_behalf_of, rule_id)
) WITHOUT ROWID;
INSERT INTO traffic_hourly
SELECT (ts / 3600000) * 3600000, key_id, kind, COALESCE(deployment_id, ''), COALESCE(mcp_server_id, ''), COALESCE(tool, ''), model_requested,
  COALESCE(on_behalf_of, ''), COALESCE(rule_id, ''),
  COUNT(*),
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),
  SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END),
  SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END),
  SUM(CASE WHEN status = 'ticketed' THEN 1 ELSE 0 END),
  SUM(CASE WHEN approval_id IS NOT NULL THEN 1 ELSE 0 END),
  COALESCE(SUM(cost_nanousd), 0),
  COALESCE(SUM(COALESCE(in_tokens, 0) + COALESCE(out_tokens, 0)), 0),
  MAX(ts)
FROM flights WHERE status IS NOT NULL AND key_id IS NOT NULL
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9;
-- Calls still in flight: the map adds these to what the summary holds.
CREATE INDEX flights_open ON flights(ts) WHERE status IS NULL;
`,
});

// A2A push notifications relayed through Control Tower: the caller's real webhook (encrypted) behind the address the agent is given.
migrations.push({
  version: 16,
  name: 'a2a_push_relays',
  sqlite: `
CREATE TABLE a2a_push_relays (
  id            TEXT PRIMARY KEY,
  a2a_agent_id  TEXT NOT NULL,
  key_id        TEXT NOT NULL,
  target_enc    TEXT NOT NULL,
  secret_hash   TEXT NOT NULL,
  flight_id     TEXT,
  on_behalf_of  TEXT,
  deliveries    INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX a2a_push_relays_agent ON a2a_push_relays(a2a_agent_id, key_id);
`,
});

// Several instances can share one database: each records the calls it serves, and says it is alive. A call left
// without an outcome by an instance that stopped is closed out by the others.
migrations.push({
  version: 17,
  name: 'instances',
  sqlite: `
CREATE TABLE instances (
  id          TEXT PRIMARY KEY,
  host        TEXT,
  version     TEXT,
  started_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
ALTER TABLE flights ADD COLUMN instance_id TEXT;
`,
});

migrations.push({
  version: 18,
  name: 'flight_endpoint_tags_customer',
  sqlite: `
ALTER TABLE flights ADD COLUMN endpoint TEXT;
ALTER TABLE flights ADD COLUMN tags TEXT;
ALTER TABLE flights ADD COLUMN customer TEXT;
ALTER TABLE flights ADD COLUMN units TEXT;
ALTER TABLE flights ADD COLUMN cache_hit INTEGER;
CREATE INDEX idx_flights_customer_ts ON flights (customer, ts) WHERE customer IS NOT NULL;
`,
});

migrations.push({
  version: 19,
  name: 'routing_regions_customers',
  sqlite: `
ALTER TABLE aliases ADD COLUMN config TEXT;
ALTER TABLE api_keys ADD COLUMN regions TEXT;
CREATE TABLE customers (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  blocked     INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
`,
});

migrations.push({
  version: 20,
  name: 'deployment_health',
  sqlite: `
ALTER TABLE deployments ADD COLUMN health TEXT;
ALTER TABLE deployments ADD COLUMN health_detail TEXT;
ALTER TABLE deployments ADD COLUMN health_checked_at INTEGER;
`,
});

migrations.push({
  version: 21,
  name: 'export_destinations',
  sqlite: `
CREATE TABLE export_destinations (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,
  config_enc     TEXT NOT NULL,
  target_hint    TEXT NOT NULL DEFAULT '',
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_status    TEXT,
  last_error     TEXT,
  last_sent_at   INTEGER,
  sent_count     INTEGER NOT NULL DEFAULT 0,
  dropped_count  INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
`,
});

migrations.push({
  version: 22,
  name: 'guardrail_services',
  sqlite: `
CREATE TABLE guardrail_services (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL,
  config_enc       TEXT NOT NULL,
  target_hint      TEXT NOT NULL DEFAULT '',
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_status      TEXT,
  last_error       TEXT,
  last_checked_at  INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
`,
});

migrations.push({
  version: 23,
  name: 'console_roles',
  sqlite: `
ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE admins ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
`,
});

migrations.push({
  version: 24,
  name: 'audit_events',
  sqlite: `
CREATE TABLE audit_events (
  seq          INTEGER PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  ts           INTEGER NOT NULL,
  actor_type   TEXT NOT NULL,
  actor_id     TEXT,
  actor_email  TEXT,
  actor_role   TEXT,
  action       TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  status       INTEGER,
  target_type  TEXT,
  target_id    TEXT,
  detail       TEXT,
  ip           TEXT,
  user_agent   TEXT,
  request_id   TEXT,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);
CREATE INDEX audit_events_ts ON audit_events (ts);
CREATE INDEX audit_events_actor ON audit_events (actor_email, ts);
`,
});

migrations.push({
  version: 25,
  name: 'single_sign_on',
  sqlite: `
CREATE TABLE identity_providers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'oidc',
  issuer            TEXT NOT NULL,
  client_id         TEXT NOT NULL,
  client_secret_enc TEXT,
  scopes            TEXT NOT NULL DEFAULT 'openid email profile',
  allowed_domains   TEXT NOT NULL DEFAULT '[]',
  groups_claim      TEXT,
  role_map          TEXT NOT NULL DEFAULT '{}',
  default_role      TEXT NOT NULL DEFAULT 'none',
  create_users      INTEGER NOT NULL DEFAULT 1,
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_status       TEXT,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
ALTER TABLE admins ADD COLUMN sso_provider_id TEXT;
ALTER TABLE admins ADD COLUMN sso_subject TEXT;
CREATE UNIQUE INDEX admins_sso ON admins (sso_provider_id, sso_subject);
`,
});

migrations.push({
  version: 26,
  name: 'identity_provider_token_auth',
  sqlite: `
ALTER TABLE identity_providers ADD COLUMN token_auth TEXT NOT NULL DEFAULT 'client_secret_basic';
`,
});

migrations.push({
  version: 27,
  name: 'saml_and_scim',
  sqlite: `
ALTER TABLE identity_providers ADD COLUMN saml_entry_point TEXT;
ALTER TABLE identity_providers ADD COLUMN saml_idp_cert TEXT;
ALTER TABLE identity_providers ADD COLUMN saml_idp_issuer TEXT;
ALTER TABLE identity_providers ADD COLUMN email_attribute TEXT;
ALTER TABLE identity_providers ADD COLUMN scim_token_hash TEXT;
ALTER TABLE identity_providers ADD COLUMN scim_token_last4 TEXT;
ALTER TABLE admins ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admins ADD COLUMN display_name TEXT;
ALTER TABLE admins ADD COLUMN scim_provider_id TEXT;
ALTER TABLE admins ADD COLUMN scim_external_id TEXT;
CREATE TABLE scim_groups (
  id           TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL,
  display_name TEXT NOT NULL,
  external_id  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX scim_groups_name ON scim_groups (provider_id, display_name);
CREATE TABLE scim_group_members (
  group_id  TEXT NOT NULL,
  admin_id  TEXT NOT NULL,
  PRIMARY KEY (group_id, admin_id)
);
CREATE TABLE sso_used (
  id          TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL
);
`,
});

migrations.push({
  version: 28,
  name: 'audit_log_exports',
  sqlite: `
ALTER TABLE export_destinations ADD COLUMN send_flights INTEGER NOT NULL DEFAULT 1;
ALTER TABLE export_destinations ADD COLUMN send_audit INTEGER NOT NULL DEFAULT 0;
CREATE TABLE audit_exports (
  destination_id TEXT PRIMARY KEY,
  last_seq       INTEGER NOT NULL DEFAULT 0,
  sent_count     INTEGER NOT NULL DEFAULT 0,
  skipped_count  INTEGER NOT NULL DEFAULT 0,
  last_status    TEXT,
  last_error     TEXT,
  last_sent_at   INTEGER,
  lease_owner    TEXT,
  lease_until    INTEGER NOT NULL DEFAULT 0
);
`,
});

migrations.push({
  version: 29,
  name: 'token_issuers',
  sqlite: `
CREATE TABLE token_issuers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  issuer          TEXT NOT NULL,
  jwks_uri        TEXT,
  jwks_json       TEXT,
  audiences       TEXT NOT NULL DEFAULT '[]',
  rules           TEXT NOT NULL DEFAULT '[]',
  principal_claim TEXT NOT NULL DEFAULT 'sub',
  max_lifetime_s  INTEGER,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_status     TEXT,
  last_error      TEXT,
  accepted_count  INTEGER NOT NULL DEFAULT 0,
  refused_count   INTEGER NOT NULL DEFAULT 0,
  last_refusal    TEXT,
  last_refusal_at INTEGER,
  last_used_at    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX token_issuers_issuer ON token_issuers (issuer);
ALTER TABLE api_keys ADD COLUMN tokens_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flights ADD COLUMN principal TEXT;
`,
});

migrations.push({
  version: 30,
  name: 'secret_managers',
  sqlite: `
CREATE TABLE secret_managers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  config_enc  TEXT NOT NULL,
  target_hint TEXT NOT NULL,
  refresh_s   INTEGER NOT NULL DEFAULT 300,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX secret_managers_name ON secret_managers (name);
`,
});

migrations.push({
  version: 31,
  name: 'key_rotation',
  sqlite: `
ALTER TABLE api_keys ADD COLUMN prev_key_hash TEXT;
ALTER TABLE api_keys ADD COLUMN prev_expires_at INTEGER;
ALTER TABLE api_keys ADD COLUMN rotate_every_days INTEGER;
ALTER TABLE api_keys ADD COLUMN rotate_overlap_s INTEGER;
ALTER TABLE api_keys ADD COLUMN deliver_to TEXT;
ALTER TABLE api_keys ADD COLUMN last_rotated_at INTEGER;
ALTER TABLE api_keys ADD COLUMN rotation_error TEXT;
ALTER TABLE api_keys ADD COLUMN rotation_claim TEXT;
ALTER TABLE api_keys ADD COLUMN rotation_claim_until INTEGER NOT NULL DEFAULT 0;
CREATE INDEX api_keys_prev_hash ON api_keys (prev_key_hash);
`,
});

migrations.push({
  version: 32,
  name: 'organisations_and_teams',
  sqlite: `
CREATE TABLE orgs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX orgs_name ON orgs (name);
CREATE TABLE teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  org_id      TEXT,
  idp_groups  TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX teams_name ON teams (name);
CREATE TABLE memberships (
  admin_id    TEXT NOT NULL,
  scope_type  TEXT NOT NULL,
  scope_id    TEXT NOT NULL,
  role        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'console',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (admin_id, scope_type, scope_id)
);
CREATE INDEX memberships_scope ON memberships (scope_type, scope_id);
`,
});

migrations.push({
  version: 33,
  name: 'regions',
  sqlite: `
CREATE TABLE regions (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  token_hash     TEXT NOT NULL,
  token_enc      TEXT NOT NULL,
  master_key_enc TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_seen      INTEGER,
  last_instance  TEXT,
  last_version   TEXT,
  applied_etag   TEXT,
  applied_at     INTEGER,
  last_error     TEXT
);
CREATE UNIQUE INDEX regions_name ON regions (name);
CREATE UNIQUE INDEX regions_token ON regions (token_hash);
`,
});

migrations.push({
  version: 34,
  name: 'region_usage_daily',
  sqlite: `
CREATE TABLE region_usage_daily (
  region     TEXT NOT NULL,
  bucket     TEXT NOT NULL,
  requests   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (region, bucket)
);
`,
});
