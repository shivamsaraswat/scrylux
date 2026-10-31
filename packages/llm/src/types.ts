import type { z } from 'zod';
import type { FailureCategory } from './errors.js';

export type ProviderName = 'anthropic' | 'openai-compatible' | 'bedrock' | 'gemini';

/** One operation's settings, parsed from the environment. It holds the key and the address: never log or return it. */
export interface OperationConfig {
  provider: ProviderName;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  region: string | null;
  local: boolean;
  /** True unless the operator declared an OpenAI-compatible provider local (FR-044a). */
  hosted: boolean;
  /** US dollars per million tokens. `output` is null for embeddings (FR-033b). */
  operatorPrice: { input: number; output: number | null } | null;
}

export interface LlmConfig {
  generation: OperationConfig | null;
  embedding: OperationConfig | null;
  timeoutMs: number;
}

/** What the rest of Scrylux may know about the configuration: no key and no address (FR-045). */
export interface LlmStatus {
  generation: { provider: ProviderName; model: string; hosted: boolean } | null;
  embedding: { provider: ProviderName; model: string; hosted: boolean } | null;
}

export interface StructuredRequest<T> {
  /** Every object strict (z.strictObject), or LlmSchemaError is thrown. */
  schema: z.ZodType<T>;
  /** [a-zA-Z0-9_-]{1,64}; some providers require a name for the schema. */
  schemaName: string;
  /** Goes in the provider's instruction position. */
  instructions: string;
  /** Untrusted. Goes only inside the marked content section (FR-040). */
  content?: string;
  /** Integer 1..32000, default 16000. */
  maxOutputTokens?: number;
  /** Default 3 (FR-014). */
  attemptLimit?: 1 | 2 | 3;
  signal?: AbortSignal;
}

export interface EmbeddingRequest {
  /** 1..1000 non-empty strings. */
  texts: readonly string[];
  signal?: AbortSignal;
}

export interface Failure {
  category: FailureCategory;
  /** Fixed text for the category, from FAILURE_MESSAGES. */
  message: string;
  /** Embeddings only: the position of the text that was too long (FR-019). */
  index?: number;
}

export interface Usage {
  operation: 'generate' | 'embed';
  /** Null when not configured. */
  provider: ProviderName | null;
  model: string | null;
  outcome: 'ok' | FailureCategory;
  /** Schema attempts plus transient retries. Free resends are not counted. */
  attempts: number;
  inputTokens: number;
  /** Always 0 for embeddings. */
  outputTokens: number;
  tokensEstimated: boolean;
  /** Null means unknown. It is never 0 for an unknown price (FR-033). */
  costUsd: number | null;
  costEstimated: boolean;
  priceSource: 'operator' | 'list' | 'none';
  /** Null for embeddings. */
  temperatureApplied: boolean | null;
  durationMs: number;
}

export type GenerateResult<T> = { ok: true; value: T; usage: Usage } | { ok: false; failure: Failure; usage: Usage };

export type EmbedResult =
  | { ok: true; vectors: number[][]; model: string; dimension: number; usage: Usage }
  | { ok: false; failure: Failure; usage: Usage };

export interface Llm {
  generate<T>(request: StructuredRequest<T>): Promise<GenerateResult<T>>;
  embed(request: EmbeddingRequest): Promise<EmbedResult>;
}
