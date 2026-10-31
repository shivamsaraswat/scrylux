import { describe, expect, it } from 'vitest';
import { LlmConfigError } from '../src/errors.js';
import { llmStatus, parseLlmConfig } from '../src/config.js';

const CANARY = 'canary-value-123';

type Env = Record<string, string | undefined>;
const ANTHROPIC: Env = { LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-haiku-5-5', LLM_API_KEY: 'sk-key' };
const OLLAMA: Env = { LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'llama3.2', LLM_BASE_URL: 'http://ollama:11434/v1', LLM_LOCAL: 'true' };

/** The message of the first problem, which must be an LlmConfigError. */
function problem(env: Env): string {
  try {
    parseLlmConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(LlmConfigError);
    return (error as Error).message;
  }
  throw new Error('expected the configuration to be refused');
}

describe('nothing set', () => {
  it('turns AI off with the default time limit (FR-005)', () => {
    expect(parseLlmConfig({})).toEqual({ generation: null, embedding: null, timeoutMs: 300_000 });
  });

  it('treats empty values as unset', () => {
    expect(parseLlmConfig({ LLM_PROVIDER: '', LLM_MODEL: '', EMBEDDING_PROVIDER: '', LLM_TIMEOUT: '', LLM_PRICE_INPUT: '' })).toEqual({
      generation: null,
      embedding: null,
      timeoutMs: 300_000,
    });
  });

  it('ignores variables that are not its own', () => {
    expect(parseLlmConfig({ PATH: '/bin', DB_HOST: 'x' }).generation).toBeNull();
  });
});

describe('rule 1: the provider', () => {
  it.each([
    ['anthropic', { LLM_API_KEY: 'k' }],
    ['openai-compatible', { LLM_BASE_URL: 'https://api.openai.com/v1' }],
    ['bedrock', { LLM_REGION: 'us-east-1' }],
    ['gemini', { LLM_API_KEY: 'k' }],
  ] as const)('accepts %s for generation', (provider, rest) => {
    const config = parseLlmConfig({ LLM_PROVIDER: provider, LLM_MODEL: 'm', ...rest });
    expect(config.generation?.provider).toBe(provider);
  });

  it.each([
    ['openai-compatible', { EMBEDDING_BASE_URL: 'https://api.openai.com/v1' }],
    ['bedrock', { EMBEDDING_REGION: 'us-east-1' }],
    ['gemini', { EMBEDDING_API_KEY: 'k' }],
  ] as const)('accepts %s for embeddings', (provider, rest) => {
    const config = parseLlmConfig({ EMBEDDING_PROVIDER: provider, EMBEDDING_MODEL: 'm', ...rest });
    expect(config.embedding?.provider).toBe(provider);
    expect(config.generation).toBeNull();
  });

  it('refuses anthropic for embeddings, and lists what is accepted', () => {
    const message = problem({ EMBEDDING_PROVIDER: 'anthropic', EMBEDDING_MODEL: 'm' });
    expect(message).toContain('EMBEDDING_PROVIDER');
    expect(message).toContain('openai-compatible, bedrock, gemini');
  });

  it('refuses an unknown name, lists the accepted ones and does not echo it', () => {
    const message = problem({ LLM_PROVIDER: CANARY, LLM_MODEL: 'm' });
    expect(message).toContain('LLM_PROVIDER');
    expect(message).toContain('anthropic, openai-compatible, bedrock, gemini');
    expect(message).not.toContain(CANARY);
  });
});

describe('rule 2: a half-made configuration is never ignored', () => {
  it.each([['LLM_MODEL'], ['LLM_API_KEY'], ['LLM_BASE_URL'], ['LLM_REGION'], ['LLM_LOCAL'], ['LLM_PRICE_INPUT'], ['LLM_PRICE_OUTPUT']])(
    '%s without LLM_PROVIDER',
    (name) => {
      const message = problem({ [name]: '1' });
      expect(message).toContain('LLM_PROVIDER');
      expect(message).toContain(name);
    },
  );

  it.each([['EMBEDDING_MODEL'], ['EMBEDDING_API_KEY'], ['EMBEDDING_BASE_URL'], ['EMBEDDING_REGION'], ['EMBEDDING_LOCAL'], ['EMBEDDING_PRICE_INPUT']])(
    '%s without EMBEDDING_PROVIDER',
    (name) => {
      expect(problem({ [name]: '1' })).toContain('EMBEDDING_PROVIDER');
    },
  );

  it('does not count LLM_TIMEOUT, which is shared', () => {
    expect(parseLlmConfig({ LLM_TIMEOUT: '60s' }).timeoutMs).toBe(60_000);
  });
});

describe('rule 3: a setting that does not apply to the provider', () => {
  it.each([
    [{ ...ANTHROPIC, LLM_REGION: 'us-east-1' }, 'LLM_REGION'],
    [{ ...ANTHROPIC, LLM_BASE_URL: 'https://x.example' }, 'LLM_BASE_URL'],
    [{ LLM_PROVIDER: 'gemini', LLM_MODEL: 'm', LLM_API_KEY: 'k', LLM_BASE_URL: 'https://x.example' }, 'LLM_BASE_URL'],
    [{ LLM_PROVIDER: 'gemini', LLM_MODEL: 'm', LLM_API_KEY: 'k', LLM_REGION: 'us-east-1' }, 'LLM_REGION'],
    [{ LLM_PROVIDER: 'bedrock', LLM_MODEL: 'm', LLM_REGION: 'us-east-1', LLM_API_KEY: 'k' }, 'LLM_API_KEY'],
    [{ LLM_PROVIDER: 'bedrock', LLM_MODEL: 'm', LLM_REGION: 'us-east-1', LLM_BASE_URL: 'https://x.example' }, 'LLM_BASE_URL'],
    [{ LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'm', LLM_BASE_URL: 'https://x.example', LLM_REGION: 'us-east-1' }, 'LLM_REGION'],
  ] as [Env, string][])('refuses %#', (env, name) => {
    const message = problem(env);
    expect(message).toContain(name);
    expect(message).not.toContain('k"');
  });
});

describe('required settings', () => {
  it('names the variable and the provider: the key for anthropic', () => {
    expect(problem({ LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-haiku-5-5' })).toBe(
      'LLM_API_KEY must be set when LLM_PROVIDER is anthropic',
    );
  });

  it.each([
    [{ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k' }, 'LLM_MODEL must be set when LLM_PROVIDER is anthropic'],
    [{ LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'm' }, 'LLM_BASE_URL must be set when LLM_PROVIDER is openai-compatible'],
    [{ LLM_PROVIDER: 'bedrock', LLM_MODEL: 'm' }, 'LLM_REGION must be set when LLM_PROVIDER is bedrock'],
    [{ LLM_PROVIDER: 'gemini', LLM_MODEL: 'm' }, 'LLM_API_KEY must be set when LLM_PROVIDER is gemini'],
    [{ EMBEDDING_PROVIDER: 'gemini', EMBEDDING_MODEL: 'm' }, 'EMBEDDING_API_KEY must be set when EMBEDDING_PROVIDER is gemini'],
  ] as [Env, string][])('%#', (env, message) => {
    expect(problem(env)).toBe(message);
  });

  it('does not need a key for openai-compatible, or for bedrock', () => {
    expect(parseLlmConfig({ ...OLLAMA }).generation?.apiKey).toBeNull();
    expect(parseLlmConfig({ LLM_PROVIDER: 'bedrock', LLM_MODEL: 'm', LLM_REGION: 'eu-west-1' }).generation?.apiKey).toBeNull();
  });

  it('accepts a key for openai-compatible', () => {
    expect(parseLlmConfig({ ...OLLAMA, LLM_API_KEY: 'k' }).generation?.apiKey).toBe('k');
  });
});

describe('rule 4: the model', () => {
  it.each([['has space'], ['tab\there'], ['x'.repeat(201)], [`bad ${CANARY}`]])('refuses %j', (model) => {
    const message = problem({ ...ANTHROPIC, LLM_MODEL: model });
    expect(message).toContain('LLM_MODEL');
    expect(message).not.toContain(CANARY);
  });

  it('accepts 200 characters, dots, colons and slashes', () => {
    expect(parseLlmConfig({ ...ANTHROPIC, LLM_MODEL: 'x'.repeat(200) }).generation?.model).toHaveLength(200);
    expect(parseLlmConfig({ ...ANTHROPIC, LLM_MODEL: 'amazon.titan-embed-text-v2:0' }).generation?.model).toBe('amazon.titan-embed-text-v2:0');
  });
});

describe('rule 5: the base address (FR-003a)', () => {
  const openai = (url: string, rest: Env = {}): Env => ({ LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'm', LLM_BASE_URL: url, ...rest });

  it('accepts https', () => {
    expect(parseLlmConfig(openai('https://api.openai.com/v1')).generation?.baseUrl).toBe('https://api.openai.com/v1');
    expect(parseLlmConfig(openai('https://r.openai.azure.com/openai/v1/')).generation?.baseUrl).toBe('https://r.openai.azure.com/openai/v1/');
  });

  it('refuses http without LLM_LOCAL=true, naming https and LLM_LOCAL', () => {
    const message = problem(openai('http://ollama:11434/v1'));
    expect(message).toContain('https');
    expect(message).toContain('LLM_LOCAL');
    expect(message).toContain('LLM_BASE_URL');
  });

  it('refuses http with LLM_LOCAL=false in the same way', () => {
    expect(problem(openai('http://ollama:11434/v1', { LLM_LOCAL: 'false' }))).toContain('LLM_LOCAL');
  });

  it('accepts http with LLM_LOCAL=true', () => {
    expect(parseLlmConfig(openai('http://ollama:11434/v1', { LLM_LOCAL: 'true' })).generation?.baseUrl).toBe('http://ollama:11434/v1');
  });

  it.each([['ftp://host/v1'], ['file:///etc/passwd'], ['not a url'], ['/relative/v1'], ['https://host/v1?x=1'], ['https://host/v1#frag'], [`ftp://${CANARY}`]])(
    'refuses %j',
    (url) => {
      const message = problem(openai(url, { LLM_LOCAL: 'true' }));
      expect(message).toContain('LLM_BASE_URL');
      expect(message).not.toContain(CANARY);
    },
  );

  it('accepts a base address with credentials and never shows it', () => {
    const config = parseLlmConfig(openai('https://user:pass@host.example/v1'));
    expect(config.generation?.baseUrl).toBe('https://user:pass@host.example/v1');
    expect(JSON.stringify(llmStatus(config))).not.toMatch(/pass|host\.example/);
  });

  it('does not echo the address when it refuses one with credentials', () => {
    expect(problem(openai('http://user:topsecret@host.example/v1'))).not.toMatch(/topsecret|host\.example/);
  });
});

describe('rule 6: *_LOCAL', () => {
  it.each([['anthropic', { LLM_API_KEY: 'k' }], ['bedrock', { LLM_REGION: 'us-east-1' }], ['gemini', { LLM_API_KEY: 'k' }]] as const)(
    'true is refused for %s',
    (provider, rest) => {
      const message = problem({ LLM_PROVIDER: provider, LLM_MODEL: 'm', LLM_LOCAL: 'true', ...rest });
      expect(message).toContain('LLM_LOCAL');
      expect(message).toContain('openai-compatible');
    },
  );

  it('false is accepted for any provider', () => {
    expect(parseLlmConfig({ ...ANTHROPIC, LLM_LOCAL: 'false' }).generation?.local).toBe(false);
  });

  it.each([['yes'], ['1'], ['TRUE'], [CANARY]])('refuses %j', (value) => {
    const message = problem({ ...OLLAMA, LLM_LOCAL: value });
    expect(message).toContain('LLM_LOCAL must be true or false');
    expect(message).not.toContain(CANARY);
  });

  it('works separately for embeddings', () => {
    const config = parseLlmConfig({
      LLM_PROVIDER: 'anthropic', LLM_MODEL: 'm', LLM_API_KEY: 'k',
      EMBEDDING_PROVIDER: 'openai-compatible', EMBEDDING_MODEL: 'nomic-embed-text', EMBEDDING_BASE_URL: 'http://ollama:11434/v1', EMBEDDING_LOCAL: 'true',
    });
    expect(config.generation?.hosted).toBe(true);
    expect(config.embedding?.hosted).toBe(false);
  });
});

describe('hosted or local (FR-044, FR-044a)', () => {
  it('is hosted unless an openai-compatible provider is declared local', () => {
    expect(parseLlmConfig(ANTHROPIC).generation).toMatchObject({ local: false, hosted: true });
    expect(parseLlmConfig({ LLM_PROVIDER: 'gemini', LLM_MODEL: 'm', LLM_API_KEY: 'k' }).generation?.hosted).toBe(true);
    expect(parseLlmConfig({ LLM_PROVIDER: 'bedrock', LLM_MODEL: 'm', LLM_REGION: 'us-east-1' }).generation?.hosted).toBe(true);
    expect(parseLlmConfig({ ...OLLAMA, LLM_BASE_URL: 'https://proxy.internal/v1', LLM_LOCAL: undefined }).generation).toMatchObject({ local: false, hosted: true });
    expect(parseLlmConfig(OLLAMA).generation).toMatchObject({ local: true, hosted: false });
  });
});

describe('rule 8: the region', () => {
  it.each([['us-east-1'], ['eu-central-2'], ['ap-southeast-4'], ['us-gov-west-1']])('accepts %s', (region) => {
    expect(parseLlmConfig({ LLM_PROVIDER: 'bedrock', LLM_MODEL: 'm', LLM_REGION: region }).generation?.region).toBe(region);
  });

  it.each([['useast1'], ['US-EAST-1'], ['us-east'], [CANARY]])('refuses %j', (region) => {
    const message = problem({ LLM_PROVIDER: 'bedrock', LLM_MODEL: 'm', LLM_REGION: region });
    expect(message).toContain('LLM_REGION');
    expect(message).not.toContain(CANARY);
  });
});

describe('rule 9: LLM_TIMEOUT', () => {
  it.each([['10s', 10_000], ['300s', 300_000], ['5m', 300_000], ['60m', 3_600_000]])('accepts %s', (value, ms) => {
    expect(parseLlmConfig({ LLM_TIMEOUT: value }).timeoutMs).toBe(ms);
  });

  it.each([['9s'], ['61m'], ['3601s'], ['5h'], ['abc'], ['0s'], ['-5s'], ['1.5m'], [CANARY]])('refuses %j', (value) => {
    const message = problem({ LLM_TIMEOUT: value });
    expect(message).toContain('LLM_TIMEOUT');
    expect(message).not.toContain(CANARY);
  });
});

describe('rule 10: operator prices (FR-033b)', () => {
  const withPrices = (rest: Env): Env => ({ ...ANTHROPIC, ...rest });

  it('accepts decimals, including zero', () => {
    expect(parseLlmConfig(withPrices({ LLM_PRICE_INPUT: '1.5', LLM_PRICE_OUTPUT: '7.25' })).generation?.operatorPrice).toEqual({ input: 1.5, output: 7.25 });
    expect(parseLlmConfig(withPrices({ LLM_PRICE_INPUT: '0', LLM_PRICE_OUTPUT: '0' })).generation?.operatorPrice).toEqual({ input: 0, output: 0 });
    expect(parseLlmConfig(withPrices({ LLM_PRICE_INPUT: '0.000001', LLM_PRICE_OUTPUT: '3' })).generation?.operatorPrice?.input).toBe(0.000001);
  });

  it.each([['-1'], ['1.1234567'], ['abc'], ['1e3'], ['1,5'], [' '], [CANARY]])('refuses %j', (value) => {
    const message = problem(withPrices({ LLM_PRICE_INPUT: value, LLM_PRICE_OUTPUT: '1' }));
    expect(message).toContain('LLM_PRICE_INPUT');
    expect(message).not.toContain(CANARY);
  });

  it('needs the input and output prices together', () => {
    expect(problem(withPrices({ LLM_PRICE_INPUT: '1' }))).toContain('LLM_PRICE_INPUT and LLM_PRICE_OUTPUT');
    expect(problem(withPrices({ LLM_PRICE_OUTPUT: '1' }))).toContain('LLM_PRICE_INPUT and LLM_PRICE_OUTPUT');
  });

  it('takes an input price alone for embeddings', () => {
    const config = parseLlmConfig({ EMBEDDING_PROVIDER: 'gemini', EMBEDDING_MODEL: 'm', EMBEDDING_API_KEY: 'k', EMBEDDING_PRICE_INPUT: '0.15' });
    expect(config.embedding?.operatorPrice).toEqual({ input: 0.15, output: null });
  });

  it('has no operator price by default', () => {
    expect(parseLlmConfig(ANTHROPIC).generation?.operatorPrice).toBeNull();
  });
});

describe('the embedding key falls back to the generation key only for the same provider and address', () => {
  const openai = { LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'gpt-5', LLM_BASE_URL: 'https://api.openai.com/v1', LLM_API_KEY: 'shared-key' };
  const embed = { EMBEDDING_PROVIDER: 'openai-compatible', EMBEDDING_MODEL: 'text-embedding-3-small' };

  it('reuses it for the same provider and address', () => {
    const config = parseLlmConfig({ ...openai, ...embed, EMBEDDING_BASE_URL: 'https://api.openai.com/v1' });
    expect(config.embedding?.apiKey).toBe('shared-key');
  });

  it('does not reuse it for another address', () => {
    expect(parseLlmConfig({ ...openai, ...embed, EMBEDDING_BASE_URL: 'https://other.example/v1' }).embedding?.apiKey).toBeNull();
  });

  it('does not reuse it for another provider', () => {
    expect(problem({ ...openai, EMBEDDING_PROVIDER: 'gemini', EMBEDDING_MODEL: 'gemini-embedding-001' })).toContain('EMBEDDING_API_KEY');
  });

  it('uses its own key when it has one', () => {
    const config = parseLlmConfig({ ...openai, ...embed, EMBEDDING_BASE_URL: 'https://api.openai.com/v1', EMBEDDING_API_KEY: 'own-key' });
    expect(config.embedding?.apiKey).toBe('own-key');
  });
});

describe('the order of the checks', () => {
  it('reports generation before embeddings, and the shared time limit after both', () => {
    expect(problem({ EMBEDDING_PROVIDER: 'nope', LLM_PROVIDER: 'anthropic', LLM_MODEL: 'm', LLM_TIMEOUT: 'bad' })).toBe(
      'LLM_API_KEY must be set when LLM_PROVIDER is anthropic',
    );
    expect(problem({ ...ANTHROPIC, EMBEDDING_PROVIDER: 'nope', LLM_TIMEOUT: 'bad' })).toContain('EMBEDDING_PROVIDER');
    expect(problem({ ...ANTHROPIC, LLM_TIMEOUT: 'bad' })).toContain('LLM_TIMEOUT');
  });

  it('reports a missing model before anything about the timeout', () => {
    expect(problem({ EMBEDDING_PROVIDER: 'nope', LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k', LLM_TIMEOUT: 'bad' })).toBe(
      'LLM_MODEL must be set when LLM_PROVIDER is anthropic',
    );
  });
});

describe('no message echoes a setting', () => {
  it('holds none of the values it was given', () => {
    const bad: Env[] = [
      { ...ANTHROPIC, LLM_API_KEY: undefined },
      { ...ANTHROPIC, LLM_MODEL: `a ${CANARY}` },
      { ...OLLAMA, LLM_BASE_URL: `http://${CANARY}.example/v1`, LLM_LOCAL: undefined },
      { ...ANTHROPIC, LLM_PRICE_INPUT: CANARY, LLM_PRICE_OUTPUT: '1' },
    ];
    for (const env of bad) expect(problem(env)).not.toContain(CANARY);
  });
});

describe('llmStatus (FR-045)', () => {
  it('returns provider, model and hosted only', () => {
    const status = llmStatus(
      parseLlmConfig({
        ...ANTHROPIC,
        EMBEDDING_PROVIDER: 'openai-compatible', EMBEDDING_MODEL: 'nomic', EMBEDDING_BASE_URL: 'http://ollama:11434/v1', EMBEDDING_LOCAL: 'true', EMBEDDING_API_KEY: 'embed-key',
      }),
    );
    expect(status).toEqual({
      generation: { provider: 'anthropic', model: 'claude-haiku-5-5', hosted: true },
      embedding: { provider: 'openai-compatible', model: 'nomic', hosted: false },
    });
    expect(JSON.stringify(status)).not.toMatch(/sk-key|embed-key|ollama/);
  });

  it('is null for what is off', () => {
    expect(llmStatus(parseLlmConfig({}))).toEqual({ generation: null, embedding: null });
  });
});

describe('rule 11: variables the provider libraries read on their own (FR-043a)', () => {
  const withProvider: Env = { ...ANTHROPIC };

  it.each([
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_LOG', 'OPENAI_CUSTOM_HEADERS', 'OPENAI_ORG_ID',
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_LOG', 'ANTHROPIC_API_KEY', 'ANTHROPIC_PROFILE',
    'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT',
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_VERTEX_BASE_URL', 'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_GENAI_USE_ENTERPRISE', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_SDK_NODE_LOGGING',
    'AWS_BEDROCK_BASE_URL',
  ])('refuses %s while a provider is configured, naming it and not its value', (name) => {
    const message = problem({ ...withProvider, [name]: CANARY });
    expect(message).toContain(name);
    expect(message).not.toContain(CANARY);
  });

  it('refuses it for an embedding provider alone', () => {
    expect(problem({ EMBEDDING_PROVIDER: 'gemini', EMBEDDING_MODEL: 'm', EMBEDDING_API_KEY: 'k', GEMINI_API_KEY: CANARY })).toContain('GEMINI_API_KEY');
  });

  it('accepts the same variables when no provider is configured', () => {
    expect(parseLlmConfig({ OPENAI_API_KEY: 'x', ANTHROPIC_BASE_URL: 'y', GEMINI_API_KEY: 'z', AWS_ENDPOINT_URL: 'w', AWS_BEDROCK_BASE_URL: 'v' }).generation).toBeNull();
  });

  it('treats an empty value as unset', () => {
    expect(parseLlmConfig({ ...withProvider, OPENAI_API_KEY: '' }).generation?.provider).toBe('anthropic');
  });

  it('names the first one it finds, in alphabetical order, so the message does not depend on the environment’s order', () => {
    expect(problem({ ...withProvider, OPENAI_API_KEY: 'x', ANTHROPIC_BASE_URL: 'y' })).toContain('ANTHROPIC_BASE_URL');
  });

  it('accepts AWS’s credential, profile and region variables, with or without Bedrock', () => {
    const aws: Env = {
      AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b', AWS_SESSION_TOKEN: 'c', AWS_PROFILE: 'p', AWS_REGION: 'us-east-1',
      AWS_DEFAULT_REGION: 'us-east-1', AWS_BEARER_TOKEN_BEDROCK: 't', AWS_ROLE_ARN: 'r', AWS_WEB_IDENTITY_TOKEN_FILE: 'f',
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: 'u', AWS_CONFIG_FILE: 'c', AWS_SHARED_CREDENTIALS_FILE: 's',
    };
    const bedrock: Env = { LLM_PROVIDER: 'bedrock', LLM_MODEL: 'm', LLM_REGION: 'us-east-1' };
    expect(parseLlmConfig({ ...bedrock, ...aws }).generation?.provider).toBe('bedrock');
    expect(parseLlmConfig({ ...withProvider, ...aws }).generation?.provider).toBe('anthropic');
  });

  it.each(['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_BEDROCK_RUNTIME', 'AWS_ENDPOINT_URL_S3', 'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'])(
    'refuses %s while Bedrock is configured, for either operation',
    (name) => {
      const bedrock: Env = { LLM_PROVIDER: 'bedrock', LLM_MODEL: 'm', LLM_REGION: 'us-east-1' };
      expect(problem({ ...bedrock, [name]: 'https://example.invalid' })).toContain(name);
      expect(problem({ ...withProvider, EMBEDDING_PROVIDER: 'bedrock', EMBEDDING_MODEL: 'm', EMBEDDING_REGION: 'us-east-1', [name]: 'x' })).toContain(name);
    },
  );

  it('accepts the AWS endpoint variables when Bedrock is not configured, because the secrets-manager client may use them', () => {
    expect(parseLlmConfig({ ...withProvider, AWS_ENDPOINT_URL: 'https://example.invalid', AWS_ENDPOINT_URL_SECRETS_MANAGER: 'x' }).generation?.provider).toBe('anthropic');
  });

  it('is checked after every other rule', () => {
    expect(problem({ ...withProvider, LLM_TIMEOUT: 'bad', OPENAI_API_KEY: 'x' })).toContain('LLM_TIMEOUT');
  });
});
