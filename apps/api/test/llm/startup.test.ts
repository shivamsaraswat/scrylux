import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { checkJobConfig } from '../../src/jobs/config.js';
import { checkLlmConfig, llmEnvironment } from '../../src/llm-startup.js';

const ANTHROPIC = { LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-haiku-5-5' };

describe('checkLlmConfig', () => {
  it('says AI is off when nothing is set (FR-005)', () => {
    expect(checkLlmConfig({}, {})).toEqual({ ok: true, line: 'AI providers: generation off, embeddings off' });
  });

  it('names a hosted generation provider with embeddings off', () => {
    expect(checkLlmConfig({ ...ANTHROPIC }, { llmApiKey: 'sk-from-secret' })).toEqual({
      ok: true,
      line: 'AI providers: generation anthropic (hosted), embeddings off',
    });
  });

  it('says local for an openai-compatible provider declared local', () => {
    const env = { LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'llama3.2', LLM_BASE_URL: 'http://ollama:11434/v1', LLM_LOCAL: 'true' };
    expect(checkLlmConfig(env, {})).toEqual({ ok: true, line: 'AI providers: generation openai-compatible (local), embeddings off' });
  });

  it('reports each operation on its own', () => {
    const env = {
      ...ANTHROPIC,
      EMBEDDING_PROVIDER: 'openai-compatible',
      EMBEDDING_MODEL: 'nomic-embed-text',
      EMBEDDING_BASE_URL: 'http://ollama:11434/v1',
      EMBEDDING_LOCAL: 'true',
    };
    expect(checkLlmConfig(env, { llmApiKey: 'k' }).line).toBe('AI providers: generation anthropic (hosted), embeddings openai-compatible (local)');
  });

  it('refuses a bad setting with a message that names the variable', () => {
    expect(checkLlmConfig({ LLM_PROVIDER: 'anthropic' }, {})).toEqual({
      ok: false,
      line: 'Startup failed: invalid AI provider configuration: LLM_MODEL must be set when LLM_PROVIDER is anthropic',
    });
  });

  // Phase 3 Milestone 2, FR-071: only the worker holds a provider key. The API reports whether AI is configured and starts
  // without one; the worker keeps Milestone 1's rule that a key is required (test/worker/startup.test.ts).
  describe('without a provider key (FR-071)', () => {
    it('starts with a hosted provider selected and no key, and reports it', () => {
      expect(checkLlmConfig({ ...ANTHROPIC }, {})).toEqual({ ok: true, line: 'AI providers: generation anthropic (hosted), embeddings off' });
      expect(checkLlmConfig({ LLM_PROVIDER: 'gemini', LLM_MODEL: 'gemini-3-flash', EMBEDDING_PROVIDER: 'gemini', EMBEDDING_MODEL: 'gemini-embedding-001' }, {})).toEqual({
        ok: true,
        line: 'AI providers: generation gemini (hosted), embeddings gemini (hosted)',
      });
    });

    it('still refuses a key set for a provider that takes none', () => {
      const bedrock = { LLM_PROVIDER: 'bedrock', LLM_MODEL: 'anthropic.claude-haiku-5-5-v1:0', LLM_REGION: 'us-east-1' };
      expect(checkLlmConfig(bedrock, {}).ok).toBe(true);
      expect(checkLlmConfig({ ...bedrock, LLM_API_KEY: 'k' }, {})).toEqual({
        ok: false,
        line: expect.stringContaining('LLM_API_KEY') as unknown,
      });
    });

    it('still refuses a vendor variable left in the environment', () => {
      const result = checkLlmConfig({ ...ANTHROPIC, ANTHROPIC_BASE_URL: 'https://elsewhere.example' }, {});
      expect(result.ok).toBe(false);
      expect(result.line).toContain('ANTHROPIC_BASE_URL');
      expect(result.line).not.toContain('elsewhere');
    });

    it('still refuses the same bad settings as the worker does, for everything but the key', () => {
      for (const env of [{ LLM_PROVIDER: 'mistral', LLM_MODEL: 'x' }, { ...ANTHROPIC, LLM_LOCAL: 'true' }, { ...ANTHROPIC, LLM_TIMEOUT: '1s' }]) {
        expect(checkLlmConfig(env, {}).ok, JSON.stringify(env)).toBe(false);
      }
    });
  });

  it('takes the keys from the secrets-manager secret, which overrides the environment', () => {
    expect(checkLlmConfig({ ...ANTHROPIC, LLM_API_KEY: 'from-env' }, { llmApiKey: 'from-secret' }).ok).toBe(true);
    expect(llmEnvironment({ LLM_API_KEY: 'from-env', EMBEDDING_API_KEY: 'e-env' }, { llmApiKey: 'from-secret' })).toMatchObject({
      LLM_API_KEY: 'from-secret',
      EMBEDDING_API_KEY: 'e-env',
    });
    expect(llmEnvironment({ LLM_API_KEY: 'from-env' }, {})).toMatchObject({ LLM_API_KEY: 'from-env' });
  });

  it('prints no model, address or key, whether it succeeds or fails', () => {
    const env = {
      LLM_PROVIDER: 'openai-compatible',
      LLM_MODEL: 'secret-model-name',
      LLM_BASE_URL: 'https://user:secret-pass@secret-host.example/v1',
      LLM_API_KEY: 'sk-secret-key',
    };
    const ok = checkLlmConfig(env, {});
    const refused = checkLlmConfig({ ...env, LLM_BASE_URL: 'http://secret-host.example/v1' }, {});
    expect(ok.ok).toBe(true);
    expect(refused.ok).toBe(false);
    for (const { line } of [ok, refused]) expect(line).not.toMatch(/secret-model-name|secret-pass|secret-host|sk-secret-key/);
  });
});

describe('starting makes no connection to a provider (FR-007)', () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  it('checks the configuration without sending a request', async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const env = {
      LLM_PROVIDER: 'openai-compatible',
      LLM_MODEL: 'llama3.2',
      LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      LLM_LOCAL: 'true',
    };
    expect(checkLlmConfig(env, {}).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requests).toEqual([]);
  });
});

describe('the job settings at the API’s start-up (Phase 3 Milestone 2, FR-040, FR-004)', () => {
  it('accepts the defaults, and every setting a good value', () => {
    expect(checkJobConfig({})).toMatchObject({ ok: true });
    expect(checkJobConfig({ JOB_TOKEN_CAP: '1000', JOB_COST_CAP: '1.5', JOB_MAX_RUNS: '2', JOB_TIME_LIMIT: '10m', JOBS_PER_ACCOUNT: '5', PROVIDER_CHECK_COOLDOWN: '0', WORKER_CONCURRENCY: '2', WORKER_HEALTH_PORT: '4000' })).toMatchObject({ ok: true });
  });

  it('refuses a bad setting with a fixed line that names it and not its value', () => {
    expect(checkJobConfig({ JOB_MAX_RUNS: '9' })).toEqual({ ok: false, line: 'Startup failed: JOB_MAX_RUNS must be a whole number from 1 to 5' });
    const secret = checkJobConfig({ JOB_TOKEN_CAP: 'secret-value' });
    expect(secret.ok).toBe(false);
    expect(secret).toEqual({ ok: false, line: expect.stringContaining('JOB_TOKEN_CAP') as unknown });
    expect(JSON.stringify(secret)).not.toContain('secret-value');
  });
});
