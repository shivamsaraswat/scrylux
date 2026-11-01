// The nine settings of sources and extraction (Phase 3 Milestone 3, specs/phase-3/milestone-3-ingestion/contracts/configuration.md).
// Both the app and the worker parse all of them when they start, so a bad value stops either one. A message names the
// variable and the rule and never repeats the value (FR-009, FR-043, FR-052), so it is safe to log.

// Exported for tests: tests check the error class.
export class SourceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceConfigError';
  }
}

export interface SourceConfig {
  /** FR-004. SOURCE_MAX_MB. */
  maxUploadBytes: number;
  /** FR-005. */
  sourcesPerThreatModel: number;
  /** FR-043: ingestion jobs an account may have queued or running, apart from Milestone 2's limit. */
  ingestionJobsPerAccount: number;
  /** FR-009: the install-wide cap on what sources store. */
  documentSpaceBytes: number;
  /** FR-005: the longest extracted text of one source, in characters (code points). */
  maxChars: number;
  /** FR-011: the bounds of reading one file. */
  extractTimeLimitMs: number;
  extractMemoryMb: number;
  extractUnpackedBytes: number;
  extractMaxPages: number;
}

type Env = Readonly<Record<string, string | undefined>>;

const MB = 1024 * 1024;
const GB = 1024 * MB;

const set = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
};

/** A whole number from `min` to `max`, or the default when the variable is unset or empty. */
function wholeNumber(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = set(env, name);
  if (raw === undefined) return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new SourceConfigError(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

/** A whole number and MB or GB, in bytes, from 100MB to 10000GB. */
function documentSpace(env: Env): number {
  const raw = set(env, 'DOCUMENT_SPACE');
  if (raw === undefined) return 2 * GB;
  const match = /^(\d+)(MB|GB)$/.exec(raw);
  const bytes = match ? Number(match[1]) * (match[2] === 'GB' ? GB : MB) : Number.NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 100 * MB || bytes > 10_000 * GB) {
    throw new SourceConfigError('DOCUMENT_SPACE must be a whole number followed by MB or GB, from 100MB to 10000GB');
  }
  return bytes;
}

/** A whole number and s or m, in milliseconds, from 10s to 30m. */
function extractTimeLimit(env: Env): number {
  const raw = set(env, 'EXTRACT_TIME_LIMIT');
  if (raw === undefined) return 120_000;
  const match = /^(\d+)([sm])$/.exec(raw);
  const ms = match ? Number(match[1]) * (match[2] === 'm' ? 60_000 : 1000) : Number.NaN;
  if (!Number.isSafeInteger(ms) || ms < 10_000 || ms > 1_800_000) {
    throw new SourceConfigError('EXTRACT_TIME_LIMIT must be a whole number followed by s or m (seconds, minutes), from 10s to 30m');
  }
  return ms;
}

/** Reads the source settings from an environment, and throws a SourceConfigError for the first problem, in a fixed order. */
export function parseSourceConfig(env: Env): SourceConfig {
  return {
    maxUploadBytes: wholeNumber(env, 'SOURCE_MAX_MB', 10, 1, 100) * MB,
    sourcesPerThreatModel: wholeNumber(env, 'SOURCES_PER_THREAT_MODEL', 20, 1, 200),
    ingestionJobsPerAccount: wholeNumber(env, 'INGESTION_JOBS_PER_ACCOUNT', 20, 1, 1000),
    documentSpaceBytes: documentSpace(env),
    maxChars: wholeNumber(env, 'SOURCE_MAX_CHARS', 1_000_000, 1000, 10_000_000),
    extractTimeLimitMs: extractTimeLimit(env),
    // Measured (Phase 3 Milestone 3): memory follows the size of the file. A 10 MB PDF, the largest an upload may be, needs about 640 MB
    // however little text it holds; a Word file of a million characters about 320 MB. 1024 leaves room for both.
    extractMemoryMb: wholeNumber(env, 'EXTRACT_MEMORY_MB', 1024, 128, 8192),
    extractUnpackedBytes: wholeNumber(env, 'EXTRACT_UNPACKED_MB', 50, 1, 1000) * MB,
    extractMaxPages: wholeNumber(env, 'EXTRACT_MAX_PAGES', 2000, 1, 100_000),
  };
}

/**
 * The settings of this process, read from its environment each time (it is cheap). A bad value falls back to the defaults
 * here, because importing a module must never throw; `server.ts` and `worker.ts` validate the environment at start with
 * parseSourceConfig and refuse to start, so a request never sees the fallback.
 */
export function currentSourceConfig(): SourceConfig {
  try {
    return parseSourceConfig(process.env);
  } catch {
    return parseSourceConfig({});
  }
}

export type SourceConfigCheck = { ok: true; config: SourceConfig } | { ok: false; line: string };

/**
 * The start-up check of the app and the worker: the settings, or a fixed line that names the setting and never its value.
 * The message of a SourceConfigError is built from variable names and rules only, so it is safe to log.
 */
export function checkSourceConfig(env: Env): SourceConfigCheck {
  try {
    return { ok: true, config: parseSourceConfig(env) };
  } catch (error) {
    if (!(error instanceof SourceConfigError)) throw error;
    return { ok: false, line: `Startup failed: ${error.message}` };
  }
}
