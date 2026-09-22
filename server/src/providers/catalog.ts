import type { ProviderKind } from '@controltower/shared';

/**
 * The provider catalogue shown in the console. A catalogue entry maps to an
 * adapter kind plus defaults; the user supplies credentials in the browser.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  baseUrlEditable: boolean;
  fields: Array<{ key: string; label: string; secret: boolean; placeholder?: string; required: boolean }>;
  extra?: Record<string, unknown>;
  docs?: string;
  /** Adapter availability in this build. */
  available: boolean;
  suggestedModels?: string[];
}

export const PROVIDER_CATALOG: CatalogEntry[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    baseUrlEditable: true,
    fields: [
      { key: 'api_key', label: 'API key', secret: true, placeholder: 'sk-…', required: true },
    ],
    docs: 'https://platform.openai.com/api-keys',
    available: true,
    suggestedModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini', 'text-embedding-3-small'],
  },
  {
    id: 'azure-openai',
    name: 'Azure OpenAI',
    kind: 'azure-openai',
    baseUrl: 'https://YOUR-RESOURCE.openai.azure.com',
    baseUrlEditable: true,
    fields: [
      { key: 'api_key', label: 'API key', secret: true, required: true },
    ],
    extra: { api_version: '2024-10-21' },
    docs: 'https://learn.microsoft.com/azure/ai-services/openai/',
    available: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    baseUrlEditable: true,
    fields: [{ key: 'api_key', label: 'API key', secret: true, placeholder: 'sk-ant-…', required: true }],
    docs: 'https://console.anthropic.com/settings/keys',
    available: true,
    suggestedModels: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    baseUrlEditable: false,
    fields: [{ key: 'api_key', label: 'API key', secret: true, required: true }],
    docs: 'https://aistudio.google.com/apikey',
    available: false,
    suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  {
    id: 'bedrock',
    name: 'AWS Bedrock',
    kind: 'bedrock',
    baseUrlEditable: false,
    fields: [
      { key: 'access_key_id', label: 'Access key ID', secret: false, required: false },
      { key: 'secret_access_key', label: 'Secret access key', secret: true, required: false },
      { key: 'region', label: 'Region', secret: false, placeholder: 'us-east-1', required: true },
    ],
    available: false,
  },
  { id: 'groq', name: 'Groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', baseUrlEditable: false, fields: [{ key: 'api_key', label: 'API key', secret: true, required: true }], available: true, suggestedModels: ['llama-3.3-70b-versatile'] },
  { id: 'together', name: 'Together AI', kind: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1', baseUrlEditable: false, fields: [{ key: 'api_key', label: 'API key', secret: true, required: true }], available: true },
  { id: 'fireworks', name: 'Fireworks', kind: 'openai-compatible', baseUrl: 'https://api.fireworks.ai/inference/v1', baseUrlEditable: false, fields: [{ key: 'api_key', label: 'API key', secret: true, required: true }], available: true },
  { id: 'mistral', name: 'Mistral', kind: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1', baseUrlEditable: false, fields: [{ key: 'api_key', label: 'API key', secret: true, required: true }], available: true, suggestedModels: ['mistral-large-latest', 'mistral-small-latest'] },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', baseUrlEditable: false, fields: [{ key: 'api_key', label: 'API key', secret: true, required: true }], available: true, suggestedModels: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'xai', name: 'xAI', kind: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', baseUrlEditable: false, fields: [{ key: 'api_key', label: 'API key', secret: true, required: true }], available: true, suggestedModels: ['grok-4'] },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', baseUrlEditable: false, fields: [{ key: 'api_key', label: 'API key', secret: true, required: true }], available: true },
  { id: 'perplexity', name: 'Perplexity', kind: 'openai-compatible', baseUrl: 'https://api.perplexity.ai', baseUrlEditable: false, fields: [{ key: 'api_key', label: 'API key', secret: true, required: true }], available: true },
  { id: 'ollama', name: 'Ollama (local)', kind: 'openai-compatible', baseUrl: 'http://host.docker.internal:11434/v1', baseUrlEditable: true, fields: [], extra: { auth_style: 'none' }, available: true, suggestedModels: ['llama3.2', 'qwen2.5'] },
  { id: 'vllm', name: 'vLLM', kind: 'openai-compatible', baseUrl: 'http://localhost:8000/v1', baseUrlEditable: true, fields: [{ key: 'api_key', label: 'API key (optional)', secret: true, required: false }], available: true },
  { id: 'lmstudio', name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://host.docker.internal:1234/v1', baseUrlEditable: true, fields: [], extra: { auth_style: 'none' }, available: true },
  { id: 'custom', name: 'Custom OpenAI-compatible', kind: 'openai-compatible', baseUrl: 'https://', baseUrlEditable: true, fields: [{ key: 'api_key', label: 'API key (optional)', secret: true, required: false }], available: true },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return PROVIDER_CATALOG.find((c) => c.id === id);
}
