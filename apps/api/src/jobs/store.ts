import type {
  JobDetail,
  JobFailureCategory,
  JobKind,
  JobProgress,
  JobRecord,
  JobState,
  JobUsageRecord,
  JsonValue,
  ProviderCheckOperation,
  ProviderCheckResult,
} from '@scrylux/core';
import type { Database } from '@scrylux/db';
import { FAILURE_MESSAGES, type Usage } from '@scrylux/llm';
import { sql, type Kysely } from 'kysely';
import type { JobConfig } from './config.js';
import { describeFailure, providerHint, type Prefix } from './failures.js';

// Everything the API and the worker do to the jobs tables (Phase 3 Milestone 2, research #3, #4). Every statement is
// parameterized. Every time is the database's now(), never a host's clock, so workers on hosts whose clocks disagree still
// agree on leases and deadlines. Every write a worker makes to a job is fenced by `claim`: the number a claim hands out
// and nothing but a claim changes, so a worker that lost its lease cannot write after another has taken the job over.

type Db = Kysely<Database>;
type JsonObject = Record<string, JsonValue>;

/** The settings the API copies onto a job, and checks, when it queues one. */
export type JobSettings = Pick<
  JobConfig,
  'tokenCap' | 'costCapUsd' | 'maxRuns' | 'timeLimitMs' | 'jobsPerAccount' | 'providerCheckCooldownMs'
>;

/** What a worker holds while it runs a job: the job and the number of the claim that took it. */
export interface Held {
  id: string;
  claim: number;
}

export interface ClaimedJob extends Held {
  kind: JobKind;
  input: JsonObject;
  /** The run that has just started: 1 for the first. */
  run: number;
  maxRuns: number;
  tokenCap: number;
  costCapUsd: number;
}

/** How a run ended. The state a job is left in follows from it, and from whether a cancel was asked (research #4). */
export type RunOutcome =
  | { kind: 'succeeded'; result?: JsonObject }
  | { kind: 'failed'; category: JobFailureCategory; detail?: 'cap_below_one_request'; result?: JsonObject }
  /** A failure that may pass (FR-020): the job runs again after a wait while it has runs left, and fails otherwise. */
  | { kind: 'transient'; category: 'provider_unavailable' | 'rate_limited'; result?: JsonObject }
  | { kind: 'cancelled'; result?: JsonObject };

const FINAL_STATES: readonly JobState[] = ['succeeded', 'failed', 'cancelled'];
export const isFinal = (state: JobState): boolean => FINAL_STATES.includes(state);

// ---- Starting, reading ------------------------------------------------------------------------------------------------

/**
 * A start that the limits refuse (FR-046, FR-047): too many active jobs, or too soon after the last provider check. The
 * message is fixed text built from the settings and the clock, never from the request, and it says when to try again.
 */
export class JobLimitError extends Error {
  constructor(
    readonly reason: 'limit' | 'cooldown',
    readonly retryAfterSeconds: number,
    message: string,
  ) {
    super(message);
    this.name = 'JobLimitError';
  }
}

// The first key of the two-integer advisory lock a start takes on its account. The migrator uses the one-integer form with
// its own key, and Postgres keeps the two key spaces apart, so no account id can collide with a migration.
const START_LOCK_NAMESPACE = 0x6a6f62;
const LIMIT_RETRY_SECONDS = 30;

/** How long to wait, in the words a person reads: seconds under a minute, minutes under an hour, hours beyond (rounded up). */
function waitPhrase(seconds: number): string {
  const s = Math.ceil(seconds);
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (s < 60) return unit(s, 'second');
  if (s < 3600) return unit(Math.ceil(s / 60), 'minute');
  return unit(Math.ceil(s / 3600), 'hour');
}

/** When the account's last provider check was queued plus the cooldown, and how long that is from now. The database's clock. */
async function nextCheck(db: Db, accountId: number, cooldownMs: number): Promise<{ at: Date; remaining: number } | undefined> {
  const { rows } = await sql<{ at: Date; remaining: number }>`
    SELECT queued_at + (${cooldownMs}::float8 * interval '1 millisecond') AS at,
           extract(epoch FROM (queued_at + (${cooldownMs}::float8 * interval '1 millisecond')) - now())::float8 AS remaining
    FROM jobs WHERE created_by = ${accountId} AND kind = 'provider_check' ORDER BY queued_at DESC LIMIT 1`.execute(db);
  return rows[0];
}

/** When the account may queue its next provider check, or null if it may now (FR-047): for the Jobs page. */
export async function nextAllowedAt(db: Db, accountId: number, settings: Pick<JobSettings, 'providerCheckCooldownMs'>): Promise<Date | null> {
  if (settings.providerCheckCooldownMs <= 0) return null;
  const next = await nextCheck(db, accountId, settings.providerCheckCooldownMs);
  return next !== undefined && next.remaining > 0 ? next.at : null;
}

/**
 * Queues a job and returns its id. The caps, runs and time limit are copied from `settings` (FR-040, FR-045). The limits
 * are checked in the same transaction, after taking a lock on the account, so two starts at once cannot both pass.
 */
export async function enqueue(
  db: Db,
  job: { kind: JobKind; input: JsonObject; accountId: number },
  settings: JobSettings,
): Promise<string> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${START_LOCK_NAMESPACE}::int, ${job.accountId}::int)`.execute(trx);

    const { rows } = await sql<{ active: number }>`
      SELECT count(*)::int AS active FROM jobs WHERE created_by = ${job.accountId} AND state IN ('queued', 'running')`.execute(trx);
    if ((rows[0]?.active ?? 0) >= settings.jobsPerAccount) {
      const n = settings.jobsPerAccount;
      throw new JobLimitError('limit', LIMIT_RETRY_SECONDS, `You already have ${n} ${n === 1 ? 'job' : 'jobs'} queued or running. Wait for one to finish, or cancel one.`);
    }

    // The cooldown between one account's provider checks (FR-047): counted from when the last was queued, whatever became of
    // it, so cancelling a check does not let the account start another sooner.
    if (job.kind === 'provider_check' && settings.providerCheckCooldownMs > 0) {
      const next = await nextCheck(trx, job.accountId, settings.providerCheckCooldownMs);
      if (next !== undefined && next.remaining > 0) {
        throw new JobLimitError('cooldown', Math.ceil(next.remaining), `You can start the next provider check in ${waitPhrase(next.remaining)}`);
      }
    }

    const row = await trx
      .insertInto('jobs')
      .values({
        kind: job.kind,
        input: job.input,
        created_by: job.accountId,
        max_runs: settings.maxRuns,
        time_limit_ms: settings.timeLimitMs,
        token_cap: settings.tokenCap,
        cost_cap_usd: settings.costCapUsd,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

interface JobRow {
  id: string;
  kind: JobKind;
  state: JobState;
  created_by: number;
  started_by_name: string;
  cancelled_by: number | null;
  cancelled_by_name: string | null;
  cancel_requested: boolean;
  worker_lost: boolean;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  next_run_at: Date | null;
  deadline_at: Date | null;
  run: number;
  max_runs: number;
  token_cap: string;
  cost_cap_usd: string;
  progress: JobProgress | null;
  failure_category: JobFailureCategory | null;
  failure_detail: 'cap_below_one_request' | null;
  result: Record<string, { status?: string } | undefined> | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  tokens_estimated: boolean;
  cost_unknown: boolean;
  cost_known: number;
  cost_estimated: boolean;
  duration_ms: number;
}

// A job with who started and cancelled it and its totals, summed from its usage records (FR-050, SC-006). next_run_at is
// shown only while the job waits for a later run; worker_lost is computed here, from the lease (FR-062).
const JOB_SELECT = sql`
  SELECT j.id, j.kind, j.state, j.created_by, u.username AS started_by_name, j.cancelled_by, c.username AS cancelled_by_name,
         (j.state = 'running' AND j.cancel_requested_at IS NOT NULL) AS cancel_requested,
         (j.state = 'running' AND j.lease_expires_at < now()) AS worker_lost,
         j.queued_at, j.started_at, j.finished_at,
         CASE WHEN j.state = 'queued' AND j.next_run_at > now() THEN j.next_run_at END AS next_run_at,
         j.deadline_at, j.run, j.max_runs, j.token_cap, j.cost_cap_usd, j.progress,
         j.failure_category, j.failure_detail, j.result,
         t.requests, t.input_tokens, t.output_tokens, t.tokens_estimated, t.cost_unknown, t.cost_known, t.cost_estimated, t.duration_ms
  FROM jobs j
  JOIN users u ON u.id = j.created_by
  LEFT JOIN users c ON c.id = j.cancelled_by
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS requests,
           coalesce(sum(input_tokens), 0)::float8 AS input_tokens,
           coalesce(sum(output_tokens), 0)::float8 AS output_tokens,
           coalesce(bool_or(tokens_estimated), false) AS tokens_estimated,
           coalesce(bool_or(cost_usd IS NULL), false) AS cost_unknown,
           coalesce(sum(cost_usd), 0)::float8 AS cost_known,
           coalesce(bool_or(cost_estimated), false) AS cost_estimated,
           coalesce(sum(duration_ms), 0)::float8 AS duration_ms
    FROM job_usage WHERE job_id = j.id
  ) t ON true`;

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/** The operation a failed provider check failed on, so that the hint names its settings: LLM or EMBEDDING. */
function failedPrefix(row: JobRow): Prefix {
  const failed = row.failure_category;
  if (row.result?.generation?.status === failed) return 'LLM';
  if (row.result?.embeddings?.status === failed) return 'EMBEDDING';
  return 'LLM';
}

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    started_by: { id: row.created_by, username: row.started_by_name },
    cancelled_by: row.cancelled_by === null ? null : { id: row.cancelled_by, username: row.cancelled_by_name ?? '' },
    cancel_requested: row.cancel_requested,
    worker_lost: row.worker_lost,
    queued_at: row.queued_at.toISOString(),
    started_at: iso(row.started_at),
    finished_at: iso(row.finished_at),
    next_run_at: iso(row.next_run_at),
    deadline_at: iso(row.deadline_at),
    run: row.run,
    max_runs: row.max_runs,
    caps: { tokens: Number(row.token_cap), cost_usd: Number(row.cost_cap_usd) },
    progress: row.progress,
    failure:
      row.failure_category === null
        ? null
        : { category: row.failure_category, ...describeFailure(row.failure_category, row.failure_detail, failedPrefix(row)) },
    totals: {
      requests: row.requests,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      tokens_estimated: row.tokens_estimated,
      cost_usd: row.cost_unknown ? null : row.cost_known,
      cost_known_usd: row.cost_known,
      cost_estimated: row.cost_estimated,
      cost_cap_applied: !row.cost_unknown,
      duration_ms: row.duration_ms,
    },
  };
}

export async function getJob(db: Db, id: string): Promise<JobRecord | undefined> {
  const { rows } = await sql<JobRow>`${JOB_SELECT} WHERE j.id = ${id}`.execute(db);
  const row = rows[0];
  return row === undefined ? undefined : toRecord(row);
}

/** Newest first by queued time, ties by id descending. */
export async function listJobs(db: Db, page: { limit: number; offset: number }): Promise<{ jobs: JobRecord[]; hasMore: boolean }> {
  const { rows } = await sql<JobRow>`${JOB_SELECT} ORDER BY j.queued_at DESC, j.id DESC LIMIT ${page.limit + 1} OFFSET ${page.offset}`.execute(db);
  return { jobs: rows.slice(0, page.limit).map(toRecord), hasMore: rows.length > page.limit };
}

interface UsageRow {
  id: number;
  run: number;
  operation: 'generate' | 'embed';
  provider: JobUsageRecord['provider'];
  model: string;
  outcome: JobUsageRecord['outcome'];
  attempts: number;
  input_tokens: number;
  output_tokens: number;
  tokens_estimated: boolean;
  cost_usd: number | null;
  cost_estimated: boolean;
  price_source: JobUsageRecord['price_source'];
  temperature_applied: boolean | null;
  duration_ms: number;
  recorded_at: Date;
}

/** The text a provider check shows for an operation that failed: the layer's fixed message and the hint for its settings. */
function describeOperation(operation: ProviderCheckOperation, prefix: Prefix): ProviderCheckOperation {
  const { status } = operation;
  if (status === 'ok' || status === 'not_run') return operation;
  // An operation that is not configured at all has no provider; one that is configured and answered "not configured" has.
  if (status === 'not_configured' && operation.provider === undefined) return operation;
  if (status === 'cancelled') return { ...operation, message: FAILURE_MESSAGES.cancelled, hint: providerHint('cancelled', prefix) };
  return { ...operation, ...describeFailure(status, null, prefix) };
}

/** A job with its usage records, oldest first, and, for a provider check, each operation's message and hint (FR-091). */
export async function getDetail(db: Db, id: string): Promise<JobDetail | undefined> {
  const record = await getJob(db, id);
  if (record === undefined) return undefined;
  const { rows } = await sql<UsageRow>`
    SELECT id::float8 AS id, run, operation, provider, model, outcome, attempts, input_tokens, output_tokens, tokens_estimated,
           cost_usd::float8 AS cost_usd, cost_estimated, price_source, temperature_applied, duration_ms, recorded_at
    FROM job_usage WHERE job_id = ${id} ORDER BY id`.execute(db);
  const stored = await db.selectFrom('jobs').select('result').where('id', '=', id).executeTakeFirst();
  const result = stored?.result as ProviderCheckResult | null | undefined;
  return {
    ...record,
    usage: rows.map((r) => ({ ...r, recorded_at: r.recorded_at.toISOString() })),
    result: result === null || result === undefined ? null : { generation: describeOperation(result.generation, 'LLM'), embeddings: describeOperation(result.embeddings, 'EMBEDDING') },
  };
}

/** The job cannot be cancelled because it has already ended (FR-032). */
export class JobFinishedError extends Error {
  constructor() {
    super('The job has already finished');
    this.name = 'JobFinishedError';
  }
}

/**
 * Cancels a job, in one statement (FR-030, FR-031):
 *  - a queued job ends as cancelled at once, so it never starts;
 *  - a running job whose worker is alive is only marked: its worker notices at the next heartbeat or at the gate before its
 *    next request, abandons its request, and ends it as cancelled;
 *  - a running job whose lease has expired has no worker to notice, so it ends as cancelled at once.
 * Asking twice changes nothing: the first account to ask stays the one who cancelled it. A job that has ended is not
 * touched and throws JobFinishedError. Returns undefined when there is no such job.
 */
export async function cancelJob(db: Db, id: string, accountId: number): Promise<JobRecord | undefined> {
  const { rows } = await sql<{ id: string }>`
    UPDATE jobs SET
      cancel_requested_at = CASE WHEN state = 'running' THEN coalesce(cancel_requested_at, now()) ELSE cancel_requested_at END,
      cancelled_by = coalesce(cancelled_by, ${accountId}),
      state = CASE WHEN state = 'queued' OR lease_expires_at < now() THEN 'cancelled' ELSE state END,
      finished_at = CASE WHEN state = 'queued' OR lease_expires_at < now() THEN now() ELSE finished_at END,
      worker_id = CASE WHEN state = 'queued' OR lease_expires_at < now() THEN NULL ELSE worker_id END,
      lease_expires_at = CASE WHEN state = 'queued' OR lease_expires_at < now() THEN NULL ELSE lease_expires_at END
    WHERE id = ${id} AND state IN ('queued', 'running')
    RETURNING id`.execute(db);
  if (rows.length === 0) {
    const exists = await db.selectFrom('jobs').select('id').where('id', '=', id).executeTakeFirst();
    if (exists !== undefined) throw new JobFinishedError();
    return undefined;
  }
  return getJob(db, id);
}

// ---- Running a job ----------------------------------------------------------------------------------------------------

interface ClaimRow {
  id: string;
  kind: JobKind;
  input: JsonObject;
  run: number;
  max_runs: number;
  claim: string;
  token_cap: string;
  cost_cap_usd: string;
}

/**
 * Takes the oldest queued job that is due, in one statement: FOR UPDATE SKIP LOCKED lets any number of workers claim
 * at once without taking the same job. It starts a lease, adds one to `run` and to `claim`, and on the first run sets
 * started_at and the deadline, which cover every run and wait (FR-022). Returns null when nothing is due.
 */
export async function claimJob(db: Db, workerId: string, leaseMs = 30_000): Promise<ClaimedJob | null> {
  const { rows } = await sql<ClaimRow>`
    UPDATE jobs SET state = 'running', run = run + 1, claim = claim + 1, worker_id = ${workerId},
      lease_expires_at = now() + (${leaseMs}::float8 * interval '1 millisecond'),
      started_at = coalesce(started_at, now()),
      deadline_at = coalesce(deadline_at, now() + (time_limit_ms::float8 * interval '1 millisecond'))
    WHERE id = (
      SELECT id FROM jobs WHERE state = 'queued' AND next_run_at <= now()
      ORDER BY queued_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id, kind, input, run, max_runs, claim, token_cap, cost_cap_usd`.execute(db);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    claim: Number(row.claim),
    kind: row.kind,
    input: row.input,
    run: row.run,
    maxRuns: row.max_runs,
    tokenCap: Number(row.token_cap),
    costCapUsd: Number(row.cost_cap_usd),
  };
}

/**
 * Renews the lease of a job this worker holds, and reads back in the same fenced statement whether a cancel was asked
 * and whether the deadline has passed (research #4). `held: false` means the job was taken away: stop, and write nothing.
 */
export async function heartbeat(
  db: Db,
  job: Held,
  leaseMs = 30_000,
): Promise<{ held: boolean; cancelRequested: boolean; deadlinePassed: boolean }> {
  const { rows } = await sql<{ cancel_requested: boolean; deadline_passed: boolean }>`
    UPDATE jobs SET lease_expires_at = now() + (${leaseMs}::float8 * interval '1 millisecond')
    WHERE id = ${job.id} AND claim = ${job.claim} AND state = 'running'
    RETURNING cancel_requested_at IS NOT NULL AS cancel_requested, deadline_at <= now() AS deadline_passed`.execute(db);
  const row = rows[0];
  return row === undefined
    ? { held: false, cancelRequested: false, deadlinePassed: false }
    : { held: true, cancelRequested: row.cancel_requested, deadlinePassed: row.deadline_passed };
}

export type GateResult =
  | { status: 'ok'; usedTokens: number; usedCostUsd: number; costUnknown: boolean }
  | { status: 'lost' }
  | { status: 'cancel_requested' }
  | { status: 'deadline_passed' };

/**
 * The check before each model request, in one read (research #4): is the job still held by this worker, has a cancel been
 * asked, has the deadline passed, and what has the job used so far, over every run (FR-041). A cancel or a deadline that
 * arrives between two heartbeats therefore stops the next request from going out (FR-030, FR-042). A lost job is
 * reported before a cancel, and a cancel before a deadline. Tokens that were estimated count as reported (FR-032).
 */
export async function gate(db: Db, job: Held): Promise<GateResult> {
  const { rows } = await sql<{
    held: boolean;
    cancel_requested: boolean;
    deadline_passed: boolean;
    used_tokens: number;
    used_cost: number;
    cost_unknown: boolean;
  }>`
    SELECT (j.state = 'running' AND j.claim = ${job.claim}) AS held,
           j.cancel_requested_at IS NOT NULL AS cancel_requested,
           coalesce(j.deadline_at <= now(), false) AS deadline_passed,
           t.used_tokens, t.used_cost, t.cost_unknown
    FROM jobs j
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(input_tokens + output_tokens), 0)::float8 AS used_tokens,
             coalesce(sum(cost_usd), 0)::float8 AS used_cost,
             coalesce(bool_or(cost_usd IS NULL), false) AS cost_unknown
      FROM job_usage WHERE job_id = j.id
    ) t ON true
    WHERE j.id = ${job.id}`.execute(db);
  const row = rows[0];
  if (row === undefined || !row.held) return { status: 'lost' };
  if (row.cancel_requested) return { status: 'cancel_requested' };
  if (row.deadline_passed) return { status: 'deadline_passed' };
  return { status: 'ok', usedTokens: row.used_tokens, usedCostUsd: row.used_cost, costUnknown: row.cost_unknown };
}

/** Records the step a running job is on. False means the job was taken away: write nothing more. */
export async function writeProgress(db: Db, job: Held, progress: JobProgress): Promise<boolean> {
  const { rows } = await sql<{ id: string }>`
    UPDATE jobs SET progress = ${JSON.stringify(progress)}::jsonb
    WHERE id = ${job.id} AND claim = ${job.claim} AND state = 'running' RETURNING id`.execute(db);
  return rows.length > 0;
}

// The wait before a job's next run, by the run that has just ended: 30 seconds, 2 minutes, 8 minutes, then 10 minutes, with
// up to a quarter more at random so that jobs failed by one outage do not all come back together (research #6). It is the
// database's clock, like every time a job holds.
const BACKOFF = sql`now() + (CASE run WHEN 1 THEN 30 WHEN 2 THEN 120 WHEN 3 THEN 480 ELSE 600 END * (1 + random() * 0.25)) * interval '1 second'`;

/**
 * Ends a run, in one fenced statement, and returns the state the job is left in, or `lost` when this worker no longer holds
 * it, in which case nothing was written.
 *  - A cancel that was asked wins over every ending (research #4): the job ends as cancelled, with no failure, and its result
 *    is still stored.
 *  - A failure that may pass queues the job again after a wait while it has runs left, and fails it on the last run.
 *  - `finished_at` is set only when the job ends: a job queued again has not finished.
 */
export async function finishRun(db: Db, job: Held, outcome: RunOutcome): Promise<JobState | 'lost'> {
  const kind = outcome.kind;
  const category = outcome.kind === 'failed' || outcome.kind === 'transient' ? outcome.category : null;
  const detail = outcome.kind === 'failed' ? (outcome.detail ?? null) : null;
  const result = outcome.result === undefined ? null : JSON.stringify(outcome.result);
  const { rows } = await sql<{ state: JobState }>`
    UPDATE jobs SET
      state = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
                   WHEN ${kind}::text = 'transient' THEN CASE WHEN run < max_runs THEN 'queued' ELSE 'failed' END
                   ELSE ${kind}::text END,
      failure_category = CASE WHEN cancel_requested_at IS NOT NULL THEN NULL
                              WHEN ${kind}::text = 'transient' AND run < max_runs THEN NULL
                              ELSE ${category}::text END,
      failure_detail = CASE WHEN cancel_requested_at IS NOT NULL THEN NULL ELSE ${detail}::text END,
      result = coalesce(${result}::jsonb, result),
      next_run_at = CASE WHEN cancel_requested_at IS NULL AND ${kind}::text = 'transient' AND run < max_runs THEN ${BACKOFF} ELSE next_run_at END,
      finished_at = CASE WHEN cancel_requested_at IS NULL AND ${kind}::text = 'transient' AND run < max_runs THEN NULL ELSE now() END,
      worker_id = NULL, lease_expires_at = NULL
    WHERE id = ${job.id} AND claim = ${job.claim} AND state = 'running'
    RETURNING state`.execute(db);
  return rows[0]?.state ?? 'lost';
}

/**
 * The sweep every worker runs before it claims (research #4). A running job whose lease has run out lost its worker (FR-007):
 * it ends as cancelled if a cancel was asked, fails as timed out if its deadline has passed, fails as worker_lost if the lost
 * run was its last, and is otherwise queued again after a wait, the lost run counted. A queued job whose deadline passed while
 * it waited for its next run fails as timed out. Safe to run from many workers at once: a job is handled once. Returns how many.
 */
export async function sweep(db: Db): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    UPDATE jobs SET
      state = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
                   WHEN deadline_at <= now() OR run >= max_runs THEN 'failed'
                   ELSE 'queued' END,
      failure_category = CASE WHEN cancel_requested_at IS NOT NULL THEN NULL
                              WHEN deadline_at <= now() THEN 'timed_out'
                              WHEN run >= max_runs THEN 'worker_lost'
                              ELSE NULL END,
      finished_at = CASE WHEN cancel_requested_at IS NOT NULL OR deadline_at <= now() OR run >= max_runs THEN now() ELSE NULL END,
      next_run_at = CASE WHEN cancel_requested_at IS NULL AND NOT (deadline_at <= now() OR run >= max_runs) THEN ${BACKOFF} ELSE next_run_at END,
      worker_id = NULL, lease_expires_at = NULL
    WHERE (state = 'running' AND lease_expires_at < now())
       OR (state = 'queued' AND deadline_at IS NOT NULL AND deadline_at <= now())
    RETURNING id`.execute(db);
  return rows.length;
}

/**
 * A worker that is stopping gives a job back (FR-007): it is queued for at once and the run is given back, so restarting or
 * scaling down workers never uses up a job's runs, even with a single run allowed. `claim` is not touched, so the number the
 * next claim hands out is still higher than this worker's. A cancel that was asked ends the job as cancelled instead.
 */
export async function handBack(db: Db, job: Held): Promise<JobState | 'lost'> {
  const { rows } = await sql<{ state: JobState }>`
    UPDATE jobs SET
      state = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'queued' END,
      run = CASE WHEN cancel_requested_at IS NOT NULL THEN run ELSE run - 1 END,
      next_run_at = CASE WHEN cancel_requested_at IS NULL THEN now() ELSE next_run_at END,
      finished_at = CASE WHEN cancel_requested_at IS NOT NULL THEN now() ELSE NULL END,
      worker_id = NULL, lease_expires_at = NULL
    WHERE id = ${job.id} AND claim = ${job.claim} AND state = 'running'
    RETURNING state`.execute(db);
  return rows[0]?.state ?? 'lost';
}

/**
 * Stores Milestone 1's usage record of one request a job made. Not fenced: a request that was made counts against the
 * job's caps whichever worker records it (FR-041). A request that was made has a provider and a model.
 */
export async function recordUsage(db: Db, jobId: string, run: number, usage: Usage): Promise<number> {
  if (usage.provider === null || usage.model === null) throw new Error('a usage record of a request that was made has a provider and a model');
  const row = await db
    .insertInto('job_usage')
    .values({
      job_id: jobId,
      run,
      operation: usage.operation === 'generate' ? 'generate' : 'embed',
      provider: usage.provider,
      model: usage.model,
      outcome: usage.outcome,
      attempts: usage.attempts,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      tokens_estimated: usage.tokensEstimated,
      cost_usd: usage.costUsd,
      cost_estimated: usage.costEstimated,
      price_source: usage.priceSource,
      temperature_applied: usage.temperatureApplied,
      duration_ms: Math.round(usage.durationMs),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

// ---- Workers ----------------------------------------------------------------------------------------------------------

export async function registerWorker(db: Db, id: string): Promise<void> {
  await db.insertInto('workers').values({ id }).execute();
}

/** A worker reports that it is alive, and, when it starts to stop, that it is stopping. */
export async function touchWorker(db: Db, id: string, stopping?: boolean): Promise<void> {
  await sql`UPDATE workers SET last_seen_at = now(), stopping = coalesce(${stopping ?? null}::boolean, stopping) WHERE id = ${id}`.execute(db);
}

export async function removeWorker(db: Db, id: string): Promise<void> {
  await db.deleteFrom('workers').where('id', '=', id).execute();
}

/** Removes the rows of workers not seen for `olderThanMs`, so restarts do not pile up rows. */
export async function deleteStaleWorkers(db: Db, olderThanMs: number): Promise<void> {
  await sql`DELETE FROM workers WHERE last_seen_at < now() - (${olderThanMs}::float8 * interval '1 millisecond')`.execute(db);
}

/** Whether a worker reported within `withinMs` and is not stopping (FR-008). True with no job running: it is the table. */
export async function workerAlive(db: Db, withinMs = 30_000): Promise<boolean> {
  const { rows } = await sql<{ alive: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM workers WHERE NOT stopping AND last_seen_at > now() - (${withinMs}::float8 * interval '1 millisecond')
    ) AS alive`.execute(db);
  return rows[0]?.alive ?? false;
}
