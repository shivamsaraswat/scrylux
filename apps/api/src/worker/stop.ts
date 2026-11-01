import type { JobFailureCategory } from '@scrylux/core';

// Why a run stopped before its kind finished (Phase 3 Milestone 2, research #4). It is the abort reason of the run's
// signal, and what the gate before a request throws, so the run and the kinds share one vocabulary.
//
//   cancelled   a cancel was asked (FR-030)
//   timed_out   the job's deadline passed (FR-022)
//   cap_reached the next request would take the job past a cap (FR-042); `detail` says when the cap is below one request
//   lost        the worker no longer holds the job, or was abandoned: write nothing more (FR-005)
//   handback    the worker is stopping and the grace period has passed: give the job back (FR-007)
export type StopReason = 'cancelled' | 'timed_out' | 'cap_reached' | 'lost' | 'handback';

export class RunStopped extends Error {
  constructor(
    readonly reason: StopReason,
    readonly detail?: 'cap_below_one_request',
  ) {
    super(`the run stopped: ${reason}`);
    this.name = 'RunStopped';
  }
}

/** The failure a stop becomes, for the reasons that end a job as failed. */
export function failureOf(stop: RunStopped): { category: JobFailureCategory; detail?: 'cap_below_one_request' } | undefined {
  if (stop.reason === 'timed_out') return { category: 'timed_out' };
  if (stop.reason === 'cap_reached') return { category: 'cap_reached', ...(stop.detail === undefined ? {} : { detail: stop.detail }) };
  return undefined;
}
