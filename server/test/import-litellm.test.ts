import { describe, expect, it } from 'vitest';
import { planLiteLLMImport, publicPlan } from '../src/importers/litellm.js';

const none = () => ({ providerSlugs: new Set<string>(), modelNames: new Set<string>(), mcpSlugs: new Set<string>() });

describe('LiteLLM config import', () => {
  it('turns a load-balanced group with order tiers and a credential set into an alias', () => {
    const plan = planLiteLLMImport(
      `
credential_list:
  - credential_name: azure-eastus
    credential_values: {api_key: os.environ/AZ_EAST_KEY, api_base: https://acme-east.openai.azure.com, api_version: "2025-03-01-preview"}
model_list:
  - model_name: gpt-4o
    litellm_params: {model: azure/prod-gpt4o, litellm_credential_name: azure-eastus, rpm: 900, order: 1}
  - model_name: gpt-4o
    litellm_params: {model: openai/gpt-4o, api_key: os.environ/OPENAI_API_KEY, rpm: 300, order: 2}
  - model_name: embed
    litellm_params: {model: openai/text-embedding-3-small, input_cost_per_token: 0.00000002, output_cost_per_token: 0}
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
    expect(plan.warnings.join('\n')).toContain('master_key, database_url');
    expect(publicPlan(plan).missing).toEqual([{ provider_ref: 'p2', provider: 'OpenAI', field: 'api_key', label: 'API key', env: 'OPENAI_API_KEY' }]);
    // Resolved secrets never appear in the public plan.
    expect(JSON.stringify(publicPlan(plan))).not.toContain('az-secret');
  });

  it('maps Bedrock and Vertex, and skips wildcards', () => {
    const plan = planLiteLLMImport(
      `
model_list:
  - model_name: claude-sonnet
    litellm_params: {model: bedrock/converse/anthropic.claude-sonnet-4-v1:0, aws_region_name: us-west-2, aws_access_key_id: os.environ/AWS_KEY, aws_secret_access_key: os.environ/AWS_SECRET, weight: 3}
  - model_name: claude-sonnet
    litellm_params: {model: vertex_ai/claude-sonnet-4, vertex_project: acme-ml, vertex_location: us-east5, vertex_credentials: /secrets/sa.json, weight: 1}
  - model_name: "gemini/*"
    litellm_params: {model: "gemini/*", api_key: os.environ/GEMINI_API_KEY}
`,
      { AWS_KEY: 'AKIAEXAMPLE', AWS_SECRET: 'shh' },
      none(),
    );
    expect(plan.providers.map((p) => [p.catalogId, p.values, p.extra])).toEqual([
      ['bedrock', { access_key_id: 'AKIAEXAMPLE', secret_access_key: 'shh', region: 'us-west-2' }, {}],
      ['vertex', {}, { project: 'acme-ml', location: 'us-east5' }],
    ]);
    expect(plan.providers[1]!.creds[0]!.label).toContain('/secrets/sa.json');
    expect(plan.deployments.map((d) => d.upstreamModel)).toEqual(['anthropic.claude-sonnet-4-v1:0', 'claude-sonnet-4']);
    expect(plan.aliases[0]).toMatchObject({ name: 'claude-sonnet', strategy: 'weighted' });
    expect(plan.skipped).toEqual([{ name: 'gemini/*', reason: 'wildcard routes are not imported — add the models you use explicitly' }]);
  });

  it('adds fallbacks after the group, recognises OpenAI-compatible hosts and keyless local servers', () => {
    const plan = planLiteLLMImport(
      `
model_list:
  - model_name: local-llama
    litellm_params: {model: openai/meta-llama-3.1-70b, api_base: http://vllm.internal:8000/v1, api_key: none}
  - model_name: fast
    litellm_params: {model: openai/llama-3.3-70b-versatile, api_base: https://api.groq.com/openai/v1, api_key: gsk_literal}
  - model_name: gpt-4o
    litellm_params: {model: gpt-4o}
litellm_settings:
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

  it('never resolves Control Tower variables and rejects non-configs', () => {
    const plan = planLiteLLMImport('model_list:\n  - model_name: x\n    litellm_params: {model: openai/x, api_key: os.environ/CT_MASTER_KEY}\n', { CT_MASTER_KEY: 'master' }, none());
    expect(plan.providers[0]!.values).toEqual({});
    expect(() => planLiteLLMImport('just: text', {}, none())).toThrow('No model_list');
    expect(() => planLiteLLMImport('model_list: [\n', {}, none())).toThrow('Not valid YAML');
  });
});
