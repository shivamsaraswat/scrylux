import type { LlmConfig, OperationConfig, ProviderName } from '../src/types.js';

// A hand-built configuration for tests that skip parseLlmConfig.
export function operation(provider: ProviderName, over: Partial<OperationConfig> = {}): OperationConfig {
  return {
    provider,
    model: 'test-model',
    baseUrl: provider === 'openai-compatible' ? 'http://127.0.0.1:1/v1' : null,
    apiKey: provider === 'bedrock' ? null : 'fake-key',
    region: provider === 'bedrock' ? 'us-east-1' : null,
    local: false,
    hosted: true,
    operatorPrice: null,
    ...over,
  };
}

export function config(over: Partial<LlmConfig> = {}): LlmConfig {
  return { generation: null, embedding: null, timeoutMs: 5000, ...over };
}
