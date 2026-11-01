import { worstCase, type Llm, type LlmConfig } from '@scrylux/llm';
import type { Database } from '@scrylux/db';
import type { Kysely } from 'kysely';
import { logJobState } from '../jobs/log.js';
import { finishRun, gate, getJob, handBack, heartbeat, recordUsage, writeProgress, type ClaimedJob, type RunOutcome } from '../jobs/store.js';
import { checkBudget } from './budget.js';
import { kinds, type KindOutcome, type RunContext } from './kinds.js';
import { RunStopped, failureOf, type StopReason } from './stop.js';
import type { Timings } from './timing.js';

// One claimed job, from its first heartbeat to its end (Phase 3 Milestone 2, research #4). The run renews the lease on a
// timer and reads back whether the job was cancelled, ran out of time or was taken away; any of them aborts the kind's
// signal, so a request in flight is abandoned. When the kind ends, the run writes exactly one fenced update: the state
// the outcome calls for, which a cancel that was asked turns into `cancelled`.

type Db = Kysely<Database>;

export interface RunDeps {
  db: Db;
  llm: Llm;
  llmConfig: LlmConfig;
  timings: Timings;
  /** Aborts when the worker is abandoned (reason `lost`: write nothing) or hands its jobs back (reason `handback`). */
  workerSignal: AbortSignal;
}

const stopReasons: readonly StopReason[] = ['cancelled', 'timed_out', 'cap_reached', 'lost', 'handback'];
const asReason = (value: unknown): StopReason | undefined => stopReasons.find((r) => r === value);

/** Logs the job's new state with its totals so far: ids and numbers only (FR-009). */
async function logState(db: Db, job: ClaimedJob, state: Parameters<typeof logJobState>[0]['state'], failureCategory?: Parameters<typeof logJobState>[0]['failureCategory']): Promise<void> {
  const record = await getJob(db, job.id);
  logJobState({
    jobId: job.id,
    kind: job.kind,
    state,
    run: job.run,
    ...(failureCategory === undefined ? {} : { failureCategory }),
    inputTokens: record?.totals.input_tokens ?? 0,
    outputTokens: record?.totals.output_tokens ?? 0,
    costUsd: record?.totals.cost_usd ?? null,
  });
}

/**
 * Runs one claimed job to the end of this run. It never throws for a job's own failure; that is the job's outcome. Says whether
 * the job was handed back, because the worker is stopping (FR-007), so that the worker can count them.
 */
export async function runJob(deps: RunDeps, job: ClaimedJob): Promise<'ended' | 'handed_back'> {
  const { db, timings } = deps;
  const controller = new AbortController();
  let reason: StopReason | undefined;
  let stopDetail: RunStopped['detail'];
  const stop = (why: StopReason, detail?: RunStopped['detail']): void => {
    if (reason !== undefined) return;
    reason = why;
    stopDetail = detail;
    controller.abort(why);
  };

  const fromWorker = (): void => stop(asReason(deps.workerSignal.reason) ?? 'lost');
  if (deps.workerSignal.aborted) fromWorker();
  else deps.workerSignal.addEventListener('abort', fromWorker, { once: true });

  await logState(db, job, 'running');

  // The heartbeat: renew the lease, and notice a cancel, the deadline, or the job being taken away.
  let beating: Promise<void> = Promise.resolve();
  const beat = async (): Promise<void> => {
    const state = await heartbeat(db, job, timings.leaseMs);
    if (!state.held) stop('lost');
    else if (state.cancelRequested) stop('cancelled');
    else if (state.deadlinePassed) stop('timed_out');
  };
  const timer = setInterval(() => {
    beating = beating.then(beat).catch(() => undefined);
  }, timings.heartbeatMs);

  let kept: KindOutcome['result'] | undefined;
  const context: RunContext = {
    job,
    llm: deps.llm,
    llmConfig: deps.llmConfig,
    signal: controller.signal,
    progress: async (progress) => {
      await writeProgress(db, job, progress);
    },
    beforeRequest: async (request) => {
      if (reason !== undefined) throw new RunStopped(reason, stopDetail);
      // One read: still held, no cancel, deadline not passed, and what the job has used over every run (research #4).
      const gated = await gate(db, job);
      if (gated.status === 'lost') throw new RunStopped('lost');
      if (gated.status === 'cancel_requested') throw new RunStopped('cancelled');
      if (gated.status === 'deadline_passed') throw new RunStopped('timed_out');
      const worst = worstCase(deps.llmConfig, request.operation === 'generate' ? { operation: 'generate', inputChars: request.inputChars } : { operation: 'embed', inputChars: request.inputChars });
      const verdict = checkBudget(gated, { tokens: job.tokenCap, costUsd: job.costCapUsd }, worst);
      if (!verdict.ok) throw new RunStopped('cap_reached', verdict.detail);
    },
    // A worker that was abandoned, as a crashed one is, writes nothing more (spec edge case “A worker crashes mid-request”).
    record: (usage) => {
      if (reason === 'lost') throw new RunStopped('lost');
      return recordUsage(db, job.id, job.run, usage);
    },
    stopReason: () => reason,
    keep: (result) => {
      kept = result;
    },
  };

  let outcome: KindOutcome | undefined;
  let thrown: unknown;
  try {
    outcome = await kinds[job.kind].run(context);
  } catch (error) {
    thrown = error;
  } finally {
    clearInterval(timer);
    deps.workerSignal.removeEventListener('abort', fromWorker);
  }
  await beating;

  if (thrown instanceof RunStopped) stop(thrown.reason, thrown.detail);
  // The worker no longer holds the job, or was abandoned: any write would be refused, and none is attempted.
  if (reason === 'lost') return 'ended';
  // The worker is stopping and its grace period is over: the job goes back to the queue with its run given back (FR-007).
  if (reason === 'handback') {
    const state = await handBack(db, job);
    if (state === 'lost') return 'ended';
    await logState(db, job, state);
    return state === 'queued' ? 'handed_back' : 'ended';
  }
  // Past this line a run that was aborted always has a reason that ends it below, so an abort is never written as a success.

  const result = outcome?.result ?? kept;
  const withResult = result === undefined ? {} : { result };
  let end: RunOutcome;
  if (reason === 'cancelled') end = { kind: 'cancelled', ...withResult };
  else if (reason === 'timed_out' || reason === 'cap_reached') {
    const failure = failureOf(new RunStopped(reason, stopDetail));
    end = { kind: 'failed', category: failure?.category ?? 'job_error', ...(failure?.detail === undefined ? {} : { detail: failure.detail }), ...withResult };
  } else if (thrown !== undefined) end = { kind: 'failed', category: 'job_error', ...withResult };
  else if (outcome?.failure?.category === 'provider_unavailable' || outcome?.failure?.category === 'rate_limited') {
    // A failure that may pass (FR-020): the job runs again after a wait while it has runs left.
    end = { kind: 'transient', category: outcome.failure.category, ...withResult };
  } else if (outcome?.failure !== undefined) end = { kind: 'failed', category: outcome.failure.category, ...withResult };
  else end = { kind: 'succeeded', ...withResult };

  const state = await finishRun(db, job, end);
  if (state === 'lost') return 'ended';
  await logState(db, job, state, state === 'failed' && (end.kind === 'failed' || end.kind === 'transient') ? end.category : undefined);
  return 'ended';
}
