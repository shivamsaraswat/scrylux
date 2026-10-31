import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkRequest, type LlmConfig } from '@scrylux/llm';
import {
  anthropicMessage, createLlmWithEndpoints, openaiCompletion, openaiEmbeddings, openaiError, resetCapabilityOverrides, startStub,
  type RecordedRequest, type Scripted, type Stub,
} from '@scrylux/llm/testing';
import { runCheck } from '../../src/llm-check.js';

let stub: Stub;
let out: string;
let err: string;

const sink = (write: (s: string) => void) => ({ write: (s: string) => void write(s) });
const noWait = { sleep: () => Promise.resolve(), random: () => 0 };

// Routes by path: chat completions get a valid check answer, embeddings get a vector.
const answerBoth = (r: RecordedRequest): Scripted =>
  r.path.endsWith('/embeddings') ? openaiEmbeddings([[0.1, 0.2, 0.3]], 9) : openaiCompletion({ content: '{"status":"ok"}', usage: { prompt_tokens: 64, completion_tokens: 9, total_tokens: 73 } });

/** Runs the check with a client whose adapters talk to the stub. */
function check(env: Record<string, string>, keys: { llmApiKey?: string; embeddingApiKey?: string } = {}) {
  return runCheck({
    env,
    keys,
    stdout: sink((s) => (out += s)),
    stderr: sink((s) => (err += s)),
    createLlm: (config: LlmConfig, options) =>
      createLlmWithEndpoints(config, { ...options, deps: noWait, endpoints: { anthropic: { baseURL: stub.url }, gemini: { baseUrl: stub.url } } }),
  });
}

const OLLAMA = () => ({
  LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'llama3.2', LLM_BASE_URL: `${stub.url}/v1`, LLM_LOCAL: 'true',
  EMBEDDING_PROVIDER: 'openai-compatible', EMBEDDING_MODEL: 'nomic-embed-text', EMBEDDING_BASE_URL: `${stub.url}/v1`, EMBEDDING_LOCAL: 'true',
});

beforeEach(async () => {
  resetCapabilityOverrides();
  stub = await startStub();
  stub.setFallback(answerBoth);
  out = '';
  err = '';
});
afterEach(() => stub.close());

describe('nothing configured', () => {
  it('says so, sends nothing and exits 0', async () => {
    expect(await check({})).toBe(0);
    expect(out).toBe('No AI provider is configured. Scrylux runs without AI features. See docs/ai-providers.md.\n');
    expect(err).toBe('');
    expect(stub.requests).toHaveLength(0);
  });
});

describe('every configured operation works', () => {
  it('prints one block for each, in the contract’s format, and exits 0', async () => {
    expect(await check(OLLAMA())).toBe(0);
    const blocks = out.trimEnd().split('\n\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatch(
      /^Generation: openai-compatible, model llama3\.2, local \(declared with LLM_LOCAL=true\)\n {2}OK in \d+\.\d s, 1 attempt, 64 input \+ 9 output tokens, cost unknown \(no price set\)$/,
    );
    expect(blocks[1]).toMatch(
      /^Embeddings: openai-compatible, model nomic-embed-text, local \(declared with EMBEDDING_LOCAL=true\)\n {2}OK in \d+\.\d s, dimension 3, 9 input tokens, cost unknown \(no price set\)$/,
    );
  });

  it('says hosted, with a cost from the price list, for a hosted provider', async () => {
    stub.setFallback(() => anthropicMessage({ text: '{"status":"ok"}', usage: { input_tokens: 64, output_tokens: 9 } }));
    expect(await check({ LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-haiku-5-5' }, { llmApiKey: 'sk-check-key' })).toBe(0);
    expect(out).toMatch(/^Generation: anthropic, model claude-haiku-5-5, hosted \(data sent to it leaves this install\)\n {2}OK in \d+\.\d s, 1 attempt, 64 input \+ 9 output tokens, cost \$0\.\d{6} \(price list\)\n$/);
  });

  it('shows the operator’s price as the source, and $0.000000 for a price of zero', async () => {
    expect(await check({ ...OLLAMA(), LLM_PRICE_INPUT: '0', LLM_PRICE_OUTPUT: '0' })).toBe(0);
    expect(out).toContain('cost $0.000000 (operator price)');
  });

  it('marks tokens it had to estimate', async () => {
    stub.setFallback((r) => (r.path.endsWith('/embeddings') ? { status: 200, json: { object: 'list', model: 'x', data: [{ object: 'embedding', index: 0, embedding: [1, 2] }] } } : openaiCompletion({ content: '{"status":"ok"}', usage: null })));
    expect(await check(OLLAMA())).toBe(0);
    expect(out).toMatch(/input \+ \d+ output tokens \(estimated\)/);
    expect(out).toMatch(/dimension 2, \d+ input tokens \(estimated\)/);
  });
});

describe('what is sent', () => {
  it('is the fixed request of the data file and nothing else', async () => {
    await check(OLLAMA());
    const chat = stub.requests.find((r) => r.path.endsWith('/chat/completions'))?.body as { messages: { role: string; content: string }[] };
    const embed = stub.requests.find((r) => r.path.endsWith('/embeddings'))?.body as { input: string[] };
    const fixed = checkRequest();
    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[0]?.content).toBe(fixed.generation.instructions);
    expect(chat.messages[0]?.role).toBe('system');
    expect(embed.input).toEqual([fixed.embedding.text]);
    expect(stub.requests).toHaveLength(2);
  });
});

describe('a failure', () => {
  it('names the operation, the category and what to check, and exits 1, while still checking the other', async () => {
    stub.setFallback((r) => (r.path.endsWith('/embeddings') ? openaiEmbeddings([[1]], 3) : openaiError(401, 'bad key')));
    expect(await check({ ...OLLAMA(), LLM_API_KEY: 'sk-check-key' })).toBe(1);
    const blocks = out.trimEnd().split('\n\n');
    expect(blocks[0]).toBe(
      'Generation: openai-compatible, model llama3.2, local (declared with LLM_LOCAL=true)\n' +
        '  FAILED: not authorized. The provider refused the credentials. Check the API key and its permissions.\n' +
        '  Check LLM_API_KEY, and that the key may use this model. For Bedrock, check the role’s permissions.\n' +
        '  Used: 1 attempt, 0 input + 0 output tokens, cost unknown (no price set)',
    );
    expect(blocks[1]).toContain('OK in');
  });

  it('says an unknown model is not available, and how to fix it for Ollama', async () => {
    stub.setFallback(() => openaiError(404, 'model not found', { code: 'model_not_found' }));
    expect(await check({ ...OLLAMA(), EMBEDDING_PROVIDER: '', EMBEDDING_MODEL: '', EMBEDDING_BASE_URL: '', EMBEDDING_LOCAL: '' })).toBe(1);
    expect(out).toContain('FAILED: not available. The provider does not know this model, or it is not enabled for this account.');
    expect(out).toContain('Check LLM_MODEL. For Ollama, run `ollama pull <model>` first.');
  });

  it('still reports what a failed operation used, with every attempt’s tokens (FR-046)', async () => {
    const usage = { prompt_tokens: 64, completion_tokens: 9, total_tokens: 73 };
    stub.setFallback((r) => (r.path.endsWith('/embeddings') ? openaiEmbeddings([[1]], 3) : openaiCompletion({ content: '{}', usage })));
    expect(await check(OLLAMA())).toBe(1);
    const blocks = out.trimEnd().split('\n\n');
    expect(blocks[0]).toContain('FAILED: invalid output.');
    expect(blocks[0]).toContain('  Used: 3 attempts, 192 input + 27 output tokens, cost unknown (no price set)');
    expect(blocks[1]).toContain('OK in');
    expect(blocks[1]).not.toContain('Used:');
  });

  it('marks estimated tokens, and shows the price source, on a failed operation too', async () => {
    stub.setFallback(() => openaiCompletion({ content: '{}', usage: null }));
    expect(await check({ ...OLLAMA(), EMBEDDING_PROVIDER: '', EMBEDDING_MODEL: '', EMBEDDING_BASE_URL: '', EMBEDDING_LOCAL: '', LLM_PRICE_INPUT: '1', LLM_PRICE_OUTPUT: '2' })).toBe(1);
    expect(out).toMatch(/Used: 3 attempts, \d+ input \+ \d+ output tokens \(estimated\), cost \$0\.\d{6} \(operator price, from estimated tokens\)/);
  });

  it('reports what a failed embedding used', async () => {
    stub.setFallback((r) => (r.path.endsWith('/embeddings') ? openaiError(401, 'bad key') : openaiCompletion({ content: '{"status":"ok"}' })));
    expect(await check(OLLAMA())).toBe(1);
    expect(out).toContain('Used: 1 attempt, 0 input tokens, cost unknown (no price set)');
  });

  it('gives a hint for every category it can report, naming a variable', async () => {
    const cases: [number, string, string][] = [
      [429, 'rate limited', 'LLM_API_KEY'],
      [500, 'provider unavailable', 'LLM_BASE_URL'],
      [400, 'rejected', 'LLM_MODEL'],
    ];
    for (const [status, label, hint] of cases) {
      out = '';
      stub.setFallback(() => openaiError(status, 'x', { headers: { 'retry-after': '99' } }));
      expect(await check({ ...OLLAMA(), EMBEDDING_PROVIDER: '', EMBEDDING_MODEL: '', EMBEDDING_BASE_URL: '', EMBEDDING_LOCAL: '' })).toBe(1);
      expect(out).toContain(`FAILED: ${label}.`);
      expect(out).toContain(hint);
    }
  });
});

describe('an invalid configuration', () => {
  it('prints the message that names the setting, sends nothing and exits 2', async () => {
    const env = { LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'llama3.2', LLM_BASE_URL: 'http://ollama:11434/v1' };
    expect(await check(env)).toBe(2);
    expect(out).toContain('Invalid AI provider configuration:');
    expect(out).toContain('https');
    expect(out).toContain('LLM_LOCAL');
    expect(stub.requests).toHaveLength(0);
  });

  it('refuses a vendor variable the same way the server does', async () => {
    expect(await check({ ...OLLAMA(), OPENAI_API_KEY: 'x' })).toBe(2);
    expect(out).toContain('OPENAI_API_KEY');
  });
});

describe('the two streams', () => {
  it('keeps the report on stdout and one llm_request line per operation on stderr', async () => {
    await check(OLLAMA());
    expect(out.split('\n').some((line) => line.startsWith('{'))).toBe(false);
    const lines = err.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => (JSON.parse(l) as { event: string; operation: string }).operation)).toEqual(['generate', 'embed']);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ event: 'llm_request', outcome: 'ok' });
  });

  it('writes one line for a failed operation too', async () => {
    stub.setFallback(() => openaiError(401, 'x'));
    await check({ ...OLLAMA(), EMBEDDING_PROVIDER: '', EMBEDDING_MODEL: '', EMBEDDING_BASE_URL: '', EMBEDDING_LOCAL: '' });
    expect(err.trimEnd().split('\n')).toHaveLength(1);
  });
});

describe('what is never printed', () => {
  it('holds no key and no base address, on either stream, for a success or a failure', async () => {
    const env = { ...OLLAMA(), LLM_API_KEY: 'sk-check-key', LLM_BASE_URL: `${stub.url.replace('http://', 'http://user:topsecret@')}/v1` };
    await check(env);
    stub.setFallback(() => openaiError(401, 'sk-check-key topsecret'));
    await check(env);
    for (const stream of [out, err]) {
      expect(stream).not.toMatch(/sk-check-key|topsecret|127\.0\.0\.1/);
    }
  });
});
