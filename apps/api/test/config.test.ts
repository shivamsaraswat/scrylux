import { describe, expect, it, vi } from 'vitest';
import config, { type SecretClient } from '../src/config.js';

function fakeClient(secret: Record<string, unknown>): SecretClient {
  return { send: () => Promise.resolve({ SecretString: JSON.stringify(secret) }) };
}

describe('config.load()', () => {
  it('is a no-op without a secret id', async () => {
    const before = JSON.stringify(config.db);
    await config.load({ secretId: undefined });
    expect(JSON.stringify(config.db)).toBe(before);
  });

  it('overrides config from the secret', async () => {
    await config.load({
      secretId: 'x',
      client: fakeClient({
        host: 'h',
        port: '5433',
        dbname: 'd',
        username: 'u',
        password: 'p',
        JWT_SECRET: 'j',
        ADMIN_USERNAME: 'a',
        ADMIN_PASSWORD: 'ap',
      }),
    });
    expect(config.db).toEqual({ host: 'h', port: 5433, database: 'd', user: 'u', password: 'p' });
    expect(config.jwtSecret).toBe('j');
    expect(config.adminUsername).toBe('a');
    expect(config.adminPassword).toBe('ap');
  });

  it('reads the AI provider keys from the secret, over the environment', async () => {
    config.llmApiKey = 'from-env';
    config.embeddingApiKey = 'embedding-from-env';
    await config.load({ secretId: 'x', client: fakeClient({ LLM_API_KEY: 'llm-from-secret', EMBEDDING_API_KEY: 'embedding-from-secret' }) });
    expect(config.llmApiKey).toBe('llm-from-secret');
    expect(config.embeddingApiKey).toBe('embedding-from-secret');
  });

  it('leaves the environment’s AI provider keys alone when the secret has none', async () => {
    config.llmApiKey = 'from-env';
    config.embeddingApiKey = 'embedding-from-env';
    await config.load({ secretId: 'x', client: fakeClient({ JWT_SECRET: 'j' }) });
    expect(config.llmApiKey).toBe('from-env');
    expect(config.embeddingApiKey).toBe('embedding-from-env');
  });

  it('reads the S3-compatible storage keys from the secret, over the environment (Phase 3 Milestone 3, FR-052)', async () => {
    config.storageS3AccessKeyId = 'access-from-env';
    config.storageS3SecretAccessKey = 'secret-from-env';
    await config.load({
      secretId: 'x',
      client: fakeClient({ STORAGE_S3_ACCESS_KEY_ID: 'access-from-secret', STORAGE_S3_SECRET_ACCESS_KEY: 'secret-from-secret' }),
    });
    expect(config.storageS3AccessKeyId).toBe('access-from-secret');
    expect(config.storageS3SecretAccessKey).toBe('secret-from-secret');
  });

  it('leaves the environment’s storage keys alone when the secret has none', async () => {
    config.storageS3AccessKeyId = 'access-from-env';
    config.storageS3SecretAccessKey = 'secret-from-env';
    await config.load({ secretId: 'x', client: fakeClient({ JWT_SECRET: 'j' }) });
    expect(config.storageS3AccessKeyId).toBe('access-from-env');
    expect(config.storageS3SecretAccessKey).toBe('secret-from-env');
  });

  it('takes the storage keys from the environment when there is no secret', async () => {
    // config.ts reads process.env once, when it is imported, so the test imports it afresh with the variables set.
    vi.stubEnv('STORAGE_S3_ACCESS_KEY_ID', 'access-from-env');
    vi.stubEnv('STORAGE_S3_SECRET_ACCESS_KEY', 'secret-from-env');
    try {
      vi.resetModules();
      const fresh = (await import('../src/config.js')).default;
      expect(fresh.storageS3AccessKeyId).toBe('access-from-env');
      expect(fresh.storageS3SecretAccessKey).toBe('secret-from-env');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('fails clearly when the secret cannot be read', async () => {
    const client: SecretClient = {
      send: () => Promise.reject(new Error('AccessDenied')),
    };
    await expect(config.load({ secretId: 'x', client })).rejects.toThrow(
      /Could not load secret "x": AccessDenied/,
    );
  });
});
