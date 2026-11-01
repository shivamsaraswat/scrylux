import { createAnthropicAdapter } from './adapters/anthropic.js';
import { createBedrockAdapter } from './adapters/bedrock.js';
import { createGeminiAdapter } from './adapters/gemini.js';
import { createOpenAICompatibleAdapter } from './adapters/openai-compatible.js';
import type { Adapter } from './adapters/types.js';
import { defaultDeps, runGenerate, type LoopDeps, type LoopResult } from './attempts.js';
import { buildPrompt } from './content.js';
import { resolveCapability } from './capabilities.js';
import { runEmbed } from './embed.js';
import { FAILURE_MESSAGES, LlmSchemaError, type FailureCategory } from './errors.js';
import { formatLogLine } from './log.js';
import { assertStrict, sanitizeFor, toJsonSchema } from './schema.js';
import type { EmbedResult, EmbeddingRequest, GenerateResult, Llm, LlmConfig, OperationConfig, StructuredRequest, Usage } from './types.js';
import { buildUsage } from './usage.js';

export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
const MAX_OUTPUT_TOKENS = 32_000;
export const DEFAULT_ATTEMPT_LIMIT = 3;
const SCHEMA_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
// A guard against an accidental unbounded call; Milestone 3 may change it when it knows its chunk counts.
const MAX_EMBEDDING_TEXTS = 1000;

/** Where the adapters send their requests instead of the provider's own address. Tests only; see @scrylux/llm/testing. */
export interface TestEndpoints {
  anthropic?: { baseURL: string };
  gemini?: { baseUrl: string };
  bedrock?: { endpoint: string; credentials: { accessKeyId: string; secretAccessKey: string } };
}

export interface ClientOptions {
  /** Receives the one log line of each request. Defaults to console.log. */
  log?: (line: string) => void;
  endpoints?: TestEndpoints;
  /** Tests only: replaces the waits and the jitter of the retry loop. */
  deps?: Partial<LoopDeps>;
}

/**
 * The client behind createLlm. It does no I/O when it is made: an adapter, and with it a provider's SDK, is created the
 * first time its operation is used (research #1, #2). `endpoints` is for tests, and is reached only through the
 * package's testing entry point.
 */
export function createLlmInternal(config: LlmConfig, options: ClientOptions = {}): Llm {
  const adapters = new Map<'generation' | 'embedding', Promise<Adapter>>();
  const log = options.log ?? ((line: string) => console.log(line));
  const deps: LoopDeps = { ...defaultDeps, ...options.deps };

  function adapterFor(which: 'generation' | 'embedding', op: OperationConfig): Promise<Adapter> {
    let adapter = adapters.get(which);
    if (adapter === undefined) {
      adapter = makeAdapter(op, config.timeoutMs, options.endpoints);
      adapters.set(which, adapter);
    }
    return adapter;
  }

  return {
    async generate<T>(request: StructuredRequest<T>): Promise<GenerateResult<T>> {
      const started = Date.now();
      assertStrict(request.schema);
      if (!SCHEMA_NAME.test(request.schemaName)) throw new LlmSchemaError('schemaName must be 1 to 64 letters, digits, "_" or "-"');
      if (request.instructions.trim() === '') throw new RangeError('instructions must not be empty');
      const maxOutputTokens = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
      if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS) {
        throw new RangeError(`maxOutputTokens must be a whole number from 1 to ${MAX_OUTPUT_TOKENS}`);
      }
      const attemptLimit = request.attemptLimit ?? DEFAULT_ATTEMPT_LIMIT;
      if (attemptLimit !== 1 && attemptLimit !== 2 && attemptLimit !== 3) throw new RangeError('attemptLimit must be 1, 2 or 3');

      const op = config.generation;
      if (op === null) return finishWith(failed('generate', 'not_configured', started));

      const prompt = buildPrompt({ instructions: request.instructions, content: request.content });
      const json = toJsonSchema(request.schema);
      const { schema: sent, strict } = sanitizeFor(op.provider, json);
      const instructionSchema = { ...json };
      delete instructionSchema.$schema;
      const adapter = await adapterFor('generation', op);
      const result = await runGenerate(adapter, {
        provider: op.provider,
        model: op.model,
        schema: request.schema,
        schemaName: request.schemaName,
        system: prompt.system,
        user: prompt.user,
        jsonSchema: sent,
        ...(strict === undefined ? {} : { strict }),
        instructionSchema,
        maxOutputTokens,
        attemptLimit,
        timeoutMs: config.timeoutMs,
        signal: request.signal,
      }, deps);
      return finishWith(finish(op, result, started));
    },

    async embed(request: EmbeddingRequest): Promise<EmbedResult> {
      const started = Date.now();
      const { texts } = request;
      if (texts.length < 1 || texts.length > MAX_EMBEDDING_TEXTS) throw new RangeError(`texts must hold 1 to ${MAX_EMBEDDING_TEXTS} texts`);
      if (texts.some((text) => typeof text !== 'string' || text === '')) throw new RangeError('every text must be a non-empty string');

      const op = config.embedding;
      if (op === null) return finishWith(embedFailed('not_configured', started));
      const adapter = await adapterFor('embedding', op);
      const result = await runEmbed(adapter, {
        provider: op.provider,
        model: op.model,
        texts,
        batchSize: resolveCapability(op.provider, op.model).embeddingBatch,
        timeoutMs: config.timeoutMs,
        signal: request.signal,
      }, deps);
      const usage = buildUsage({
        operation: 'embed',
        op,
        calls: result.calls,
        attempts: result.attempts,
        outcome: result.outcome.ok ? 'ok' : result.outcome.category,
        temperatureApplied: null,
        startedAt: started,
      });
      if (result.outcome.ok) {
        return finishWith<EmbedResult>({ ok: true, vectors: result.outcome.vectors, model: op.model, dimension: result.outcome.dimension, usage });
      }
      const { category, index } = result.outcome;
      return finishWith<EmbedResult>({
        ok: false,
        failure: { category, message: FAILURE_MESSAGES[category], ...(index === undefined ? {} : { index }) },
        usage,
      });
    },
  };

  /** Every request that returns writes exactly one line (SC-004). */
  function finishWith<R extends { usage: Usage }>(result: R): R {
    log(formatLogLine(result.usage));
    return result;
  }
}

/** The public client: no way to redirect an adapter. */
export function createLlm(config: LlmConfig, options: { log?: (line: string) => void } = {}): Llm {
  return createLlmInternal(config, options.log === undefined ? {} : { log: options.log });
}

async function makeAdapter(op: OperationConfig, timeoutMs: number, endpoints: TestEndpoints | undefined): Promise<Adapter> {
  switch (op.provider) {
    case 'anthropic':
      return createAnthropicAdapter({ apiKey: requireKey(op), model: op.model, timeoutMs, ...(endpoints?.anthropic ? { baseURL: endpoints.anthropic.baseURL } : {}) });
    case 'openai-compatible':
      return createOpenAICompatibleAdapter({ apiKey: op.apiKey, baseURL: requireValue(op.baseUrl, 'base address'), model: op.model, timeoutMs });
    case 'bedrock':
      return createBedrockAdapter({ region: requireValue(op.region, 'region'), model: op.model, timeoutMs, ...(endpoints?.bedrock ? { test: endpoints.bedrock } : {}) });
    case 'gemini':
      return createGeminiAdapter({ apiKey: requireKey(op), model: op.model, timeoutMs, ...(endpoints?.gemini ? { baseUrl: endpoints.gemini.baseUrl } : {}) });
  }
}

// parseLlmConfig guarantees these. They guard a LlmConfig that was built by hand.
const requireKey = (op: OperationConfig): string => requireValue(op.apiKey, 'API key');
function requireValue<V>(value: V | null, what: string): V {
  if (value === null) throw new LlmSchemaError(`the ${what} of the configured provider is missing`);
  return value;
}

function finish<T>(op: OperationConfig, result: LoopResult<T>, started: number): GenerateResult<T> {
  const usage = buildUsage({
    operation: 'generate',
    op,
    calls: result.calls,
    attempts: result.attempts,
    outcome: result.outcome.ok ? 'ok' : result.outcome.category,
    temperatureApplied: result.temperatureApplied,
    startedAt: started,
  });
  if (result.outcome.ok) return { ok: true, value: result.outcome.value, usage };
  const { category } = result.outcome;
  return { ok: false, failure: { category, message: FAILURE_MESSAGES[category] }, usage };
}

function failed(operation: Usage['operation'], category: FailureCategory, started: number): GenerateResult<never> {
  const usage = buildUsage({
    operation,
    op: null,
    calls: [],
    attempts: 0,
    outcome: category,
    temperatureApplied: operation === 'generate' ? false : null,
    startedAt: started,
  });
  return { ok: false, failure: { category, message: FAILURE_MESSAGES[category] }, usage };
}

function embedFailed(category: FailureCategory, started: number): EmbedResult {
  const usage = buildUsage({ operation: 'embed', op: null, calls: [], attempts: 0, outcome: category, temperatureApplied: null, startedAt: started });
  return { ok: false, failure: { category, message: FAILURE_MESSAGES[category] }, usage };
}
