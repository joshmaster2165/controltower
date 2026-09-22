import type { ProviderKind } from '@controltower/shared';
import type { ProviderAdapter } from './adapter.js';
import { MockAdapter } from './mock.js';
import { OpenAICompatAdapter } from './openai-compat.js';
import { AnthropicAdapter } from './anthropic.js';

/**
 * Adapter registry. Adapters are stateless; one instance per kind.
 * OpenAI-compatible, Anthropic, Gemini, Bedrock and Vertex adapters are added
 * here as they land (build steps 3–4 in the plan).
 */
export class Adapters {
  private byKind = new Map<ProviderKind, ProviderAdapter>();

  constructor() {
    this.register(new MockAdapter());
    this.register(new OpenAICompatAdapter('openai'));
    this.register(new OpenAICompatAdapter('azure-openai'));
    this.register(new OpenAICompatAdapter('openai-compatible'));
    this.register(new AnthropicAdapter());
  }

  register(a: ProviderAdapter): void {
    this.byKind.set(a.kind, a);
  }

  get(kind: ProviderKind): ProviderAdapter | undefined {
    return this.byKind.get(kind);
  }

  kinds(): ProviderKind[] {
    return [...this.byKind.keys()];
  }
}

export type { ProviderAdapter } from './adapter.js';
