import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLlmWithEndpoints, resetCapabilityOverrides } from '../../testing/index.js';
import type { Llm } from '../../src/index.js';
import { bedrockError, invokeAnswer } from '../../testing/stubs/bedrock.js';
import { config, operation } from '../helpers.js';
import { startStub, type RecordedRequest, type Stub } from '../../testing/stubs/server.js';

let stub: Stub;
const textOf = (r: RecordedRequest): string => (r.body as { inputText: string }).inputText;
const vectorOf = (text: string): number[] => [Number(text.slice(1)), 0.25, 0.5];

function llm(model = 'amazon.titan-embed-text-v2:0'): Llm {
  return createLlmWithEndpoints(config({ embedding: operation('bedrock', { model }) }), {
    log: () => undefined,
    endpoints: { bedrock: { endpoint: stub.url, credentials: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake' } } },
  });
}

beforeEach(async () => {
  resetCapabilityOverrides();
  stub = await startStub({ http2: true });
  stub.setFallback((r) => invokeAnswer({ embedding: vectorOf(textOf(r)), inputTextTokenCount: 4 }));
});
afterEach(() => stub.close());

describe('embedding with Amazon Titan Text Embeddings V2 on Bedrock', () => {
  it('invokes the model once per text, with { inputText }, in order', async () => {
    const result = await llm().embed({ texts: ['t3', 't1', 't2'] });
    expect(stub.requests.map((r) => [r.path, textOf(r)])).toEqual([
      ['/model/amazon.titan-embed-text-v2%3A0/invoke', 't3'],
      ['/model/amazon.titan-embed-text-v2%3A0/invoke', 't1'],
      ['/model/amazon.titan-embed-text-v2%3A0/invoke', 't2'],
    ]);
    expect(result).toMatchObject({ ok: true, vectors: [[3, 0.25, 0.5], [1, 0.25, 0.5], [2, 0.25, 0.5]], model: 'amazon.titan-embed-text-v2:0', dimension: 3 });
    expect(stub.requests[0]?.body).toEqual({ inputText: 't3' });
  });

  it('counts tokens from inputTextTokenCount, over every call', async () => {
    const result = await llm().embed({ texts: ['t1', 't2', 't3'] });
    expect(result.usage).toMatchObject({ operation: 'embed', inputTokens: 12, tokensEstimated: false, attempts: 1 });
  });

  it('fails as not_available, without any request, for a model with no known request body', async () => {
    const result = await llm('amazon.nova-lite-v1:0').embed({ texts: ['t1'] });
    expect(!result.ok && result.failure.category).toBe('not_available');
    expect(stub.requests).toHaveLength(0);
  });

  it('fails as input_too_large with the position of the text that was too long', async () => {
    stub.setFallback((r) =>
      textOf(r) === 't2' ? bedrockError(400, 'ValidationException', 'Too many input tokens. Max input tokens: 8192, request input token count: 9001') : invokeAnswer({ embedding: vectorOf(textOf(r)), inputTextTokenCount: 4 }),
    );
    const result = await llm().embed({ texts: ['t0', 't1', 't2', 't3'] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ category: 'input_too_large', index: 2 });
    expect(result.usage.inputTokens).toBe(8);
  });

  it('a throttled call is retried', async () => {
    stub.enqueue(bedrockError(429, 'ThrottlingException', 'slow down'));
    const result = await llm().embed({ texts: ['t1'] });
    expect(result.ok).toBe(true);
    expect(result.usage.attempts).toBe(2);
  }, 10_000);
});
