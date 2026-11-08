// The two settings of extraction (Phase 3 Milestone 4, specs/phase-3/milestone-4-system-extraction/contracts/configuration.md).
// Both the app and the worker parse both when they start, so a bad value stops either one. A message names the variable and the
// rule and never repeats the value (FR-010), so it is safe to log.

class ExtractionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionConfigError';
  }
}

export { ExtractionConfigError };

export interface ExtractionConfig {
  /** FR-010. EXTRACTION_CONTEXT_CHARS: the most chunk text one extraction sends. */
  contextChars: number;
  /** Research #9. EXTRACTION_MAX_OUTPUT_TOKENS: the output limit of the extraction request. */
  maxOutputTokens: number;
}

type Env = Readonly<Record<string, string | undefined>>;

const set = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
};

/** A whole number from `min` to `max`, or the default when the variable is unset or empty. */
function wholeNumber(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = set(env, name);
  if (raw === undefined) return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new ExtractionConfigError(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

/**
 * Reads the extraction settings from an environment, and throws an ExtractionConfigError for the first problem, in a fixed order.
 * The defaults are sized together (research #5, FR-016): 36,000 characters of chunk text and 12,000 output tokens fit one request in
 * a 32,768-token context with room to spare, and the worst case of five calls fits the default job caps. A test holds both.
 */
export function parseExtractionConfig(env: Env): ExtractionConfig {
  return {
    contextChars: wholeNumber(env, 'EXTRACTION_CONTEXT_CHARS', 36_000, 2000, 2_000_000),
    maxOutputTokens: wholeNumber(env, 'EXTRACTION_MAX_OUTPUT_TOKENS', 12_000, 1000, 32_000),
  };
}

/**
 * The settings of this process, read from its environment each time (it is cheap). A bad value falls back to the defaults here,
 * because importing a module must never throw; `server.ts` and `worker.ts` validate the environment at start with
 * checkExtractionConfig and refuse to start, so a request never sees the fallback.
 */
export function currentExtractionConfig(): ExtractionConfig {
  try {
    return parseExtractionConfig(process.env);
  } catch {
    return parseExtractionConfig({});
  }
}

export type ExtractionConfigCheck = { ok: true; config: ExtractionConfig } | { ok: false; line: string };

/**
 * The start-up check of the app and the worker: the settings, or a fixed line that names the setting and never its value. The
 * message of an ExtractionConfigError is built from variable names and rules only, so it is safe to log.
 */
export function checkExtractionConfig(env: Env): ExtractionConfigCheck {
  try {
    return { ok: true, config: parseExtractionConfig(env) };
  } catch (error) {
    if (!(error instanceof ExtractionConfigError)) throw error;
    return { ok: false, line: `Startup failed: ${error.message}` };
  }
}
