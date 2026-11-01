import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The two compose files run the worker next to the app (Phase 3 Milestone 2, FR-001, FR-071, research #9, #11): the same
// image with another command, the provider keys given to the worker alone, the job settings to both, a health check on the
// worker, and nothing published by it. It reads the files as structure, as workflows.test.ts does.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Service {
  build?: unknown;
  image?: string;
  command?: string[];
  environment?: Record<string, string | number>;
  ports?: unknown;
  extra_hosts?: string[];
  healthcheck?: { test?: string[] };
  depends_on?: Record<string, { condition?: string }>;
  volumes?: string[];
}
interface Compose {
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
}

const FILES = ['docker-compose.yml', 'docker-compose.release.yml'] as const;
const load = (file: string): Compose => parse(readFileSync(path.join(ROOT, file), 'utf8')) as Compose;

const KEYS = ['LLM_API_KEY', 'EMBEDDING_API_KEY'];
const PROVIDER_SETTINGS = [
  'LLM_PROVIDER', 'LLM_MODEL', 'LLM_BASE_URL', 'LLM_LOCAL', 'LLM_REGION',
  'EMBEDDING_PROVIDER', 'EMBEDDING_MODEL', 'EMBEDDING_BASE_URL', 'EMBEDDING_LOCAL', 'EMBEDDING_REGION',
  'LLM_TIMEOUT', 'LLM_PRICE_INPUT', 'LLM_PRICE_OUTPUT', 'EMBEDDING_PRICE_INPUT',
];
const JOB_SETTINGS = [
  'JOB_TOKEN_CAP', 'JOB_COST_CAP', 'JOB_MAX_RUNS', 'JOB_TIME_LIMIT', 'JOBS_PER_ACCOUNT', 'PROVIDER_CHECK_COOLDOWN',
  'WORKER_CONCURRENCY', 'WORKER_HEALTH_PORT',
];
// Phase 3 Milestone 3 (contracts/configuration.md): who reads which document setting. The storage settings and the document space
// are the same for both; the S3 keys are given to both, because the app stores the uploads and the worker reads them.
const STORAGE = [
  'STORAGE_BACKEND', 'STORAGE_S3_BUCKET', 'STORAGE_S3_PREFIX', 'STORAGE_S3_REGION', 'STORAGE_S3_ENDPOINT', 'STORAGE_S3_FORCE_PATH_STYLE',
  'STORAGE_S3_ACCESS_KEY_ID', 'STORAGE_S3_SECRET_ACCESS_KEY',
];
const APP_DOCUMENT_SETTINGS = ['SOURCE_MAX_MB', 'SOURCES_PER_THREAT_MODEL', 'INGESTION_JOBS_PER_ACCOUNT', 'DOCUMENT_SPACE', ...STORAGE];
const WORKER_DOCUMENT_SETTINGS = ['DOCUMENT_SPACE', 'SOURCE_MAX_CHARS', 'EXTRACT_TIME_LIMIT', 'EXTRACT_MEMORY_MB', 'EXTRACT_UNPACKED_MB', 'EXTRACT_MAX_PAGES', ...STORAGE];
const DATABASE = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];

describe.each(FILES)('%s', (file) => {
  const compose = load(file);
  const app = compose.services.app as Service;
  const worker = compose.services.worker;
  const env = (service: Service | undefined): Record<string, string | number> => service?.environment ?? {};

  it('has a worker service next to the app and the database', () => {
    expect(Object.keys(compose.services).sort()).toEqual(['app', 'db', 'worker']);
  });

  it('runs the same image or build as the app, with the worker as its command', () => {
    expect(worker?.command).toEqual(['node', 'dist/worker.js']);
    if (app.build !== undefined) expect(worker?.build).toEqual(app.build);
    else expect(worker?.image).toBe(app.image);
    expect(worker?.build !== undefined || worker?.image !== undefined).toBe(true);
  });

  it('gives the worker the database, every provider setting and both provider keys, and the job settings', () => {
    for (const name of [...DATABASE, ...PROVIDER_SETTINGS, ...KEYS, ...JOB_SETTINGS]) expect(env(worker), name).toHaveProperty(name);
  });

  it('points the worker at the same database as the app', () => {
    for (const name of DATABASE) expect(env(worker)[name], name).toBe(env(app)[name]);
  });

  it('gives the provider keys to the worker alone: the app has neither (FR-071)', () => {
    for (const name of KEYS) expect(env(app), name).not.toHaveProperty(name);
  });

  it('still gives the app every other provider setting, which it reports, and the job settings, which it checks and copies', () => {
    for (const name of [...PROVIDER_SETTINGS, ...JOB_SETTINGS]) expect(env(app), name).toHaveProperty(name);
  });

  it('gives the worker nothing of the web app: no signing secret and no sign-in', () => {
    for (const name of ['JWT_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'PORT', 'TRUST_PROXY']) expect(env(worker), name).not.toHaveProperty(name);
  });

  it('checks the worker’s health on its port, with Node, because the image has no curl', () => {
    const test = worker?.healthcheck?.test ?? [];
    expect(test.slice(0, 2)).toEqual(['CMD', 'node']);
    expect(test.join(' ')).toContain('/health');
    expect(test.join(' ')).toContain('3001');
  });

  it('gives each process the document settings it reads, all empty by default so that the defaults of the code apply', () => {
    for (const name of APP_DOCUMENT_SETTINGS) expect(env(app), name).toHaveProperty(name);
    for (const name of WORKER_DOCUMENT_SETTINGS) expect(env(worker), name).toHaveProperty(name);
    for (const name of [...APP_DOCUMENT_SETTINGS, ...WORKER_DOCUMENT_SETTINGS]) {
      for (const service of [app, worker]) {
        const value = env(service)[name];
        if (value !== undefined) expect(String(value), name).toMatch(/^\$\{[A-Z_0-9]+:-\}$/);
      }
    }
  });

  it('gives each process only the document settings it reads', () => {
    for (const name of ['SOURCE_MAX_CHARS', 'EXTRACT_TIME_LIMIT', 'EXTRACT_MEMORY_MB', 'EXTRACT_UNPACKED_MB', 'EXTRACT_MAX_PAGES']) expect(env(app), name).not.toHaveProperty(name);
    for (const name of ['SOURCE_MAX_MB', 'SOURCES_PER_THREAT_MODEL', 'INGESTION_JOBS_PER_ACCOUNT']) expect(env(worker), name).not.toHaveProperty(name);
  });

  it('shares one named volume for the stored originals between the app and the worker, at the directory the image makes', () => {
    expect(app.volumes).toEqual(['storage:/app/apps/api/storage']);
    expect(worker?.volumes).toEqual(['storage:/app/apps/api/storage']);
    expect(compose.volumes).toHaveProperty('storage');
    expect(compose.volumes).toHaveProperty('pgdata');
  });

  it('runs the database on the pgvector image, which Debian builds and Alpine does not', () => {
    expect(compose.services.db?.image).toMatch(/^pgvector\/pgvector:0\.8\.7-pg16-trixie/);
  });

  it('waits for the database to be healthy', () => {
    expect(worker?.depends_on?.db?.condition).toBe('service_healthy');
  });

  it('publishes nothing: the health port is for the platform’s check, not for the host', () => {
    expect(worker?.ports).toBeUndefined();
  });

  it('can reach a model server on the host, as the app can', () => {
    expect(worker?.extra_hosts).toEqual(app.extra_hosts);
  });
});

describe('docker-compose.release.yml', () => {
  const text = readFileSync(path.join(ROOT, 'docker-compose.release.yml'), 'utf8');

  it('names the version in one place for both services, so the release pins both', () => {
    expect(text.match(/\$\{SCRYLUX_VERSION:-[^}]+\}/g)).toHaveLength(2);
  });

  it('pins the database image by digest, which is the digest CI and the upgrade check use', () => {
    const digest = /pgvector\/pgvector:0\.8\.7-pg16-trixie@(sha256:[0-9a-f]{64})/.exec(text)?.[1];
    expect(digest).toBeDefined();
    const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const script = readFileSync(path.join(ROOT, 'scripts', 'check-db-upgrade.sh'), 'utf8');
    expect(ci).toContain(digest as string);
    expect(script).toContain(digest as string);
  });

  it('no longer names the Alpine database image, except as the old one in the upgrade check', () => {
    expect(text).not.toContain('postgres:16-alpine');
  });

  it('says the worker needs the image of the next release', () => {
    expect(text).toMatch(/worker[\s\S]*next release/i);
  });
});

// Dependabot keeps the database image's digest current, and holds back what a person must decide (Phase 3 Milestone 3, FR-092,
// research #15): the image the compose files run is named in its `docker-compose` entry, not the one they ran before.
describe('.github/dependabot.yml, the docker-compose entry', () => {
  interface Entry {
    'package-ecosystem': string;
    ignore?: { 'dependency-name': string; 'update-types'?: string[] }[];
  }
  const entries = (parse(readFileSync(path.join(ROOT, '.github', 'dependabot.yml'), 'utf8')) as { updates: Entry[] }).updates;
  const compose = entries.find((e) => e['package-ecosystem'] === 'docker-compose');
  const image = (file: string): string => (load(file).services.db?.image ?? '').split(':')[0] ?? '';

  it('names the image of the database in both compose files, which are the same', () => {
    expect(image('docker-compose.yml')).toBe('pgvector/pgvector');
    expect(image('docker-compose.release.yml')).toBe('pgvector/pgvector');
  });

  it('holds back a major update of that image for a person to decide, as it did for the image before it', () => {
    const ignored = compose?.ignore?.find((rule) => rule['dependency-name'] === image('docker-compose.release.yml'));
    expect(ignored?.['update-types']).toContain('version-update:semver-major');
  });

  it('does not keep a rule for an image no compose file runs', () => {
    const used = new Set(FILES.map(image));
    for (const rule of compose?.ignore ?? []) expect(used.has(rule['dependency-name']), rule['dependency-name']).toBe(true);
  });
});
