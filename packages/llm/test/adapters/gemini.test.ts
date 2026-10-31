import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGeminiAdapter } from '../../src/adapters/gemini.js';
import type { Adapter, GenerateInput } from '../../src/adapters/types.js';
import { AdapterError, type FailureCategory } from '../../src/errors.js';
import { geminiAnswer, geminiError } from '../../testing/stubs/gemini.js';
import { startStub, type Stub } from '../../testing/stubs/server.js';

const SCHEMA = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false };

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
const make = (timeoutMs = 5000) => createGeminiAdapter({ apiKey: 'AIza-fake-key', baseUrl: stub.url, model: 'gemini-test', timeoutMs });

beforeEach(async () => {
  stub = await startStub();
  adapter = await make();
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

type Body = {
  contents: { role?: string; parts: { text: string }[] }[];
  systemInstruction?: { parts: { text: string }[] };
  generationConfig?: Record<string, unknown>;
  [key: string]: unknown;
};

describe('the request', () => {
  it('sends the instructions as systemInstruction, the user turn as contents, and a native schema', async () => {
    stub.enqueue(geminiAnswer());
    await adapter.generateOnce(input());
    const req = stub.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('/v1beta/models/gemini-test:generateContent');
    const body = req?.body as Body;
    expect(body.systemInstruction?.parts).toEqual([{ text: 'SYSTEM-TEXT' }]);
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'USER-TEXT' }] }]);
    expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json', responseJsonSchema: SCHEMA, maxOutputTokens: 16000 });
    expect(body.generationConfig).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('toolConfig');
  });

  it('sends temperature 0 only when given one', async () => {
    stub.enqueue(geminiAnswer());
    await adapter.generateOnce(input({ temperature: 0 }));
    expect((stub.requests[0]?.body as Body).generationConfig).toMatchObject({ temperature: 0 });
  });

  it('asks for JSON in the instructions only, with no schema', async () => {
    stub.enqueue(geminiAnswer());
    await adapter.generateOnce(input({ mode: 'instructions' }));
    const config = (stub.requests[0]?.body as Body).generationConfig ?? {};
    expect(config).not.toHaveProperty('responseMimeType');
    expect(config).not.toHaveProperty('responseJsonSchema');
    expect(config).toMatchObject({ maxOutputTokens: 16000 });
  });

  it('adds the retry note to the user turn', async () => {
    stub.enqueue(geminiAnswer());
    await adapter.generateOnce(input({ retryNote: 'RETRY' }));
    expect((stub.requests[0]?.body as Body).contents[0]?.parts[0]?.text).toBe('USER-TEXT\n\nRETRY');
  });

  it('authenticates with x-goog-api-key and sends the key nowhere else', async () => {
    stub.enqueue(geminiAnswer());
    await adapter.generateOnce(input());
    expect(stub.requests[0]?.headers['x-goog-api-key']).toBe('AIza-fake-key');
    expect(stub.requests[0]?.query).not.toContain('AIza-fake-key');
    expect(stub.requests[0]?.raw).not.toContain('AIza-fake-key');
  });
});

describe('the SDK does not retry', () => {
  it('a 500 makes exactly one request', async () => {
    stub.enqueue(geminiError(500, 'boom', 'INTERNAL'), geminiAnswer());
    expect((await failure(adapter.generateOnce(input()))).category).toBe('provider_unavailable');
    expect(stub.requests).toHaveLength(1);
  });
});

describe('answers', () => {
  it('returns the text; output tokens include the thinking tokens', async () => {
    stub.enqueue(
      geminiAnswer({ text: '{"name":"x"}', usage: { promptTokenCount: 30, candidatesTokenCount: 7, thoughtsTokenCount: 100, totalTokenCount: 137 } }),
    );
    expect(await adapter.generateOnce(input())).toEqual({ kind: 'answer', text: '{"name":"x"}', inputTokens: 30, outputTokens: 107 });
  });

  it('skips thought parts', async () => {
    stub.enqueue(geminiAnswer({ parts: [{ text: 'thinking...', thought: true }, { text: '{"a":1}' }] }));
    expect(await adapter.generateOnce(input())).toMatchObject({ kind: 'answer', text: '{"a":1}' });
  });

  it('reports no tokens when the answer has no usage', async () => {
    stub.enqueue(geminiAnswer({ usage: null }));
    const out = await adapter.generateOnce(input());
    expect(out).not.toHaveProperty('inputTokens');
  });

  it('MAX_TOKENS is a cut-off', async () => {
    stub.enqueue(geminiAnswer({ finishReason: 'MAX_TOKENS', text: '{"na' }));
    expect((await adapter.generateOnce(input())).kind).toBe('cut_off');
  });

  it.each(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'])('finishReason %s is a refusal', async (finishReason) => {
    stub.enqueue(geminiAnswer({ finishReason, parts: [] }));
    expect((await adapter.generateOnce(input())).kind).toBe('refused');
  });

  it('a blocked prompt is a refusal', async () => {
    stub.enqueue(geminiAnswer({ blockReason: 'SAFETY' }));
    expect((await adapter.generateOnce(input())).kind).toBe('refused');
  });
});

describe('errors', () => {
  const cases: [string, ReturnType<typeof geminiError>, FailureCategory, Record<string, unknown>?][] = [
    ['429', geminiError(429, 'Resource has been exhausted', 'RESOURCE_EXHAUSTED'), 'rate_limited'],
    [
      '429 with a retry delay',
      geminiError(429, 'quota', 'RESOURCE_EXHAUSTED', [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }]),
      'rate_limited',
      { retryAfterMs: 12000 },
    ],
    ['403', geminiError(403, 'permission denied', 'PERMISSION_DENIED'), 'not_authorized'],
    ['401', geminiError(401, 'unauthenticated', 'UNAUTHENTICATED'), 'not_authorized'],
    ['400 for an invalid API key', geminiError(400, 'API key not valid. Please pass a valid API key.'), 'not_authorized'],
    ['404', geminiError(404, 'models/nope is not found', 'NOT_FOUND'), 'not_available'],
    ['400 naming the token count', geminiError(400, 'The input token count (2000000) exceeds the maximum number of tokens allowed (1048576).'), 'input_too_large'],
    ['400 naming temperature', geminiError(400, 'temperature is not supported for this model'), 'rejected', { rejectedParam: 'temperature' }],
    ['400 naming responseJsonSchema', geminiError(400, 'responseJsonSchema is not supported for this model'), 'rejected', { rejectedParam: 'format' }],
    ['any other 400', geminiError(400, 'contents is required'), 'rejected'],
    ['503', geminiError(503, 'unavailable', 'UNAVAILABLE'), 'provider_unavailable'],
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

  it('never carries the provider text, the key or the address', async () => {
    stub.enqueue(geminiError(403, 'SECRET-PROVIDER-TEXT AIza-fake-key', 'PERMISSION_DENIED'));
    const error = await failure(adapter.generateOnce(input()));
    expect(JSON.stringify([error.message, error.stack])).not.toMatch(/SECRET-PROVIDER-TEXT|AIza-fake-key|127\.0\.0\.1/);
  });
});

describe('time and cancellation', () => {
  it('a call that never answers ends at the time limit as provider_unavailable', async () => {
    stub.enqueue('hang');
    const fast = await make(200);
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
