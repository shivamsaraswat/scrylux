import { describe, expect, it } from 'vitest';
import { SourceConfigError, checkSourceConfig, currentSourceConfig, parseSourceConfig } from '../../src/sources/config.js';

// The nine settings of sources and extraction (Phase 3 Milestone 3, contracts/configuration.md). The app and the worker
// parse all of them when they start, so a bad value stops either one with the variable's name and never its value
// (FR-009, FR-043, FR-052).

type Env = Record<string, string | undefined>;

const MB = 1024 * 1024;
const GB = 1024 * MB;

function problem(env: Env): string {
  try {
    parseSourceConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(SourceConfigError);
    return (error as Error).message;
  }
  throw new Error('expected the settings to be refused');
}

const ALL = [
  'SOURCE_MAX_MB',
  'SOURCES_PER_THREAT_MODEL',
  'INGESTION_JOBS_PER_ACCOUNT',
  'DOCUMENT_SPACE',
  'SOURCE_MAX_CHARS',
  'EXTRACT_TIME_LIMIT',
  'EXTRACT_MEMORY_MB',
  'EXTRACT_UNPACKED_MB',
  'EXTRACT_MAX_PAGES',
];

describe('the defaults', () => {
  const expected = {
    maxUploadBytes: 10 * MB,
    sourcesPerThreatModel: 20,
    ingestionJobsPerAccount: 20,
    documentSpaceBytes: 2 * GB,
    maxChars: 1_000_000,
    extractTimeLimitMs: 120_000,
    extractMemoryMb: 1024,
    extractUnpackedBytes: 50 * MB,
    extractMaxPages: 2000,
  };

  it('apply when nothing is set', () => {
    expect(parseSourceConfig({})).toEqual(expected);
  });

  it('apply to empty values, which an unset compose variable becomes', () => {
    expect(parseSourceConfig(Object.fromEntries(ALL.map((name) => [name, ''])))).toEqual(expected);
  });

  it('ignore variables that are not its own', () => {
    expect(parseSourceConfig({ PATH: '/bin', JOB_TOKEN_CAP: '5', STORAGE_DIR: 'x' })).toEqual(expected);
  });
});

describe('the accepted edges', () => {
  it.each([
    [{ SOURCE_MAX_MB: '1' }, { maxUploadBytes: MB }],
    [{ SOURCE_MAX_MB: '100' }, { maxUploadBytes: 100 * MB }],
    [{ SOURCES_PER_THREAT_MODEL: '1' }, { sourcesPerThreatModel: 1 }],
    [{ SOURCES_PER_THREAT_MODEL: '200' }, { sourcesPerThreatModel: 200 }],
    [{ INGESTION_JOBS_PER_ACCOUNT: '1' }, { ingestionJobsPerAccount: 1 }],
    [{ INGESTION_JOBS_PER_ACCOUNT: '1000' }, { ingestionJobsPerAccount: 1000 }],
    [{ DOCUMENT_SPACE: '100MB' }, { documentSpaceBytes: 100 * MB }],
    [{ DOCUMENT_SPACE: '10000GB' }, { documentSpaceBytes: 10_000 * GB }],
    [{ DOCUMENT_SPACE: '2048MB' }, { documentSpaceBytes: 2 * GB }],
    [{ DOCUMENT_SPACE: '5GB' }, { documentSpaceBytes: 5 * GB }],
    [{ SOURCE_MAX_CHARS: '1000' }, { maxChars: 1000 }],
    [{ SOURCE_MAX_CHARS: '10000000' }, { maxChars: 10_000_000 }],
    [{ EXTRACT_TIME_LIMIT: '10s' }, { extractTimeLimitMs: 10_000 }],
    [{ EXTRACT_TIME_LIMIT: '30m' }, { extractTimeLimitMs: 1_800_000 }],
    [{ EXTRACT_TIME_LIMIT: '2m' }, { extractTimeLimitMs: 120_000 }],
    [{ EXTRACT_MEMORY_MB: '128' }, { extractMemoryMb: 128 }],
    [{ EXTRACT_MEMORY_MB: '8192' }, { extractMemoryMb: 8192 }],
    [{ EXTRACT_UNPACKED_MB: '1' }, { extractUnpackedBytes: MB }],
    [{ EXTRACT_UNPACKED_MB: '1000' }, { extractUnpackedBytes: 1000 * MB }],
    [{ EXTRACT_MAX_PAGES: '1' }, { extractMaxPages: 1 }],
    [{ EXTRACT_MAX_PAGES: '100000' }, { extractMaxPages: 100_000 }],
  ])('%j gives %j', (env, expected) => {
    expect(parseSourceConfig(env)).toMatchObject(expected);
  });
});

describe('the refusals', () => {
  it.each([
    ['SOURCE_MAX_MB', ['0', '101', '-1', '1.5', '10MB', 'ten', ' 10', '1e1']],
    ['SOURCES_PER_THREAT_MODEL', ['0', '201', '-3', '2.5', 'many']],
    ['INGESTION_JOBS_PER_ACCOUNT', ['0', '1001', '-1', '3.0', 'lots']],
    ['DOCUMENT_SPACE', ['0', '0GB', '99MB', '10001GB', '-2GB', '2', '2gb', '2 GB', '2TB', '1.5GB', 'GB', '2GiB', '20000000MB']],
    ['SOURCE_MAX_CHARS', ['0', '999', '10000001', '-1', '1e6', '1,000,000']],
    ['EXTRACT_TIME_LIMIT', ['0s', '9s', '31m', '0', '120', '2h', '1.5m', '-1s', 'soon', '120S']],
    ['EXTRACT_MEMORY_MB', ['0', '127', '8193', '-1', '1G', '512MB']],
    ['EXTRACT_UNPACKED_MB', ['0', '1001', '-5', '50MB', 'big']],
    ['EXTRACT_MAX_PAGES', ['0', '100001', '-1', '2k', '1.5']],
  ])('%s refuses %j', (name, values) => {
    for (const value of values) {
      expect(problem({ [name]: value }), `${name}=${value}`).toContain(name);
    }
  });

  it('never repeats the value, however bad', () => {
    for (const name of ALL) {
      const message = problem({ [name]: 'SECRET-VALUE-9' });
      expect(message).toContain(name);
      expect(message).not.toContain('SECRET-VALUE-9');
      expect(message).not.toContain('SECRET');
    }
  });

  it('names the first problem in a fixed order, whatever order the environment lists its variables in', () => {
    const first = problem({ EXTRACT_MAX_PAGES: '0', SOURCE_MAX_MB: '0' });
    const second = problem({ SOURCE_MAX_MB: '0', EXTRACT_MAX_PAGES: '0' });
    expect(first).toBe(second);
    expect(first).toContain('SOURCE_MAX_MB');
  });
});

describe('checkSourceConfig', () => {
  it('returns the settings when they are right', () => {
    const result = checkSourceConfig({ SOURCE_MAX_MB: '5' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.maxUploadBytes).toBe(5 * MB);
  });

  it('returns a line that names the setting and never its value, for the start-up message', () => {
    const result = checkSourceConfig({ DOCUMENT_SPACE: 'BAD-VALUE' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.line).toMatch(/^Startup failed: DOCUMENT_SPACE /);
      expect(result.line).not.toContain('BAD-VALUE');
    }
  });
});

describe('currentSourceConfig', () => {
  it('reads the process environment', () => {
    const before = process.env.SOURCE_MAX_MB;
    try {
      process.env.SOURCE_MAX_MB = '7';
      expect(currentSourceConfig().maxUploadBytes).toBe(7 * MB);
    } finally {
      if (before === undefined) delete process.env.SOURCE_MAX_MB;
      else process.env.SOURCE_MAX_MB = before;
    }
  });

  it('falls back to the defaults on a bad value, because importing a module must never throw', () => {
    const before = process.env.SOURCE_MAX_MB;
    try {
      process.env.SOURCE_MAX_MB = 'not a number';
      expect(currentSourceConfig().maxUploadBytes).toBe(10 * MB);
    } finally {
      if (before === undefined) delete process.env.SOURCE_MAX_MB;
      else process.env.SOURCE_MAX_MB = before;
    }
  });
});
