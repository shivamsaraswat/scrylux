import type { GenerateContentResponse } from '@google/genai';
import { AdapterError } from '../errors.js';
import { createFetch } from './http.js';
import { categoryForStatus, classifyBadRequest } from './shared.js';
import { userTurn, type Adapter, type GenerateInput, type GenerateOutcome } from './types.js';

export interface GeminiAdapterOptions {
  apiKey: string;
  /** Tests only reach another address (through @scrylux/llm/testing). Otherwise Google's own address is used. */
  baseUrl?: string;
  model: string;
  timeoutMs: number;
}

const GOOGLE_ADDRESS = 'https://generativelanguage.googleapis.com/';
const REFUSED_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'RECITATION']);
// Gemini answers a bad key with a 400, not a 401.
const BAD_KEY = /API key not valid|API_KEY_INVALID|API key expired/i;
const RETRY_DELAY = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/;

/**
 * The Gemini Developer API through Google's official SDK, loaded here and nowhere else. It is always the Developer
 * API with an API key (FR-002a): Vertex AI is out of scope, and `vertexai` and `enterprise` are pinned off so a stray
 * GOOGLE_GENAI_USE_* variable cannot switch it. The SDK's own retries are off (its default is five attempts).
 */
export async function createGeminiAdapter(options: GeminiAdapterOptions): Promise<Adapter> {
  const sdk = await import('@google/genai');
  const client = new sdk.GoogleGenAI({
    apiKey: options.apiKey,
    vertexai: false,
    enterprise: false,
    httpOptions: {
      // Always set, so GOOGLE_GEMINI_BASE_URL cannot choose the address (FR-043a).
      baseUrl: options.baseUrl ?? GOOGLE_ADDRESS,
      timeout: options.timeoutMs,
      fetch: await createFetch(options.timeoutMs),
      retryOptions: { attempts: 1 },
    },
  });

  function mapError(error: unknown, signal: AbortSignal): AdapterError {
    if (signal.aborted && !(error instanceof sdk.ApiError)) return new AdapterError('cancelled');
    if (error instanceof sdk.ApiError) {
      const category = categoryForStatus(error.status);
      if (category === 'rate_limited') {
        const delay = RETRY_DELAY.exec(error.message)?.[1];
        return new AdapterError('rate_limited', delay === undefined ? {} : { retryAfterMs: Math.round(Number(delay) * 1000) });
      }
      if (category !== undefined) return new AdapterError(category);
      if (BAD_KEY.test(error.message)) return new AdapterError('not_authorized');
      return classifyBadRequest(error.message);
    }
    return new AdapterError('provider_unavailable');
  }

  return {
    async generateOnce(input: GenerateInput): Promise<GenerateOutcome> {
      let response: GenerateContentResponse;
      try {
        response = await client.models.generateContent({
          model: options.model,
          contents: [{ role: 'user', parts: [{ text: userTurn(input) }] }],
          config: {
            systemInstruction: input.system,
            maxOutputTokens: input.maxOutputTokens,
            ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
            ...(input.mode === 'native' ? { responseMimeType: 'application/json', responseJsonSchema: input.jsonSchema } : {}),
            abortSignal: input.signal,
          },
        });
      } catch (error) {
        throw mapError(error, input.signal);
      }

      const usage = response.usageMetadata;
      const tokens =
        usage === undefined
          ? {}
          : {
              ...(usage.promptTokenCount === undefined ? {} : { inputTokens: usage.promptTokenCount }),
              ...(usage.candidatesTokenCount === undefined && usage.thoughtsTokenCount === undefined
                ? {}
                : { outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) }),
            };
      if (response.promptFeedback?.blockReason !== undefined) return { kind: 'refused', ...tokens };
      const candidate = response.candidates?.[0];
      if (candidate?.finishReason !== undefined && REFUSED_FINISH.has(String(candidate.finishReason))) return { kind: 'refused', ...tokens };
      if (String(candidate?.finishReason) === 'MAX_TOKENS') return { kind: 'cut_off', ...tokens };
      const text = (candidate?.content?.parts ?? []).flatMap((part) => (part.thought !== true && typeof part.text === 'string' ? [part.text] : [])).join('');
      return { kind: 'answer', text, ...tokens };
    },

    async embedBatch(texts, call) {
      let response;
      try {
        // One Content per text: several texts in one Content would be combined into a single vector (research #17).
        response = await client.models.embedContent({
          model: options.model,
          contents: texts.map((text) => ({ parts: [{ text }] })),
          config: { abortSignal: call.signal },
        });
      } catch (error) {
        throw mapError(error, call.signal);
      }
      // The Developer API reports no token count for an embedding, so the layer estimates it.
      return { vectors: (response.embeddings ?? []).map((e) => e.values ?? []) };
    },
  };
}
