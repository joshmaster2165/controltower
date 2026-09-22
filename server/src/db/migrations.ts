/**
 * Forward-only migrations, embedded as strings so they survive esbuild bundling.
 * Never edit a shipped migration; add a new one.
 */
export interface Migration {
  version: number;
  name: string;
  sqlite: string;
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
