import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  anthropicError, anthropicMessage, bedrockError, converseAnswer, createLlmWithEndpoints, geminiAnswer, geminiEmbeddings, geminiError,
  invokeAnswer, openaiCompletion, openaiEmbeddings, openaiError, resetCapabilityOverrides, startStub,
  type RecordedRequest, type Scripted, type Stub,
} from '@scrylux/llm/testing';
import type { FailureCategory, Llm, LlmConfig, OperationConfig, ProviderName } from '@scrylux/llm';
import { runCheck } from '../../src/llm-check.js';

// SC-005 (Phase 3 Milestone 1): a recognizable fake key, fake document content and a fake password in a base address go
// through every outcome of FR-020 on every adapter, and appear in no log line, error, failure, usage record or output.
// The stub servers answer with error bodies that echo all three, the way a provider can echo a request.

const KEY = 'sk-canary-7f3a9c';
const DOC = 'CANARY-DOC-5e1b';
const PW = 'CANARY-PW-91d2';
const ECHO = `${KEY} ${DOC} ${PW}`;
const ALL_CANARIES = [KEY, DOC, PW];

const schema = z.strictObject({ x: z.number() });
const request = { schema, schemaName: 'thing', instructions: 'Describe the document.', content: DOC };
const GOOD = '{"x":1}';
const noWait = { sleep: () => Promise.resolve(), random: () => 0 };

const PROVIDERS: { provider: ProviderName; http2: boolean }[] = [
  { provider: 'anthropic', http2: false },
  { provider: 'openai-compatible', http2: false },
  { provider: 'bedrock', http2: true },
  { provider: 'gemini', http2: false },
];

// What each provider sends for each way a request can end, with the canaries in every free-text field.
type Kind = 'ok' | 'invalid_output' | 'not_authorized' | 'not_available' | 'rate_limited' | 'provider_unavailable' | 'input_too_large' | 'output_limit_reached' | 'refused' | 'rejected';
const scripts: Record<ProviderName, Record<Kind, Scripted[]>> = {
  anthropic: {
    ok: [anthropicMessage({ text: GOOD })],
    invalid_output: Array.from({ length: 3 }, () => anthropicMessage({ text: `{"wrong":"${ECHO}"}` })),
    not_authorized: [anthropicError(401, ECHO)],
    not_available: [anthropicError(404, ECHO)],
    rate_limited: [anthropicError(429, ECHO, { 'retry-after': '61' })],
    provider_unavailable: Array.from({ length: 3 }, () => anthropicError(500, ECHO)),
    input_too_large: [anthropicError(400, `prompt is too long: ${ECHO}`)],
    output_limit_reached: [anthropicMessage({ stop_reason: 'max_tokens', text: ECHO })],
    refused: [anthropicMessage({ stop_reason: 'refusal', text: ECHO })],
    rejected: [anthropicError(400, `messages: ${ECHO}`)],
  },
  'openai-compatible': {
    ok: [openaiCompletion({ content: GOOD })],
    invalid_output: Array.from({ length: 3 }, () => openaiCompletion({ content: `{"wrong":"${ECHO}"}` })),
    not_authorized: [openaiError(401, ECHO)],
    not_available: [openaiError(404, ECHO)],
    rate_limited: [openaiError(429, ECHO, { headers: { 'retry-after': '61' } })],
    provider_unavailable: Array.from({ length: 3 }, () => openaiError(500, ECHO)),
    input_too_large: [openaiError(400, ECHO, { code: 'context_length_exceeded' })],
    output_limit_reached: [openaiCompletion({ finish_reason: 'length', content: ECHO })],
    refused: [openaiCompletion({ content: null, refusal: ECHO })],
    rejected: [openaiError(400, `messages: ${ECHO}`)],
  },
  bedrock: {
    ok: [converseAnswer({ text: GOOD })],
    invalid_output: Array.from({ length: 3 }, () => converseAnswer({ text: `{"wrong":"${ECHO}"}` })),
    not_authorized: [bedrockError(403, 'AccessDeniedException', ECHO)],
    not_available: [bedrockError(404, 'ResourceNotFoundException', ECHO)],
    rate_limited: Array.from({ length: 3 }, () => bedrockError(429, 'ThrottlingException', ECHO)),
    provider_unavailable: Array.from({ length: 3 }, () => bedrockError(500, 'InternalServerException', ECHO)),
    input_too_large: [bedrockError(400, 'ValidationException', `Input is too long: ${ECHO}`)],
    output_limit_reached: [converseAnswer({ stopReason: 'max_tokens', text: ECHO })],
    refused: [converseAnswer({ stopReason: 'guardrail_intervened', text: ECHO })],
    rejected: [bedrockError(400, 'ValidationException', `messages: ${ECHO}`)],
  },
  gemini: {
    ok: [geminiAnswer({ text: GOOD })],
    invalid_output: Array.from({ length: 3 }, () => geminiAnswer({ text: `{"wrong":"${ECHO}"}` })),
    not_authorized: [geminiError(403, ECHO, 'PERMISSION_DENIED')],
    not_available: [geminiError(404, ECHO, 'NOT_FOUND')],
    rate_limited: [geminiError(429, ECHO, 'RESOURCE_EXHAUSTED', [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '61s' }])],
    provider_unavailable: Array.from({ length: 3 }, () => geminiError(500, ECHO, 'INTERNAL')),
    input_too_large: [geminiError(400, `The input token count exceeds the maximum: ${ECHO}`)],
    output_limit_reached: [geminiAnswer({ finishReason: 'MAX_TOKENS', text: ECHO })],
    refused: [geminiAnswer({ finishReason: 'SAFETY', text: ECHO })],
    rejected: [geminiError(400, `contents: ${ECHO}`)],
  },
};

const EXPECTED: Record<Kind, FailureCategory | 'ok'> = {
  ok: 'ok', invalid_output: 'invalid_output', not_authorized: 'not_authorized', not_available: 'not_available', rate_limited: 'rate_limited',
  provider_unavailable: 'provider_unavailable', input_too_large: 'input_too_large', output_limit_reached: 'output_limit_reached', refused: 'refused', rejected: 'rejected',
};

function operation(provider: ProviderName, stub: Stub, over: Partial<OperationConfig> = {}): OperationConfig {
  return {
    provider,
    model: 'canary-model',
    baseUrl: provider === 'openai-compatible' ? `http://u:${PW}@${stub.url.replace('http://', '')}/v1` : null,
    apiKey: provider === 'bedrock' ? null : KEY,
    region: provider === 'bedrock' ? 'us-east-1' : null,
    local: provider === 'openai-compatible',
    hosted: provider !== 'openai-compatible',
    operatorPrice: null,
    ...over,
  };
}

function client(config: LlmConfig, stub: Stub | undefined, lines: string[]): Llm {
  const url = stub?.url ?? 'http://127.0.0.1:1';
  return createLlmWithEndpoints(config, {
    log: (line) => lines.push(line),
    deps: noWait,
    endpoints: {
      anthropic: { baseURL: url },
      gemini: { baseUrl: url },
      bedrock: { endpoint: url, credentials: { accessKeyId: 'AKIACANARYFAKE', secretAccessKey: KEY } },
    },
  });
}

let output: string[];
let lines: string[];

beforeEach(() => {
  resetCapabilityOverrides();
  output = [];
  lines = [];
  const take = (chunk: unknown): boolean => {
    output.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(take);
  vi.spyOn(process.stderr, 'write').mockImplementation(take);
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void take(args.join(' ')));
});
afterEach(() => vi.restoreAllMocks());

/** Everything a caller, an operator or a log reader could see after a request. */
function everythingSeen(...results: unknown[]): string {
  return [...output, ...lines, ...results.map((r) => JSON.stringify(r))].join('\n');
}
function expectNoCanary(seen: string): void {
  for (const canary of ALL_CANARIES) expect(seen, `"${canary}" appeared`).not.toContain(canary);
  expect(seen).not.toContain('127.0.0.1');
}

describe.each(PROVIDERS)('generation through $provider', ({ provider, http2 }) => {
  it.each(Object.keys(EXPECTED) as Kind[])('%s leaks nothing', async (kind) => {
    const stub = await startStub({ http2 });
    stub.enqueue(...scripts[provider][kind]);
    const result = await client({ generation: operation(provider, stub), embedding: null, timeoutMs: 5000 }, stub, lines).generate(request);
    await stub.close();

    expect(result.ok ? 'ok' : result.failure.category).toBe(EXPECTED[kind]);
    expect(lines).toHaveLength(1);
    expectNoCanary(everythingSeen(result));
  });

  it('cancelled leaks nothing', async () => {
    const stub = await startStub({ http2 });
    stub.enqueue('hang');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const result = await client({ generation: operation(provider, stub), embedding: null, timeoutMs: 5000 }, stub, lines).generate({ ...request, signal: controller.signal });
    await stub.close();
    expect(!result.ok && result.failure.category).toBe('cancelled');
    expectNoCanary(everythingSeen(result));
  });

  it('not configured leaks nothing', async () => {
    const result = await client({ generation: null, embedding: null, timeoutMs: 5000 }, undefined, lines).generate(request);
    expect(!result.ok && result.failure.category).toBe('not_configured');
    expectNoCanary(everythingSeen(result));
  });
});

describe('a base address with credentials in it', () => {
  it('is used as basic authentication when there is no key, and never shown', async () => {
    const stub = await startStub();
    stub.enqueue(openaiCompletion({ content: GOOD }));
    const result = await client({ generation: operation('openai-compatible', stub, { apiKey: null }), embedding: null, timeoutMs: 5000 }, stub, lines).generate(request);
    await stub.close();
    expect(result.ok).toBe(true);
    expect(stub.requests[0]?.path).toBe('/v1/chat/completions');
    expect(stub.requests[0]?.headers.authorization).toBe(`Basic ${Buffer.from(`u:${PW}`).toString('base64')}`);
    expectNoCanary(everythingSeen(result));
  });
});

describe.each([
  { provider: 'openai-compatible' as const, http2: false, ok: (): Scripted => openaiEmbeddings([[1, 2]]), authFail: (): Scripted => openaiError(401, ECHO), tooLong: (): Scripted => openaiError(400, ECHO, { code: 'context_length_exceeded' }) },
  { provider: 'bedrock' as const, http2: true, ok: (): Scripted => invokeAnswer({ embedding: [1, 2], inputTextTokenCount: 3 }), authFail: (): Scripted => bedrockError(403, 'AccessDeniedException', ECHO), tooLong: (): Scripted => bedrockError(400, 'ValidationException', `Too many input tokens: ${ECHO}`) },
  { provider: 'gemini' as const, http2: false, ok: (): Scripted => geminiEmbeddings([[1, 2]]), authFail: (): Scripted => geminiError(403, ECHO, 'PERMISSION_DENIED'), tooLong: (): Scripted => geminiError(400, `The input token count exceeds the maximum: ${ECHO}`) },
])('embeddings through $provider', ({ provider, http2, ok, authFail, tooLong }) => {
  const run = async (script: Scripted[]) => {
    const stub = await startStub({ http2 });
    stub.enqueue(...script);
    stub.setFallback(() => script.at(-1) ?? ok());
    const result = await client({ generation: null, embedding: operation(provider, stub, { model: provider === 'bedrock' ? 'amazon.titan-embed-text-v2:0' : 'embed-model' }), timeoutMs: 5000 }, stub, lines).embed({ texts: [DOC] });
    await stub.close();
    return result;
  };

  it.each([['ok', () => [ok()]], ['not_authorized', () => [authFail()]], ['input_too_large', () => [tooLong()]]] as [string, () => Scripted[]][])('%s leaks nothing', async (_name, script) => {
    const result = await run(script());
    expect(lines).toHaveLength(1);
    expectNoCanary(everythingSeen(result));
  });
});

describe('a stray vendor variable', () => {
  const VENDOR: Record<string, string> = {
    OPENAI_API_KEY: 'CANARY-VENDOR-OPENAI-KEY',
    OPENAI_BASE_URL: 'http://127.0.0.1:1/CANARY-VENDOR-OPENAI-URL',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/CANARY-VENDOR-ANTHROPIC-URL',
    ANTHROPIC_AUTH_TOKEN: 'CANARY-VENDOR-ANTHROPIC-TOKEN',
    GEMINI_API_KEY: 'CANARY-VENDOR-GEMINI-KEY',
  };
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const [name, value] of Object.entries(VENDOR)) {
      saved.set(name, process.env[name]);
      process.env[name] = value;
    }
  });
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  // The adapters are built directly, which skips the start-up refusal of these variables (rule 11): this shows that,
  // even if one got through, no SDK would use it.
  it.each(PROVIDERS)('reaches nothing through $provider', async ({ provider, http2 }) => {
    const stub = await startStub({ http2 });
    stub.enqueue(...scripts[provider].ok);
    const result = await client({ generation: operation(provider, stub), embedding: null, timeoutMs: 5000 }, stub, lines).generate(request);
    await stub.close();

    expect(result.ok).toBe(true);
    const seen = stub.requests.map((r: RecordedRequest) => JSON.stringify([r.path, r.query, r.headers, r.raw])).join('\n');
    expect(stub.requests).toHaveLength(1);
    expect(seen).not.toContain('CANARY-VENDOR');
  });
});

// The check command (T064): its report and its log lines hold none of the canaries either, when it succeeds and when
// the provider fails and echoes them back.
describe('the check command', () => {
  const runWith = async (script: (r: RecordedRequest) => Scripted) => {
    const stub = await startStub();
    stub.setFallback(script);
    let out = '';
    let err = '';
    const code = await runCheck({
      env: {
        LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'canary-model', LLM_BASE_URL: `http://u:${PW}@${stub.url.replace('http://', '')}/v1`, LLM_LOCAL: 'true',
        EMBEDDING_PROVIDER: 'openai-compatible', EMBEDDING_MODEL: 'canary-embed', EMBEDDING_BASE_URL: `http://u:${PW}@${stub.url.replace('http://', '')}/v1`, EMBEDDING_LOCAL: 'true',
      },
      keys: { llmApiKey: KEY },
      stdout: { write: (t: string) => void (out += t) },
      stderr: { write: (t: string) => void (err += t) },
      createLlm: (config, options) => createLlmWithEndpoints(config, { ...options, deps: noWait, endpoints: {} }),
    });
    await stub.close();
    return { code, out, err };
  };

  it('prints none of them when it works', async () => {
    const { code, out: report, err: log } = await runWith((r) => (r.path.endsWith('/embeddings') ? openaiEmbeddings([[1, 2]], 3) : openaiCompletion({ content: '{"status":"ok"}' })));
    expect(code).toBe(0);
    expectNoCanary(`${report}\n${log}`);
  });

  it('prints none of them when the provider fails and echoes them', async () => {
    for (const status of [401, 404, 429, 500, 400]) {
      const { code, out: report, err: log } = await runWith(() => openaiError(status, ECHO, { headers: { 'retry-after': '61' } }));
      expect(code).toBe(1);
      expect(report).toContain('FAILED');
      expectNoCanary(`${report}\n${log}`);
    }
  });
});
