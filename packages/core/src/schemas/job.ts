import { z } from 'zod';
import { timestamp, uuid } from '../fields.js';

// The records of the job routes (Phase 3 Milestone 2, specs/phase-3/milestone-2-worker-jobs/contracts/http-api.md).
// The API parses every success body with them, so a stray column is a server bug and not a leak, and the web app parses
// what it receives. Nothing here can hold a key, a base address, a prompt, an answer or a raw provider error (FR-051).
// Every object is strict.

export const JOB_KINDS = ['provider_check'] as const;
export const JobKind = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof JobKind>;

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const JobState = z.enum(JOB_STATES);
export type JobState = z.infer<typeof JobState>;
export const JOB_FINAL_STATES = ['succeeded', 'failed', 'cancelled'] as const satisfies readonly JobState[];

/**
 * Why a job failed: Milestone 1's categories, without `cancelled` (a cancel ends the job in the `cancelled` state), and
 * the job's own four (data-model.md "Failure categories").
 */
export const JOB_FAILURE_CATEGORIES = [
  'not_configured',
  'not_authorized',
  'not_available',
  'rate_limited',
  'provider_unavailable',
  'input_too_large',
  'output_limit_reached',
  'refused',
  'rejected',
  'invalid_output',
  'cap_reached',
  'timed_out',
  'worker_lost',
  'job_error',
] as const;
export const JobFailureCategory = z.enum(JOB_FAILURE_CATEGORIES);
export type JobFailureCategory = z.infer<typeof JobFailureCategory>;

/** The categories a job retries (FR-020): the provider was unavailable or limiting requests. */
export const JOB_TRANSIENT_CATEGORIES = ['provider_unavailable', 'rate_limited'] as const satisfies readonly JobFailureCategory[];

export const PROVIDER_NAMES = ['anthropic', 'openai-compatible', 'bedrock', 'gemini'] as const;
export const ProviderName = z.enum(PROVIDER_NAMES);
export type ProviderName = z.infer<typeof ProviderName>;

export const PROVIDER_CHECK_STEPS = ['generation', 'embeddings'] as const;
export const ProviderCheckStep = z.enum(PROVIDER_CHECK_STEPS);
export type ProviderCheckStep = z.infer<typeof ProviderCheckStep>;

const count = z.number().int().min(0);

export const JobProgress = z.strictObject({
  step: ProviderCheckStep,
  done: count.optional(),
  total: count.optional(),
});
export type JobProgress = z.infer<typeof JobProgress>;

export const JobUser = z.strictObject({ id: z.number().int(), username: z.string() });
export type JobUser = z.infer<typeof JobUser>;

export const JobFailure = z.strictObject({ category: JobFailureCategory, message: z.string(), hint: z.string() });
export type JobFailure = z.infer<typeof JobFailure>;

/** Summed from the job's usage records when it is read, never stored (FR-050). */
export const JobTotals = z.strictObject({
  requests: count,
  input_tokens: count,
  output_tokens: count,
  tokens_estimated: z.boolean(),
  /** Null when any request's price was unknown (FR-043). */
  cost_usd: z.number().min(0).nullable(),
  /** The sum of the costs that are known: the least the job cost. */
  cost_known_usd: z.number().min(0),
  cost_estimated: z.boolean(),
  /** False when any request's price was unknown, so the cost cap could not be applied to it (FR-043). */
  cost_cap_applied: z.boolean(),
  duration_ms: count,
});
export type JobTotals = z.infer<typeof JobTotals>;

export const JobRecord = z.strictObject({
  id: uuid,
  kind: JobKind,
  state: JobState,
  started_by: JobUser,
  cancelled_by: JobUser.nullable(),
  /** A cancel was asked of a job that is still running. */
  cancel_requested: z.boolean(),
  /** The job is running, but its worker has stopped reporting: computed when read (FR-062). */
  worker_lost: z.boolean(),
  queued_at: timestamp,
  started_at: timestamp.nullable(),
  finished_at: timestamp.nullable(),
  /** Set only while the job is queued and waiting for a next run. */
  next_run_at: timestamp.nullable(),
  deadline_at: timestamp.nullable(),
  run: count,
  max_runs: z.number().int().min(1),
  caps: z.strictObject({ tokens: z.number().int().min(1), cost_usd: z.number().positive() }),
  progress: JobProgress.nullable(),
  failure: JobFailure.nullable(),
  totals: JobTotals,
});
export type JobRecord = z.infer<typeof JobRecord>;

export const USAGE_OUTCOMES = [
  'ok',
  'not_configured',
  'not_authorized',
  'not_available',
  'rate_limited',
  'provider_unavailable',
  'input_too_large',
  'output_limit_reached',
  'refused',
  'rejected',
  'invalid_output',
  'cancelled',
] as const;

/** Milestone 1's usage record of one model request, with the row's id and the run that made it. */
export const JobUsageRecord = z.strictObject({
  id: z.number().int(),
  run: z.number().int().min(1),
  operation: z.enum(['generate', 'embed']),
  provider: ProviderName,
  model: z.string(),
  outcome: z.enum(USAGE_OUTCOMES),
  attempts: count,
  input_tokens: count,
  output_tokens: count,
  tokens_estimated: z.boolean(),
  cost_usd: z.number().min(0).nullable(),
  cost_estimated: z.boolean(),
  price_source: z.enum(['operator', 'list', 'none']),
  temperature_applied: z.boolean().nullable(),
  duration_ms: count,
  recorded_at: timestamp,
});
export type JobUsageRecord = z.infer<typeof JobUsageRecord>;

/** How one operation of a provider check ended. `not_run` is an operation the job never reached. */
export const PROVIDER_CHECK_STATUSES = ['ok', 'not_run', 'cancelled', ...JOB_FAILURE_CATEGORIES] as const;
export const ProviderCheckStatus = z.enum(PROVIDER_CHECK_STATUSES);
export type ProviderCheckStatus = z.infer<typeof ProviderCheckStatus>;

/** No key and no base address (FR-091). `message` and `hint` are added when the job is read. */
export const ProviderCheckOperation = z.strictObject({
  status: ProviderCheckStatus,
  provider: ProviderName.optional(),
  model: z.string().optional(),
  hosted: z.boolean().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
  usage_id: z.number().int().optional(),
});
export type ProviderCheckOperation = z.infer<typeof ProviderCheckOperation>;

export const ProviderCheckResult = z.strictObject({ generation: ProviderCheckOperation, embeddings: ProviderCheckOperation });
export type ProviderCheckResult = z.infer<typeof ProviderCheckResult>;

export const JobDetail = JobRecord.extend({
  usage: JobUsageRecord.array(),
  result: ProviderCheckResult.nullable(),
});
export type JobDetail = z.infer<typeof JobDetail>;

export const JobList = z.strictObject({ jobs: JobRecord.array(), has_more: z.boolean() });
export type JobList = z.infer<typeof JobList>;

const operationStatus = z.strictObject({ provider: ProviderName, model: z.string(), hosted: z.boolean() }).nullable();

/** What the Jobs page needs besides the list (FR-008, FR-044, FR-045, FR-047, FR-063). No key and no address. */
export const JobsStatus = z.strictObject({
  worker_alive: z.boolean(),
  ai: z.strictObject({ generation: operationStatus, embedding: operationStatus }),
  provider_check: z.strictObject({ offered: z.boolean(), next_allowed_at: timestamp.nullable() }),
});
export type JobsStatus = z.infer<typeof JobsStatus>;

// A provider check takes no input from the person who starts it (FR-093). The caps, runs and time limit are the
// operator's, copied onto the job by the server, so none of them can be set here (FR-045): every object is strict.
export const JobCreateInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('provider_check'), input: z.strictObject({}).default({}) }),
]);
export type JobCreateInput = z.infer<typeof JobCreateInput>;

// The query of the list: one fixed message for every problem, which never repeats what the client sent, as ReportQuery.
const LIST_MESSAGE = 'limit must be a whole number from 1 to 100, and offset a whole number of 0 or more';

export const JobListQuery = z.strictObject(
  {
    limit: z.coerce.number({ error: LIST_MESSAGE }).int({ error: LIST_MESSAGE }).min(1, { error: LIST_MESSAGE }).max(100, { error: LIST_MESSAGE }).default(25),
    offset: z.coerce.number({ error: LIST_MESSAGE }).int({ error: LIST_MESSAGE }).min(0, { error: LIST_MESSAGE }).default(0),
  },
  { error: LIST_MESSAGE },
);
export type JobListQuery = z.infer<typeof JobListQuery>;
