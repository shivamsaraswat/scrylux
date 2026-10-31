import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLlmWithEndpoints, resetCapabilityOverrides } from '../../testing/index.js';
import type { Llm } from '../../src/index.js';
import { config, operation } from '../helpers.js';
import { openaiEmbeddings, openaiError } from '../../testing/stubs/openai.js';
import { startStub, type RecordedRequest, type Stub } from '../../testing/stubs/server.js';

let stub: Stub;
let lines: string[];

// Vectors the stub makes up from the text itself: "t7" gives [7, 0.5], so order is checkable.
const vectorOf = (text: string): number[] => [Number(text.slice(1)), 0.5];
const inputOf = (r: RecordedRequest): string[] => (r.body as { input: string[] }).input;
const texts = (n: number): string[] => Array.from({ length: n }, (_, i) => `t${i}`);

function llm(over = {}): Llm {
  return createLlmWithEndpoints(
    config({ embedding: operation('openai-compatible', { model: 'nomic-embed-text', baseUrl: `${stub.url}/v1`, local: true, hosted: false, ...over }) }),
    { log: (line) => lines.push(line), endpoints: {} },
  );
}

beforeEach(async () => {
  resetCapabilityOverrides();
  stub = await startStub();
  lines = [];
  stub.setFallback((r) => openaiEmbeddings(inputOf(r).map(vectorOf), inputOf(r).length * 2));
});
afterEach(() => stub.close());

describe('embedding through an OpenAI-compatible server', () => {
  it('posts the texts as an array to <base>/embeddings, asking for plain numbers', async () => {
    const result = await llm().embed({ texts: ['t1', 't2', 't3'] });
    expect(result.ok).toBe(true);
    const req = stub.requests[0];
    expect(req?.path).toBe('/v1/embeddings');
    expect(req?.body).toMatchObject({ model: 'nomic-embed-text', input: ['t1', 't2', 't3'], encoding_format: 'float' });
  });

  it('returns one vector per text in order, with the model and dimension', async () => {
    const result = await llm().embed({ texts: ['t3', 't1', 't2'] });
    expect(result).toMatchObject({ ok: true, vectors: [[3, 0.5], [1, 0.5], [2, 0.5]], model: 'nomic-embed-text', dimension: 2 });
  });

  it('splits 300 texts into batches of 256 and 44, and puts them back in order', async () => {
    const result = await llm().embed({ texts: texts(300) });
    expect(stub.requests.map((r) => inputOf(r).length)).toEqual([256, 44]);
    expect(result.ok && result.vectors.map((v) => v[0])).toEqual(Array.from({ length: 300 }, (_, i) => i));
    expect(result.usage).toMatchObject({ operation: 'embed', attempts: 1, inputTokens: 600, outputTokens: 0, temperatureApplied: null });
    expect(lines).toHaveLength(1);
  });

  it('works against a local http address with no key', async () => {
    const result = await llm({ apiKey: null }).embed({ texts: ['t1'] });
    expect(result.ok).toBe(true);
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer unused');
  });

  it('counts tokens from usage.prompt_tokens', async () => {
    stub.setFallback((r) => openaiEmbeddings(inputOf(r).map(vectorOf), 77));
    expect((await llm().embed({ texts: ['t1', 't2'] })).usage).toMatchObject({ inputTokens: 77, tokensEstimated: false });
  });
});

describe('a text that is too long (FR-019)', () => {
  const tooLong = openaiError(400, "This model's maximum context length is 8192 tokens.", { code: 'context_length_exceeded' });

  it('is found by sending its batch one text at a time, and fails with its position, counting every call', async () => {
    stub.setFallback((r) => {
      const input = inputOf(r);
      if (input.length > 1 || input[0] === 't1') return tooLong;
      return openaiEmbeddings(input.map(vectorOf), 5);
    });
    const result = await llm().embed({ texts: ['t0', 't1', 't2'] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.category).toBe('input_too_large');
    expect(result.failure.index).toBe(1);
    expect(stub.requests.map((r) => inputOf(r))).toEqual([['t0', 't1', 't2'], ['t0'], ['t1']]);
    expect(result.usage.inputTokens).toBe(5);
    expect(JSON.stringify(result)).not.toContain('t1"');
  });

  it('reports the position within the whole list, not within its batch', async () => {
    stub.setFallback((r) => {
      const input = inputOf(r);
      return input.includes('t270') ? tooLong : openaiEmbeddings(input.map(vectorOf), input.length);
    });
    const result = await llm().embed({ texts: texts(300) });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.index).toBe(270);
  });

  it('succeeds when the batch was too large only as a whole, because each text fits alone', async () => {
    stub.setFallback((r) => (inputOf(r).length > 1 ? tooLong : openaiEmbeddings(inputOf(r).map(vectorOf), 4)));
    const result = await llm().embed({ texts: ['t0', 't1', 't2'] });
    expect(result).toMatchObject({ ok: true, vectors: [[0, 0.5], [1, 0.5], [2, 0.5]] });
    expect(result.usage.inputTokens).toBe(12);
  });

  it('names the position of a single text without a search', async () => {
    stub.setFallback(() => tooLong);
    const result = await llm().embed({ texts: ['t0'] });
    expect(!result.ok && result.failure).toMatchObject({ category: 'input_too_large', index: 0 });
    expect(stub.requests).toHaveLength(1);
  });
});

describe('other failures', () => {
  it('a wrong key is not_authorized and is not retried', async () => {
    stub.setFallback(() => openaiError(401, 'bad key'));
    const result = await llm().embed({ texts: ['t1'] });
    expect(!result.ok && result.failure.category).toBe('not_authorized');
    expect(stub.requests).toHaveLength(1);
  });

  it('an unknown model is not_available', async () => {
    stub.setFallback(() => openaiError(404, 'model not found', { code: 'model_not_found' }));
    expect((await llm().embed({ texts: ['t1'] })).ok).toBe(false);
  });
});
