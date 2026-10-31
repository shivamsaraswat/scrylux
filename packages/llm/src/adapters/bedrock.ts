import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { AdapterError } from '../errors.js';
import { resolveCapability } from '../capabilities.js';
import { classifyBadRequest } from './shared.js';
import { userTurn, type Adapter, type GenerateInput, type GenerateOutcome } from './types.js';

export interface BedrockAdapterOptions {
  region: string;
  model: string;
  timeoutMs: number;
  /**
   * Tests only, set through @scrylux/llm/testing: another address and static credentials. In production both are
   * absent, and the AWS default credential chain applies (an instance or task role, or the usual AWS variables).
   */
  test?: { endpoint?: string; credentials?: { accessKeyId: string; secretAccessKey: string } };
}

interface AwsError {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

const NOT_AUTHORIZED = new Set([
  'AccessDeniedException',
  'UnrecognizedClientException',
  'ExpiredTokenException',
  'InvalidSignatureException',
  'UnauthorizedException',
  'CredentialsProviderError',
]);
const RATE_LIMITED = new Set(['ThrottlingException', 'ServiceQuotaExceededException', 'TooManyRequestsException']);
const UNAVAILABLE = new Set([
  'InternalServerException',
  'ServiceUnavailableException',
  'ModelNotReadyException',
  'ModelTimeoutException',
  'ModelErrorException',
  'TimeoutError',
]);
const MODEL_ACCESS = /model (identifier|id)|access to the model|not authorized to invoke|isn't supported in this region/i;

/**
 * Bedrock's Converse API through the official AWS SDK, loaded here and nowhere else. The SDK's retries are off
 * (maxAttempts 1). The region is passed explicitly, and credentials come from the AWS default chain by design
 * (FR-004), so Bedrock needs no key of Scrylux's own.
 */
export async function createBedrockAdapter(options: BedrockAdapterOptions): Promise<Adapter> {
  const sdk = await import('@aws-sdk/client-bedrock-runtime');
  const client = new sdk.BedrockRuntimeClient({
    region: options.region,
    maxAttempts: 1,
    // The handler's limit is for an idle connection, not for the whole call. The attempt loop's time limit,
    // which reaches the call through its abort signal, is the one that bounds a call.
    requestHandler: { requestTimeout: options.timeoutMs },
    ...(options.test?.endpoint === undefined ? {} : { endpoint: options.test.endpoint }),
    ...(options.test?.credentials === undefined ? {} : { credentials: options.test.credentials }),
  });

  function mapError(error: unknown): AdapterError {
    const e = (error ?? {}) as AwsError;
    const name = e.name ?? '';
    if (name === 'AbortError') return new AdapterError('cancelled');
    if (NOT_AUTHORIZED.has(name)) return new AdapterError('not_authorized');
    if (RATE_LIMITED.has(name)) return new AdapterError('rate_limited');
    if (name === 'ResourceNotFoundException') return new AdapterError('not_available');
    if (name === 'ValidationException') {
      const text = e.message ?? '';
      return MODEL_ACCESS.test(text) ? new AdapterError('not_available') : classifyBadRequest(text);
    }
    if (UNAVAILABLE.has(name)) return new AdapterError('provider_unavailable');
    return new AdapterError('provider_unavailable');
  }

  return {
    async generateOnce(input: GenerateInput): Promise<GenerateOutcome> {
      let response: ConverseCommandOutput;
      try {
        response = await client.send(
          new sdk.ConverseCommand({
            modelId: options.model,
            system: [{ text: input.system }],
            messages: [{ role: 'user', content: [{ text: userTurn(input) }] }],
            inferenceConfig: {
              maxTokens: input.maxOutputTokens,
              ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
            },
            ...(input.mode === 'native'
              ? {
                  outputConfig: {
                    textFormat: {
                      type: 'json_schema' as const,
                      structure: { jsonSchema: { schema: JSON.stringify(input.jsonSchema), name: input.schemaName } },
                    },
                  },
                }
              : {}),
          }),
          { abortSignal: input.signal },
        );
      } catch (error) {
        throw mapError(error);
      }

      const usage = response.usage;
      const tokens =
        usage === undefined
          ? {}
          : {
              inputTokens: (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0),
              outputTokens: usage.outputTokens ?? 0,
            };
      if (response.stopReason === 'content_filtered' || response.stopReason === 'guardrail_intervened') return { kind: 'refused', ...tokens };
      if (response.stopReason === 'max_tokens' || response.stopReason === 'model_context_window_exceeded') return { kind: 'cut_off', ...tokens };
      const text = (response.output?.message?.content ?? []).flatMap((block) => ('text' in block && typeof block.text === 'string' ? [block.text] : [])).join('');
      return { kind: 'answer', text, ...tokens };
    },

    async embedBatch(texts, call) {
      // Only Amazon Titan Text Embeddings V2's request body is known (research #17). Any other model fails before
      // anything is sent.
      if (resolveCapability('bedrock', options.model).embeddingBody !== 'titan-v2') throw new AdapterError('not_available');
      const vectors: number[][] = [];
      let inputTokens = 0;
      for (const text of texts) {
        let response;
        try {
          response = await client.send(
            new sdk.InvokeModelCommand({
              modelId: options.model,
              contentType: 'application/json',
              accept: 'application/json',
              body: JSON.stringify({ inputText: text }),
            }),
            { abortSignal: call.signal },
          );
        } catch (error) {
          throw mapError(error);
        }
        const answer = JSON.parse(new TextDecoder().decode(response.body)) as { embedding?: unknown; inputTextTokenCount?: unknown };
        if (!Array.isArray(answer.embedding)) throw new AdapterError('rejected');
        vectors.push(answer.embedding as number[]);
        if (typeof answer.inputTextTokenCount === 'number') inputTokens += answer.inputTextTokenCount;
      }
      return { vectors, inputTokens };
    },
  };
}
