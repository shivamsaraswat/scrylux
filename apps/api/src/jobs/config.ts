// The eight job settings (Phase 3 Milestone 2, specs/phase-3/milestone-2-worker-jobs/contracts/configuration.md).
// Both the API and the worker parse all of them when they start, so a bad value stops either one. A message names the
// variable and the rule and never repeats the value (FR-004, FR-040, SC-009), so it is safe to log.

export class JobConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobConfigError';
  }
}

export interface JobConfig {
  /** Copied onto each job when the API queues it (FR-040, FR-045). */
  tokenCap: number;
  costCapUsd: number;
  maxRuns: number;
  timeLimitMs: number;
  /** FR-046. */
  jobsPerAccount: number;
  /** FR-047. Zero turns it off. */
  providerCheckCooldownMs: number;
  /** FR-006. */
  workerConcurrency: number;
  /** FR-010. */
  workerHealthPort: number;
}

type Env = Readonly<Record<string, string | undefined>>;

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;
const DAY_MS = 24 * UNIT_MS.h;

const set = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
};

/** A whole number from `min` to `max`, or the default when the variable is unset or empty. */
function wholeNumber(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = set(env, name);
  if (raw === undefined) return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new JobConfigError(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

/** US dollars: above zero, at most 6 decimal places, at most `max`. */
function dollars(env: Env, name: string, fallback: number, max: number): number {
  const raw = set(env, name);
  if (raw === undefined) return fallback;
  const n = /^\d+(\.\d{1,6})?$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(n > 0) || n > max) {
    throw new JobConfigError(`${name} must be a number of US dollars above 0 and at most ${max}, with at most 6 decimal places`);
  }
  return n;
}

/** A whole number and `s`, `m` or `h`, in milliseconds, or null when the text is not one or is out of range. */
function duration(raw: string, minMs: number, maxMs: number): number | null {
  const match = /^(\d+)([smh])$/.exec(raw);
  const ms = match ? Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS] : Number.NaN;
  return Number.isSafeInteger(ms) && ms >= minMs && ms <= maxMs ? ms : null;
}

function timeLimit(env: Env): number {
  const raw = set(env, 'JOB_TIME_LIMIT');
  if (raw === undefined) return 60 * UNIT_MS.m;
  const ms = duration(raw, UNIT_MS.m, DAY_MS);
  if (ms === null) throw new JobConfigError('JOB_TIME_LIMIT must be a whole number followed by s, m or h (seconds, minutes, hours), from 1m to 24h');
  return ms;
}

function cooldown(env: Env): number {
  const raw = set(env, 'PROVIDER_CHECK_COOLDOWN');
  if (raw === undefined) return 5 * UNIT_MS.m;
  if (raw === '0') return 0;
  const ms = duration(raw, 1000, DAY_MS);
  if (ms === null) {
    throw new JobConfigError('PROVIDER_CHECK_COOLDOWN must be 0 to turn it off, or a whole number followed by s, m or h (seconds, minutes, hours), up to 24h');
  }
  return ms;
}

/** Reads the job settings from an environment, and throws a JobConfigError for the first problem, in a fixed order. */
export function parseJobConfig(env: Env): JobConfig {
  return {
    tokenCap: wholeNumber(env, 'JOB_TOKEN_CAP', 500_000, 1, 1_000_000_000),
    costCapUsd: dollars(env, 'JOB_COST_CAP', 5, 10_000),
    maxRuns: wholeNumber(env, 'JOB_MAX_RUNS', 3, 1, 5),
    timeLimitMs: timeLimit(env),
    jobsPerAccount: wholeNumber(env, 'JOBS_PER_ACCOUNT', 3, 1, 100),
    providerCheckCooldownMs: cooldown(env),
    workerConcurrency: wholeNumber(env, 'WORKER_CONCURRENCY', 1, 1, 32),
    workerHealthPort: wholeNumber(env, 'WORKER_HEALTH_PORT', 3001, 1, 65_535),
  };
}

/**
 * The settings of this process, read from its environment each time (it is cheap). A bad value falls back to the
 * defaults here, because importing a module must never throw; `server.ts` and `worker.ts` validate the environment at
 * start with parseJobConfig and refuse to start, so a request never sees the fallback.
 */
export function currentJobConfig(): JobConfig {
  try {
    return parseJobConfig(process.env);
  } catch {
    return parseJobConfig({});
  }
}

export type JobConfigCheck = { ok: true; config: JobConfig } | { ok: false; line: string };

/**
 * The start-up check of the API and the worker: the settings, or a fixed line that names the setting and never its value
 * (FR-004, FR-040, SC-009). The message of a JobConfigError is built from variable names and rules only, so it is safe to log.
 */
export function checkJobConfig(env: Env): JobConfigCheck {
  try {
    return { ok: true, config: parseJobConfig(env) };
  } catch (error) {
    if (!(error instanceof JobConfigError)) throw error;
    return { ok: false, line: `Startup failed: ${error.message}` };
  }
}
