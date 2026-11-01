import { randomUUID } from 'node:crypto';
import type { Database } from '@scrylux/db';
import type { Llm, LlmConfig } from '@scrylux/llm';
import type { Kysely } from 'kysely';
import { logWorker } from '../jobs/log.js';
import { claimJob, deleteStaleWorkers, registerWorker, removeWorker, sweep, touchWorker } from '../jobs/store.js';
import { runJob } from './run.js';
import { STALE_WORKER_MS, defaultTimings, type Timings } from './timing.js';

// The worker (Phase 3 Milestone 2, research #9): it registers, reports that it is alive, and claims due jobs while it has
// a free slot. It keeps no state of its own between jobs; everything is in Postgres, so any number of workers can run.

type Db = Kysely<Database>;

export interface WorkerOptions {
  db: Db;
  /** The provider layer's client, made from `llmConfig` (FR-070: only the worker sends requests to a provider). */
  llm: Llm;
  llmConfig: LlmConfig;
  /** How many jobs this worker runs at once (FR-006). */
  concurrency?: number;
  /** Tests shorten these; the worker never reads them from the environment. */
  timings?: Partial<Timings>;
  workerId?: string;
}

export interface Worker {
  id: string;
  /** Stops claiming, lets running jobs go on, removes this worker's row, and returns how many jobs it handed back. */
  stop(): Promise<number>;
  /** Stops at once and writes nothing, as a crashed worker does: its jobs come back when their leases run out. */
  abandon(): Promise<void>;
}

export async function startWorker(options: WorkerOptions): Promise<Worker> {
  const { db, llm, llmConfig } = options;
  const id = options.workerId ?? randomUUID();
  const concurrency = options.concurrency ?? 1;
  const timings: Timings = { ...defaultTimings, ...options.timings };
  const workerAbort = new AbortController();
  // Keyed by the claim as well as the job: a job this worker claims again must not be removed by the run it replaced.
  const running = new Map<string, Promise<'ended' | 'handed_back'>>();
  let stopping = false;
  let ticking = false;

  await deleteStaleWorkers(db, STALE_WORKER_MS);
  await registerWorker(db, id);
  logWorker('start', { workerId: id, concurrency });

  async function tick(): Promise<void> {
    if (stopping || ticking) return;
    ticking = true;
    try {
      // Before claiming: a job whose worker was lost comes back to the queue, one waiting past its deadline fails (FR-007).
      await sweep(db);
      while (!stopping && running.size < concurrency) {
        const job = await claimJob(db, id, timings.leaseMs);
        if (job === null) break;
        const key = `${job.id}#${job.claim}`;
        const done = runJob({ db, llm, llmConfig, timings, workerSignal: workerAbort.signal }, job)
          // A fixed line: the error may carry what a provider or the database said.
          .catch(() => {
            console.error(JSON.stringify({ event: 'worker', action: 'error', worker_id: id, job_id: job.id }));
            return 'ended' as const;
          })
          .finally(() => running.delete(key));
        running.set(key, done);
      }
    } catch {
      // The database may be down for a moment: try again on the next poll.
    } finally {
      ticking = false;
    }
  }

  const poll = setInterval(() => void tick(), timings.pollMs);
  const report = setInterval(() => void touchWorker(db, id).catch(() => undefined), timings.reportMs);
  void tick();

  const halt = (): void => {
    stopping = true;
    clearInterval(poll);
    clearInterval(report);
  };

  return {
    id,
    async stop() {
      halt();
      // Not alive from now on: the Jobs page must not count on a worker that is going (FR-008).
      await touchWorker(db, id, true).catch(() => undefined);
      // Running jobs go on for the grace period. Those still running after it are abandoned and handed back (FR-007).
      const finished = Promise.all(running.values());
      let grace: NodeJS.Timeout | undefined;
      const inTime = await Promise.race([
        finished.then(() => true),
        new Promise<false>((resolve) => {
          grace = setTimeout(() => resolve(false), timings.graceMs);
        }),
      ]);
      clearTimeout(grace);
      if (!inTime) workerAbort.abort('handback');
      const outcomes = await finished;
      await removeWorker(db, id);
      const handedBack = outcomes.filter((outcome) => outcome === 'handed_back').length;
      logWorker('stop', { workerId: id, handedBack });
      return handedBack;
    },
    async abandon() {
      halt();
      workerAbort.abort('lost');
      await Promise.all(running.values());
    },
  };
}
