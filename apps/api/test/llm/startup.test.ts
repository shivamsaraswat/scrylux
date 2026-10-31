import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(checkLlmConfig({ ...ANTHROPIC }, {})).toEqual({
      ok: false,
      line: 'Startup failed: invalid AI provider configuration: LLM_API_KEY must be set when LLM_PROVIDER is anthropic',
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
