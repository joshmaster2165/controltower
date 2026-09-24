import { describe, expect, it } from 'vitest';
import { planConfigImport, publicPlan } from '../src/importers/config.js';

const none = () => ({ providerSlugs: new Set<string>(), modelNames: new Set<string>(), mcpSlugs: new Set<string>() });

describe('config file import', () => {
  it('turns a load-balanced group with order tiers and a credential set into an alias', () => {
    const plan = planConfigImport(
      `
credential_list:
  - credential_name: azure-eastus
    credential_values: {api_key: os.environ/AZ_EAST_KEY, api_base: https://acme-east.openai.azure.com, api_version: "2025-03-01-preview"}
model_list:
  - model_name: gpt-4o
    params: {model: azure/prod-gpt4o, credential: azure-eastus, rpm: 900, order: 1}
  - model_name: gpt-4o
    params: {model: openai/gpt-4o, api_key: os.environ/OPENAI_API_KEY, rpm: 300, order: 2}
  - model_name: embed
    params: {model: openai/text-embedding-3-small, input_cost_per_token: 0.00000002, output_cost_per_token: 0}
    model_info: {mode: embedding}
router_settings: {routing_strategy: usage-based-routing-v2, num_retries: 2}
general_settings: {master_key: sk-1234, database_url: postgres://x}
`,
      { AZ_EAST_KEY: 'az-secret', CT_MASTER_KEY: 'never' },
      none(),
    );
    expect(plan.providers.map((p) => [p.name, p.catalogId, p.baseUrl, p.creds.map((c) => `${c.field}:${c.from}`)])).toEqual([
      ['azure-eastus', 'azure-openai', 'https://acme-east.openai.azure.com', ['api_key:env']],
      ['OpenAI', 'openai', undefined, ['api_key:missing']],
    ]);
    expect(plan.providers[0]!.values).toEqual({ api_key: 'az-secret' });
    expect(plan.providers[0]!.extra).toEqual({ api_version: '2025-03-01-preview' });
    // Both OpenAI entries share one provider (same endpoint, same key reference).
    expect(plan.deployments.map((d) => [d.upstreamModel, d.providerRef, d.publicName, d.weight])).toEqual([
      ['prod-gpt4o', 'p1', null, 900],
      ['gpt-4o', 'p2', null, 300],
      ['text-embedding-3-small', 'p2', 'embed', 100],
    ]);
    expect(plan.deployments[2]!.pricing).toEqual({ input: 0.02, output: 0, mode: 'embedding' });
    // Different `order` tiers: a priority alias, Azure first.
    expect(plan.aliases).toEqual([{ name: 'gpt-4o', strategy: 'priority', targets: [{ deploymentRef: 'd1', priority: 0, weight: 900 }, { deploymentRef: 'd2', priority: 1, weight: 300 }] }]);
    expect(plan.warnings.join('\n')).toContain('ignored (Control Tower has its own): database_url');
    // The master key is honoured when the file is loaded with --config.
    expect(plan.settings.masterKey).toBe('sk-1234');
    expect(publicPlan(plan).missing).toEqual([{ provider_ref: 'p2', provider: 'OpenAI', field: 'api_key', label: 'API key', env: 'OPENAI_API_KEY' }]);
    // Resolved secrets never appear in the public plan.
    expect(JSON.stringify(publicPlan(plan))).not.toContain('az-secret');
  });

  it('maps Bedrock and Vertex, and connects a provider for a wildcard', () => {
    const plan = planConfigImport(
      `
model_list:
  - model_name: claude-sonnet
    params: {model: bedrock/converse/anthropic.claude-sonnet-4-v1:0, aws_region_name: us-west-2, aws_access_key_id: os.environ/AWS_KEY, aws_secret_access_key: os.environ/AWS_SECRET, weight: 3}
  - model_name: claude-sonnet
    params: {model: vertex_ai/claude-sonnet-4, vertex_project: acme-ml, vertex_location: us-east5, vertex_credentials: /secrets/sa.json, weight: 1}
  - model_name: "gemini/*"
    params: {model: "gemini/*", api_key: os.environ/GEMINI_API_KEY}
`,
      { AWS_KEY: 'AKIAEXAMPLE', AWS_SECRET: 'shh' },
      none(),
    );
    expect(plan.providers.map((p) => [p.catalogId, p.values, p.extra])).toEqual([
      ['bedrock', { access_key_id: 'AKIAEXAMPLE', secret_access_key: 'shh', region: 'us-west-2' }, {}],
      ['vertex', {}, { project: 'acme-ml', location: 'us-east5' }],
      ['gemini', {}, {}],
    ]);
    // gemini/* connects Gemini with no deployments: its models are added on first use.
    expect(plan.providers[2]!.wildcard).toBe(true);
    expect(plan.providers[1]!.creds[0]!.label).toContain('/secrets/sa.json');
    expect(plan.deployments.map((d) => d.upstreamModel)).toEqual(['anthropic.claude-sonnet-4-v1:0', 'claude-sonnet-4']);
    expect(plan.aliases[0]).toMatchObject({ name: 'claude-sonnet', strategy: 'weighted' });
    expect(plan.skipped).toEqual([]);
    expect(plan.warnings.join('\n')).toContain('models are added the first time an agent asks for one');
  });

  it('turns model "*" into every provider whose key is in the environment, and reads Slack alerting', () => {
    const plan = planConfigImport(
      `
model_list:
  - model_name: "*"
    params: {model: "*"}
general_settings: {master_key: os.environ/ADMIN_MASTER_KEY, alerting: ["slack"], alert_types: ["llm_exceptions", "budget_alerts"]}
`,
      { OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a', ADMIN_MASTER_KEY: 'sk-master', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' },
      none(),
    );
    expect(plan.providers.map((p) => p.catalogId).sort()).toEqual(['anthropic', 'openai']);
    expect(plan.deployments).toEqual([]);
    expect(plan.settings).toEqual({ masterKey: 'sk-master', slack: { webhook: 'https://hooks.slack.com/services/T/B/x', alertTypes: ['llm_exceptions', 'budget_alerts'] } });
  });

  it('adds fallbacks after the group, recognises OpenAI-compatible hosts and keyless local servers', () => {
    const plan = planConfigImport(
      `
model_list:
  - model_name: local-llama
    params: {model: openai/meta-llama-3.1-70b, api_base: http://vllm.internal:8000/v1, api_key: none}
  - model_name: fast
    params: {model: openai/llama-3.3-70b-versatile, api_base: https://api.groq.com/openai/v1, api_key: gsk_literal}
  - model_name: gpt-4o
    params: {model: gpt-4o}
settings:
  fallbacks: [{local-llama: [fast, missing-model]}]
  context_window_fallbacks: [{fast: [gpt-4o]}]
mcp_servers:
  crm: {url: https://crm.example.com/mcp, transport: http}
  local: {transport: stdio, command: npx}
`,
      {},
      { providerSlugs: new Set(['openai']), modelNames: new Set(['gpt-4o']), mcpSlugs: new Set() },
    );
    expect(plan.providers.map((p) => [p.catalogId, p.slug, p.extra])).toEqual([
      ['custom', 'openai-compatible-vllm-i', { auth_style: 'none' }],
      ['groq', 'groq', {}],
    ]);
    expect(plan.aliases).toEqual([
      { name: 'local-llama', strategy: 'weighted', targets: [{ deploymentRef: 'd1', priority: 0, weight: 100 }, { deploymentRef: 'd2', priority: 1, weight: 100, viaFallback: 'fast' }] },
    ]);
    expect(plan.deployments.find((d) => d.group === 'fast')!.publicName).toBe('fast');
    expect(plan.skipped.map((s) => s.name)).toEqual(['gpt-4o', 'MCP local']);
    expect(plan.mcpServers).toEqual([{ name: 'crm', slug: 'crm', url: 'https://crm.example.com/mcp' }]);
    const w = plan.warnings.join('\n');
    expect(w).toContain('no provider prefix on "gpt-4o"');
    expect(w).toContain('fallback "missing-model" is not a model in this file');
    expect(w).toContain('context_window_fallbacks are not imported');
  });

  it('accepts the long-form keys other gateways\' files use', () => {
    const short = planConfigImport('model_list:\n  - model_name: fast\n    params: {model: openai/gpt-4.1-mini, api_key: sk-a, credential: shared}\ncredential_list:\n  - credential_name: shared\n    credential_values: {api_base: https://proxy.example.com/v1}\nsettings:\n  fallbacks: [{fast: [fast]}]\n', {}, none());
    const long = planConfigImport('model_list:\n  - model_name: fast\n    litellm_params: {model: openai/gpt-4.1-mini, api_key: sk-a, litellm_credential_name: shared}\ncredential_list:\n  - credential_name: shared\n    credential_values: {api_base: https://proxy.example.com/v1}\nlitellm_settings:\n  fallbacks: [{fast: [fast]}]\n', {}, none());
    expect(publicPlan(long)).toEqual(publicPlan(short));
    expect(short.providers[0]!.baseUrl).toBe('https://proxy.example.com/v1');
  });

  it('never resolves Control Tower variables and rejects non-configs', () => {
    const plan = planConfigImport('model_list:\n  - model_name: x\n    params: {model: openai/x, api_key: os.environ/CT_MASTER_KEY}\n', { CT_MASTER_KEY: 'master' }, none());
    expect(plan.providers[0]!.values).toEqual({});
    expect(() => planConfigImport('just: text', {}, none())).toThrow('No model_list');
    expect(() => planConfigImport('model_list: [\n', {}, none())).toThrow('Not valid YAML');
  });
});
