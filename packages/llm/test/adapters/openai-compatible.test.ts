import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpenAICompatibleAdapter } from '../../src/adapters/openai-compatible.js';
import type { Adapter, GenerateInput } from '../../src/adapters/types.js';
import { AdapterError, type FailureCategory } from '../../src/errors.js';
import { openaiCompletion, openaiError, plainError } from '../../testing/stubs/openai.js';
import { startStub, type Stub } from '../../testing/stubs/server.js';

const SCHEMA = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false };

function input(over: Partial<GenerateInput> = {}): GenerateInput {
  return {
    system: 'SYSTEM-TEXT',
    user: 'USER-TEXT',
    jsonSchema: SCHEMA,
    strict: true,
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
const make = (over: { apiKey?: string | null; baseURL?: string } = {}) =>
  createOpenAICompatibleAdapter({ apiKey: 'sk-fake-key', baseURL: `${stub.url}/v1`, model: 'llama3.2', timeoutMs: 5000, ...over });

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
  model: string;
  messages: { role: string; content: string }[];
  response_format?: { type: string; json_schema?: { name: string; strict: boolean; schema: unknown } };
  [key: string]: unknown;
};
const bodyOf = (): Body => stub.requests[0]?.body as Body;

describe('the request', () => {
  it('sends the instructions as the system message and the user turn as a user message', async () => {
    stub.enqueue(openaiCompletion());
    await adapter.generateOnce(input());
    expect(stub.requests[0]?.path).toBe('/v1/chat/completions');
    expect(bodyOf().model).toBe('llama3.2');
    expect(bodyOf().messages).toEqual([
      { role: 'system', content: 'SYSTEM-TEXT' },
      { role: 'user', content: 'USER-TEXT' },
    ]);
  });

  it('appends the retry note to the user turn', async () => {
    stub.enqueue(openaiCompletion());
    await adapter.generateOnce(input({ retryNote: 'RETRY' }));
    expect(bodyOf().messages[1]?.content).toBe('USER-TEXT\n\nRETRY');
  });

  it('asks for a native json_schema, strict only when told it may be', async () => {
    stub.enqueue(openaiCompletion(), openaiCompletion());
    await adapter.generateOnce(input({ strict: true }));
    await adapter.generateOnce(input({ strict: false }));
    expect((stub.requests[0]?.body as Body).response_format).toEqual({ type: 'json_schema', json_schema: { name: 'thing', strict: true, schema: SCHEMA } });
    expect((stub.requests[1]?.body as Body).response_format?.json_schema?.strict).toBe(false);
  });

  it('json_object mode sends json_object, and instructions mode sends no response_format', async () => {
    stub.enqueue(openaiCompletion(), openaiCompletion());
    await adapter.generateOnce(input({ mode: 'json_object' }));
    await adapter.generateOnce(input({ mode: 'instructions' }));
    expect((stub.requests[0]?.body as Body).response_format).toEqual({ type: 'json_object' });
    expect(stub.requests[1]?.body).not.toHaveProperty('response_format');
  });

  it('names the output limit as told: max_tokens or max_completion_tokens', async () => {
    stub.enqueue(openaiCompletion(), openaiCompletion());
    await adapter.generateOnce(input({ maxTokensParam: 'max_tokens' }));
    await adapter.generateOnce(input({ maxTokensParam: 'max_completion_tokens' }));
    expect(stub.requests[0]?.body).toMatchObject({ max_tokens: 16000 });
    expect(stub.requests[0]?.body).not.toHaveProperty('max_completion_tokens');
    expect(stub.requests[1]?.body).toMatchObject({ max_completion_tokens: 16000 });
    expect(stub.requests[1]?.body).not.toHaveProperty('max_tokens');
  });

  it('sends temperature 0 only when given one, and never tools or streaming', async () => {
    stub.enqueue(openaiCompletion(), openaiCompletion());
    await adapter.generateOnce(input({ temperature: 0 }));
    await adapter.generateOnce(input());
    expect(stub.requests[0]?.body).toMatchObject({ temperature: 0 });
    expect(stub.requests[1]?.body).not.toHaveProperty('temperature');
    for (const r of stub.requests) {
      expect(r.body).not.toHaveProperty('tools');
      expect(r.body).not.toHaveProperty('tool_choice');
      expect(r.body).not.toHaveProperty('functions');
      expect(r.body).not.toHaveProperty('stream');
    }
  });
});

describe('authorization and address', () => {
  it('sends the key as a bearer token', async () => {
    stub.enqueue(openaiCompletion());
    await adapter.generateOnce(input());
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-fake-key');
    expect(stub.requests[0]?.headers).not.toHaveProperty('openai-organization');
    expect(stub.requests[0]?.headers).not.toHaveProperty('openai-project');
  });

  it('sends a fixed placeholder when there is no key', async () => {
    const keyless = await make({ apiKey: null });
    stub.enqueue(openaiCompletion());
    await keyless.generateOnce(input());
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer unused');
  });

  it('turns credentials in the base address into basic authentication, and sends them nowhere else', async () => {
    const withCredentials = await make({ apiKey: null, baseURL: `${stub.url.replace('http://', 'http://user:p%40ss@')}/v1` });
    stub.enqueue(openaiCompletion());
    await withCredentials.generateOnce(input());
    expect(stub.requests[0]?.path).toBe('/v1/chat/completions');
    expect(stub.requests[0]?.headers.authorization).toBe(`Basic ${Buffer.from('user:p@ss').toString('base64')}`);
  });

  it('prefers the API key to credentials in the address, and still sends the address without them', async () => {
    const both = await make({ baseURL: `${stub.url.replace('http://', 'http://user:pw@')}/v1` });
    stub.enqueue(openaiCompletion());
    await both.generateOnce(input());
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-fake-key');
  });

  it("respects Azure's v1 base address, which ends in /openai/v1/", async () => {
    const azure = await make({ baseURL: `${stub.url}/openai/v1/` });
    stub.enqueue(openaiCompletion());
    await azure.generateOnce(input());
    expect(stub.requests[0]?.path).toBe('/openai/v1/chat/completions');
  });
});

describe('the SDK does not retry', () => {
  it('a 500 makes exactly one request', async () => {
    stub.enqueue(openaiError(500, 'boom'), openaiCompletion());
    expect((await failure(adapter.generateOnce(input()))).category).toBe('provider_unavailable');
    expect(stub.requests).toHaveLength(1);
  });
});

describe('answers', () => {
  it('returns the text and the tokens', async () => {
    stub.enqueue(openaiCompletion({ content: '{"name":"x"}', usage: { prompt_tokens: 21, completion_tokens: 8, total_tokens: 29 } }));
    expect(await adapter.generateOnce(input())).toEqual({ kind: 'answer', text: '{"name":"x"}', inputTokens: 21, outputTokens: 8 });
  });

  it('reports no tokens when the server gives no usage', async () => {
    stub.enqueue(openaiCompletion({ usage: null }));
    const out = await adapter.generateOnce(input());
    expect(out.kind).toBe('answer');
    expect(out).not.toHaveProperty('inputTokens');
    expect(out).not.toHaveProperty('outputTokens');
  });

  it('length is a cut-off; a refusal and a content filter are refusals', async () => {
    stub.enqueue(
      openaiCompletion({ finish_reason: 'length', content: '{"na' }),
      openaiCompletion({ content: null, refusal: 'I cannot help with that.' }),
      openaiCompletion({ content: null, finish_reason: 'content_filter' }),
    );
    expect((await adapter.generateOnce(input())).kind).toBe('cut_off');
    expect((await adapter.generateOnce(input())).kind).toBe('refused');
    expect((await adapter.generateOnce(input())).kind).toBe('refused');
  });
});

describe('errors', () => {
  const cases: [string, ReturnType<typeof openaiError>, FailureCategory, Record<string, unknown>?][] = [
    ['401', openaiError(401, 'bad key', { code: 'invalid_api_key' }), 'not_authorized'],
    ['403', openaiError(403, 'no access'), 'not_authorized'],
    ['404', openaiError(404, 'The model does not exist', { code: 'model_not_found' }), 'not_available'],
    ['429 with retry-after', openaiError(429, 'rate limit', { headers: { 'retry-after': '3' } }), 'rate_limited', { retryAfterMs: 3000 }],
    ['503', openaiError(503, 'overloaded'), 'provider_unavailable'],
    ['400 with param temperature', openaiError(400, "Unsupported value: 'temperature' does not support 0", { param: 'temperature' }), 'rejected', { rejectedParam: 'temperature' }],
    ['400 naming temperature with no param (vLLM style)', plainError(400, 'temperature is not supported for this model'), 'rejected', { rejectedParam: 'temperature' }],
    ['400 naming max_tokens', openaiError(400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", { param: 'max_tokens' }), 'rejected', { rejectedParam: 'max_tokens' }],
    ['400 naming response_format', plainError(400, "response_format of type 'json_schema' is not supported"), 'rejected', { rejectedParam: 'format' }],
    ['400 context_length_exceeded', openaiError(400, "This model's maximum context length is 8192 tokens.", { code: 'context_length_exceeded' }), 'input_too_large'],
    ['any other 400', plainError(400, 'messages must be an array'), 'rejected'],
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
    stub.enqueue(openaiError(401, 'SECRET-PROVIDER-TEXT sk-fake-key'));
    const error = await failure(adapter.generateOnce(input()));
    expect(JSON.stringify([error.message, error.stack])).not.toMatch(/SECRET-PROVIDER-TEXT|sk-fake-key|127\.0\.0\.1/);
  });
});

describe('time and cancellation', () => {
  it('a call that never answers ends at the time limit as provider_unavailable', async () => {
    stub.enqueue('hang');
    const started = Date.now();
    expect((await failure(adapter.generateOnce(input({ timeoutMs: 200 })))).category).toBe('provider_unavailable');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('an aborted signal ends the call as cancelled', async () => {
    stub.enqueue('hang');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect((await failure(adapter.generateOnce(input({ signal: controller.signal })))).category).toBe('cancelled');
  });
});
