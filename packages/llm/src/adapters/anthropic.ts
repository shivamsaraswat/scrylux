import type Anthropic from '@anthropic-ai/sdk';
import { AdapterError } from '../errors.js';
import { createFetch } from './http.js';
import { categoryForStatus, classifyBadRequest, headerValue, parseRetryAfter } from './shared.js';
import { userTurn, type Adapter, type GenerateInput, type GenerateOutcome } from './types.js';

export interface AnthropicAdapterOptions {
  apiKey: string;
  /** Tests only reach another address (through @scrylux/llm/testing). Otherwise the SDK's own address is used. */
  baseURL?: string;
  model: string;
  timeoutMs: number;
}

/**
 * Anthropic's Messages API through the official SDK, which is loaded here and nowhere else. Retries are the attempt
 * loop's, so the SDK's are off. Every client option that has an environment default is set explicitly, so a stray
 * ANTHROPIC_* variable cannot change the key, the address or the logging (FR-043a, research #12).
 */
export async function createAnthropicAdapter(options: AnthropicAdapterOptions): Promise<Adapter> {
  const sdk = await import('@anthropic-ai/sdk');
  const Client = sdk.default;
  const client = new Client({
    apiKey: options.apiKey,
    authToken: null,
    baseURL: options.baseURL ?? 'https://api.anthropic.com',
    webhookKey: null,
    maxRetries: 0,
    // Also set per request. A client-level timeout switches off the SDK's own estimate of how long a large
    // non-streaming request may take, which the attempt loop's time limit replaces.
    timeout: options.timeoutMs,
    fetch: await createFetch(options.timeoutMs),
    logLevel: 'off',
  });

  function mapError(error: unknown): AdapterError {
    if (error instanceof Client.APIUserAbortError) return new AdapterError('cancelled');
    if (error instanceof Client.APIConnectionError) return new AdapterError('provider_unavailable');
    if (error instanceof Client.APIError && typeof error.status === 'number') {
      const category = categoryForStatus(error.status);
      if (category === 'rate_limited') {
        const retryAfterMs = parseRetryAfter(headerValue(error.headers, 'retry-after'));
        return new AdapterError('rate_limited', retryAfterMs === undefined ? {} : { retryAfterMs });
      }
      if (category !== undefined) return new AdapterError(category);
      const body = error.error as { error?: { message?: unknown } } | undefined;
      const text = typeof body?.error?.message === 'string' ? body.error.message : error.message;
      return classifyBadRequest(text);
    }
    return new AdapterError('provider_unavailable');
  }

  return {
    async generateOnce(input: GenerateInput): Promise<GenerateOutcome> {
      let response: Anthropic.Message;
      try {
        response = await client.messages.create(
          {
            model: options.model,
            max_tokens: input.maxOutputTokens,
            system: input.system,
            messages: [{ role: 'user', content: userTurn(input) }],
            ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
            ...(input.mode === 'native' ? { output_config: { format: { type: 'json_schema' as const, schema: input.jsonSchema } } } : {}),
          },
          { timeout: input.timeoutMs, signal: input.signal },
        );
      } catch (error) {
        throw mapError(error);
      }

      const usage = response.usage;
      const tokens = {
        inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
      };
      if (response.stop_reason === 'refusal') return { kind: 'refused', ...tokens };
      if (response.stop_reason === 'max_tokens' || response.stop_reason === 'model_context_window_exceeded') {
        return { kind: 'cut_off', ...tokens };
      }
      const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
      return { kind: 'answer', text, ...tokens };
    },

    embedBatch(): Promise<never> {
      // Anthropic offers no embeddings (FR-002), and the configuration refuses it for that operation.
      return Promise.reject(new AdapterError('not_available'));
    },
  };
}
