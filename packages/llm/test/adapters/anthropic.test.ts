import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnthropicAdapter } from '../../src/adapters/anthropic.js';
import type { Adapter, GenerateInput } from '../../src/adapters/types.js';
import { AdapterError, type FailureCategory } from '../../src/errors.js';
import { anthropicError, anthropicMessage } from '../../testing/stubs/anthropic.js';
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

beforeEach(async () => {
  stub = await startStub();
  adapter = await createAnthropicAdapter({ apiKey: 'sk-fake-key', baseURL: stub.url, model: 'claude-test', timeoutMs: 5000 });
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
  it('puts instructions in system, the user turn in messages, and asks for a native schema', async () => {
    stub.enqueue(anthropicMessage());
    await adapter.generateOnce(input());
    const req = stub.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('/v1/messages');
    expect(req?.body).toMatchObject({
      model: 'claude-test',
      max_tokens: 16000,
      system: 'SYSTEM-TEXT',
      messages: [{ role: 'user', content: 'USER-TEXT' }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    });
    expect(req?.body).not.toHaveProperty('tools');
    expect(req?.body).not.toHaveProperty('tool_choice');
    expect(req?.body).not.toHaveProperty('temperature');
    expect(req?.body).not.toHaveProperty('stream');
  });

  it('sends temperature 0 only when given one', async () => {
    stub.enqueue(anthropicMessage());
    await adapter.generateOnce(input({ temperature: 0 }));
    expect(stub.requests[0]?.body).toMatchObject({ temperature: 0 });
  });

  it('asks for JSON in the instructions only, with no output_config', async () => {
    stub.enqueue(anthropicMessage());
    await adapter.generateOnce(input({ mode: 'instructions' }));
    expect(stub.requests[0]?.body).not.toHaveProperty('output_config');
  });

  it('adds the retry note to the user turn', async () => {
    stub.enqueue(anthropicMessage());
    await adapter.generateOnce(input({ retryNote: 'RETRY-NOTE' }));
    const body = stub.requests[0]?.body as { messages: { content: string }[] };
    expect(body.messages[0]?.content).toBe('USER-TEXT\n\nRETRY-NOTE');
  });

  it('authenticates with x-api-key and sends no bearer token', async () => {
    stub.enqueue(anthropicMessage());
    await adapter.generateOnce(input());
    const headers = stub.requests[0]?.headers ?? {};
    expect(headers['x-api-key']).toBe('sk-fake-key');
    expect(headers).not.toHaveProperty('authorization');
  });
});

describe('the SDK does not retry', () => {
  it('a 500 makes exactly one request', async () => {
    stub.enqueue(anthropicError(500, 'boom'), anthropicMessage());
    const error = await failure(adapter.generateOnce(input()));
    expect(error.category).toBe('provider_unavailable');
    expect(stub.requests).toHaveLength(1);
  });
});

describe('answers', () => {
  it('returns the text and the tokens, cache tokens included', async () => {
    stub.enqueue(
      anthropicMessage({ text: '{"name":"x"}', usage: { input_tokens: 10, output_tokens: 7, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } }),
    );
    expect(await adapter.generateOnce(input())).toEqual({ kind: 'answer', text: '{"name":"x"}', inputTokens: 17, outputTokens: 7 });
  });

  it('joins several text blocks and skips thinking blocks', async () => {
    stub.enqueue(
      anthropicMessage({ blocks: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'text', text: '{"a"' }, { type: 'text', text: ':1}' }] }),
    );
    const out = await adapter.generateOnce(input());
    expect(out).toMatchObject({ kind: 'answer', text: '{"a":1}' });
  });

  it('max_tokens is a cut-off, refusal is a refusal, with their tokens', async () => {
    stub.enqueue(anthropicMessage({ stop_reason: 'max_tokens', text: '{"na' }), anthropicMessage({ stop_reason: 'refusal', text: '' }));
    expect(await adapter.generateOnce(input())).toMatchObject({ kind: 'cut_off', inputTokens: 10, outputTokens: 5 });
    expect(await adapter.generateOnce(input())).toMatchObject({ kind: 'refused' });
  });

  it('a context window that ran out is a cut-off too', async () => {
    stub.enqueue(anthropicMessage({ stop_reason: 'model_context_window_exceeded' }));
    expect(await adapter.generateOnce(input())).toMatchObject({ kind: 'cut_off' });
  });
});

describe('errors', () => {
  const cases: [string, ReturnType<typeof anthropicError>, FailureCategory, Record<string, unknown>?][] = [
    ['401', anthropicError(401, 'invalid x-api-key'), 'not_authorized'],
    ['403', anthropicError(403, 'forbidden'), 'not_authorized'],
    ['404', anthropicError(404, 'model: nope'), 'not_available'],
    ['413', anthropicError(413, 'request too large'), 'input_too_large'],
    ['429 with retry-after', anthropicError(429, 'slow down', { 'retry-after': '7' }), 'rate_limited', { retryAfterMs: 7000 }],
    ['429 without retry-after', anthropicError(429, 'slow down'), 'rate_limited'],
    ['529', anthropicError(529, 'overloaded'), 'provider_unavailable'],
    ['500', anthropicError(500, 'boom'), 'provider_unavailable'],
    ['400 naming the prompt length', anthropicError(400, 'prompt is too long: 250000 tokens > 200000 maximum'), 'input_too_large'],
    ['400 naming temperature', anthropicError(400, '`temperature` may only be set to 1 for this model'), 'rejected', { rejectedParam: 'temperature' }],
    ['400 naming output_config', anthropicError(400, 'output_config.format: json_schema is not supported by this model'), 'rejected', { rejectedParam: 'format' }],
    ['any other 400', anthropicError(400, 'messages: text content blocks must be non-empty'), 'rejected'],
    ['422', anthropicError(422, 'unprocessable'), 'rejected'],
  ];

  it.each(cases)('%s', async (_name, scripted, category, extra) => {
    stub.enqueue(scripted);
    const error = await failure(adapter.generateOnce(input()));
    expect(error.category).toBe(category);
    for (const [key, value] of Object.entries(extra ?? {})) expect((error as unknown as Record<string, unknown>)[key]).toBe(value);
    if (!extra?.rejectedParam) expect(error.rejectedParam).toBeUndefined();
  });

  it('a dropped connection is provider_unavailable', async () => {
    stub.enqueue('drop');
    expect((await failure(adapter.generateOnce(input()))).category).toBe('provider_unavailable');
    expect(stub.requests).toHaveLength(1);
  });

  it('never carries the provider text, the key or the address', async () => {
    stub.enqueue(anthropicError(401, 'SECRET-PROVIDER-TEXT sk-fake-key'));
    const error = await failure(adapter.generateOnce(input()));
    expect(JSON.stringify([error.message, error.stack])).not.toMatch(/SECRET-PROVIDER-TEXT|sk-fake-key|127\.0\.0\.1/);
  });
});

describe('time and cancellation', () => {
  it('a call that never answers ends at the time limit as provider_unavailable', async () => {
    stub.enqueue('hang');
    const started = Date.now();
    const error = await failure(adapter.generateOnce(input({ timeoutMs: 200 })));
    expect(error.category).toBe('provider_unavailable');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('an aborted signal ends the call as cancelled', async () => {
    stub.enqueue('hang');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const error = await failure(adapter.generateOnce(input({ signal: controller.signal })));
    expect(error.category).toBe('cancelled');
  });
});
