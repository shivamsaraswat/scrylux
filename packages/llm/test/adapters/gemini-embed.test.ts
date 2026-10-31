import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLlmWithEndpoints, resetCapabilityOverrides } from '../../testing/index.js';
import type { Llm } from '../../src/index.js';
import { geminiEmbeddings, geminiError } from '../../testing/stubs/gemini.js';
import { config, operation } from '../helpers.js';
import { startStub, type RecordedRequest, type Stub } from '../../testing/stubs/server.js';

let stub: Stub;
type Body = { requests: { model: string; content: { parts: { text: string }[] } }[] };
const inputOf = (r: RecordedRequest): string[] => (r.body as Body).requests.map((q) => q.content.parts[0]?.text ?? '');
const vectorOf = (text: string): number[] => [Number(text.slice(1)), 0.5];
const texts = (n: number): string[] => Array.from({ length: n }, (_, i) => `t${i}`);

function llm(): Llm {
  return createLlmWithEndpoints(config({ embedding: operation('gemini', { model: 'gemini-embedding-001' }) }), {
    log: () => undefined,
    endpoints: { gemini: { baseUrl: stub.url } },
  });
}

beforeEach(async () => {
  resetCapabilityOverrides();
  stub = await startStub();
  stub.setFallback((r) => geminiEmbeddings(inputOf(r).map(vectorOf)));
});
afterEach(() => stub.close());

describe('embedding with Gemini', () => {
  it('sends one Content per text, not one Content with many parts', async () => {
    const result = await llm().embed({ texts: ['t1', 't2', 't3'] });
    expect(result).toMatchObject({ ok: true, vectors: [[1, 0.5], [2, 0.5], [3, 0.5]], model: 'gemini-embedding-001', dimension: 2 });
    const req = stub.requests[0];
    expect(req?.path).toBe('/v1beta/models/gemini-embedding-001:batchEmbedContents');
    const body = req?.body as Body;
    expect(body.requests).toHaveLength(3);
    for (const [i, q] of body.requests.entries()) {
      expect(q.content.parts).toEqual([{ text: `t${i + 1}` }]);
      expect(q.model).toContain('gemini-embedding-001');
    }
    expect(req?.headers['x-goog-api-key']).toBe('fake-key');
  });

  it('splits 150 texts into batches of 100 and 50, in order', async () => {
    const result = await llm().embed({ texts: texts(150) });
    expect(stub.requests.map((r) => inputOf(r).length)).toEqual([100, 50]);
    expect(result.ok && result.vectors.map((v) => v[0])).toEqual(Array.from({ length: 150 }, (_, i) => i));
  });

  it('estimates tokens, and marks them, when the answer gives none', async () => {
    const result = await llm().embed({ texts: ['t1', 'a longer text that is forty characters....'] });
    expect(result.usage.tokensEstimated).toBe(true);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBe(0);
  });

  it('finds a text that is too long and names its position', async () => {
    stub.setFallback((r) => {
      const input = inputOf(r);
      return input.length > 1 || input[0] === 't1'
        ? geminiError(400, 'The input token count (9000) exceeds the maximum number of tokens allowed (2048).')
        : geminiEmbeddings(input.map(vectorOf));
    });
    const result = await llm().embed({ texts: ['t0', 't1', 't2'] });
    expect(!result.ok && result.failure).toMatchObject({ category: 'input_too_large', index: 1 });
  });
});
