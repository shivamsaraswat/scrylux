import { describe, expect, it } from 'vitest';
import { JobConfigError, parseJobConfig } from '../../src/jobs/config.js';

// The eight job settings (Phase 3 Milestone 2, contracts/configuration.md). Both the API and the worker parse all of
// them at start, so a bad value stops either one with the variable's name and never its value (FR-004, FR-040, SC-009).

type Env = Record<string, string | undefined>;

function problem(env: Env): string {
  try {
    parseJobConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(JobConfigError);
    return (error as Error).message;
  }
  throw new Error('expected the settings to be refused');
}

describe('the defaults', () => {
  const expected = {
    tokenCap: 500_000,
    costCapUsd: 5,
    maxRuns: 3,
    timeLimitMs: 3_600_000,
    jobsPerAccount: 3,
    providerCheckCooldownMs: 300_000,
    workerConcurrency: 1,
    workerHealthPort: 3001,
  };

  it('applies when nothing is set', () => {
    expect(parseJobConfig({})).toEqual(expected);
  });

  it('applies to empty values, which an unset compose variable becomes', () => {
    const empty = Object.fromEntries(
      ['JOB_TOKEN_CAP', 'JOB_COST_CAP', 'JOB_MAX_RUNS', 'JOB_TIME_LIMIT', 'JOBS_PER_ACCOUNT', 'PROVIDER_CHECK_COOLDOWN', 'WORKER_CONCURRENCY', 'WORKER_HEALTH_PORT'].map((n) => [n, '']),
    );
    expect(parseJobConfig(empty)).toEqual(expected);
  });

  it('ignores variables that are not its own', () => {
    expect(parseJobConfig({ PATH: '/bin', LLM_PROVIDER: 'anthropic' })).toEqual(expected);
  });
});

describe('the accepted edges', () => {
  it.each([
    [{ JOB_TOKEN_CAP: '1' }, { tokenCap: 1 }],
    [{ JOB_TOKEN_CAP: '1000000000' }, { tokenCap: 1_000_000_000 }],
    [{ JOB_COST_CAP: '0.000001' }, { costCapUsd: 0.000001 }],
    [{ JOB_COST_CAP: '10000' }, { costCapUsd: 10_000 }],
    [{ JOB_COST_CAP: '2.5' }, { costCapUsd: 2.5 }],
    [{ JOB_MAX_RUNS: '1' }, { maxRuns: 1 }],
    [{ JOB_MAX_RUNS: '5' }, { maxRuns: 5 }],
    [{ JOB_TIME_LIMIT: '1m' }, { timeLimitMs: 60_000 }],
    [{ JOB_TIME_LIMIT: '90s' }, { timeLimitMs: 90_000 }],
    [{ JOB_TIME_LIMIT: '24h' }, { timeLimitMs: 86_400_000 }],
    [{ JOB_TIME_LIMIT: '1440m' }, { timeLimitMs: 86_400_000 }],
    [{ JOBS_PER_ACCOUNT: '1' }, { jobsPerAccount: 1 }],
    [{ JOBS_PER_ACCOUNT: '100' }, { jobsPerAccount: 100 }],
    [{ PROVIDER_CHECK_COOLDOWN: '0' }, { providerCheckCooldownMs: 0 }],
    [{ PROVIDER_CHECK_COOLDOWN: '30s' }, { providerCheckCooldownMs: 30_000 }],
    [{ PROVIDER_CHECK_COOLDOWN: '24h' }, { providerCheckCooldownMs: 86_400_000 }],
    [{ WORKER_CONCURRENCY: '32' }, { workerConcurrency: 32 }],
    [{ WORKER_HEALTH_PORT: '1' }, { workerHealthPort: 1 }],
    [{ WORKER_HEALTH_PORT: '65535' }, { workerHealthPort: 65_535 }],
  ] as [Env, Record<string, number>][])('accepts %o', (env, changed) => {
    expect(parseJobConfig(env)).toMatchObject(changed);
  });
});

describe('the refusals', () => {
  // Each value is distinctive, so a message that repeated it would be caught below.
  const BAD: [string, string][] = [
    ['JOB_TOKEN_CAP', '0'],
    ['JOB_TOKEN_CAP', '-5'],
    ['JOB_TOKEN_CAP', '1000000001'],
    ['JOB_TOKEN_CAP', '12.5'],
    ['JOB_TOKEN_CAP', '12k'],
    ['JOB_TOKEN_CAP', 'lots'],
    ['JOB_COST_CAP', '0'],
    ['JOB_COST_CAP', '0.0000001'],
    ['JOB_COST_CAP', '-1'],
    ['JOB_COST_CAP', '10000.01'],
    ['JOB_COST_CAP', '$5'],
    ['JOB_COST_CAP', '1e3'],
    ['JOB_MAX_RUNS', '0'],
    ['JOB_MAX_RUNS', '6'],
    ['JOB_MAX_RUNS', '2.5'],
    ['JOB_MAX_RUNS', 'many'],
    ['JOB_TIME_LIMIT', '30s'],
    ['JOB_TIME_LIMIT', '59s'],
    ['JOB_TIME_LIMIT', '25h'],
    ['JOB_TIME_LIMIT', '1d'],
    ['JOB_TIME_LIMIT', '0m'],
    ['JOB_TIME_LIMIT', '60'],
    ['JOB_TIME_LIMIT', 'an hour'],
    ['JOBS_PER_ACCOUNT', '0'],
    ['JOBS_PER_ACCOUNT', '101'],
    ['JOBS_PER_ACCOUNT', '-3'],
    ['PROVIDER_CHECK_COOLDOWN', '-1'],
    ['PROVIDER_CHECK_COOLDOWN', '25h'],
    ['PROVIDER_CHECK_COOLDOWN', '5'],
    ['PROVIDER_CHECK_COOLDOWN', '1d'],
    ['PROVIDER_CHECK_COOLDOWN', '0m'],
    ['WORKER_CONCURRENCY', '0'],
    ['WORKER_CONCURRENCY', '33'],
    ['WORKER_CONCURRENCY', '1.5'],
    ['WORKER_HEALTH_PORT', '0'],
    ['WORKER_HEALTH_PORT', '65536'],
    ['WORKER_HEALTH_PORT', 'http'],
  ];

  it.each(BAD)('refuses %s=%s, naming the variable and not the value', (name, value) => {
    const message = problem({ [name]: value });
    expect(message).toContain(name);
    expect(message).not.toContain(`=${value}`);
    // A value of two or more characters is not echoed in any form.
    if (value.length > 3) expect(message).not.toContain(value);
  });

  it('names the variable in front of any other problem when two are bad, in a fixed order', () => {
    expect(problem({ WORKER_HEALTH_PORT: 'x', JOB_TOKEN_CAP: 'x' })).toContain('JOB_TOKEN_CAP');
  });

  it('states the rule in the message', () => {
    expect(problem({ JOB_MAX_RUNS: '9' })).toBe('JOB_MAX_RUNS must be a whole number from 1 to 5');
    expect(problem({ PROVIDER_CHECK_COOLDOWN: '2d' })).toContain('0 to turn it off');
  });
});
