import { describe, expect, it } from 'vitest';
import { checkWorkerStartup } from '../../src/worker/startup.js';

// The worker refuses to start with a bad configuration, as the API does, and names the setting and never its value
// (Phase 3 Milestone 2, US5, FR-004, SC-009). The worker holds the provider keys, so unlike the API it requires them.

type Env = Record<string, string | undefined>;
const ANTHROPIC: Env = { LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-haiku-5-5' };
const OLLAMA: Env = { LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'llama3.2', LLM_BASE_URL: 'http://ollama:11434/v1', LLM_LOCAL: 'true' };

describe('a configuration that starts', () => {
  it('starts with no provider, as v0.1 does, and says AI is off', () => {
    const result = checkWorkerStartup({}, {});
    expect(result).toMatchObject({ ok: true, line: 'AI providers: generation off, embeddings off' });
  });

  it('starts with a provider and every setting it needs, and says which and where its data goes', () => {
    expect(checkWorkerStartup({ ...ANTHROPIC }, { llmApiKey: 'k' })).toMatchObject({ ok: true, line: 'AI providers: generation anthropic (hosted), embeddings off' });
    expect(checkWorkerStartup(OLLAMA, {})).toMatchObject({ ok: true, line: 'AI providers: generation openai-compatible (local), embeddings off' });
  });

  it('takes the key from the environment or from the secret, as the API does', () => {
    expect(checkWorkerStartup({ ...ANTHROPIC, LLM_API_KEY: 'from-env' }, {}).ok).toBe(true);
    expect(checkWorkerStartup({ ...ANTHROPIC }, { llmApiKey: 'from-secret' }).ok).toBe(true);
  });

  it('returns the parsed settings for the worker to use, with the key in them', () => {
    const result = checkWorkerStartup({ ...ANTHROPIC, WORKER_CONCURRENCY: '4', JOB_MAX_RUNS: '5' }, { llmApiKey: 'k' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.jobs).toMatchObject({ workerConcurrency: 4, maxRuns: 5, workerHealthPort: 3001 });
      expect(result.llm.generation).toMatchObject({ provider: 'anthropic', apiKey: 'k' });
    }
  });
});

describe('a configuration that does not start', () => {
  it('refuses a provider selected without its key, which the worker, unlike the API, requires (FR-004)', () => {
    expect(checkWorkerStartup({ ...ANTHROPIC }, {})).toEqual({
      ok: false,
      line: 'Startup failed: invalid AI provider configuration: LLM_API_KEY must be set when LLM_PROVIDER is anthropic',
    });
  });

  it.each([
    ['an unknown provider', { LLM_PROVIDER: 'mistral', LLM_MODEL: 'x' }, 'LLM_PROVIDER'],
    ['a missing model', { LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k' }, 'LLM_MODEL'],
    ['a hosted address over plain http', { ...OLLAMA, LLM_LOCAL: undefined }, 'LLM_BASE_URL'],
    ['a vendor variable left in the environment', { ...OLLAMA, OPENAI_API_KEY: 'sk-leftover' }, 'OPENAI_API_KEY'],
    ['a bad price', { ...OLLAMA, LLM_PRICE_INPUT: 'cheap', LLM_PRICE_OUTPUT: '1' }, 'LLM_PRICE_INPUT'],
    ['a bad time limit for a request', { ...OLLAMA, LLM_TIMEOUT: '5s' }, 'LLM_TIMEOUT'],
  ])('refuses %s, naming the setting', (_label, env, name) => {
    const result = checkWorkerStartup(env, {});
    expect(result.ok).toBe(false);
    expect(result.line).toContain(name);
    expect(result.line.startsWith('Startup failed: invalid AI provider configuration:')).toBe(true);
  });

  it.each([
    ['JOB_TOKEN_CAP', '0'],
    ['JOB_COST_CAP', '-1'],
    ['JOB_MAX_RUNS', '9'],
    ['JOB_TIME_LIMIT', '30s'],
    ['JOBS_PER_ACCOUNT', '0'],
    ['PROVIDER_CHECK_COOLDOWN', '-5'],
    ['WORKER_CONCURRENCY', '0'],
    ['WORKER_HEALTH_PORT', '70000'],
  ])('refuses a bad %s, naming it', (name, value) => {
    const result = checkWorkerStartup({ [name]: value }, {});
    expect(result).toEqual({ ok: false, line: expect.stringContaining(`Startup failed: ${name} must`) as unknown });
  });

  it('holds no setting value in any message (SC-009)', () => {
    const lines = [
      checkWorkerStartup({ LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'secret-model', LLM_BASE_URL: 'http://secret-host.example/v1', LLM_API_KEY: 'sk-secret-key' }, {}).line,
      checkWorkerStartup({ OPENAI_API_KEY: 'sk-secret-key', LLM_PROVIDER: 'anthropic', LLM_MODEL: 'secret-model', LLM_API_KEY: 'sk-secret-key' }, {}).line,
      checkWorkerStartup({ JOB_TOKEN_CAP: 'secret-value' }, {}).line,
      checkWorkerStartup({ WORKER_HEALTH_PORT: 'secret-port' }, {}).line,
    ];
    for (const line of lines) expect(line).not.toMatch(/secret-model|secret-host|sk-secret-key|secret-value|secret-port/);
  });

  it('reports a provider problem before a job setting', () => {
    expect(checkWorkerStartup({ ...ANTHROPIC, JOB_MAX_RUNS: '9' }, {}).line).toContain('LLM_API_KEY');
  });
});
