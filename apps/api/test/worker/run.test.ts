import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLlmWithEndpoints, openaiError, resetCapabilityOverrides, startStub, type Stub } from '@scrylux/llm/testing';
import db, { kdb } from '../../src/db.js';
import { getDetail, getJob, workerAlive } from '../../src/jobs/store.js';
import { runCheck } from '../../src/llm-check.js';
import { startWorker, type Worker } from '../../src/worker/loop.js';
import {
  FAST, answerBoth, captureLog, clientFor, embeddingRequests, generationRequests, localConfig, makeUser, queueCheck, resetJobTables,
  sleep, waitFor, waitForState, watch,
} from './helpers.js';

// The worker runs a provider check from the queue to its end (Phase 3 Milestone 2, US1, US6): the states and steps a
// person sees, the usage it stores, the failure it reports. It runs in-process against a stub provider, with shortened
// timings, and shares only the database with whatever else the test starts.

let stub: Stub;
let alice: number;
let worker: Worker | undefined;

beforeEach(async () => {
  resetCapabilityOverrides();
  await resetJobTables();
  alice = await makeUser();
  stub = await startStub();
});

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await stub.close();
});

async function run(options: { embeddings?: boolean; concurrency?: number } = {}): Promise<Worker> {
  const config = localConfig(stub.url, options.embeddings === undefined ? {} : { embeddings: options.embeddings });
  worker = await startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings: FAST, ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }) });
  return worker;
}

describe('a provider check that works', () => {
  it('goes from queued to running to succeeded, one step after the other, and stores what it used (US1)', async () => {
    stub.setFallback(answerBoth(120));
    const id = await queueCheck(alice);
    const seen = watch(id);
    const log = captureLog();
    await sleep(40); // long enough for the queued state to be seen before a worker exists
    await run();
    const done = await waitForState(id, ['succeeded', 'failed']);
    await seen.stop();
    const lines = log.lines().filter((l) => l.event === 'job' && l.job_id === id);
    log.restore();

    expect(done.state).toBe('succeeded');
    expect(seen.states).toEqual(['queued', 'running', 'succeeded']);
    expect(seen.steps).toEqual(['generation', 'embeddings']);
    expect(done).toMatchObject({ run: 1, failure: null, finished_at: expect.any(String) as unknown, worker_lost: false });

    // One usage record per operation, with Milestone 1's fields (FR-050).
    const detail = await getDetail(kdb, id);
    expect(detail?.usage).toHaveLength(2);
    expect(detail?.usage[0]).toMatchObject({
      run: 1, operation: 'generate', provider: 'openai-compatible', model: 'llama3.2', outcome: 'ok', attempts: 1,
      input_tokens: 64, output_tokens: 9, tokens_estimated: false, cost_usd: null, price_source: 'none', temperature_applied: true,
    });
    expect(detail?.usage[1]).toMatchObject({ operation: 'embed', model: 'nomic-embed-text', input_tokens: 9, output_tokens: 0, temperature_applied: null });
    expect(detail?.totals).toMatchObject({ requests: 2, input_tokens: 73, output_tokens: 9, cost_usd: null, cost_cap_applied: false });

    // The result of a provider check: no key, no address (FR-091).
    expect(detail?.result).toEqual({
      generation: { status: 'ok', provider: 'openai-compatible', model: 'llama3.2', hosted: false, usage_id: detail?.usage[0]?.id },
      embeddings: { status: 'ok', provider: 'openai-compatible', model: 'nomic-embed-text', hosted: false, usage_id: detail?.usage[1]?.id },
    });
    expect(JSON.stringify(detail)).not.toContain(stub.url);

    // One line for each change of state, with the totals so far and no content (FR-009).
    expect(lines.map((l) => l.state)).toEqual(['running', 'succeeded']);
    expect(lines[1]).toMatchObject({ kind: 'provider_check', run: 1, input_tokens: 73, output_tokens: 9, cost_usd: null });
    expect(Object.keys(lines[1] ?? {}).sort()).toEqual(['cost_usd', 'event', 'input_tokens', 'job_id', 'kind', 'output_tokens', 'run', 'state']);
  });

  it('sends the check’s fixed request and nothing a person typed (FR-093)', async () => {
    stub.setFallback(answerBoth());
    const id = await queueCheck(alice);
    await run();
    await waitForState(id, ['succeeded']);
    const body = JSON.stringify(generationRequests(stub)[0]?.body);
    expect(body).toContain('connection check');
    expect(embeddingRequests(stub)).toHaveLength(1);
  });

  it('does not fail for an operation that is not configured, and says so (FR-092)', async () => {
    stub.setFallback(answerBoth());
    const id = await queueCheck(alice);
    await run({ embeddings: false });
    expect((await waitForState(id, ['succeeded', 'failed'])).state).toBe('succeeded');
    expect((await getDetail(kdb, id))?.result).toMatchObject({ embeddings: { status: 'not_configured' } });
    expect((await getDetail(kdb, id))?.result?.embeddings).not.toHaveProperty('provider');
    expect(embeddingRequests(stub)).toHaveLength(0);
    expect((await getDetail(kdb, id))?.usage).toHaveLength(1);
  });
});

describe('a provider check that fails', () => {
  it('ends as failed after one run when the key is refused, with the message and the hint of that operation (US1)', async () => {
    stub.setFallback((r) => (r.path.endsWith('/embeddings') ? answerBoth()(r) : openaiError(401, 'Incorrect API key provided: sk-canary-1234')));
    const id = await queueCheck(alice);
    await run();
    const done = await waitForState(id, ['failed', 'succeeded']);
    expect(done.state).toBe('failed');
    expect(done.run).toBe(1);
    expect(done.failure?.category).toBe('not_authorized');
    expect(done.failure?.hint).toContain('LLM_API_KEY');
    expect(JSON.stringify(done)).not.toContain('canary');
    const detail = await getDetail(kdb, id);
    // The operation that failed is shown, and so is the one that worked (FR-092).
    expect(detail?.result?.generation).toMatchObject({ status: 'not_authorized', message: expect.any(String) as unknown, hint: expect.stringContaining('LLM_API_KEY') as unknown });
    expect(detail?.result?.embeddings.status).toBe('ok');
    // The refused request is still a request that was made, and its usage is stored.
    expect(detail?.usage[0]).toMatchObject({ operation: 'generate', outcome: 'not_authorized' });
    expect(JSON.stringify(detail)).not.toContain('canary');
  });

  it('names the embedding settings when embeddings are what failed', async () => {
    stub.setFallback((r) => (r.path.endsWith('/embeddings') ? openaiError(404, 'model not found') : answerBoth()(r)));
    const id = await queueCheck(alice);
    await run();
    const done = await waitForState(id, ['failed', 'succeeded']);
    expect(done.failure?.category).toBe('not_available');
    expect(done.failure?.hint).toContain('EMBEDDING_MODEL');
  });

  it('ends as failed with the first failing operation’s category when both fail', async () => {
    stub.setFallback((r) => (r.path.endsWith('/embeddings') ? openaiError(404, 'model not found') : openaiError(401, 'bad key')));
    const id = await queueCheck(alice);
    await run();
    const done = await waitForState(id, ['failed']);
    expect(done.failure?.category).toBe('not_authorized');
  });
});

describe('one operation that works and one that fails (FR-092, FR-093)', () => {
  it('fails with the failing operation’s category, shows the result of the one that worked, and stores both operations’ usage', async () => {
    stub.setFallback((r) => (r.path.endsWith('/embeddings') ? openaiError(404, 'model not found') : answerBoth()(r)));
    const id = await queueCheck(alice);
    await run();
    const done = await waitForState(id, ['failed', 'succeeded']);
    expect(done.state).toBe('failed');
    expect(done.failure?.category).toBe('not_available');
    const detail = await getDetail(kdb, id);
    expect(detail?.result).toMatchObject({
      generation: { status: 'ok', provider: 'openai-compatible', model: 'llama3.2', hosted: false },
      embeddings: { status: 'not_available', provider: 'openai-compatible', model: 'nomic-embed-text', hosted: false, hint: expect.stringContaining('EMBEDDING_MODEL') as unknown },
    });
    expect(detail?.usage.map((u) => [u.operation, u.outcome])).toEqual([['generate', 'ok'], ['embed', 'not_available']]);
    // The first operation’s usage still counts toward the job’s totals.
    expect(detail?.totals.requests).toBe(2);
  });

  it('sends exactly the request the operator’s command sends: the fixed check, and nothing a person typed', async () => {
    stub.setFallback(answerBoth());
    const id = await queueCheck(alice);
    await run({ embeddings: false });
    await waitForState(id, ['succeeded', 'failed']);
    const fromJob = generationRequests(stub)[0]?.body;

    const commandStub = await startStub();
    try {
      commandStub.setFallback(answerBoth());
      const env = { LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'llama3.2', LLM_BASE_URL: `${commandStub.url}/v1`, LLM_LOCAL: 'true' };
      const out: string[] = [];
      const code = await runCheck({
        env,
        keys: {},
        stdout: { write: (text: string) => out.push(text) },
        stderr: { write: () => true },
        createLlm: (config, options) => createLlmWithEndpoints(config, { ...options, endpoints: {}, deps: { sleep: () => Promise.resolve(), random: () => 0 } }),
      });
      expect(code).toBe(0);
      const fromCommand = generationRequests(commandStub)[0]?.body;
      expect(fromJob).toBeDefined();
      expect(fromJob).toEqual(fromCommand);
    } finally {
      await commandStub.close();
    }
    expect(JSON.stringify(fromJob)).toContain('connection check');
  });
});

describe('a provider check queued while no provider is configured', () => {
  it('fails as not configured, once, and sends nothing (spec edge case “No provider configured”)', async () => {
    const id = await queueCheck(alice);
    const config = localConfig(stub.url, { embeddings: false });
    const none = { ...config, generation: null };
    worker = await startWorker({ db: kdb, llm: clientFor(none), llmConfig: none, timings: FAST });
    const done = await waitForState(id, ['failed', 'succeeded']);
    expect(done.state).toBe('failed');
    expect(done.run).toBe(1);
    expect(done.failure?.category).toBe('not_configured');
    expect(stub.requests).toHaveLength(0);
    expect((await getDetail(kdb, id))?.usage).toHaveLength(0);
  });
});

describe('the worker’s own row (FR-008)', () => {
  it('is alive while the worker runs, and not after it stops', async () => {
    stub.setFallback(answerBoth());
    expect(await workerAlive(kdb, FAST.aliveWithinMs)).toBe(false);
    const w = await run();
    expect(await workerAlive(kdb, FAST.aliveWithinMs)).toBe(true);
    // It reports again and again: last_seen_at moves.
    const { rows: before } = await db.query<{ last_seen_at: Date }>('SELECT last_seen_at FROM workers WHERE id = $1', [w.id]);
    await sleep(FAST.reportMs * 3);
    const { rows: after } = await db.query<{ last_seen_at: Date }>('SELECT last_seen_at FROM workers WHERE id = $1', [w.id]);
    expect(after[0]?.last_seen_at.getTime()).toBeGreaterThan(before[0]?.last_seen_at.getTime() ?? Infinity);
    await w.stop();
    worker = undefined;
    expect(await workerAlive(kdb, FAST.aliveWithinMs)).toBe(false);
    expect((await db.query('SELECT 1 FROM workers WHERE id = $1', [w.id])).rowCount).toBe(0);
  });

  it('is not alive once its row is older than the window, with the worker gone without a word', async () => {
    const w = await run();
    await w.abandon();
    worker = undefined;
    await db.query(`UPDATE workers SET last_seen_at = now() - interval '1 minute' WHERE id = $1`, [w.id]);
    expect(await workerAlive(kdb, 30_000)).toBe(false);
    await db.query(`UPDATE workers SET last_seen_at = now() WHERE id = $1`, [w.id]);
    expect(await workerAlive(kdb, 30_000)).toBe(true);
  });

  it('is not alive while it is stopping', async () => {
    const w = await run();
    await db.query('UPDATE workers SET stopping = true WHERE id = $1', [w.id]);
    expect(await workerAlive(kdb, 30_000)).toBe(false);
  });

  it('removes the rows of workers not seen for a day when a worker starts', async () => {
    await db.query(`INSERT INTO workers (id, last_seen_at) VALUES (gen_random_uuid(), now() - interval '25 hours')`);
    await db.query(`INSERT INTO workers (id, last_seen_at) VALUES (gen_random_uuid(), now() - interval '1 hour')`);
    await run();
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM workers');
    expect(rows[0]?.n).toBe(2);
  });
});

describe('concurrency (FR-006)', () => {
  /** The most jobs this worker held at once, from polling the table while five jobs of 250 ms run. */
  async function mostAtOnce(concurrency?: number): Promise<{ most: number; done: number }> {
    stub.setFallback((r) => answerBoth(250)(r));
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await queueCheck(alice));
    const w = await run({ embeddings: false, ...(concurrency === undefined ? {} : { concurrency }) });
    let most = 0;
    const timer = setInterval(() => {
      void db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE state = 'running' AND worker_id = $1`, [w.id]).then(({ rows }) => {
        most = Math.max(most, rows[0]?.n ?? 0);
      });
    }, 5);
    await waitFor(async () => {
      const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE state = 'succeeded'`);
      return rows[0]?.n === 5 ? true : undefined;
    }, 15_000, 'all five jobs');
    clearInterval(timer);
    return { most, done: ids.length };
  }

  it('runs at most the number of jobs it was told to, and uses all of it', async () => {
    const { most, done } = await mostAtOnce(2);
    expect(done).toBe(5);
    expect(most).toBe(2);
  });

  it('runs one job at a time by default', async () => {
    const { most } = await mostAtOnce();
    expect(most).toBe(1);
  });
});

describe('progress (FR-015)', () => {
  it('never goes backwards within a run: generation, then embeddings', async () => {
    stub.setFallback(answerBoth(60));
    const id = await queueCheck(alice);
    const seen = watch(id);
    await run();
    await waitForState(id, ['succeeded']);
    await seen.stop();
    const order = ['generation', 'embeddings'];
    const indexes = seen.steps.map((s) => order.indexOf(s));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(indexes).not.toContain(-1);
  });
});

describe('a worker with nothing to do', () => {
  it('leaves a job that has ended as it is', async () => {
    stub.setFallback(answerBoth());
    const id = await queueCheck(alice);
    await run();
    const done = await waitForState(id, ['succeeded']);
    await sleep(FAST.pollMs * 5);
    expect(await getJob(kdb, id)).toEqual(done);
  });
});
