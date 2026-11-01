import { openaiCompletion, resetCapabilityOverrides, startStub, type RecordedRequest, type Scripted, type Stub } from '@scrylux/llm/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kdb } from '../../src/db.js';
import { cancelJob, getDetail, getJob } from '../../src/jobs/store.js';
import { startWorker, type Worker } from '../../src/worker/loop.js';
import { defaultTimings, type Timings } from '../../src/worker/timing.js';
import { FAST, answerBoth, clientFor, embeddingRequests, generationRequests, localConfig, makeUser, queueCheck, resetJobTables, sleep, waitFor, waitForState } from './helpers.js';

// Cancelling a job (Phase 3 Milestone 2, US3, FR-030 to FR-033, SC-003): a queued job never starts; a running job abandons
// its request, sends nothing more, and ends as cancelled with what it used so far, whichever worker holds it.

let stub: Stub;
let alice: number;
let bob: number;
const workers: Worker[] = [];

beforeEach(async () => {
  resetCapabilityOverrides();
  await resetJobTables();
  alice = await makeUser();
  bob = await makeUser();
  stub = await startStub();
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.abandon()));
  await stub.close();
});

async function run(timings: Timings = FAST): Promise<Worker> {
  const config = localConfig(stub.url);
  const worker = await startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings });
  workers.push(worker);
  return worker;
}

/** Waits until the stub has been asked for a chat completion, which it holds: the job is in the middle of its request. */
const inFlight = (): Promise<RecordedRequest> => waitFor(() => generationRequests(stub)[0], 5000, 'the generation request');

describe('a running job (FR-030, FR-033)', () => {
  it('ends as cancelled within 10 seconds at the real heartbeat, abandons its request, and keeps its usage (SC-003)', async () => {
    stub.setFallback(() => 'hang');
    const id = await queueCheck(alice);
    // The default heartbeat and lease: the 10 seconds of FR-030 are measured against the real intervals.
    await run({ ...defaultTimings, pollMs: FAST.pollMs });
    await inFlight();
    const sentBefore = stub.requests.length;

    const cancelledAt = Date.now();
    const asked = await cancelJob(kdb, id, bob);
    expect(asked).toMatchObject({ state: 'running', cancel_requested: true });
    const done = await waitForState(id, ['cancelled', 'succeeded', 'failed'], 15_000);
    const took = Date.now() - cancelledAt;

    expect(done.state).toBe('cancelled');
    expect(took).toBeLessThan(10_000);
    expect(done.cancelled_by).toMatchObject({ id: bob });
    expect(done.failure).toBeNull();
    expect(done.finished_at).not.toBeNull();
    // No request was sent after the cancel, and the one in flight was abandoned.
    expect(stub.requests).toHaveLength(sentBefore);
    expect(embeddingRequests(stub)).toHaveLength(0);
    // The request that was abandoned is a request that was made, and its usage is stored as far as the layer reports it.
    const detail = await getDetail(kdb, id);
    expect(detail?.usage).toHaveLength(1);
    expect(detail?.usage[0]).toMatchObject({ operation: 'generate', outcome: 'cancelled' });
    expect(detail?.result).toMatchObject({ generation: { status: 'cancelled' }, embeddings: { status: 'not_run' } });
  }, 25_000);

  it('does the same quickly with short intervals, and the worker goes on to the next job', async () => {
    stub.setFallback(() => 'hang');
    const first = await queueCheck(alice);
    await run();
    await inFlight();
    await cancelJob(kdb, first, bob);
    await waitForState(first, ['cancelled'], 3000);

    stub.setFallback(answerBoth());
    const second = await queueCheck(alice);
    expect((await waitForState(second, ['succeeded', 'failed'], 5000)).state).toBe('succeeded');
  });

  it('ends as cancelled when another worker process is the one holding the job, sharing only the database (SC-003)', async () => {
    stub.setFallback(() => 'hang');
    const id = await queueCheck(alice);
    const a = await run();
    const b = await run();
    await inFlight();
    const holder = (await getJob(kdb, id))?.state;
    expect(holder).toBe('running');
    const sentBefore = stub.requests.length;

    await cancelJob(kdb, id, bob);
    const done = await waitForState(id, ['cancelled', 'succeeded', 'failed'], 3000);
    expect(done.state).toBe('cancelled');
    // The other worker did not pick the job up again, and nothing more reached the stub.
    await sleep(FAST.pollMs * 8);
    expect((await getJob(kdb, id))?.state).toBe('cancelled');
    expect(stub.requests).toHaveLength(sentBefore);
    expect(a.id).not.toBe(b.id);
  });

  it('does not send the second request when the cancel arrives between the two: the gate before each request (FR-042)', async () => {
    const id = await queueCheck(alice);
    // The heartbeat is too slow to notice anything, so only the gate before the embedding request can stop the job.
    const slow: Timings = { ...FAST, heartbeatMs: 60_000, leaseMs: 120_000 };
    stub.setFallback((r: RecordedRequest): Scripted => {
      if (r.path.endsWith('/embeddings')) return answerBoth()(r);
      // The cancel is asked while the generation request is in flight, and its answer arrives later.
      void cancelJob(kdb, id, bob);
      return { delay: 250, then: openaiCompletion({ content: '{"status":"ok"}', usage: { prompt_tokens: 64, completion_tokens: 9, total_tokens: 73 } }) };
    });
    await run(slow);
    const done = await waitForState(id, ['cancelled', 'succeeded', 'failed'], 5000);
    expect(done.state).toBe('cancelled');
    expect(generationRequests(stub)).toHaveLength(1);
    expect(embeddingRequests(stub)).toHaveLength(0);
    // The generation request finished and counts; the embedding request was never made.
    const detail = await getDetail(kdb, id);
    expect(detail?.usage).toHaveLength(1);
    expect(detail?.result).toMatchObject({ generation: { status: 'ok' }, embeddings: { status: 'not_run' } });
  });

  it('ends as cancelled and not as succeeded when the cancel arrives as the last request finishes', async () => {
    const id = await queueCheck(alice);
    const slow: Timings = { ...FAST, heartbeatMs: 60_000, leaseMs: 120_000 };
    stub.setFallback((r: RecordedRequest): Scripted => {
      if (r.path.endsWith('/embeddings')) {
        void cancelJob(kdb, id, bob);
        return { delay: 200, then: answerBoth()(r) };
      }
      return answerBoth()(r);
    });
    await run(slow);
    const done = await waitForState(id, ['cancelled', 'succeeded', 'failed'], 5000);
    // Both requests were made and the work is done, but a cancel was asked, and a cancel wins.
    expect(done.state).toBe('cancelled');
    expect((await getDetail(kdb, id))?.usage).toHaveLength(2);
  });
});

describe('a queued job (FR-030)', () => {
  it('is never claimed by a worker started after it was cancelled', async () => {
    stub.setFallback(answerBoth());
    const id = await queueCheck(alice);
    expect(await cancelJob(kdb, id, bob)).toMatchObject({ state: 'cancelled' });
    await run();
    await sleep(FAST.pollMs * 8);
    expect(stub.requests).toHaveLength(0);
    expect(await getJob(kdb, id)).toMatchObject({ state: 'cancelled', run: 0 });
  });

  it('leaves the other queued jobs to run', async () => {
    stub.setFallback(answerBoth());
    const cancelled = await queueCheck(alice);
    const kept = await queueCheck(alice);
    await cancelJob(kdb, cancelled, bob);
    await run();
    expect((await waitForState(kept, ['succeeded', 'failed'], 5000)).state).toBe('succeeded');
    expect((await getJob(kdb, cancelled))?.state).toBe('cancelled');
  });
});
