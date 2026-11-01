import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AWS_S3_EXEMPT_VARIABLES,
  StorageConfigError,
  checkStorageConfig,
  parseStorageConfig,
  refusesS3Variable,
  storageEnvironment,
} from '../../src/storage/config.js';

// The storage settings (Phase 3 Milestone 3, contracts/configuration.md). The app and the worker parse them when they
// start, so a bad value stops either one with the variable's name and never its value (FR-052). A secret is never part of
// a message (Principle I).

type Env = Record<string, string | undefined>;

function problem(env: Env): string {
  try {
    parseStorageConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(StorageConfigError);
    return (error as Error).message;
  }
  throw new Error('expected the settings to be refused');
}

const s3 = (extra: Env = {}): Env => ({ STORAGE_BACKEND: 's3', STORAGE_S3_BUCKET: 'scrylux-docs', STORAGE_S3_REGION: 'eu-west-1', ...extra });

describe('the local volume, the default', () => {
  it('is chosen when nothing is set, in a directory called storage', () => {
    expect(parseStorageConfig({})).toEqual({ backend: 'local', dir: 'storage' });
  });

  it('is chosen for empty values, which an unset compose variable becomes', () => {
    expect(parseStorageConfig({ STORAGE_BACKEND: '', STORAGE_DIR: '', STORAGE_S3_BUCKET: '', STORAGE_S3_REGION: '', STORAGE_S3_ACCESS_KEY_ID: '' })).toEqual({
      backend: 'local',
      dir: 'storage',
    });
  });

  it('takes a relative or an absolute directory', () => {
    expect(parseStorageConfig({ STORAGE_BACKEND: 'local', STORAGE_DIR: '/data/originals' })).toEqual({ backend: 'local', dir: '/data/originals' });
    expect(parseStorageConfig({ STORAGE_DIR: 'var/originals' })).toEqual({ backend: 'local', dir: 'var/originals' });
  });

  it('refuses a directory with a NUL, and a backend that is neither local nor s3', () => {
    expect(problem({ STORAGE_DIR: 'a\u0000b' })).toContain('STORAGE_DIR');
    expect(problem({ STORAGE_BACKEND: 'database' })).toContain('STORAGE_BACKEND');
    expect(problem({ STORAGE_BACKEND: 'S3' })).toContain('STORAGE_BACKEND');
  });

  it('refuses an S3 setting that would be ignored, so a forgotten STORAGE_BACKEND is not silent', () => {
    expect(problem({ STORAGE_S3_BUCKET: 'scrylux-docs' })).toMatch(/STORAGE_S3_BUCKET.*STORAGE_BACKEND/);
    expect(problem({ STORAGE_S3_ENDPOINT: 'https://s3.example.com' })).toContain('STORAGE_S3_ENDPOINT');
  });
});

describe('the S3-compatible service', () => {
  it('takes a bucket and a region, with the prefix scrylux/ and virtual-hosted addressing by default', () => {
    expect(parseStorageConfig(s3())).toEqual({ backend: 's3', bucket: 'scrylux-docs', prefix: 'scrylux/', region: 'eu-west-1', forcePathStyle: false });
  });

  it('takes an endpoint, path-style addressing and a key pair, for MinIO and its kind', () => {
    expect(
      parseStorageConfig(
        s3({
          STORAGE_S3_PREFIX: 'team-a/docs/',
          STORAGE_S3_ENDPOINT: 'https://minio.example.com:9000',
          STORAGE_S3_FORCE_PATH_STYLE: 'true',
          STORAGE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
          STORAGE_S3_SECRET_ACCESS_KEY: 'a-secret',
        }),
      ),
    ).toEqual({
      backend: 's3',
      bucket: 'scrylux-docs',
      prefix: 'team-a/docs/',
      region: 'eu-west-1',
      endpoint: 'https://minio.example.com:9000',
      forcePathStyle: true,
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'a-secret',
    });
  });

  it('leaves out the keys when there are none, so that the instance or task role is used', () => {
    const config = parseStorageConfig(s3());
    expect(config).not.toHaveProperty('accessKeyId');
    expect(config).not.toHaveProperty('secretAccessKey');
  });

  it('refuses a missing bucket or region, naming the variable', () => {
    expect(problem({ STORAGE_BACKEND: 's3', STORAGE_S3_REGION: 'eu-west-1' })).toContain('STORAGE_S3_BUCKET');
    expect(problem({ STORAGE_BACKEND: 's3', STORAGE_S3_BUCKET: 'scrylux-docs' })).toContain('STORAGE_S3_REGION');
  });

  it.each(['ab', 'A-Bucket', 'bucket_name', '-leading', 'trailing-', 'a'.repeat(64), 'has space', 'x/y', '../x'])('refuses the bucket %j', (bucket) => {
    expect(problem(s3({ STORAGE_S3_BUCKET: bucket }))).toContain('STORAGE_S3_BUCKET');
  });

  it.each(['docs', '/docs/', 'docs//more/', 'docs/../x/', 'do cs/', 'docs/é/', ''])('refuses the prefix %j unless it is empty (the default)', (prefix) => {
    if (prefix === '') {
      expect(parseStorageConfig(s3({ STORAGE_S3_PREFIX: prefix }))).toMatchObject({ prefix: 'scrylux/' });
    } else {
      expect(problem(s3({ STORAGE_S3_PREFIX: prefix }))).toContain('STORAGE_S3_PREFIX');
    }
  });

  it.each(['A', 'us east 1', 'us_east_1', 'x'.repeat(33)])('refuses the region %j', (region) => {
    expect(problem(s3({ STORAGE_S3_REGION: region }))).toContain('STORAGE_S3_REGION');
  });

  it.each(['minio:9000', 'ftp://minio.example.com', 'https://', 'https://user:pass@minio.example.com', 'https://minio.example.com/path?x=1', 'https://minio.example.com/#frag', 'not a url'])(
    'refuses the endpoint %j',
    (endpoint) => {
      expect(problem(s3({ STORAGE_S3_ENDPOINT: endpoint }))).toContain('STORAGE_S3_ENDPOINT');
    },
  );

  it.each([
    'http://localhost:9000',
    'http://127.0.0.1:9000',
    'http://10.1.2.3:9000',
    'http://172.20.0.5:9000',
    'http://192.168.1.10:9000',
    'http://[::1]:9000',
    'http://minio:9000',
    'http://host.docker.internal:9000',
  ])('allows %s, a host on a private network, over plain http', (endpoint) => {
    expect(parseStorageConfig(s3({ STORAGE_S3_ENDPOINT: endpoint }))).toMatchObject({ endpoint });
  });

  it.each(['http://s3.example.com', 'http://8.8.8.8:9000', 'http://172.32.0.1:9000', 'http://192.169.0.1'])('refuses %s: credentials must not cross a public network unencrypted', (endpoint) => {
    expect(problem(s3({ STORAGE_S3_ENDPOINT: endpoint }))).toMatch(/STORAGE_S3_ENDPOINT.*https/);
  });

  it('refuses a path-style flag that is not true or false', () => {
    expect(problem(s3({ STORAGE_S3_FORCE_PATH_STYLE: 'yes' }))).toContain('STORAGE_S3_FORCE_PATH_STYLE');
    expect(parseStorageConfig(s3({ STORAGE_S3_FORCE_PATH_STYLE: 'false' }))).toMatchObject({ forcePathStyle: false });
  });

  it('wants both keys or neither', () => {
    expect(problem(s3({ STORAGE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE' }))).toMatch(/STORAGE_S3_ACCESS_KEY_ID.*STORAGE_S3_SECRET_ACCESS_KEY/);
    expect(problem(s3({ STORAGE_S3_SECRET_ACCESS_KEY: 'a-secret' }))).toMatch(/STORAGE_S3_ACCESS_KEY_ID.*STORAGE_S3_SECRET_ACCESS_KEY/);
  });

  it('refuses a directory setting that would be ignored', () => {
    expect(problem(s3({ STORAGE_DIR: '/data' }))).toContain('STORAGE_DIR');
  });

  it('never repeats a value in a message, however bad it is', () => {
    const secrets = ['top-secret-bucket-VALUE!', 'AKIASECRETKEYVALUE', 'secret-access-VALUE'];
    const messages = [
      problem(s3({ STORAGE_S3_BUCKET: secrets[0] })),
      problem(s3({ STORAGE_S3_ACCESS_KEY_ID: secrets[1] })),
      problem(s3({ STORAGE_S3_SECRET_ACCESS_KEY: secrets[2] })),
      problem(s3({ STORAGE_S3_ENDPOINT: 'https://user:pass-VALUE@minio.example.com' })),
      problem(s3({ STORAGE_S3_PREFIX: 'prefix-VALUE' })),
      problem({ STORAGE_BACKEND: 'backend-VALUE' }),
    ];
    for (const message of messages) expect(message).not.toMatch(/VALUE|SECRETKEY/);
  });
});

describe('the variables the AWS client would read on its own', () => {
  it.each([
    'AWS_ENDPOINT_URL',
    'AWS_ENDPOINT_URL_S3',
    'AWS_ENDPOINT_URL_STS',
    'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
    'AWS_S3_USE_ARN_REGION',
    'AWS_S3_DISABLE_MULTIREGION_ACCESS_POINTS',
    'AWS_S3_US_EAST_1_REGIONAL_ENDPOINT',
    'AWS_USE_DUALSTACK_ENDPOINT',
    'AWS_USE_FIPS_ENDPOINT',
  ])('stops the S3 backend from starting while %s is set, naming it', (name) => {
    expect(refusesS3Variable(name)).toBe(true);
    const message = problem(s3({ [name]: 'anything' }));
    expect(message).toContain(name);
    expect(message).not.toContain('anything');
  });

  it('does not stop the local volume, which has no AWS client', () => {
    expect(parseStorageConfig({ AWS_ENDPOINT_URL: 'http://elsewhere', AWS_USE_FIPS_ENDPOINT: 'true' })).toEqual({ backend: 'local', dir: 'storage' });
  });

  it('lets the credentials, the profile and the region through, which the role of an instance or task needs', () => {
    const env = s3({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b', AWS_SESSION_TOKEN: 'c', AWS_PROFILE: 'p', AWS_REGION: 'eu-west-1', AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/x', AWS_WEB_IDENTITY_TOKEN_FILE: '/t', AWS_ROLE_ARN: 'r' });
    expect(parseStorageConfig(env)).toMatchObject({ backend: 's3' });
  });

  it('ignores an empty value, as for every other setting', () => {
    expect(parseStorageConfig(s3({ AWS_ENDPOINT_URL: '' }))).toMatchObject({ backend: 's3' });
  });

  it('names the first of several, in alphabetical order, so the message does not depend on the environment’s order', () => {
    expect(problem(s3({ AWS_USE_FIPS_ENDPOINT: '1', AWS_ENDPOINT_URL: 'x' }))).toContain('AWS_ENDPOINT_URL');
  });
});

describe('storageEnvironment', () => {
  it('puts the keys that config.load() resolved, from the secret, over the environment’s', () => {
    const merged = storageEnvironment(s3({ STORAGE_S3_ACCESS_KEY_ID: 'from-env', STORAGE_S3_SECRET_ACCESS_KEY: 'from-env-too' }), {
      storageS3AccessKeyId: 'from-secret',
      storageS3SecretAccessKey: 'from-secret-too',
    });
    expect(parseStorageConfig(merged)).toMatchObject({ accessKeyId: 'from-secret', secretAccessKey: 'from-secret-too' });
  });

  it('leaves the environment alone when there are no keys to put', () => {
    const env = s3({ STORAGE_S3_ACCESS_KEY_ID: 'from-env', STORAGE_S3_SECRET_ACCESS_KEY: 'from-env-too' });
    expect(storageEnvironment(env, {})).toEqual(env);
    expect(storageEnvironment(env, { storageS3AccessKeyId: undefined })).toEqual(env);
  });

  it('does not change the environment it was given', () => {
    const env = s3();
    storageEnvironment(env, { storageS3AccessKeyId: 'k', storageS3SecretAccessKey: 's' });
    expect(env).toEqual(s3());
  });
});

describe('checkStorageConfig', () => {
  it('returns the settings when they are right', () => {
    expect(checkStorageConfig({})).toEqual({ ok: true, config: { backend: 'local', dir: 'storage' } });
  });

  it('returns a line that names the setting and never its value', () => {
    const result = checkStorageConfig(s3({ STORAGE_S3_BUCKET: 'BAD-VALUE-bucket' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.line).toMatch(/^Startup failed: STORAGE_S3_BUCKET /);
    expect(result.line).not.toContain('BAD-VALUE');
  });
});

// FR-052 and research #10: the AWS client reads environment variables on its own. Scrylux refuses the ones that choose
// another address, and lists the ones that are harmless. This test keeps both lists in step with the installed client and
// its whole production dependency tree, as packages/llm/test/sdk-env.test.ts does for the provider libraries.

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOTS = ['@aws-sdk/client-s3'];
const LITERAL = /["'`](AWS_[A-Z0-9_]+)["'`]/g;

// Names that look like variables but cannot change a request that Scrylux sends. Each says why.
const NOT_READ: Record<string, string> = {
  // The client is built with these two set explicitly, and an explicit option wins over the environment.
  AWS_REQUEST_CHECKSUM_CALCULATION: 'set explicitly by the backend',
  AWS_RESPONSE_CHECKSUM_VALIDATION: 'set explicitly by the backend',
  // @aws-sdk/client-s3: values of a generated enumeration (a storage class), not environment variables.
  AWS_BACKUP_WARM: 'a constant',
  AWS_BACKUP_LOW_COST_WARM: 'a constant',
  // The AWS libraries read these to tell where they run, for the user-agent and tracing. They configure no request.
  AWS_EXECUTION_ENV: 'runtime detection',
  AWS_LAMBDA_FUNCTION_NAME: 'runtime detection',
  AWS_LAMBDA_MAX_CONCURRENCY: 'runtime detection',
};

function locate(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

function jsFiles(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) jsFiles(path, into);
    else if (/\.(?:c|m)?js$/.test(entry.name) && !entry.name.endsWith('.min.js')) into.push(path);
  }
  return into;
}

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function installedPackages(): Map<string, string> {
  const found = new Map<string, string>();
  const queue = ROOTS.map((name) => locate(PACKAGE_DIR, name)).filter((dir): dir is string => dir !== undefined);
  for (const dir of queue) {
    if ([...found.values()].includes(dir)) continue;
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
    found.set(manifest.name, dir);
    const deps = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
    for (const dep of Object.keys(deps)) {
      const at = locate(dir, dep);
      if (at !== undefined) queue.push(at);
    }
  }
  return found;
}

function awsVariables(): Map<string, string> {
  const names = new Map<string, string>();
  for (const [pkg, dir] of installedPackages()) {
    for (const file of jsFiles(dir)) {
      const text = readFileSync(file, 'utf8');
      if (text.length > 5_000_000) continue;
      for (const match of text.matchAll(LITERAL)) {
        const name = match[1] as string;
        if (!names.has(name)) names.set(name, `${pkg}: ${basename(file)}`);
      }
    }
  }
  return names;
}

describe('the installed AWS client', () => {
  const packages = installedPackages();
  const names = awsVariables();

  it('is found, with its dependencies', () => {
    expect(packages.has('@aws-sdk/client-s3')).toBe(true);
    expect(packages.size).toBeGreaterThan(10);
  });

  it('reads the variables that are refused or exempt, so the scan is looking at the right thing', () => {
    expect(names.has('AWS_ENDPOINT_URL')).toBe(true);
    expect(names.has('AWS_ACCESS_KEY_ID')).toBe(true);
    expect([...names.keys()].some((name) => name.startsWith('AWS_S3_'))).toBe(true);
  });

  it('reads no variable that Scrylux neither refuses, nor exempts, nor can show is not read (FR-052)', () => {
    const uncovered = [...names]
      .filter(([name]) => !refusesS3Variable(name) && !AWS_S3_EXEMPT_VARIABLES.includes(name) && !(name in NOT_READ))
      .map(([name, where]) => `${name} (${where})`);
    expect(uncovered, 'Decide each: refuse it in storage/config.ts, exempt it there as a credential or behaviour variable, or say in NOT_READ why it is not read').toEqual([]);
  });

  it('has no stale entry in NOT_READ', () => {
    for (const name of Object.keys(NOT_READ)) expect(names.has(name), `${name} is not in any installed package any more: delete it`).toBe(true);
  });

  it('has no stale entry in the exemption, and none that is also refused', () => {
    const stale = AWS_S3_EXEMPT_VARIABLES.filter((name) => !names.has(name));
    expect(stale, 'not in any installed package any more: delete these from AWS_S3_EXEMPT_VARIABLES').toEqual([]);
    expect(AWS_S3_EXEMPT_VARIABLES.filter((name) => refusesS3Variable(name))).toEqual([]);
  });
});
