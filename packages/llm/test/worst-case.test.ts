import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAX_ISSUES } from '../src/attempts.js';
import { parseLlmConfig } from '../src/config.js';
import { loadPrompt } from '../src/data.js';
import { LlmConfigError } from '../src/errors.js';
import { estimateTokens } from '../src/usage.js';
import { RETRY_ALLOWANCE_CHARS, requestSize, worstCase } from '../src/worst-case.js';
import { anthropicMessage, createLlmWithEndpoints, startStub, type Stub } from '../testing/index.js';

// The most a request could use, for the job caps (Phase 3 Milestone 2, FR-042, contracts/library-api.md).

type Env = Record<string, string | undefined>;
const HAIKU: Env = { LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-haiku-5-5', LLM_API_KEY: 'k' };
const OLLAMA: Env = { LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'llama3.2', LLM_BASE_URL: 'http://ollama:11434/v1', LLM_LOCAL: 'true' };
const EMBED_OLLAMA: Env = {
  EMBEDDING_PROVIDER: 'openai-compatible',
  EMBEDDING_MODEL: 'nomic-embed-text',
  EMBEDDING_BASE_URL: 'http://ollama:11434/v1',
  EMBEDDING_LOCAL: 'true',
};

describe('worstCase for a structured request', () => {
  it('is five calls of the input plus the default output limit: three schema attempts and two transient retries', () => {
    const result = worstCase(parseLlmConfig(OLLAMA), { operation: 'generate', inputChars: 4000 });
    expect(result.tokens).toBe(5 * (1000 + 16_000));
  });

  it('follows the attempt limit and the output limit the caller sets', () => {
    const config = parseLlmConfig(OLLAMA);
    expect(worstCase(config, { operation: 'generate', inputChars: 4000, attemptLimit: 1, maxOutputTokens: 1000 }).tokens).toBe(3 * (1000 + 1000));
    expect(worstCase(config, { operation: 'generate', inputChars: 0, attemptLimit: 2 }).tokens).toBe(4 * 16_000);
  });

  it('does not count the free resends that follow a refused setting (research #7)', () => {
    // Nine calls could be made at most; only the five that a provider can bill are counted.
    expect(worstCase(parseLlmConfig(OLLAMA), { operation: 'generate', inputChars: 0 }).tokens).toBe(5 * 16_000);
  });

  it('prices the tokens with the operator price: input and output separately', () => {
    const config = parseLlmConfig({ ...OLLAMA, LLM_PRICE_INPUT: '1', LLM_PRICE_OUTPUT: '2' });
    const { tokens, costUsd } = worstCase(config, { operation: 'generate', inputChars: 4000 });
    expect(tokens).toBe(85_000);
    expect(costUsd).toBeCloseTo((5 * (1000 * 1 + 16_000 * 2)) / 1_000_000, 9);
  });

  it('prices the tokens from the list when there is no operator price, and takes the higher tier of a tiered price', () => {
    // claude-haiku-5-5: 0.1 in, 0.5 out; above 100,000 input tokens 0.5 in, 2.5 out (packages/llm/data/prices.yaml).
    const { costUsd } = worstCase(parseLlmConfig(HAIKU), { operation: 'generate', inputChars: 4000 });
    expect(costUsd).toBeCloseTo((5 * (1000 * 0.5 + 16_000 * 2.5)) / 1_000_000, 9);
  });

  it('prices an untiered list entry at its only price', () => {
    const { costUsd } = worstCase(parseLlmConfig({ ...HAIKU, LLM_MODEL: 'claude-opus-5-5' }), { operation: 'generate', inputChars: 4000 });
    // claude-opus-5-5: 4 in, 20 out.
    expect(costUsd).toBeCloseTo((5 * (1000 * 4 + 16_000 * 20)) / 1_000_000, 9);
  });

  it('reports an unknown price as null cost, never as zero (M1 FR-033)', () => {
    const { tokens, costUsd } = worstCase(parseLlmConfig(OLLAMA), { operation: 'generate', inputChars: 4000 });
    expect(tokens).toBeGreaterThan(0);
    expect(costUsd).toBeNull();
  });

  it('counts a price of zero as a known cost of zero', () => {
    const config = parseLlmConfig({ ...OLLAMA, LLM_PRICE_INPUT: '0', LLM_PRICE_OUTPUT: '0' });
    expect(worstCase(config, { operation: 'generate', inputChars: 4000 }).costUsd).toBe(0);
  });
});

describe('worstCase for embeddings', () => {
  it('is three calls of the input: the request and its two retries, with no output tokens', () => {
    const config = parseLlmConfig({ ...OLLAMA, ...EMBED_OLLAMA });
    expect(worstCase(config, { operation: 'embed', inputChars: 4000 }).tokens).toBe(3 * 1000);
  });

  it('prices the input at the embedding price, and is null without one', () => {
    const priced = parseLlmConfig({ ...OLLAMA, ...EMBED_OLLAMA, EMBEDDING_PRICE_INPUT: '0.02' });
    expect(worstCase(priced, { operation: 'embed', inputChars: 4000 }).costUsd).toBeCloseTo((3 * 1000 * 0.02) / 1_000_000, 12);
    const unpriced = parseLlmConfig({ ...OLLAMA, ...EMBED_OLLAMA });
    expect(worstCase(unpriced, { operation: 'embed', inputChars: 4000 }).costUsd).toBeNull();
  });
});

describe('worstCase with an operation that is not configured', () => {
  it('throws LlmConfigError for generation and for embeddings', () => {
    expect(() => worstCase(parseLlmConfig({}), { operation: 'generate', inputChars: 1 })).toThrow(LlmConfigError);
    expect(() => worstCase(parseLlmConfig(OLLAMA), { operation: 'embed', inputChars: 1 })).toThrow(LlmConfigError);
  });

  it('says which operation, and holds no setting value', () => {
    expect(() => worstCase(parseLlmConfig({}), { operation: 'generate', inputChars: 1 })).toThrow('generation is not configured');
    expect(() => worstCase(parseLlmConfig(OLLAMA), { operation: 'embed', inputChars: 1 })).toThrow('embeddings is not configured');
  });
});

describe('requestSize', () => {
  const schema = z.strictObject({ name: z.string(), kind: z.enum(['a', 'b']) });
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });
  afterEach(() => stub.close());

  /** What the Anthropic adapter was actually sent for one attempt: the instruction, the user turn and the schema. */
  async function sentChars(request: { content?: string }): Promise<number> {
    const llm = createLlmWithEndpoints(parseLlmConfig(HAIKU), { log: () => undefined, endpoints: { anthropic: { baseURL: stub.url } } });
    stub.enqueue(anthropicMessage({ text: '{"name":"n","kind":"a"}' }));
    const result = await llm.generate({ schema, schemaName: 'thing', instructions: 'Name the thing.', ...request });
    expect(result.ok).toBe(true);
    const body = stub.requests[0]?.body as {
      system: string;
      messages: { content: string }[];
      output_config: { format: { schema: unknown } };
    };
    return body.system.length + (body.messages[0]?.content.length ?? 0) + JSON.stringify(body.output_config.format.schema).length;
  }

  it.each([
    ['without content', {}],
    ['with content', { content: 'A design document. '.repeat(200) }],
  ])('covers at least what one attempt sends, and a fixed allowance for a retry, %s', async (_label, extra) => {
    const sent = await sentChars(extra);
    const size = requestSize({ schema, schemaName: 'thing', instructions: 'Name the thing.', ...extra });
    expect(size).toBeGreaterThanOrEqual(sent);
    // The only difference is the allowance, and the few bytes by which the schema the adapter sends is smaller than the one converted.
    expect(size - sent).toBeLessThanOrEqual(RETRY_ALLOWANCE_CHARS + 200);
    expect(size - sent).toBeGreaterThan(RETRY_ALLOWANCE_CHARS - 200);
  });

  it('grows with the content, character for character', () => {
    const base = { schema, schemaName: 'thing', instructions: 'Name the thing.' };
    const small = requestSize({ ...base, content: 'x'.repeat(100) });
    const large = requestSize({ ...base, content: 'x'.repeat(1100) });
    expect(large - small).toBe(1000);
    expect(small).toBeGreaterThan(requestSize(base));
  });

  it('is the total length of the texts of an embedding request', () => {
    expect(requestSize({ texts: ['abc', 'defgh', 'i'] })).toBe(9);
  });

  it('allows for a retry at least as large as the prompts that make one', () => {
    // Where a provider is not given a native schema its instructions ask for JSON, and a retry names what was wrong, at
    // most MAX_ISSUES lines of about 300 characters. If these prompts grow, so must RETRY_ALLOWANCE_CHARS.
    const needed = loadPrompt('json-instructions.md').length + loadPrompt('schema-retry.md').length + MAX_ISSUES * 300;
    expect(RETRY_ALLOWANCE_CHARS).toBeGreaterThanOrEqual(needed);
  });

  it('feeds worstCase: the estimate of the size is what the budget multiplies', () => {
    const size = requestSize({ schema, schemaName: 'thing', instructions: 'Name the thing.' });
    expect(worstCase(parseLlmConfig(OLLAMA), { operation: 'generate', inputChars: size }).tokens).toBe(5 * (estimateTokens(size) + 16_000));
  });
});
