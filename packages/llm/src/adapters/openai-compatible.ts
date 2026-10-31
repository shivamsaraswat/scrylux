import type OpenAI from 'openai';
import { AdapterError } from '../errors.js';
import { createFetch } from './http.js';
import { categoryForStatus, classifyBadRequest, headerValue, parseRetryAfter } from './shared.js';
import { userTurn, type Adapter, type GenerateInput, type GenerateOutcome } from './types.js';

export interface OpenAICompatibleAdapterOptions {
  /** Null for a local server that needs none. */
  apiKey: string | null;
  /** OpenAI, Azure OpenAI's v1 address, Ollama, vLLM or any other server that speaks Chat Completions. */
  baseURL: string;
  model: string;
  timeoutMs: number;
}

// The SDK insists on a key; a server that needs none is sent this fixed placeholder, never a key from the environment.
const NO_KEY = 'unused';

/**
 * A base address may carry credentials (`https://user:pass@host/v1`), as one behind a proxy with basic authentication
 * does. fetch refuses such an address, so they are taken out of it and, when there is no API key, sent as basic
 * authentication. With a key, the key is used and the credentials are dropped.
 */
function splitCredentials(raw: string, hasKey: boolean): { baseURL: string; basic?: string } {
  const url = new URL(raw);
  if (url.username === '' && url.password === '') return { baseURL: raw };
  const basic = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64');
  url.username = '';
  url.password = '';
  return hasKey ? { baseURL: url.toString() } : { baseURL: url.toString(), basic };
}

/**
 * Chat Completions and /embeddings through the official `openai` SDK, loaded here and nowhere else. One adapter serves
 * OpenAI, Azure OpenAI, Ollama and vLLM through the base address (FR-003). The SDK's retries are off, and every
 * client option that has an environment default is set explicitly, so a stray OPENAI_* variable cannot add a key, an
 * organization, a different address or logging (FR-043a, research #12).
 */
export async function createOpenAICompatibleAdapter(options: OpenAICompatibleAdapterOptions): Promise<Adapter> {
  const sdk = await import('openai');
  const Client = sdk.default;
  const { baseURL, basic } = splitCredentials(options.baseURL, options.apiKey !== null);
  const client = new Client({
    apiKey: options.apiKey ?? NO_KEY,
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    baseURL,
    ...(basic === undefined ? {} : { defaultHeaders: { Authorization: `Basic ${basic}` } }),
    maxRetries: 0,
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
      const body = error.error as { message?: unknown } | undefined;
      const text = typeof body?.message === 'string' ? body.message : error.message;
      return classifyBadRequest(text, { code: error.code, param: error.param });
    }
    return new AdapterError('provider_unavailable');
  }

  return {
    async generateOnce(input: GenerateInput): Promise<GenerateOutcome> {
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await client.chat.completions.create(
          {
            model: options.model,
            messages: [
              { role: 'system', content: input.system },
              { role: 'user', content: userTurn(input) },
            ],
            ...(input.maxTokensParam === 'max_tokens'
              ? { max_tokens: input.maxOutputTokens }
              : { max_completion_tokens: input.maxOutputTokens }),
            ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
            ...(input.mode === 'native'
              ? {
                  response_format: {
                    type: 'json_schema' as const,
                    json_schema: { name: input.schemaName, schema: input.jsonSchema, strict: input.strict ?? false },
                  },
                }
              : input.mode === 'json_object'
                ? { response_format: { type: 'json_object' as const } }
                : {}),
          },
          { timeout: input.timeoutMs, signal: input.signal },
        );
      } catch (error) {
        throw mapError(error);
      }

      const tokens = {
        ...(completion.usage?.prompt_tokens === undefined ? {} : { inputTokens: completion.usage.prompt_tokens }),
        ...(completion.usage?.completion_tokens === undefined ? {} : { outputTokens: completion.usage.completion_tokens }),
      };
      const choice = completion.choices[0];
      if (choice?.message.refusal || choice?.finish_reason === 'content_filter') return { kind: 'refused', ...tokens };
      if (choice?.finish_reason === 'length') return { kind: 'cut_off', ...tokens };
      return { kind: 'answer', text: choice?.message.content ?? '', ...tokens };
    },

    async embedBatch(texts, call) {
      let response: OpenAI.CreateEmbeddingResponse;
      try {
        // Plain numbers, not the SDK's default base64: every server the adapter serves answers them the same way.
        response = await client.embeddings.create(
          { model: options.model, input: [...texts], encoding_format: 'float' },
          { timeout: call.timeoutMs, signal: call.signal },
        );
      } catch (error) {
        throw mapError(error);
      }
      const vectors = [...response.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
      return { vectors, ...(response.usage?.prompt_tokens === undefined ? {} : { inputTokens: response.usage.prompt_tokens }) };
    },
  };
}
