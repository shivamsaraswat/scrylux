import { describe, expect, it } from 'vitest';
import { LlmConfigError } from '../src/errors.js';
import { llmStatus, parseLlmConfig, parseLlmStatus } from '../src/config.js';

// parseLlmStatus is parseLlmConfig without the rule that a key must be present (Phase 3 Milestone 2, FR-071): the API
// process reports whether AI is configured, and needs no key to do so. Everything else must agree, so the two cannot
// drift apart.

type Env = Record<string, string | undefined>;

const ANTHROPIC: Env = { LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-haiku-5-5' };
const GEMINI: Env = { LLM_PROVIDER: 'gemini', LLM_MODEL: 'gemini-3-flash' };
const OLLAMA: Env = { LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'llama3.2', LLM_BASE_URL: 'http://ollama:11434/v1', LLM_LOCAL: 'true' };
const BEDROCK: Env = { LLM_PROVIDER: 'bedrock', LLM_MODEL: 'anthropic.claude-haiku-5-5-v1:0', LLM_REGION: 'us-east-1' };
const EMBED_OLLAMA: Env = {
  EMBEDDING_PROVIDER: 'openai-compatible',
  EMBEDDING_MODEL: 'nomic-embed-text',
  EMBEDDING_BASE_URL: 'http://ollama:11434/v1',
  EMBEDDING_LOCAL: 'true',
};

/** The result of each parser as a plain value, so the two can be compared whether they return or throw. */
function outcome(parse: (env: Env) => unknown, env: Env): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: parse(env) };
  } catch (error) {
    expect(error).toBeInstanceOf(LlmConfigError);
    return { ok: false, message: (error as Error).message };
  }
}

const viaConfig = (env: Env): unknown => llmStatus(parseLlmConfig(env));

// Cases with a key where one is needed, and cases that are wrong for another reason. The two parsers must agree on every one.
const AGREE: [string, Env][] = [
  ['nothing set', {}],
  ['empty values', { LLM_PROVIDER: '', LLM_MODEL: '', EMBEDDING_PROVIDER: '' }],
  ['anthropic with a key', { ...ANTHROPIC, LLM_API_KEY: 'sk-key' }],
  ['gemini with a key', { ...GEMINI, LLM_API_KEY: 'k' }],
  ['a local openai-compatible provider', OLLAMA],
  ['a hosted openai-compatible provider with a key', { LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'gpt-5', LLM_BASE_URL: 'https://api.openai.com/v1', LLM_API_KEY: 'k' }],
  ['bedrock', BEDROCK],
  ['generation and local embeddings', { ...ANTHROPIC, LLM_API_KEY: 'k', ...EMBED_OLLAMA }],
  ['an unknown provider', { LLM_PROVIDER: 'mistral', LLM_MODEL: 'x' }],
  ['anthropic as the embedding provider', { ...ANTHROPIC, LLM_API_KEY: 'k', EMBEDDING_PROVIDER: 'anthropic', EMBEDDING_MODEL: 'x' }],
  ['a missing model', { LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k' }],
  ['a model with whitespace', { ...ANTHROPIC, LLM_API_KEY: 'k', LLM_MODEL: 'a b' }],
  ['http for a hosted provider', { ...OLLAMA, LLM_LOCAL: undefined }],
  ['an address that is not http or https', { ...OLLAMA, LLM_BASE_URL: 'ftp://x' }],
  ['the local declaration for anthropic', { ...ANTHROPIC, LLM_API_KEY: 'k', LLM_LOCAL: 'true' }],
  ['a bad local declaration', { ...OLLAMA, LLM_LOCAL: 'yes' }],
  ['a bad bedrock region', { ...BEDROCK, LLM_REGION: 'nowhere' }],
  ['a key set for bedrock, which takes none', { ...BEDROCK, LLM_API_KEY: 'k' }],
  ['an address set for anthropic', { ...ANTHROPIC, LLM_API_KEY: 'k', LLM_BASE_URL: 'https://x' }],
  ['an orphan setting', { LLM_MODEL: 'x' }],
  ['one price without the other', { ...OLLAMA, LLM_PRICE_INPUT: '1' }],
  ['a bad price', { ...OLLAMA, LLM_PRICE_INPUT: '-1', LLM_PRICE_OUTPUT: '1' }],
  ['prices set together', { ...OLLAMA, LLM_PRICE_INPUT: '1', LLM_PRICE_OUTPUT: '2' }],
  ['a bad time limit', { ...OLLAMA, LLM_TIMEOUT: '5s' }],
  ['a vendor variable', { ...ANTHROPIC, LLM_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://x' }],
  ['a vendor variable with a missing key, which comes later', { ...OLLAMA, OPENAI_API_KEY: 'k' }],
  ['an AWS endpoint variable while bedrock is configured', { ...BEDROCK, AWS_ENDPOINT_URL: 'https://x' }],
];

describe('parseLlmStatus agrees with parseLlmConfig', () => {
  it.each(AGREE)('on %s', (_label, env) => {
    expect(outcome(parseLlmStatus, env)).toEqual(outcome(viaConfig, env));
  });

  it('runs through the same table as Milestone 1: every case that parseLlmConfig accepts gives the same status', () => {
    const accepted = AGREE.filter(([, env]) => outcome(viaConfig, env).ok);
    expect(accepted.length).toBeGreaterThan(8);
    for (const [, env] of accepted) expect(parseLlmStatus(env)).toEqual(viaConfig(env));
  });
});

describe('the one difference: a missing key (FR-071)', () => {
  it.each([
    ['anthropic', ANTHROPIC, 'LLM_API_KEY must be set when LLM_PROVIDER is anthropic'],
    ['gemini', GEMINI, 'LLM_API_KEY must be set when LLM_PROVIDER is gemini'],
  ])('is allowed for %s, and parseLlmConfig still refuses it', (_name, env, message) => {
    expect(outcome(viaConfig, env)).toEqual({ ok: false, message });
    expect(parseLlmStatus(env).generation).toMatchObject({ hosted: true });
  });

  it('reports the status of both operations without any key', () => {
    const status = parseLlmStatus({ ...ANTHROPIC, ...EMBED_OLLAMA });
    expect(status).toEqual({
      generation: { provider: 'anthropic', model: 'claude-haiku-5-5', hosted: true },
      embedding: { provider: 'openai-compatible', model: 'nomic-embed-text', hosted: false },
    });
  });

  it('allows a missing embedding key for gemini', () => {
    const env = { ...ANTHROPIC, EMBEDDING_PROVIDER: 'gemini', EMBEDDING_MODEL: 'gemini-embedding-001' };
    expect(() => parseLlmConfig(env)).toThrow(LlmConfigError);
    expect(parseLlmStatus(env).embedding).toEqual({ provider: 'gemini', model: 'gemini-embedding-001', hosted: true });
  });

  it('still refuses every other problem when the key is missing', () => {
    expect(() => parseLlmStatus({ ...ANTHROPIC, LLM_MODEL: 'a b' })).toThrow('LLM_MODEL must be 1 to 200 characters');
    expect(() => parseLlmStatus({ ...ANTHROPIC, ANTHROPIC_BASE_URL: 'https://x' })).toThrow('ANTHROPIC_BASE_URL is set');
  });
});

describe('what the status holds', () => {
  it('has no key and no address', () => {
    const status = parseLlmStatus({ ...ANTHROPIC, LLM_API_KEY: 'sk-canary-key', ...EMBED_OLLAMA, EMBEDDING_API_KEY: 'embed-canary-key' });
    expect(JSON.stringify(status)).not.toMatch(/canary|ollama|11434/);
    expect(Object.keys(status.generation ?? {}).sort()).toEqual(['hosted', 'model', 'provider']);
  });
});
