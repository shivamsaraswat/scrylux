import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AWS_EXEMPT_VARIABLES, refusesVariable } from '../src/config.js';

// FR-043a: the provider SDKs read environment variables on their own (a key, an address, extra headers, logging), and
// Scrylux refuses to start while one is set. This test keeps that list in step with the installed libraries. It reads
// the SDKs and their whole production dependency tree and finds every string that looks like a vendor variable, not
// only readEnv and getEnv calls, because the AWS SDK reads its variables through configuration selectors.

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['@anthropic-ai/sdk', 'openai', '@google/genai', '@aws-sdk/client-bedrock-runtime', 'undici'];
const VENDOR = /^(?:ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GCLOUD|AWS)_[A-Z0-9_]+$/;
const LITERAL = /["'`]((?:ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GCLOUD|AWS)_[A-Z0-9_]+)["'`]/g;

// Names that look like variables but cannot change a request that Scrylux sends. Each says why.
const NOT_READ: Record<string, string> = {
  // google-auth-library reads these for Google Cloud credentials. @google/genai uses that library only for Vertex AI,
  // which is out of scope (FR-002a) and pinned off with vertexai: false and enterprise: false in the adapter.
  GCLOUD_PROJECT: 'Vertex AI only',
  GOOGLE_APPLICATION_CREDENTIALS: 'Vertex AI only',
  GOOGLE_CLOUD_QUOTA_PROJECT: 'Vertex AI only',
  GOOGLE_API_CERTIFICATE_CONFIG: 'Vertex AI only',
  GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: 'Vertex AI only',
  GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE: 'Vertex AI only',
  GOOGLE_EXTERNAL_ACCOUNT_IMPERSONATED_EMAIL: 'Vertex AI only',
  GOOGLE_EXTERNAL_ACCOUNT_INTERACTIVE: 'Vertex AI only',
  GOOGLE_EXTERNAL_ACCOUNT_OUTPUT_FILE: 'Vertex AI only',
  GOOGLE_EXTERNAL_ACCOUNT_TOKEN_TYPE: 'Vertex AI only',
  // @google/genai: names of tool types and authentication kinds, not environment variables.
  GOOGLE_SERVICE_ACCOUNT_AUTH: 'a constant',
  GOOGLE_SEARCH_WEB: 'a constant',
  GOOGLE_SEARCH_IMAGE: 'a constant',
  GOOGLE_MAPS: 'a constant',
  // @aws-sdk/client-bedrock-runtime: property names of a generated model.
  AWS_ACCESS_KEY: 'a constant',
  AWS_SECRET_KEY: 'a constant',
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

function vendorVariables(): Map<string, string> {
  const names = new Map<string, string>();
  for (const [pkg, dir] of installedPackages()) {
    for (const file of jsFiles(dir)) {
      if (statSync(file).size > 5_000_000) continue;
      for (const match of readFileSync(file, 'utf8').matchAll(LITERAL)) {
        const name = match[1] as string;
        if (!names.has(name)) names.set(name, `${pkg}: ${basename(file)}`);
      }
    }
  }
  return names;
}

describe('the installed SDKs', () => {
  const packages = installedPackages();
  const names = vendorVariables();

  it('are found, with their dependencies', () => {
    for (const root of ROOTS) expect(packages.has(root), root).toBe(true);
    expect(packages.size).toBeGreaterThan(ROOTS.length);
  });

  it('read the vendor variables that are refused, and some exempt ones, so the scan is looking at the right thing', () => {
    expect(names.has('OPENAI_API_KEY')).toBe(true);
    expect(names.has('ANTHROPIC_BASE_URL')).toBe(true);
    expect(names.has('GEMINI_API_KEY')).toBe(true);
  });

  it('read no vendor variable that Scrylux neither refuses, nor exempts, nor can show is not read (FR-043a)', () => {
    const uncovered = [...names]
      .filter(([name]) => VENDOR.test(name) || name.endsWith('_'))
      .filter(([name]) => !refusesVariable(name, true) && !AWS_EXEMPT_VARIABLES.includes(name) && !(name in NOT_READ))
      .map(([name, where]) => `${name} (${where})`);
    expect(uncovered, `Decide each: refuse it in config.ts, exempt it as an AWS credential variable, or say in NOT_READ why it is not read`).toEqual([]);
  });

  it('has no stale entry in NOT_READ', () => {
    for (const name of Object.keys(NOT_READ)) expect(names.has(name), `${name} is not in any installed SDK any more: delete it`).toBe(true);
  });

  it('has no stale entry in the AWS exemption', () => {
    const stale = AWS_EXEMPT_VARIABLES.filter((name) => !names.has(name));
    expect(stale, 'not in any installed SDK any more: delete these from AWS_EXEMPT_VARIABLES').toEqual([]);
  });
});
