// The intervals of the worker (Phase 3 Milestone 2, research #5). Each sits well inside the bound it serves: a queued
// job starts within about a poll, a cancel or deadline is noticed within a heartbeat, a crashed worker's job comes back
// within a lease, and "no worker" shows within the alive window. Tests shorten them through the worker's options and
// never through the environment.

export interface Timings {
  /** How often an idle slot looks for a due job. */
  pollMs: number;
  /** How often a running job renews its lease and reads back whether a cancel was asked or its deadline passed. */
  heartbeatMs: number;
  /** How long a lease lasts after it is renewed: a worker that stops renewing loses the job after this. */
  leaseMs: number;
  /** How often a worker reports that it is alive. */
  reportMs: number;
  /** A worker that has not reported within this counts as not alive (FR-008). */
  aliveWithinMs: number;
  /** How long a stopping worker lets its jobs go on before it hands them back (FR-007). */
  graceMs: number;
}

export const defaultTimings: Readonly<Timings> = {
  pollMs: 2_000,
  heartbeatMs: 5_000,
  leaseMs: 30_000,
  reportMs: 10_000,
  aliveWithinMs: 30_000,
  graceMs: 30_000,
};

/** A worker row not seen for this long is removed when a worker starts, so restarts do not pile up rows. */
export const STALE_WORKER_MS = 24 * 60 * 60 * 1000;
