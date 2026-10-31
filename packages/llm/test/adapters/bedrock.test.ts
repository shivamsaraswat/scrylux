import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBedrockAdapter } from '../../src/adapters/bedrock.js';
import type { Adapter, GenerateInput } from '../../src/adapters/types.js';
import { AdapterError, type FailureCategory } from '../../src/errors.js';
import { bedrockError, converseAnswer } from '../../testing/stubs/bedrock.js';
import { startStub, type Stub } from '../../testing/stubs/server.js';

const SCHEMA = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false };
const MODEL = 'anthropic.claude-test-v1:0';

function input(over: Partial<GenerateInput> = {}): GenerateInput {
  return {
    system: 'SYSTEM-TEXT',
    user: 'USER-TEXT',
    jsonSchema: SCHEMA,
    schemaName: 'thing',
    maxOutputTokens: 16000,
    temperature: undefined,
    mode: 'native',
    maxTokensParam: 'max_tokens',
    timeoutMs: 5000,
    signal: new AbortController().signal,
    ...over,
  };
}

let stub: Stub;
let adapter: Adapter;

beforeEach(async () => {
  stub = await startStub({ http2: true });
  adapter = await createBedrockAdapter({
    region: 'us-east-1',
    model: MODEL,
    timeoutMs: 5000,
    test: { endpoint: stub.url, credentials: { accessKeyId: 'AKIAFAKEKEY', secretAccessKey: 'fake-secret' } },
  });
});
afterEach(() => stub.close());

async function failure(promise: Promise<unknown>): Promise<AdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    return error as AdapterError;
  }
  throw new Error('expected the call to fail');
}

describe('the request', () => {
  it('sends the instructions as system, the user turn as a content block, and a native schema as a string', async () => {
    stub.enqueue(converseAnswer());
    await adapter.generateOnce(input());
    const req = stub.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('/model/anthropic.claude-test-v1%3A0/converse');
    expect(req?.body).toMatchObject({
      system: [{ text: 'SYSTEM-TEXT' }],
      messages: [{ role: 'user', content: [{ text: 'USER-TEXT' }] }],
      inferenceConfig: { maxTokens: 16000 },
      outputConfig: { textFormat: { type: 'json_schema', structure: { jsonSchema: { schema: JSON.stringify(SCHEMA), name: 'thing' } } } },
    });
    expect(req?.body).not.toHaveProperty('toolConfig');
    expect((req?.body as { inferenceConfig: object }).inferenceConfig).not.toHaveProperty('temperature');
  });

  it('sends temperature 0 only when given one', async () => {
    stub.enqueue(converseAnswer());
    await adapter.generateOnce(input({ temperature: 0 }));
    expect(stub.requests[0]?.body).toMatchObject({ inferenceConfig: { temperature: 0 } });
  });

  it('asks for JSON in the instructions only, with no outputConfig', async () => {
    stub.enqueue(converseAnswer());
    await adapter.generateOnce(input({ mode: 'instructions' }));
    expect(stub.requests[0]?.body).not.toHaveProperty('outputConfig');
  });

  it('adds the retry note to the user turn', async () => {
    stub.enqueue(converseAnswer());
    await adapter.generateOnce(input({ retryNote: 'RETRY' }));
    expect(stub.requests[0]?.body).toMatchObject({ messages: [{ content: [{ text: 'USER-TEXT\n\nRETRY' }] }] });
  });
});

describe('the SDK does not retry', () => {
  it('a 500 makes exactly one request', async () => {
    stub.enqueue(bedrockError(500, 'InternalServerException', 'boom'), converseAnswer());
    expect((await failure(adapter.generateOnce(input()))).category).toBe('provider_unavailable');
    expect(stub.requests).toHaveLength(1);
  });
});

describe('the SDK does not retry, whatever the environment says', () => {
  it('AWS_MAX_ATTEMPTS does not override the single attempt', async () => {
    const saved = process.env.AWS_MAX_ATTEMPTS;
    process.env.AWS_MAX_ATTEMPTS = '5';
    try {
      const fresh = await createBedrockAdapter({
        region: 'us-east-1', model: MODEL, timeoutMs: 5000,
        test: { endpoint: stub.url, credentials: { accessKeyId: 'AKIAFAKEKEY', secretAccessKey: 'fake-secret' } },
      });
      stub.enqueue(bedrockError(500, 'InternalServerException', 'boom'), converseAnswer());
      expect((await failure(fresh.generateOnce(input()))).category).toBe('provider_unavailable');
      expect(stub.requests).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.AWS_MAX_ATTEMPTS;
      else process.env.AWS_MAX_ATTEMPTS = saved;
    }
  });
});

describe('answers', () => {
  it('returns the text and the tokens', async () => {
    stub.enqueue(converseAnswer({ text: '{"name":"x"}', usage: { inputTokens: 31, outputTokens: 9, totalTokens: 40 } }));
    expect(await adapter.generateOnce(input())).toEqual({ kind: 'answer', text: '{"name":"x"}', inputTokens: 31, outputTokens: 9 });
  });

  it('skips reasoning blocks', async () => {
    stub.enqueue(converseAnswer({ blocks: [{ reasoningContent: { reasoningText: { text: 'hmm' } } }, { text: '{"a":1}' }] }));
    expect(await adapter.generateOnce(input())).toMatchObject({ kind: 'answer', text: '{"a":1}' });
  });

  it.each([
    ['max_tokens', 'cut_off'],
    ['model_context_window_exceeded', 'cut_off'],
    ['content_filtered', 'refused'],
    ['guardrail_intervened', 'refused'],
  ] as const)('stopReason %s is %s', async (stopReason, kind) => {
    stub.enqueue(converseAnswer({ stopReason, text: '' }));
    expect((await adapter.generateOnce(input())).kind).toBe(kind);
  });
});

describe('errors', () => {
  const cases: [string, ReturnType<typeof bedrockError>, FailureCategory, Record<string, unknown>?][] = [
    ['ThrottlingException', bedrockError(429, 'ThrottlingException', 'Too many requests'), 'rate_limited'],
    ['ServiceQuotaExceededException', bedrockError(400, 'ServiceQuotaExceededException', 'quota'), 'rate_limited'],
    ['AccessDeniedException', bedrockError(403, 'AccessDeniedException', 'no access'), 'not_authorized'],
    ['UnrecognizedClientException', bedrockError(403, 'UnrecognizedClientException', 'bad token'), 'not_authorized'],
    ['ResourceNotFoundException', bedrockError(404, 'ResourceNotFoundException', 'not found'), 'not_available'],
    ['ValidationException naming input length', bedrockError(400, 'ValidationException', 'Input is too long for requested model.'), 'input_too_large'],
    ['ValidationException naming model access', bedrockError(400, 'ValidationException', "The provided model identifier is invalid. You don't have access to the model."), 'not_available'],
    ['ValidationException naming temperature', bedrockError(400, 'ValidationException', 'inferenceConfig.temperature is not supported for this model'), 'rejected', { rejectedParam: 'temperature' }],
    ['ValidationException naming outputConfig', bedrockError(400, 'ValidationException', 'outputConfig.textFormat is not supported by this model'), 'rejected', { rejectedParam: 'format' }],
    ['any other ValidationException', bedrockError(400, 'ValidationException', 'messages: must not be empty'), 'rejected'],
    ['ServiceUnavailableException', bedrockError(503, 'ServiceUnavailableException', 'down'), 'provider_unavailable'],
    ['InternalServerException', bedrockError(500, 'InternalServerException', 'boom'), 'provider_unavailable'],
    ['ModelNotReadyException', bedrockError(429, 'ModelNotReadyException', 'warming up'), 'provider_unavailable'],
    ['ModelTimeoutException', bedrockError(408, 'ModelTimeoutException', 'timed out'), 'provider_unavailable'],
  ];

  it.each(cases)('%s', async (_name, scripted, category, extra) => {
    stub.enqueue(scripted);
    const error = await failure(adapter.generateOnce(input()));
    expect(error.category).toBe(category);
    for (const [key, value] of Object.entries(extra ?? {})) expect((error as unknown as Record<string, unknown>)[key]).toBe(value);
  });

  it('a dropped connection is provider_unavailable', async () => {
    stub.enqueue('drop');
    expect((await failure(adapter.generateOnce(input()))).category).toBe('provider_unavailable');
  });

  it('never carries the provider text, a key or the address', async () => {
    stub.enqueue(bedrockError(403, 'AccessDeniedException', 'SECRET-PROVIDER-TEXT AKIAFAKEKEY'));
    const error = await failure(adapter.generateOnce(input()));
    expect(JSON.stringify([error.message, error.stack])).not.toMatch(/SECRET-PROVIDER-TEXT|AKIAFAKEKEY|fake-secret|127\.0\.0\.1/);
  });
});

describe('time and cancellation', () => {
  it('a call that never answers ends at the time limit as provider_unavailable', async () => {
    stub.enqueue('hang');
    const fast = await createBedrockAdapter({
      region: 'us-east-1',
      model: MODEL,
      timeoutMs: 200,
      test: { endpoint: stub.url, credentials: { accessKeyId: 'AKIAFAKEKEY', secretAccessKey: 'fake-secret' } },
    });
    const started = Date.now();
    expect((await failure(fast.generateOnce(input({ timeoutMs: 200 })))).category).toBe('provider_unavailable');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('an aborted signal ends the call as cancelled', async () => {
    stub.enqueue('hang');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect((await failure(adapter.generateOnce(input({ signal: controller.signal })))).category).toBe('cancelled');
  });
});
