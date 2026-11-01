import { MAX_TRANSIENT_RETRIES } from './attempts.js';
import { DEFAULT_ATTEMPT_LIMIT, DEFAULT_MAX_OUTPUT_TOKENS } from './client.js';
import { buildPrompt } from './content.js';
import { LlmConfigError } from './errors.js';
import { findPrice } from './pricing.js';
import { toJsonSchema } from './schema.js';
import type { EmbeddingRequest, LlmConfig, StructuredRequest } from './types.js';
import { estimateTokens } from './usage.js';

// The most one request could use, so that a job can refuse to send a request that would take it past its token or cost
// cap (Phase 3 Milestone 2, FR-042, research #7). It is arithmetic over the layer's own constants, estimate and price
// lookup, so the worker never copies them. The caps are checked against this before the request is sent, and against
// the real usage after it.

/**
 * What a retry adds to the input of one attempt, in characters: the instructions that ask for JSON where a provider is
 * not given a native schema (prompts/json-instructions.md), and the note that names what was wrong with the last answer
 * (prompts/schema-retry.md, at most MAX_ISSUES lines of 300 characters). A test fails if the prompts outgrow it.
 */
export const RETRY_ALLOWANCE_CHARS = 8_000;

export type WorstCaseRequest =
  | { operation: 'generate'; inputChars: number; maxOutputTokens?: number; attemptLimit?: 1 | 2 | 3 }
  | { operation: 'embed'; inputChars: number };

export interface WorstCase {
  tokens: number;
  /** US dollars, or null when the price is unknown (M1 FR-033): the token cap still applies, the cost cap cannot. */
  costUsd: number | null;
}

/**
 * The size of one attempt's input in characters: the instructions, the content section with its preamble and markers,
 * the schema, and the allowance for a retry. An embedding request is the total length of its texts. This is what a
 * caller gives `worstCase` as `inputChars`, so nobody measures a request themselves.
 */
export function requestSize(request: StructuredRequest<unknown> | EmbeddingRequest): number {
  if ('texts' in request) return request.texts.reduce((sum, text) => sum + text.length, 0);
  const prompt = buildPrompt({ instructions: request.instructions, content: request.content });
  return prompt.system.length + prompt.user.length + JSON.stringify(toJsonSchema(request.schema)).length + RETRY_ALLOWANCE_CHARS;
}

/**
 * The most tokens, and the most dollars where the price is known, that one request of this size could use.
 *
 * - Generation: every call a provider can bill for one request. That is the schema attempts (3 unless the caller asks
 *   for fewer) and the transient retries (2), each with the input and the whole output limit. The free resends that
 *   follow a refused setting are not counted: they follow a 400 answer that comes before any generation (M1 research
 *   #4 and #9), so they spend nothing.
 * - Embeddings: the request and its transient retries, each over the whole input. That over-counts, because the retries
 *   belong to one batch and not to all of them, which is the safe side.
 * - A price with a higher tier is taken at the higher tier: this is a ceiling, and the estimate of the input is rough.
 *
 * Throws LlmConfigError, with fixed text, when the operation is not configured.
 */
export function worstCase(config: LlmConfig, request: WorstCaseRequest): WorstCase {
  const operation = request.operation === 'generate' ? config.generation : config.embedding;
  if (operation === null) throw new LlmConfigError(`${request.operation === 'generate' ? 'generation' : 'embeddings'} is not configured`);

  const input = estimateTokens(request.inputChars);
  const output = request.operation === 'generate' ? (request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) : 0;
  const calls = (request.operation === 'generate' ? (request.attemptLimit ?? DEFAULT_ATTEMPT_LIMIT) : 1) + MAX_TRANSIENT_RETRIES;

  const price = findPrice(operation);
  const rates = price === null ? null : (price.above ?? price);
  return {
    tokens: calls * (input + output),
    costUsd: rates === null ? null : (calls * (input * rates.input + output * (rates.output ?? 0))) / 1_000_000,
  };
}
