import type { z } from 'zod';
import type { Adapter, GenerateInput } from './adapters/types.js';
import { nextFormatMode, rememberRefusal, resolveCapability } from './capabilities.js';
import { fillPlaceholders, loadPrompt } from './data.js';
import { AdapterError, type FailureCategory, type RejectedParam } from './errors.js';
import { parseAnswer, type JsonSchema } from './schema.js';
import type { ProviderName } from './types.js';

// The attempt loop (research #9). One loop per request, in the layer and not in an adapter, so the rules are the same
// for every provider: schema attempts (FR-014), transient retries (FR-022), free resends when a model refuses a
// setting, the time limit of each call (FR-010) and cancellation (FR-023).

const MAX_TRANSIENT_RETRIES = 2;
const BASE_WAITS_MS = [1000, 2000] as const;
const JITTER = 0.25;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_ISSUES = 20;

export interface LoopRequest<T> {
  provider: ProviderName;
  model: string;
  schema: z.ZodType<T>;
  schemaName: string;
  system: string;
  user: string;
  /** The schema as the provider is sent it (sanitized). */
  jsonSchema: JsonSchema;
  /** OpenAI-compatible only. */
  strict?: boolean;
  /** The schema as the model is told it in the instructions, when the provider is only asked for JSON. */
  instructionSchema: JsonSchema;
  maxOutputTokens: number;
  attemptLimit: number;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

/** One call to the provider, as the usage record needs it. */
export interface CallRecord {
  /** As the provider reported it; undefined when it did not. */
  inputTokens?: number;
  outputTokens?: number;
  /** The size of what was sent and of what came back, so that missing tokens can be estimated (FR-032). */
  inputChars: number;
  outputChars: number;
  temperature: 0 | undefined;
  /** True when the provider answered. A call that failed first, such as a rate limit, used no tokens we know of. */
  answered: boolean;
}

export type LoopOutcome<T> = { ok: true; value: T } | { ok: false; category: FailureCategory; index?: number };

export interface LoopResult<T> {
  outcome: LoopOutcome<T>;
  calls: CallRecord[];
  /** Schema attempts plus transient retries. Free resends are not counted. */
  attempts: number;
  /** True when every call was sent with the fixed temperature of 0. */
  temperatureApplied: boolean;
}

export interface LoopDeps {
  /** Waits for `ms`, or until `signal` fires. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** A number in [0, 1) for the jitter. */
  random: () => number;
}

export const defaultDeps: LoopDeps = {
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    }),
  random: Math.random,
};

/**
 * How long to wait before the next transient retry, or why not to retry. Shared by generation and embeddings, so one
 * rule bounds both (FR-022): at most two retries per request, after 1 s and 2 s plus up to a quarter more; a provider's
 * retry-after replaces the wait when it is longer, up to a minute, and a longer ask fails the request as rate limited.
 */
export function planRetry(retriesUsed: number, retryAfterMs: number | undefined, random: () => number): { waitMs: number } | { giveUp: true; category?: 'rate_limited' } {
  if (retriesUsed >= MAX_TRANSIENT_RETRIES) return { giveUp: true };
  if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) return { giveUp: true, category: 'rate_limited' };
  const base = BASE_WAITS_MS[retriesUsed] as number;
  return { waitMs: Math.max(base * (1 + JITTER * random()), retryAfterMs ?? 0) };
}

/** Rejects as soon as `signal` fires, even if the adapter never settles. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const onAbort = (): void => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('adapter failed'));
      },
    );
  });
}

/** The problems with an answer, by path. It names what was wrong and never quotes what was received. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, MAX_ISSUES)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : 'the answer';
      const text =
        issue.code === 'invalid_value' && 'values' in issue
          ? `must be one of ${issue.values.map((v) => JSON.stringify(v)).join(', ')}`
          : issue.message;
      return `- ${path}: ${text}`;
    })
    .join('\n');
}

export async function runGenerate<T>(adapter: Adapter, req: LoopRequest<T>, deps: LoopDeps = defaultDeps): Promise<LoopResult<T>> {
  const capability = resolveCapability(req.provider, req.model);
  let mode = capability.structuredOutput;
  let temperature: 0 | undefined = capability.temperature === 'send' ? 0 : undefined;
  let maxTokensParam = capability.maxTokensParam;

  const calls: CallRecord[] = [];
  let attempts = 0;
  let schemaAttempts = 0;
  let transientRetries = 0;
  let retryNote: string | undefined;
  let temperatureResent = false;

  const finish = (outcome: LoopOutcome<T>): LoopResult<T> => ({
    outcome,
    calls,
    attempts,
    temperatureApplied: calls.length > 0 && calls.every((c) => c.temperature === 0),
  });
  const fail = (category: FailureCategory, index?: number): LoopResult<T> =>
    finish(index === undefined ? { ok: false, category } : { ok: false, category, index });

  // Asks for JSON in the instructions when the provider is not (or no longer) given a native schema.
  const instructions = (): string =>
    fillPlaceholders(loadPrompt('json-instructions.md'), { schema: JSON.stringify(req.instructionSchema, null, 2) }).trim();

  /** Handles a provider's refusal of one setting. Returns false when it cannot be worked around. */
  const resend = (param: RejectedParam): boolean => {
    if (param === 'temperature') {
      if (temperature === undefined || temperatureResent) return false;
      temperatureResent = true;
      temperature = undefined;
    } else if (param === 'max_tokens') {
      if (req.provider !== 'openai-compatible' || maxTokensParam === 'max_completion_tokens') return false;
      maxTokensParam = 'max_completion_tokens';
    } else {
      const next = nextFormatMode(req.provider, mode);
      if (next === undefined) return false;
      mode = next;
    }
    rememberRefusal(req.provider, req.model, param);
    return true;
  };

  for (;;) {
    if (req.signal?.aborted) return fail('cancelled');

    const system = mode === 'native' ? req.system : `${req.system}\n\n${instructions()}`;
    const input: GenerateInput = {
      system,
      user: req.user,
      ...(retryNote === undefined ? {} : { retryNote }),
      jsonSchema: req.jsonSchema,
      ...(req.strict === undefined ? {} : { strict: req.strict }),
      schemaName: req.schemaName,
      maxOutputTokens: req.maxOutputTokens,
      temperature,
      mode,
      maxTokensParam,
      timeoutMs: req.timeoutMs,
      signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs)]) : AbortSignal.timeout(req.timeoutMs),
    };
    const record: CallRecord = {
      inputChars: system.length + req.user.length + (retryNote?.length ?? 0),
      outputChars: 0,
      temperature,
      answered: false,
    };

    let outcome;
    try {
      outcome = await raceAbort(adapter.generateOnce(input), input.signal);
    } catch (error) {
      const known = error instanceof AdapterError ? error : undefined;
      if (known?.inputTokens !== undefined) record.inputTokens = known.inputTokens;
      if (known?.outputTokens !== undefined) record.outputTokens = known.outputTokens;
      calls.push(record);

      if (req.signal?.aborted) {
        attempts++;
        return fail('cancelled');
      }
      // The time limit fired while the caller was still waiting, whatever the adapter threw.
      const timedOut = input.signal.aborted;
      let category: FailureCategory = timedOut ? 'provider_unavailable' : (known?.category ?? 'provider_unavailable');

      if (!timedOut && known?.rejectedParam !== undefined) {
        if (resend(known.rejectedParam)) continue; // a free resend: not an attempt
        category = 'rejected';
      }

      attempts++;
      if (category !== 'rate_limited' && category !== 'provider_unavailable') return fail(category, known?.index);

      const plan = planRetry(transientRetries, known?.retryAfterMs, deps.random);
      if ('giveUp' in plan) return fail(plan.category ?? category);
      transientRetries++;
      await deps.sleep(plan.waitMs, req.signal);
      continue;
    }

    attempts++;
    record.answered = true;
    if (outcome.inputTokens !== undefined) record.inputTokens = outcome.inputTokens;
    if (outcome.outputTokens !== undefined) record.outputTokens = outcome.outputTokens;
    if (outcome.kind === 'answer') record.outputChars = outcome.text.length;
    calls.push(record);

    if (outcome.kind !== 'answer') return fail(outcome.kind === 'cut_off' ? 'output_limit_reached' : 'refused');

    const parsed = parseAnswer(outcome.text, mode);
    const checked = parsed === undefined ? undefined : req.schema.safeParse(parsed);
    if (checked?.success) return finish({ ok: true, value: checked.data });

    schemaAttempts++;
    if (schemaAttempts >= req.attemptLimit) return fail('invalid_output');
    const issues = checked === undefined ? '- the answer: it is not valid JSON' : describeIssues(checked.error);
    retryNote = fillPlaceholders(loadPrompt('schema-retry.md'), { issues }).trim();
  }
}
