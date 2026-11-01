import { openaiError, resetCapabilityOverrides, startStub, type RecordedRequest, type Scripted, type Stub } from '@scrylux/llm/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import db, { kdb } from '../../src/db.js';
import { getDetail, getJob } from '../../src/jobs/store.js';
import { startWorker, type Worker } from '../../src/worker/loop.js';
import { defaultTimings, type Timings } from '../../src/worker/timing.js';
import {
  FAST, SETTINGS, answerBoth, captureLog, clientFor, generationRequests, localConfig, makeUser, queueCheck, resetJobTables, sleep, waitFor,
  waitForState,
} from './helpers.js';

// Jobs survive failures and restarts (Phase 3 Milestone 2, US4): a run that failed for a reason that may pass runs again; a
// worker that stops or crashes does not lose its job; no job is ever run by two workers at once (FR-005, FR-007, FR-020 to
// FR-022, SC-005, SC-008). The waits between runs are minutes, so a test that needs the next run moves the wait to now.

let stub: Stub;
let alice: number;
const workers: Worker[] = [];

beforeEach(async () => {
  resetCapabilityOverrides();
  await resetJobTables();
  alice = await makeUser();
  stub = await startStub();
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.abandon()));
  await stub.close();
});

async function run(options: { timings?: Timings; concurrency?: number; embeddings?: boolean } = {}): Promise<Worker> {
  const config = localConfig(stub.url, { embeddings: options.embeddings ?? false });
  const worker = await startWorker({
    db: kdb,
    llm: clientFor(config),
    llmConfig: config,
    timings: options.timings ?? FAST,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  });
  workers.push(worker);
  return worker;
}

/** The provider layer retries a transient failure twice by itself, so a run that fails this way sees three of them. */
const unavailable = (): Scripted => openaiError(503, 'overloaded', { type: 'server_error' });
const generationAnswer = (): Scripted => answerBoth()({ path: '/v1/chat/completions' } as RecordedRequest);

/** Moves the wait before the next run to now, once the job is queued again after `run` runs. */
async function skipWait(id: string, run: number): Promise<void> {
  await waitFor(async () => {
    const job = await getJob(kdb, id);
    return job?.state === 'queued' && job.run === run && job.next_run_at !== null ? true : undefined;
  }, 5000, `job ${id} to wait for run ${run + 1}`);
  await db.query('UPDATE jobs SET next_run_at = now() WHERE id = $1', [id]);
}

describe('a failure that may pass (FR-020, FR-021, SC-008)', () => {
  it.each([
    ['the provider is unavailable', unavailable],
    ['the provider is limiting requests', () => openaiError(429, 'slow down', { type: 'rate_limit_error' })],
  ])('runs again after a wait when %s, and succeeds on the second run with both runs’ usage recorded', async (_label, failure) => {
    let seen = 0;
    stub.setFallback((): Scripted => (++seen <= 3 ? failure() : generationAnswer()));
    const id = await queueCheck(alice);
    await run();
    await skipWait(id, 1);
    const done = await waitForState(id, ['succeeded', 'failed'], 5000);
    expect(done.state).toBe('succeeded');
    expect(done.run).toBe(2);
    const detail = await getDetail(kdb, id);
    // Run 1 made one request (three tries, by the layer) that failed, and run 2 one that worked: both are the job’s usage.
    expect(detail?.usage.map((u) => [u.run, u.outcome])).toEqual([[1, expect.stringMatching(/provider_unavailable|rate_limited/) as unknown], [2, 'ok']]);
    expect(detail?.usage[0]?.attempts).toBe(3);
    expect(detail?.totals.requests).toBe(2);
    expect(generationRequests(stub)).toHaveLength(4);
  });

  it('fails after the last run, with that failure, and has run exactly as often as it was allowed (SC-008)', async () => {
    stub.setFallback(unavailable);
    const id = await queueCheck(alice, { ...SETTINGS, maxRuns: 3 });
    await run();
    await skipWait(id, 1);
    await skipWait(id, 2);
    const done = await waitForState(id, ['failed', 'succeeded'], 5000);
    expect(done.state).toBe('failed');
    expect(done.run).toBe(3);
    expect(done.failure?.category).toBe('provider_unavailable');
    expect(generationRequests(stub)).toHaveLength(9);
    await sleep(FAST.pollMs * 6);
    expect(generationRequests(stub)).toHaveLength(9);
  });

  it('does not run again after a failure that will not pass: a refused key ends the job after one run', async () => {
    stub.setFallback(() => openaiError(401, 'bad key'));
    const id = await queueCheck(alice);
    await run();
    const done = await waitForState(id, ['failed', 'succeeded'], 5000);
    expect(done.state).toBe('failed');
    expect(done.run).toBe(1);
    expect(done.failure?.category).toBe('not_authorized');
  });

  it('waits before the next run: the job is not claimed again until its wait is over', async () => {
    stub.setFallback(unavailable);
    const id = await queueCheck(alice);
    await run();
    await waitFor(async () => {
      const job = await getJob(kdb, id);
      return job?.state === 'queued' && job.run === 1 ? true : undefined;
    }, 5000, 'the first run to end');
    const before = generationRequests(stub).length;
    await sleep(FAST.pollMs * 8);
    expect(generationRequests(stub)).toHaveLength(before);
    const waiting = await getJob(kdb, id);
    expect(waiting?.next_run_at).not.toBeNull();
    expect(new Date(waiting?.next_run_at ?? 0).getTime()).toBeGreaterThan(Date.now() + 20_000);
  });
});

describe('a worker that is lost (FR-005, FR-007, SC-005)', () => {
  it('has its job picked up again by another worker after the lease runs out, and finishes it', async () => {
    let first = true;
    stub.setFallback((): Scripted => {
      if (first) {
        first = false;
        return 'hang';
      }
      return generationAnswer();
    });
    const id = await queueCheck(alice);
    const crashed = await run();
    await waitFor(() => (generationRequests(stub).length > 0 ? true : undefined), 5000, 'the request');
    // The worker stops hard and says nothing, as a crashed one does: the job stays running until its lease ends.
    await crashed.abandon();
    expect(await getJob(kdb, id)).toMatchObject({ state: 'running', run: 1 });

    await run();
    await skipWait(id, 1);
    const done = await waitForState(id, ['succeeded', 'failed'], 5000);
    expect(done.state).toBe('succeeded');
    expect(done.run).toBe(2);
    // The crashed worker wrote nothing after the second took over: the only usage is the request that worked.
    expect((await getDetail(kdb, id))?.usage.map((u) => [u.run, u.outcome])).toEqual([[2, 'ok']]);
  });

  it('fails as worker_lost when the lost run was the last one allowed', async () => {
    stub.setFallback(() => 'hang');
    const id = await queueCheck(alice, { ...SETTINGS, maxRuns: 1 });
    const crashed = await run();
    await waitFor(() => (generationRequests(stub).length > 0 ? true : undefined), 5000, 'the request');
    await crashed.abandon();
    await run();
    const done = await waitForState(id, ['failed', 'succeeded'], 5000);
    expect(done.state).toBe('failed');
    expect(done.failure?.category).toBe('worker_lost');
  });
});

describe('a worker that is asked to stop (FR-007)', () => {
  it('hands back the job that did not finish in the grace period, without using up a run, and another worker finishes it', async () => {
    let first = true;
    stub.setFallback((): Scripted => {
      if (first) {
        first = false;
        return 'hang';
      }
      return generationAnswer();
    });
    const id = await queueCheck(alice, { ...SETTINGS, maxRuns: 1 });
    const stopping = await run();
    await waitFor(() => (generationRequests(stub).length > 0 ? true : undefined), 5000, 'the request');

    const log = captureLog();
    const handedBack = await stopping.stop();
    const lines = log.lines();
    log.restore();

    expect(handedBack).toBe(1);
    expect(lines.find((l) => l.event === 'worker' && l.action === 'stop')).toMatchObject({ handed_back: 1 });
    // Queued for at once, its run given back: with a single run allowed, it can still run.
    expect(await getJob(kdb, id)).toMatchObject({ state: 'queued', run: 0, next_run_at: null });

    await run();
    const done = await waitForState(id, ['succeeded', 'failed'], 5000);
    expect(done.state).toBe('succeeded');
    expect(done.run).toBe(1);
  });

  it('lets a job that finishes within the grace period finish, and hands back nothing', async () => {
    stub.setFallback(() => ({ delay: 120, then: generationAnswer() }));
    const id = await queueCheck(alice);
    const stopping = await run();
    await waitFor(() => (generationRequests(stub).length > 0 ? true : undefined), 5000, 'the request');
    expect(await stopping.stop()).toBe(0);
    expect((await getJob(kdb, id))?.state).toBe('succeeded');
  });

  it('takes no new job once it is stopping', async () => {
    stub.setFallback(() => ({ delay: 100, then: generationAnswer() }));
    const first = await queueCheck(alice);
    const stopping = await run();
    await waitFor(() => (generationRequests(stub).length > 0 ? true : undefined), 5000, 'the request');
    const second = await queueCheck(alice);
    await stopping.stop();
    expect((await getJob(kdb, first))?.state).toBe('succeeded');
    expect((await getJob(kdb, second))?.state).toBe('queued');
  });
});

describe('the time limit of a job (FR-022, SC-008)', () => {
  it('ends the job as timed out when its deadline passes during a request, and abandons the request', async () => {
    stub.setFallback(() => 'hang');
    const id = await queueCheck(alice, { ...SETTINGS, timeLimitMs: 400 });
    await run();
    const done = await waitForState(id, ['failed', 'succeeded', 'cancelled'], 5000);
    expect(done.state).toBe('failed');
    expect(done.failure?.category).toBe('timed_out');
    // Within one heartbeat of the deadline, plus a little.
    expect(new Date(done.finished_at ?? 0).getTime() - new Date(done.deadline_at ?? 0).getTime()).toBeLessThan(FAST.heartbeatMs + 1000);
    // The request that was abandoned is shown as the deadline's doing.
    expect((await getDetail(kdb, id))?.result).toMatchObject({ generation: { status: 'timed_out' } });
    expect(done.run).toBe(1);
  });

  it('is within 10 seconds of the deadline at the real heartbeat', async () => {
    stub.setFallback(() => 'hang');
    const id = await queueCheck(alice, { ...SETTINGS, timeLimitMs: 1500 });
    await run({ timings: { ...defaultTimings, pollMs: FAST.pollMs } });
    const done = await waitForState(id, ['failed', 'succeeded', 'cancelled'], 15_000);
    expect(done.failure?.category).toBe('timed_out');
    expect(new Date(done.finished_at ?? 0).getTime() - new Date(done.deadline_at ?? 0).getTime()).toBeLessThan(10_000);
  }, 25_000);

  it('counts the waits between runs: a job that waits past its deadline is failed by the next sweep', async () => {
    stub.setFallback(unavailable);
    const id = await queueCheck(alice, { ...SETTINGS, timeLimitMs: 60_000 });
    await run();
    await waitFor(async () => {
      const job = await getJob(kdb, id);
      return job?.state === 'queued' && job.run === 1 ? true : undefined;
    }, 5000, 'the first run to end');
    await db.query(`UPDATE jobs SET deadline_at = now() - interval '1 second' WHERE id = $1`, [id]);
    const done = await waitForState(id, ['failed'], 5000);
    expect(done.failure?.category).toBe('timed_out');
  });
});

describe('many jobs and many workers (FR-005, SC-005)', () => {
  it('runs each of 100 jobs exactly once with two workers', async () => {
    stub.setFallback(generationAnswer);
    await db.query(
      `INSERT INTO jobs (kind, created_by, max_runs, time_limit_ms, token_cap, cost_cap_usd)
       SELECT 'provider_check', $1, 3, 3600000, 500000, 5 FROM generate_series(1, 100)`,
      [alice],
    );
    await run({ concurrency: 4 });
    await run({ concurrency: 4 });
    await waitFor(async () => {
      const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE state NOT IN ('succeeded', 'failed', 'cancelled')`);
      return rows[0]?.n === 0 ? true : undefined;
    }, 60_000, 'all 100 jobs to end');
    const { rows } = await db.query<{ state: string; run: number; claim: string; n: number }>(
      `SELECT state, run, claim, count(*)::int AS n FROM jobs GROUP BY state, run, claim`,
    );
    expect(rows).toEqual([{ state: 'succeeded', run: 1, claim: '1', n: 100 }]);
    expect(generationRequests(stub)).toHaveLength(100);
  }, 90_000);
});
