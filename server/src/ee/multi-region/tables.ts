import crypto from 'node:crypto';
import { BUILT_IN_KEYS } from '../../admin/key-lifecycle.js';

/**
 * What a region takes from the control plane: every configuration table, in the order their foreign keys need
 * (parents first). Per table:
 *   key       the primary key
 *   local     columns the region keeps its own values for (health, counters, spend): never sent, never overwritten
 *   volatile  sent, but not part of the fingerprint (a health check touching updated_at isn't a configuration change)
 *   enc       columns encrypted with the master key: re-encrypted for the region's key
 *   skip      rows that aren't sent (each install has its own built-in keys)
 *   keepLocal rows a region keeps although the control plane doesn't send them
 */
type Row = Record<string, unknown>;
export interface Replicated {
  name: string;
  key: readonly string[];
  local: readonly string[];
  volatile?: readonly string[];
  enc: readonly string[];
  skip?: (row: Row) => boolean;
  keepLocal?: (row: Row) => boolean;
}

const builtIn = (row: Row) => BUILT_IN_KEYS.has(String(row.id));

export const REPLICATED: readonly Replicated[] = [
  { name: 'zones', key: ['id'], local: [], enc: [] },
  { name: 'rules', key: ['id'], local: [], enc: [] },
  { name: 'providers', key: ['id'], local: ['health', 'health_detail', 'stream_usage_supported'], volatile: ['updated_at'], enc: ['creds_enc'] },
  { name: 'deployments', key: ['id'], local: ['health', 'health_detail', 'health_checked_at', 'cooling_until', 'ewma_ttft_ms'], enc: [] },
  { name: 'aliases', key: ['id'], local: [], enc: [] },
  { name: 'alias_targets', key: ['alias_id', 'deployment_id'], local: [], enc: [] },
  { name: 'api_keys', key: ['id'], local: ['last_used_at', 'rotation_claim', 'rotation_claim_until'], enc: [], skip: builtIn, keepLocal: builtIn },
  { name: 'budgets', key: ['id'], local: ['spent_nanousd', 'resets_at'], enc: [] },
  { name: 'customers', key: ['id'], local: [], enc: [] },
  { name: 'mcp_servers', key: ['id'], local: ['health', 'health_detail', 'tools_cache', 'tools_hash', 'last_checked_at'], volatile: ['updated_at'], enc: ['auth_enc'] },
  { name: 'http_apis', key: ['id'], local: ['health', 'health_detail', 'last_checked_at'], volatile: ['updated_at'], enc: ['auth_enc'] },
  { name: 'a2a_agents', key: ['id'], local: ['health', 'health_detail', 'card_cache', 'endpoint', 'protocol_version', 'last_checked_at'], volatile: ['updated_at'], enc: ['auth_enc'] },
  { name: 'guardrail_services', key: ['id'], local: ['last_status', 'last_error', 'last_checked_at'], enc: ['config_enc'] },
  { name: 'export_destinations', key: ['id'], local: ['last_status', 'last_error', 'last_sent_at', 'sent_count', 'dropped_count'], enc: ['config_enc'] },
  { name: 'token_issuers', key: ['id'], local: ['last_status', 'last_error', 'accepted_count', 'refused_count', 'last_refusal', 'last_refusal_at', 'last_used_at'], enc: [] },
  { name: 'secret_managers', key: ['id'], local: [], enc: ['config_enc'] },
  { name: 'alert_channels', key: ['id'], local: ['last_status', 'last_error', 'last_sent_at'], enc: ['config_enc'] },
  { name: 'alert_rules', key: ['id'], local: ['last_fired_at'], enc: [] },
];

/** Settings a region takes: the license (and its renewals, which the control plane fetches). */
export const SETTINGS_KEYS = ['license_key', 'license_key_renewed'] as const;

/** `v1=<hex HMAC-SHA256(token, body)>`: only the control plane (which holds the token) can make it. */
export const sign = (token: string, body: string) => `v1=${crypto.createHmac('sha256', token).update(body).digest('hex')}`;
export function verify(token: string, body: string, signature: string | null | undefined): boolean {
  if (!signature) return false;
  const want = Buffer.from(sign(token, body));
  const got = Buffer.from(signature);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
