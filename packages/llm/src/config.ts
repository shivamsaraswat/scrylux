import { LlmConfigError } from './errors.js';
import type { LlmConfig, LlmStatus, OperationConfig, ProviderName } from './types.js';

// The layer's configuration, from environment values only (Principle IV, FR-001). parseLlmConfig is pure: it reads the
// object it is given, never contacts a provider (FR-007), and every message it throws is built from fixed text and
// variable names, so it is safe to log (FR-006). The one value a message may repeat is an accepted provider name.
// The rules and their order are in specs/phase-3/milestone-1-llm-provider-layer/contracts/configuration.md.

type Env = Readonly<Record<string, string | undefined>>;
type Prefix = 'LLM' | 'EMBEDDING';

const GENERATION_PROVIDERS = ['anthropic', 'openai-compatible', 'bedrock', 'gemini'] as const satisfies readonly ProviderName[];
// Anthropic offers no embeddings of its own (FR-002).
const EMBEDDING_PROVIDERS = ['openai-compatible', 'bedrock', 'gemini'] as const satisfies readonly ProviderName[];

const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 3_600_000;

type Setting = 'MODEL' | 'BASE_URL' | 'API_KEY' | 'LOCAL' | 'REGION';

// What each provider needs, and the settings that do not apply to it (rule 3). LOCAL is judged by rule 6.
const REQUIRED: Record<ProviderName, readonly Setting[]> = {
  anthropic: ['MODEL', 'API_KEY'],
  'openai-compatible': ['MODEL', 'BASE_URL'],
  bedrock: ['MODEL', 'REGION'],
  gemini: ['MODEL', 'API_KEY'],
};
const ALLOWED: Record<ProviderName, readonly Setting[]> = {
  anthropic: ['MODEL', 'API_KEY'],
  'openai-compatible': ['MODEL', 'BASE_URL', 'API_KEY'],
  bedrock: ['MODEL', 'REGION'],
  gemini: ['MODEL', 'API_KEY'],
};
const NOT_APPLICABLE_CHECKS: readonly Setting[] = ['BASE_URL', 'API_KEY', 'REGION'];

const set = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
};

function pickProvider(env: Env, prefix: Prefix, accepted: readonly ProviderName[]): ProviderName | null {
  const name = `${prefix}_PROVIDER`;
  const raw = set(env, name);
  if (raw === undefined) return null;
  const match = accepted.find((p) => p === raw);
  if (match === undefined) throw new LlmConfigError(`${name} must be one of ${accepted.join(', ')}`);
  return match;
}

// Rule 2: a setting of an operation whose provider is not chosen is never silently ignored.
function refuseOrphans(env: Env, prefix: Prefix): void {
  const others = ['MODEL', 'BASE_URL', 'API_KEY', 'LOCAL', 'REGION', 'PRICE_INPUT', ...(prefix === 'LLM' ? ['PRICE_OUTPUT'] : [])];
  for (const other of others) {
    if (set(env, `${prefix}_${other}`) !== undefined) {
      throw new LlmConfigError(`set ${prefix}_PROVIDER, or remove ${prefix}_${other}`);
    }
  }
}

function parseBaseUrl(name: string, raw: string, local: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LlmConfigError(`${name} must be an absolute http or https address with no query or fragment`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '' || url.search !== '' || url.hash !== '') {
    throw new LlmConfigError(`${name} must be an absolute http or https address with no query or fragment`);
  }
  if (url.protocol === 'http:' && !local) {
    const flag = name.replace('BASE_URL', 'LOCAL');
    throw new LlmConfigError(`${name} must use https. A hosted provider needs https; a local one must be declared with ${flag}=true`);
  }
  return raw;
}

function parsePrice(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) {
    throw new LlmConfigError(`${name} must be a number of US dollars per million tokens, zero or more, with at most 6 decimal places`);
  }
  return Number(raw);
}

function parseOperation(
  env: Env,
  prefix: Prefix,
  accepted: readonly ProviderName[],
  generation: OperationConfig | null,
  requireKeys: boolean,
): OperationConfig | null {
  const providerVar = `${prefix}_PROVIDER`;
  const provider = pickProvider(env, prefix, accepted);
  if (provider === null) {
    refuseOrphans(env, prefix);
    return null;
  }
  const value = (setting: Setting): string | undefined => set(env, `${prefix}_${setting}`);

  // Rule 3: a setting that does not apply to this provider.
  for (const setting of NOT_APPLICABLE_CHECKS) {
    if (value(setting) !== undefined && !ALLOWED[provider].includes(setting)) {
      throw new LlmConfigError(`${prefix}_${setting} does not apply when ${providerVar} is ${provider}`);
    }
  }

  // The embedding key falls back to the generation key only for the same provider and the same address.
  let apiKey = value('API_KEY') ?? null;
  const sameEndpoint =
    generation !== null && generation.provider === provider && generation.baseUrl === (value('BASE_URL') ?? null) && generation.region === (value('REGION') ?? null);
  if (apiKey === null && prefix === 'EMBEDDING' && sameEndpoint) apiKey = generation.apiKey;

  for (const setting of REQUIRED[provider]) {
    // The API process reports whether AI is configured and holds no key (parseLlmStatus), so a key may be missing there.
    if (setting === 'API_KEY' && !requireKeys) continue;
    const present = setting === 'API_KEY' ? apiKey !== null : value(setting) !== undefined;
    if (!present) throw new LlmConfigError(`${prefix}_${setting} must be set when ${providerVar} is ${provider}`);
  }

  // Rules 4 to 8. The value of LOCAL comes first, because the rule for the address depends on it.
  const localRaw = value('LOCAL');
  if (localRaw !== undefined && localRaw !== 'true' && localRaw !== 'false') {
    throw new LlmConfigError(`${prefix}_LOCAL must be true or false`);
  }
  const local = localRaw === 'true';
  if (local && provider !== 'openai-compatible') {
    throw new LlmConfigError(`${prefix}_LOCAL=true applies only to openai-compatible: ${provider} is always hosted`);
  }

  const model = value('MODEL') as string;
  if (!/^[^\s\p{C}]{1,200}$/u.test(model)) {
    throw new LlmConfigError(`${prefix}_MODEL must be 1 to 200 characters with no whitespace`);
  }
  const baseUrl = provider === 'openai-compatible' ? parseBaseUrl(`${prefix}_BASE_URL`, value('BASE_URL') as string, local) : null;
  let region: string | null = null;
  if (provider === 'bedrock') {
    region = value('REGION') as string;
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new LlmConfigError(`${prefix}_REGION must be an AWS region such as us-east-1`);
  }

  const input = parsePrice(`${prefix}_PRICE_INPUT`, set(env, `${prefix}_PRICE_INPUT`));
  let operatorPrice: OperationConfig['operatorPrice'] = null;
  if (prefix === 'LLM') {
    const output = parsePrice('LLM_PRICE_OUTPUT', set(env, 'LLM_PRICE_OUTPUT'));
    if ((input === undefined) !== (output === undefined)) {
      throw new LlmConfigError('LLM_PRICE_INPUT and LLM_PRICE_OUTPUT must be set together');
    }
    if (input !== undefined && output !== undefined) operatorPrice = { input, output };
  } else if (input !== undefined) {
    operatorPrice = { input, output: null };
  }

  return { provider, model, baseUrl, apiKey, region, local, hosted: !local, operatorPrice };
}

// ---- Variables the provider libraries read on their own (FR-043a, rule 11) --------------------------------------------
//
// The SDKs read far more than a key from the environment: an address, extra headers, logging, telemetry. Some have no
// constructor option that overrides them, so passing options explicitly is not enough, and a stray variable could send
// the configured key to another host or print a prompt. While a provider is configured, Scrylux refuses to start with
// one of these set. test/sdk-env.test.ts reads the installed libraries and fails when one reads a name that is neither
// refused here, nor exempt below, nor shown not to be read, so an update of a library cannot add one unnoticed.

/** Refused by prefix: every variable the Anthropic and OpenAI libraries (and OpenAI's Azure helper) read starts with one. */
export const SDK_ENV_PREFIXES = ['ANTHROPIC_', 'OPENAI_', 'AZURE_OPENAI_'] as const;

/** Refused by name. */
export const SDK_ENV_VARIABLES = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_VERTEX_BASE_URL',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_ENTERPRISE',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_SDK_NODE_LOGGING',
  'AWS_BEDROCK_BASE_URL',
] as const;

// Refused only while Bedrock is configured: they send the AWS client to another address. With no Bedrock provider they
// are harmless to Scrylux and may serve the API's own secrets-manager client.
const BEDROCK_ENDPOINT_VARIABLES = ['AWS_ENDPOINT_URL', 'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'] as const;
const BEDROCK_ENDPOINT_PREFIX = 'AWS_ENDPOINT_URL_';

/**
 * AWS's own variables for credentials, profile, region and the standard behaviour of its client, which Bedrock is meant
 * to use (FR-004), listed by name and never by prefix. An explicit client option already wins where Scrylux sets one
 * (the region, and one attempt). FIPS and dual-stack choose another endpoint of the same AWS region, not another host.
 */
export const AWS_EXEMPT_VARIABLES: readonly string[] = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CREDENTIAL_EXPIRATION',
  'AWS_CREDENTIAL_SCOPE',
  'AWS_ACCOUNT_ID',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_EC2_METADATA_DISABLED',
  'AWS_EC2_METADATA_V1_DISABLED',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_AUTH_SCHEME_PREFERENCE',
  'AWS_MAX_ATTEMPTS',
  'AWS_RETRY_MODE',
  'AWS_DEFAULTS_MODE',
  'AWS_DISABLE_CLOCK_SKEW_CORRECTION',
  'AWS_SDK_UA_APP_ID',
  'AWS_USE_FIPS_ENDPOINT',
  'AWS_USE_DUALSTACK_ENDPOINT',
  'AWS_ACCOUNT_ID_ENDPOINT_MODE',
];

/** Whether Scrylux refuses to start while this variable is set. `bedrock` is whether a Bedrock provider is configured. */
export function refusesVariable(name: string, bedrock: boolean): boolean {
  if (SDK_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  if ((SDK_ENV_VARIABLES as readonly string[]).includes(name)) return true;
  return bedrock && ((BEDROCK_ENDPOINT_VARIABLES as readonly string[]).includes(name) || name.startsWith(BEDROCK_ENDPOINT_PREFIX));
}

function refuseVendorVariables(env: Env, generation: OperationConfig | null, embedding: OperationConfig | null): void {
  if (generation === null && embedding === null) return;
  const bedrock = generation?.provider === 'bedrock' || embedding?.provider === 'bedrock';
  // In alphabetical order, so the message does not depend on the order the environment lists its variables in.
  for (const name of Object.keys(env).sort()) {
    if (set(env, name) !== undefined && refusesVariable(name, bedrock)) {
      throw new LlmConfigError(`${name} is set, and the AI provider libraries would read it on their own. Remove it from the environment`);
    }
  }
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const match = /^(\d+)([sm])$/.exec(raw);
  const ms = match ? Number(match[1]) * (match[2] === 'm' ? 60_000 : 1000) : 0;
  if (!Number.isSafeInteger(ms) || ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS) {
    throw new LlmConfigError('LLM_TIMEOUT must be a whole number followed by s or m (seconds or minutes), from 10s to 60m');
  }
  return ms;
}

/**
 * Reads the AI settings from an environment. With none set it returns `{ generation: null, embedding: null }`, and
 * Scrylux behaves as v0.1 (FR-005). Otherwise it throws an LlmConfigError for the first problem it finds.
 */
export function parseLlmConfig(env: Env): LlmConfig {
  return parse(env, true);
}

/**
 * The same rules as parseLlmConfig, except that a key may be missing: the API process holds no provider key, only the
 * worker does, and it needs to know only whether generation and embeddings are configured and whether each is hosted
 * (Phase 3 Milestone 2, FR-071). One parser with a flag, so the two cannot drift. A key that is set is still checked
 * like any other setting.
 */
export function parseLlmStatus(env: Env): LlmStatus {
  return llmStatus(parse(env, false));
}

function parse(env: Env, requireKeys: boolean): LlmConfig {
  const generation = parseOperation(env, 'LLM', GENERATION_PROVIDERS, null, requireKeys);
  const embedding = parseOperation(env, 'EMBEDDING', EMBEDDING_PROVIDERS, generation, requireKeys);
  const timeoutMs = parseTimeout(set(env, 'LLM_TIMEOUT'));
  refuseVendorVariables(env, generation, embedding);
  return { generation, embedding, timeoutMs };
}

/** What the rest of Scrylux may know about the configuration: no key and no address (FR-045). */
export function llmStatus(config: LlmConfig): LlmStatus {
  const status = (op: OperationConfig | null): LlmStatus['generation'] =>
    op === null ? null : { provider: op.provider, model: op.model, hosted: op.hosted };
  return { generation: status(config.generation), embedding: status(config.embedding) };
}

