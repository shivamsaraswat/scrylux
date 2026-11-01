// The storage settings (Phase 3 Milestone 3, specs/phase-3/milestone-3-ingestion/contracts/configuration.md). The app and the
// worker parse all of them when they start, so a bad value stops either one. A message names the variable and the rule and
// never repeats the value (FR-052), so it is safe to log. Neither process contacts storage when it starts.

// Exported for tests: tests check the error class.
export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageConfigError';
  }
}

export type StorageConfig =
  | { backend: 'local'; dir: string }
  | {
      backend: 's3';
      bucket: string;
      /** Ends with a slash; the bucket may be shared, and Scrylux touches only keys of its own shape under this. */
      prefix: string;
      region: string;
      endpoint?: string;
      forcePathStyle: boolean;
      /** Both or neither. Without them the client uses the instance or task role. */
      accessKeyId?: string;
      secretAccessKey?: string;
    };

type Env = Readonly<Record<string, string | undefined>>;

const set = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
};

// What the AWS client reads from the environment on its own and that would send a document, or the credentials that come
// with it, to another address: the endpoint settings, the S3-specific settings, and the choice of another endpoint of the
// same region. Refused while the S3 backend is chosen (research #10), as Milestone 1 does for Bedrock.
const REFUSED_PREFIXES = ['AWS_ENDPOINT_URL', 'AWS_S3_'] as const;
const REFUSED_NAMES = ['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS', 'AWS_USE_DUALSTACK_ENDPOINT', 'AWS_USE_FIPS_ENDPOINT'] as const;

/**
 * AWS's own variables for credentials, profile, region and the standard behaviour of its client, which the S3 backend is
 * meant to use when it runs with a role, listed by name and never by prefix. An explicit client option already wins where
 * Scrylux sets one (the region, and the checksum settings).
 */
// Exported for tests: a test keeps it in step with the installed AWS client.
export const AWS_S3_EXEMPT_VARIABLES: readonly string[] = [
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
  'AWS_AUTH_SCHEME_PREFERENCE',
  'AWS_MAX_ATTEMPTS',
  'AWS_RETRY_MODE',
  'AWS_DEFAULTS_MODE',
  'AWS_DISABLE_CLOCK_SKEW_CORRECTION',
  'AWS_SDK_UA_APP_ID',
  'AWS_ACCOUNT_ID_ENDPOINT_MODE',
];

/** Whether Scrylux refuses to start the S3 backend while this variable is set. */
// Exported for tests: a test keeps the refused names in step with the installed AWS client.
export const refusesS3Variable = (name: string): boolean =>
  REFUSED_PREFIXES.some((prefix) => name.startsWith(prefix)) || (REFUSED_NAMES as readonly string[]).includes(name);

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX = /^(?:[A-Za-z0-9_-]+\/)+$/;
const REGION = /^[a-z0-9-]{2,32}$/;

/** Whether plain http is acceptable for this host: the credentials must not cross a public network unencrypted. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'host.docker.internal') return true;
  if (host.startsWith('[')) {
    const address = host.slice(1, -1);
    return address === '::1' || /^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address);
  }
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (octets) {
    const [a, b] = [Number(octets[1]), Number(octets[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  // A name with no dot is a service on the same network, such as a compose service.
  return !host.includes('.');
}

function endpoint(raw: string): string {
  const rule = 'STORAGE_S3_ENDPOINT must be an absolute http or https address with no credentials, query or fragment';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StorageConfigError(rule);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new StorageConfigError(rule);
  }
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    throw new StorageConfigError('STORAGE_S3_ENDPOINT must use https, unless it names a host on a private network');
  }
  return raw;
}

function parseS3(env: Env): StorageConfig {
  if (set(env, 'STORAGE_DIR') !== undefined) throw new StorageConfigError('STORAGE_DIR is set, but STORAGE_BACKEND is s3. Remove STORAGE_DIR, or set STORAGE_BACKEND=local');
  for (const name of Object.keys(env).sort()) {
    if (set(env, name) !== undefined && refusesS3Variable(name)) {
      throw new StorageConfigError(`${name} is set, and the AWS client would read it on its own. Remove it from the environment`);
    }
  }
  const bucket = set(env, 'STORAGE_S3_BUCKET');
  if (bucket === undefined) throw new StorageConfigError('STORAGE_S3_BUCKET must be set when STORAGE_BACKEND is s3');
  if (!BUCKET.test(bucket)) throw new StorageConfigError('STORAGE_S3_BUCKET must be a bucket name: 3 to 63 lowercase letters, digits, hyphens or dots');
  const region = set(env, 'STORAGE_S3_REGION');
  if (region === undefined) throw new StorageConfigError('STORAGE_S3_REGION must be set when STORAGE_BACKEND is s3');
  if (!REGION.test(region)) throw new StorageConfigError('STORAGE_S3_REGION must be a region name: 2 to 32 lowercase letters, digits or hyphens');
  const prefix = set(env, 'STORAGE_S3_PREFIX') ?? 'scrylux/';
  if (!PREFIX.test(prefix)) throw new StorageConfigError('STORAGE_S3_PREFIX must end with / and hold only letters, digits, hyphens, underscores and slashes between names');
  const rawEndpoint = set(env, 'STORAGE_S3_ENDPOINT');
  const style = set(env, 'STORAGE_S3_FORCE_PATH_STYLE');
  if (style !== undefined && style !== 'true' && style !== 'false') throw new StorageConfigError('STORAGE_S3_FORCE_PATH_STYLE must be true or false');
  const accessKeyId = set(env, 'STORAGE_S3_ACCESS_KEY_ID');
  const secretAccessKey = set(env, 'STORAGE_S3_SECRET_ACCESS_KEY');
  if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
    throw new StorageConfigError('STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY must be set together, or both left out to use the instance or task role');
  }
  return {
    backend: 's3',
    bucket,
    prefix,
    region,
    ...(rawEndpoint === undefined ? {} : { endpoint: endpoint(rawEndpoint) }),
    forcePathStyle: style === 'true',
    ...(accessKeyId === undefined || secretAccessKey === undefined ? {} : { accessKeyId, secretAccessKey }),
  };
}

function parseLocal(env: Env): StorageConfig {
  for (const name of Object.keys(env).sort()) {
    if (name.startsWith('STORAGE_S3_') && set(env, name) !== undefined) {
      throw new StorageConfigError(`${name} is set, but STORAGE_BACKEND is not s3. Set STORAGE_BACKEND=s3, or remove ${name}`);
    }
  }
  const dir = set(env, 'STORAGE_DIR') ?? 'storage';
  if (dir.includes('\u0000')) throw new StorageConfigError('STORAGE_DIR must be a directory path');
  return { backend: 'local', dir };
}

/** Reads the storage settings from an environment, and throws a StorageConfigError for the first problem, in a fixed order. */
export function parseStorageConfig(env: Env): StorageConfig {
  const backend = set(env, 'STORAGE_BACKEND') ?? 'local';
  if (backend !== 'local' && backend !== 's3') throw new StorageConfigError('STORAGE_BACKEND must be local or s3');
  return backend === 's3' ? parseS3(env) : parseLocal(env);
}

/** The S3 keys that `config.load()` resolved: the environment's, overridden by the secrets-manager secret. */
export interface StorageKeys {
  storageS3AccessKeyId?: string | undefined;
  storageS3SecretAccessKey?: string | undefined;
}

/** The environment with the resolved keys put back in, which is what parseStorageConfig reads. */
export function storageEnvironment(env: Env, keys: StorageKeys): Env {
  return {
    ...env,
    ...(keys.storageS3AccessKeyId === undefined ? {} : { STORAGE_S3_ACCESS_KEY_ID: keys.storageS3AccessKeyId }),
    ...(keys.storageS3SecretAccessKey === undefined ? {} : { STORAGE_S3_SECRET_ACCESS_KEY: keys.storageS3SecretAccessKey }),
  };
}

export type StorageConfigCheck = { ok: true; config: StorageConfig } | { ok: false; line: string };

/**
 * The start-up check of the app and the worker: the settings, or a fixed line that names the setting and never its value
 * (FR-052). The message of a StorageConfigError is built from variable names and rules only, so it is safe to log.
 */
export function checkStorageConfig(env: Env): StorageConfigCheck {
  try {
    return { ok: true, config: parseStorageConfig(env) };
  } catch (error) {
    if (!(error instanceof StorageConfigError)) throw error;
    return { ok: false, line: `Startup failed: ${error.message}` };
  }
}
