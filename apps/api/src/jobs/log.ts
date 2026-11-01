import type { JobFailureCategory, JobKind, JobState } from '@scrylux/core';

// One JSON line per event on stdout (Principle IV, Phase 3 Milestone 2 FR-009, contracts/worker.md and
// contracts/http-api.md). Each function takes the documented fields and builds the line from them by name, so nothing
// else can reach it: no content, prompt, answer, key, base address or provider error text.

const write = (line: Record<string, unknown>): void => console.log(JSON.stringify(line));

/** Who started or cancelled which job: the API's line for a write, as the other v1 routes (FR-060). */
export function logJobAction(accountId: number, action: 'start' | 'cancel', jobId: string, kind?: JobKind): void {
  write({ event: 'job', action, account_id: accountId, job_id: jobId, ...(kind === undefined ? {} : { kind }) });
}

export interface JobStateLine {
  jobId: string;
  kind: JobKind;
  state: JobState;
  run: number;
  failureCategory?: JobFailureCategory;
  /** The job's totals so far; the cost is null when any price was unknown. */
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** The worker's line for each change of a job's state. */
export function logJobState(line: JobStateLine): void {
  write({
    event: 'job',
    job_id: line.jobId,
    kind: line.kind,
    state: line.state,
    run: line.run,
    ...(line.failureCategory === undefined ? {} : { failure_category: line.failureCategory }),
    input_tokens: line.inputTokens,
    output_tokens: line.outputTokens,
    cost_usd: line.costUsd,
  });
}

/** When a worker starts (with its concurrency) and stops (with the number of jobs it handed back). */
export function logWorker(action: 'start' | 'stop', fields: { workerId: string; concurrency?: number; handedBack?: number }): void {
  write({
    event: 'worker',
    action,
    worker_id: fields.workerId,
    ...(fields.concurrency === undefined ? {} : { concurrency: fields.concurrency }),
    ...(fields.handedBack === undefined ? {} : { handed_back: fields.handedBack }),
  });
}
