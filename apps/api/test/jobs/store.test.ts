import { randomBytes, randomUUID } from 'node:crypto';
import { JobRecord } from '@scrylux/core';
import type { Usage } from '@scrylux/llm';
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import db, { kdb } from '../../src/db.js';
import { JobFinishedError, JobLimitError, cancelJob, claimJob, enqueue, finishRun, gate, getJob, handBack, listJobs, nextAllowedAt, recordUsage, sweep, writeProgress, type JobSettings, type RunCommit } from '../../src/jobs/store.js';

// The job store against the real database (Phase 3 Milestone 2, data-model.md). This file runs in the `jobs` group, one
// file at a time (apps/api/vitest.config.ts), and starts every test from empty job tables, because a worker claims any
// queued job in the shared test database.

const SETTINGS: JobSettings = {
  tokenCap: 500_000,
  costCapUsd: 5,
  maxRuns: 3,
  timeLimitMs: 3_600_000,
  jobsPerAccount: 100,
  providerCheckCooldownMs: 0,
};

async function makeUser(): Promise<number> {
  const { rows } = await db.query<{ id: number }>('INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id', [
    `jobs-test-store-${randomUUID()}`,
    'not-a-real-hash',
  ]);
  const row = rows[0];
  if (!row) throw new Error('no user');
  return row.id;
}

let alice: number;
let bob: number;

beforeEach(async () => {
  await db.query('TRUNCATE jobs, job_usage, workers');
  alice = await makeUser();
  bob = await makeUser();
});

const queue = (accountId = alice, settings: JobSettings = SETTINGS): Promise<string> =>
  enqueue(kdb, { kind: 'provider_check', input: {}, accountId }, settings);

/** A usage record as Milestone 1's layer returns it. */
function usage(over: Partial<Usage> = {}): Usage {
  return {
    operation: 'generate',
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    outcome: 'ok',
    attempts: 1,
    inputTokens: 100,
    outputTokens: 20,
    tokensEstimated: false,
    costUsd: 0.0005,
    costEstimated: false,
    priceSource: 'list',
    temperatureApplied: true,
    durationMs: 800,
    ...over,
  };
}

async function row(id: string): Promise<Record<string, unknown>> {
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM jobs WHERE id = $1', [id]);
  const found = rows[0];
  if (!found) throw new Error('no such job');
  return found;
}

async function setRow(id: string, set: string, values: unknown[] = []): Promise<void> {
  // `set` is a fixed fragment written in this file, never a value.
  await db.query(`UPDATE jobs SET ${set} WHERE id = $1`, [id, ...values]);
}

describe('enqueue and getJob', () => {
  it('queues a job with the caps, runs and time limit of the settings copied onto it (FR-040, FR-045)', async () => {
    const id = await queue(alice, { ...SETTINGS, tokenCap: 123_456, costCapUsd: 2.5, maxRuns: 4, timeLimitMs: 90_000 });
    const found = await getJob(kdb, id);
    expect(found).toMatchObject({
      id,
      kind: 'provider_check',
      state: 'queued',
      run: 0,
      max_runs: 4,
      caps: { tokens: 123_456, cost_usd: 2.5 },
      started_at: null,
      finished_at: null,
      next_run_at: null,
      deadline_at: null,
      cancelled_by: null,
      cancel_requested: false,
      worker_lost: false,
      progress: null,
      failure: null,
    });
    expect(Number((await row(id)).time_limit_ms)).toBe(90_000);
    // The record is what the API sends, so it parses with the shared schema.
    expect(() => JobRecord.parse(found)).not.toThrow();
  });

  it('names who started it', async () => {
    const id = await queue(bob);
    expect((await getJob(kdb, id))?.started_by).toMatchObject({ id: bob });
    expect((await getJob(kdb, id))?.started_by.username).toMatch(/^jobs-test-store-/);
  });

  it('returns undefined for a job that does not exist', async () => {
    expect(await getJob(kdb, randomUUID())).toBeUndefined();
  });

  it('shows no input beyond what the kind takes, and stores the empty object', async () => {
    const id = await queue();
    expect((await row(id)).input).toEqual({});
  });
});

describe('listJobs', () => {
  it('lists newest first by queued time, ties by id descending', async () => {
    const ids = [await queue(), await queue(), await queue()];
    // The same instant for the last two: the order falls back to the id, descending.
    await db.query(`UPDATE jobs SET queued_at = '2030-01-01T00:00:00Z' WHERE id = ANY($1)`, [ids.slice(1)]);
    await setRow(ids[0] as string, `queued_at = '2029-01-01T00:00:00Z'`);
    const { jobs } = await listJobs(kdb, { limit: 25, offset: 0 });
    const tied = [...ids.slice(1)].sort().reverse();
    expect(jobs.map((j) => j.id)).toEqual([...tied, ids[0]]);
  });

  it('pages with limit and offset, and says whether there is more', async () => {
    for (let i = 0; i < 5; i++) await queue();
    const first = await listJobs(kdb, { limit: 2, offset: 0 });
    expect(first.jobs).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const last = await listJobs(kdb, { limit: 2, offset: 4 });
    expect(last.jobs).toHaveLength(1);
    expect(last.hasMore).toBe(false);
    const exact = await listJobs(kdb, { limit: 5, offset: 0 });
    expect(exact.jobs).toHaveLength(5);
    expect(exact.hasMore).toBe(false);
    const all = [...first.jobs, ...(await listJobs(kdb, { limit: 2, offset: 2 })).jobs, ...last.jobs].map((j) => j.id);
    expect(new Set(all).size).toBe(5);
  });

  it('lists every account’s jobs, with the starter’s username', async () => {
    await queue(alice);
    await queue(bob);
    const { jobs } = await listJobs(kdb, { limit: 25, offset: 0 });
    expect(jobs.map((j) => j.started_by.id).sort()).toEqual([alice, bob].sort());
  });

  it('shows next_run_at only while a job is queued and waiting for a later run', async () => {
    const waiting = await queue();
    const due = await queue();
    await setRow(waiting, `next_run_at = now() + interval '5 minutes', run = 1`);
    const byId = new Map((await listJobs(kdb, { limit: 25, offset: 0 })).jobs.map((j) => [j.id, j]));
    expect(byId.get(waiting)?.next_run_at).not.toBeNull();
    expect(byId.get(due)?.next_run_at).toBeNull();
  });

  it('marks a running job whose lease has passed as worker_lost, and no other (FR-062)', async () => {
    const live = await queue();
    const lost = await queue();
    const queued = await queue();
    for (const [id, lease] of [[live, '+ interval \'30 seconds\''], [lost, '- interval \'1 second\'']] as const) {
      await setRow(id, `state = 'running', run = 1, claim = 1, worker_id = $2, lease_expires_at = now() ${lease}, started_at = now(), deadline_at = now() + interval '1 hour'`, [randomUUID()]);
    }
    const byId = new Map((await listJobs(kdb, { limit: 25, offset: 0 })).jobs.map((j) => [j.id, j]));
    expect(byId.get(live)?.worker_lost).toBe(false);
    expect(byId.get(lost)?.worker_lost).toBe(true);
    expect(byId.get(queued)?.worker_lost).toBe(false);
    expect((await getJob(kdb, lost))?.worker_lost).toBe(true);
  });
});

describe('totals are summed from the usage records (FR-050, SC-006)', () => {
  it('are zero, with a known cost, before any request', async () => {
    const id = await queue();
    expect((await getJob(kdb, id))?.totals).toEqual({
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      tokens_estimated: false,
      cost_usd: 0,
      cost_known_usd: 0,
      cost_estimated: false,
      cost_cap_applied: true,
      duration_ms: 0,
    });
  });

  it('equal the sum of one record, and of three', async () => {
    const id = await queue();
    await recordUsage(kdb, id, 1, usage());
    expect((await getJob(kdb, id))?.totals).toMatchObject({ requests: 1, input_tokens: 100, output_tokens: 20, duration_ms: 800 });
    await recordUsage(kdb, id, 1, usage({ operation: 'embed', inputTokens: 10, outputTokens: 0, costUsd: 0.0001, durationMs: 100, temperatureApplied: null }));
    await recordUsage(kdb, id, 2, usage({ inputTokens: 50, outputTokens: 5, costUsd: 0.0002, durationMs: 300 }));
    const totals = (await getJob(kdb, id))?.totals;
    expect(totals).toMatchObject({ requests: 3, input_tokens: 160, output_tokens: 25, duration_ms: 1200, tokens_estimated: false, cost_cap_applied: true });
    expect(totals?.cost_usd).toBeCloseTo(0.0008, 9);
    expect(totals?.cost_known_usd).toBeCloseTo(0.0008, 9);
  });

  it('report an unknown cost as null with the known part, and say the cost cap could not be applied (FR-043)', async () => {
    const id = await queue();
    await recordUsage(kdb, id, 1, usage({ costUsd: 0.001 }));
    await recordUsage(kdb, id, 1, usage({ operation: 'embed', provider: 'openai-compatible', model: 'nomic', costUsd: null, priceSource: 'none', outputTokens: 0, temperatureApplied: null }));
    const totals = (await getJob(kdb, id))?.totals;
    expect(totals).toMatchObject({ cost_usd: null, cost_cap_applied: false });
    expect(totals?.cost_known_usd).toBeCloseTo(0.001, 9);
  });

  it('say when any token count or cost was estimated', async () => {
    const id = await queue();
    await recordUsage(kdb, id, 1, usage());
    expect((await getJob(kdb, id))?.totals).toMatchObject({ tokens_estimated: false, cost_estimated: false });
    await recordUsage(kdb, id, 1, usage({ tokensEstimated: true, costEstimated: true }));
    expect((await getJob(kdb, id))?.totals).toMatchObject({ tokens_estimated: true, cost_estimated: true });
  });

  it('refuse a record with no provider or model, which a made request always has', async () => {
    const id = await queue();
    await expect(recordUsage(kdb, id, 1, usage({ provider: null }))).rejects.toThrow();
    await expect(recordUsage(kdb, id, 1, usage({ model: null }))).rejects.toThrow();
  });

  it('hold no prompt, answer, key or address: the columns are only the usage record’s', async () => {
    const id = await queue();
    await recordUsage(kdb, id, 1, usage());
    const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM job_usage WHERE job_id = $1', [id]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'attempts', 'cost_estimated', 'cost_usd', 'duration_ms', 'id', 'input_tokens', 'job_id', 'model', 'operation', 'outcome',
      'output_tokens', 'price_source', 'provider', 'recorded_at', 'run', 'temperature_applied', 'tokens_estimated',
    ]);
  });
});

describe('claimJob', () => {
  const worker = (): string => randomUUID();

  it('takes the oldest queued job first, and each job once', async () => {
    const first = await queue();
    const second = await queue();
    const third = await queue();
    await setRow(first, `queued_at = now() - interval '3 minutes'`);
    await setRow(second, `queued_at = now() - interval '2 minutes'`);
    await setRow(third, `queued_at = now() - interval '1 minute'`);
    const a = await claimJob(kdb, worker());
    const b = await claimJob(kdb, worker());
    const c = await claimJob(kdb, worker());
    expect([a?.id, b?.id, c?.id]).toEqual([first, second, third]);
    expect(await claimJob(kdb, worker())).toBeNull();
  });

  it('skips a job whose next run is not due yet', async () => {
    const later = await queue();
    const due = await queue();
    await setRow(later, `next_run_at = now() + interval '10 minutes', queued_at = now() - interval '1 hour', run = 1`);
    expect((await claimJob(kdb, worker()))?.id).toBe(due);
    expect(await claimJob(kdb, worker())).toBeNull();
  });

  it('returns null when nothing is queued', async () => {
    expect(await claimJob(kdb, worker())).toBeNull();
  });

  it('sets the job running with a lease, the first run, the claim number and the deadline from the time limit', async () => {
    const id = await queue(alice, { ...SETTINGS, timeLimitMs: 90_000 });
    const workerId = worker();
    const claimed = await claimJob(kdb, workerId);
    expect(claimed).toMatchObject({ id, kind: 'provider_check', run: 1, maxRuns: 3, claim: 1 });
    const found = await row(id);
    expect(found).toMatchObject({ state: 'running', run: 1, worker_id: workerId });
    expect(Number(found.claim)).toBe(1);
    const { rows } = await db.query<{ lease: number; limit: number }>(
      `SELECT extract(epoch FROM lease_expires_at - now()) AS lease, extract(epoch FROM deadline_at - started_at) AS "limit" FROM jobs WHERE id = $1`,
      [id],
    );
    expect(Number(rows[0]?.lease)).toBeGreaterThan(25);
    expect(Number(rows[0]?.lease)).toBeLessThanOrEqual(30);
    expect(Number(rows[0]?.limit)).toBeCloseTo(90, 3);
    expect((await getJob(kdb, id))?.state).toBe('running');
  });

  it('keeps started_at and the deadline on a later run, and adds one to run and to claim', async () => {
    const id = await queue();
    await claimJob(kdb, worker());
    const first = await row(id);
    // The first run ended with a transient failure: the job is queued again (the rule itself is tested with finishRun).
    await setRow(id, `state = 'queued', worker_id = NULL, lease_expires_at = NULL, next_run_at = now()`);
    const again = await claimJob(kdb, worker());
    expect(again).toMatchObject({ id, run: 2, claim: 2 });
    const second = await row(id);
    expect(second.started_at).toEqual(first.started_at);
    expect(second.deadline_at).toEqual(first.deadline_at);
  });

  it('gives two claimers at once two different jobs', async () => {
    await queue();
    await queue();
    const [a, b] = await Promise.all([claimJob(kdb, worker()), claimJob(kdb, worker())]);
    expect(a?.id).toBeDefined();
    expect(b?.id).toBeDefined();
    expect(a?.id).not.toBe(b?.id);
  });
});

describe('fencing: a worker that lost its job cannot write to it (FR-005)', () => {
  async function held(): Promise<{ id: string; claim: number }> {
    const id = await queue();
    const claimed = await claimJob(kdb, randomUUID());
    if (!claimed) throw new Error('nothing claimed');
    return { id, claim: claimed.claim };
  }

  it('lets the holder write progress and finish', async () => {
    const job = await held();
    expect(await writeProgress(kdb, job, { step: 'generation' })).toBe(true);
    expect((await getJob(kdb, job.id))?.progress).toEqual({ step: 'generation' });
    expect(await writeProgress(kdb, job, { step: 'embeddings', done: 1, total: 2 })).toBe(true);
    expect((await getJob(kdb, job.id))?.progress).toEqual({ step: 'embeddings', done: 1, total: 2 });
  });

  it('refuses progress from a stale claim and changes nothing', async () => {
    const job = await held();
    expect(await writeProgress(kdb, { ...job, claim: job.claim - 1 }, { step: 'embeddings' })).toBe(false);
    expect((await getJob(kdb, job.id))?.progress).toBeNull();
  });

  it('refuses to finish from a stale claim, reports the job as lost and changes nothing', async () => {
    const job = await held();
    const stale = { ...job, claim: job.claim - 1 };
    expect(await finishRun(kdb, stale, { kind: 'succeeded', result: { generation: { status: 'ok' }, embeddings: { status: 'not_configured' } } })).toBe('lost');
    expect(await finishRun(kdb, stale, { kind: 'failed', category: 'job_error' })).toBe('lost');
    expect((await row(job.id)).state).toBe('running');
    expect((await row(job.id)).result).toBeNull();
  });

  it('refuses a write to a job that is no longer running', async () => {
    const job = await held();
    await finishRun(kdb, job, { kind: 'succeeded' });
    expect(await writeProgress(kdb, job, { step: 'generation' })).toBe(false);
    expect(await finishRun(kdb, job, { kind: 'failed', category: 'job_error' })).toBe('lost');
    expect((await row(job.id)).state).toBe('succeeded');
  });

  it('does not fence the usage records: a request that was made counts whoever records it (FR-041)', async () => {
    const job = await held();
    await finishRun(kdb, job, { kind: 'succeeded' });
    await recordUsage(kdb, job.id, 1, usage());
    expect((await getJob(kdb, job.id))?.totals.requests).toBe(1);
  });
});

describe('finishRun', () => {
  async function held(): Promise<{ id: string; claim: number }> {
    const id = await queue();
    const claimed = await claimJob(kdb, randomUUID());
    if (!claimed) throw new Error('nothing claimed');
    return { id, claim: claimed.claim };
  }

  it('ends a job as succeeded with its finish time and result, releasing the lease', async () => {
    const job = await held();
    const result = { generation: { status: 'ok', provider: 'anthropic', model: 'm', hosted: true, usage_id: 1 }, embeddings: { status: 'not_configured' } };
    expect(await finishRun(kdb, job, { kind: 'succeeded', result })).toBe('succeeded');
    const found = await row(job.id);
    expect(found).toMatchObject({ state: 'succeeded', worker_id: null, lease_expires_at: null, result });
    expect(found.finished_at).toBeInstanceOf(Date);
    expect((await getJob(kdb, job.id))?.finished_at).not.toBeNull();
  });

  it('ends a job as failed with its category, and the message and hint of failures.yaml (FR-064)', async () => {
    const job = await held();
    expect(await finishRun(kdb, job, { kind: 'failed', category: 'timed_out' })).toBe('failed');
    const found = await getJob(kdb, job.id);
    expect(found?.state).toBe('failed');
    expect(found?.failure).toEqual({ category: 'timed_out', message: 'The job ran out of time.', hint: expect.stringContaining('JOB_TIME_LIMIT') as unknown });
  });

  it('keeps the detail that chooses the “lower than one request” message (FR-044)', async () => {
    const job = await held();
    await finishRun(kdb, job, { kind: 'failed', category: 'cap_reached', detail: 'cap_below_one_request' });
    expect((await getJob(kdb, job.id))?.failure?.message).toMatch(/lower than one request/);
  });

  it('names the hint after the operation that failed: LLM for generation, EMBEDDING for embeddings', async () => {
    const a = await held();
    await finishRun(kdb, a, { kind: 'failed', category: 'not_authorized', result: { generation: { status: 'not_authorized' }, embeddings: { status: 'not_run' } } });
    expect((await getJob(kdb, a.id))?.failure?.hint).toContain('LLM_API_KEY');
    const b = await held();
    await finishRun(kdb, b, { kind: 'failed', category: 'not_authorized', result: { generation: { status: 'ok' }, embeddings: { status: 'not_authorized' } } });
    expect((await getJob(kdb, b.id))?.failure?.hint).toContain('EMBEDDING_API_KEY');
  });

  it('uses sql for nothing but parameters: a fixed-looking category from a caller is still only a value', async () => {
    const job = await held();
    // A category that is not one of the fourteen is refused by the database, not run as SQL.
    await expect(finishRun(kdb, job, { kind: 'failed', category: "job_error'; DROP TABLE jobs; --" as never })).rejects.toThrow();
    expect(Number((await sql<{ n: number }>`SELECT count(*)::int AS n FROM jobs`.execute(kdb)).rows[0]?.n)).toBe(1);
  });
});

describe('gate: the check before each model request (FR-030, FR-042, FR-022)', () => {
  async function held(): Promise<{ id: string; claim: number }> {
    const id = await queue();
    const claimed = await claimJob(kdb, randomUUID());
    if (!claimed) throw new Error('nothing claimed');
    return { id, claim: claimed.claim };
  }

  it('says ok for a job the worker holds, with what it has used so far: nothing at first', async () => {
    const job = await held();
    expect(await gate(kdb, job)).toEqual({ status: 'ok', usedTokens: 0, usedCostUsd: 0, costUnknown: false });
  });

  it('adds up the tokens of every record, estimated ones included, and every cost that is known', async () => {
    const job = await held();
    await recordUsage(kdb, job.id, 1, usage({ inputTokens: 100, outputTokens: 20, costUsd: 0.5 }));
    await recordUsage(kdb, job.id, 1, usage({ inputTokens: 40, outputTokens: 0, costUsd: 0.25, tokensEstimated: true, operation: 'embed', temperatureApplied: null }));
    expect(await gate(kdb, job)).toEqual({ status: 'ok', usedTokens: 160, usedCostUsd: 0.75, costUnknown: false });
  });

  it('counts the usage of an earlier run, which belongs to the job and not to the run (FR-041)', async () => {
    const job = await held();
    await recordUsage(kdb, job.id, 1, usage({ inputTokens: 10, outputTokens: 5, costUsd: 0.1 }));
    await setRow(job.id, 'run = 2');
    await recordUsage(kdb, job.id, 2, usage({ inputTokens: 1, outputTokens: 1, costUsd: 0.1 }));
    expect(await gate(kdb, job)).toMatchObject({ status: 'ok', usedTokens: 17 });
  });

  it('says the cost is unknown when any request’s price was, and sums the costs that are known', async () => {
    const job = await held();
    await recordUsage(kdb, job.id, 1, usage({ costUsd: 0.5 }));
    await recordUsage(kdb, job.id, 1, usage({ costUsd: null, priceSource: 'none' }));
    expect(await gate(kdb, job)).toMatchObject({ status: 'ok', usedCostUsd: 0.5, costUnknown: true });
  });

  it('says lost for a stale claim, and for a job that is no longer running', async () => {
    const job = await held();
    expect(await gate(kdb, { ...job, claim: job.claim - 1 })).toEqual({ status: 'lost' });
    await finishRun(kdb, job, { kind: 'succeeded' });
    expect(await gate(kdb, job)).toEqual({ status: 'lost' });
    expect(await gate(kdb, { id: randomUUID(), claim: 1 })).toEqual({ status: 'lost' });
  });

  it('says a cancel was requested, and that the deadline has passed', async () => {
    const asked = await held();
    await setRow(asked.id, `cancel_requested_at = now(), cancelled_by = ${alice}`);
    expect(await gate(kdb, asked)).toEqual({ status: 'cancel_requested' });

    const late = await held();
    await setRow(late.id, `deadline_at = now() - interval '1 second'`);
    expect(await gate(kdb, late)).toEqual({ status: 'deadline_passed' });
  });

  it('puts a lost job before a cancel, and a cancel before a deadline', async () => {
    const job = await held();
    await setRow(job.id, `cancel_requested_at = now(), cancelled_by = ${alice}, deadline_at = now() - interval '1 second'`);
    expect(await gate(kdb, job)).toEqual({ status: 'cancel_requested' });
    expect(await gate(kdb, { ...job, claim: job.claim - 1 })).toEqual({ status: 'lost' });
  });

  it('changes nothing: it only reads', async () => {
    const job = await held();
    const before = await row(job.id);
    await gate(kdb, job);
    expect(await row(job.id)).toEqual(before);
  });
});

describe('the limit on an account’s active jobs (FR-046)', () => {
  const three: JobSettings = { ...SETTINGS, jobsPerAccount: 3 };

  it('lets an account queue up to the limit and refuses the next, with a message that names the limit', async () => {
    for (let i = 0; i < 3; i++) await queue(alice, three);
    await expect(queue(alice, three)).rejects.toBeInstanceOf(JobLimitError);
    await expect(queue(alice, three)).rejects.toMatchObject({
      reason: 'limit',
      retryAfterSeconds: 30,
      message: 'You already have 3 jobs queued or running. Wait for one to finish, or cancel one.',
    });
    expect((await db.query('SELECT 1 FROM jobs')).rowCount).toBe(3);
  });

  it('says “1 job” and not “1 jobs”', async () => {
    const one: JobSettings = { ...SETTINGS, jobsPerAccount: 1 };
    await queue(alice, one);
    await expect(queue(alice, one)).rejects.toMatchObject({ message: 'You already have 1 job queued or running. Wait for one to finish, or cancel one.' });
  });

  it('counts running jobs as well as queued ones', async () => {
    for (let i = 0; i < 3; i++) await queue(alice, three);
    await claimJob(kdb, randomUUID());
    await expect(queue(alice, three)).rejects.toBeInstanceOf(JobLimitError);
  });

  it('does not count the jobs of another account', async () => {
    for (let i = 0; i < 3; i++) await queue(alice, three);
    await expect(queue(bob, three)).resolves.toEqual(expect.any(String));
  });

  it('frees a place when a job ends', async () => {
    for (let i = 0; i < 3; i++) await queue(alice, three);
    const claimed = await claimJob(kdb, randomUUID());
    if (!claimed) throw new Error('nothing claimed');
    await finishRun(kdb, claimed, { kind: 'succeeded' });
    await expect(queue(alice, three)).resolves.toEqual(expect.any(String));
    await expect(queue(alice, three)).rejects.toBeInstanceOf(JobLimitError);
  });

  it('holds when ten starts arrive at once: exactly the limit is queued', async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => queue(alice, three)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(7);
    for (const r of refused) expect(r.reason).toBeInstanceOf(JobLimitError);
    expect((await db.query('SELECT 1 FROM jobs WHERE created_by = $1', [alice])).rowCount).toBe(3);
  });

  it('uses a lock of its own: an account whose id is the migrator’s lock key is not held up by a migration', async () => {
    // The migrator holds pg_advisory_lock(727274) while it runs. The limit locks with the two-integer form, which has a key
    // space of its own, so an account whose id happens to be 727274 does not wait for a migration.
    await db.query(`INSERT INTO users (id, username, password_hash) VALUES (727274, $1, 'not-a-real-hash') ON CONFLICT DO NOTHING`, [`jobs-test-lock-${randomUUID()}`]);
    const client = await db.connect();
    try {
      await client.query('SELECT pg_advisory_lock(727274)');
      const outcome = await Promise.race([
        queue(727274, three).then(() => 'queued'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 2000)),
      ]);
      expect(outcome).toBe('queued');
    } finally {
      await client.query('SELECT pg_advisory_unlock(727274)');
      client.release();
    }
  });
});

describe('cancelJob (FR-030, FR-031, FR-032)', () => {
  async function running(): Promise<{ id: string; claim: number }> {
    const id = await queue();
    const claimed = await claimJob(kdb, randomUUID());
    if (!claimed) throw new Error('nothing claimed');
    return { id, claim: claimed.claim };
  }

  it('ends a queued job at once, with who cancelled it and when, so that it never starts', async () => {
    const id = await queue(alice);
    const cancelled = await cancelJob(kdb, id, bob);
    expect(cancelled).toMatchObject({ id, state: 'cancelled', cancelled_by: { id: bob }, cancel_requested: false });
    expect(cancelled?.finished_at).not.toBeNull();
    expect(await claimJob(kdb, randomUUID())).toBeNull();
    expect(await row(id)).toMatchObject({ state: 'cancelled', worker_id: null, lease_expires_at: null, cancelled_by: bob });
  });

  it('only records the request for a running job whose worker is alive, which then ends it', async () => {
    const job = await running();
    const asked = await cancelJob(kdb, job.id, bob);
    expect(asked).toMatchObject({ state: 'running', cancel_requested: true, cancelled_by: { id: bob }, finished_at: null });
    expect(await row(job.id)).toMatchObject({ state: 'running' });
    expect((await row(job.id)).cancel_requested_at).toBeInstanceOf(Date);
  });

  it('changes nothing the second time, whoever asks', async () => {
    const job = await running();
    await cancelJob(kdb, job.id, bob);
    const first = await row(job.id);
    const again = await cancelJob(kdb, job.id, alice);
    expect(again).toMatchObject({ state: 'running', cancel_requested: true, cancelled_by: { id: bob } });
    expect(await row(job.id)).toEqual(first);
  });

  it('ends a running job at once when its lease has expired, because its worker is gone (FR-030)', async () => {
    const job = await running();
    await setRow(job.id, `lease_expires_at = now() - interval '1 second'`);
    const cancelled = await cancelJob(kdb, job.id, alice);
    expect(cancelled).toMatchObject({ state: 'cancelled', cancelled_by: { id: alice }, worker_lost: false });
    expect(await row(job.id)).toMatchObject({ state: 'cancelled', worker_id: null, lease_expires_at: null });
  });

  it('ends a job at once when a cancel was asked while its lease was live and the lease has since expired', async () => {
    const job = await running();
    await cancelJob(kdb, job.id, bob);
    await setRow(job.id, `lease_expires_at = now() - interval '1 second'`);
    const cancelled = await cancelJob(kdb, job.id, alice);
    expect(cancelled).toMatchObject({ state: 'cancelled', cancelled_by: { id: bob } });
  });

  it.each([
    ['succeeded', {}],
    ['failed', { failure_category: 'job_error' }],
    ['cancelled', {}],
  ] as const)('refuses to cancel a job that has %s, and changes nothing (FR-032)', async (state, extra) => {
    const id = await queue();
    const columns = Object.keys(extra).length > 0 ? `, failure_category = '${(extra as { failure_category: string }).failure_category}'` : '';
    await setRow(id, `state = '${state}', finished_at = now()${columns}`);
    const before = await row(id);
    await expect(cancelJob(kdb, id, bob)).rejects.toBeInstanceOf(JobFinishedError);
    await expect(cancelJob(kdb, id, bob)).rejects.toMatchObject({ message: 'The job has already finished' });
    expect(await row(id)).toEqual(before);
  });

  it('returns undefined for a job that does not exist', async () => {
    expect(await cancelJob(kdb, randomUUID(), alice)).toBeUndefined();
  });

  it('lets any account cancel any job (FR-065)', async () => {
    const id = await queue(alice);
    expect((await cancelJob(kdb, id, bob))?.state).toBe('cancelled');
  });
});

describe('a cancel wins over every way a run can end (research #4)', () => {
  async function asked(): Promise<{ id: string; claim: number }> {
    const id = await queue();
    const claimed = await claimJob(kdb, randomUUID());
    if (!claimed) throw new Error('nothing claimed');
    await cancelJob(kdb, id, bob);
    return { id, claim: claimed.claim };
  }

  it('ends as cancelled instead of succeeded, and still stores the result', async () => {
    const job = await asked();
    const result = { generation: { status: 'ok' }, embeddings: { status: 'not_configured' } };
    expect(await finishRun(kdb, job, { kind: 'succeeded', result })).toBe('cancelled');
    expect(await row(job.id)).toMatchObject({ state: 'cancelled', failure_category: null, worker_id: null, lease_expires_at: null, result });
    expect((await getJob(kdb, job.id))?.cancelled_by).toMatchObject({ id: bob });
  });

  it('ends as cancelled instead of failed, with no failure', async () => {
    const job = await asked();
    expect(await finishRun(kdb, job, { kind: 'failed', category: 'timed_out' })).toBe('cancelled');
    expect(await row(job.id)).toMatchObject({ state: 'cancelled', failure_category: null, failure_detail: null });
    expect((await getJob(kdb, job.id))?.failure).toBeNull();
  });

  it('ends as cancelled when the worker reports the cancel itself', async () => {
    const job = await asked();
    expect(await finishRun(kdb, job, { kind: 'cancelled' })).toBe('cancelled');
  });

  it('leaves a job that nobody cancelled to end as the run says', async () => {
    const id = await queue();
    const claimed = await claimJob(kdb, randomUUID());
    if (!claimed) throw new Error('nothing claimed');
    expect(await finishRun(kdb, claimed, { kind: 'succeeded' })).toBe('succeeded');
    expect(id).toBe(claimed.id);
  });
});

describe('a run that failed for a reason that may pass (FR-020, FR-021)', () => {
  const five: JobSettings = { ...SETTINGS, maxRuns: 5 };

  /** Claims the job, whatever its wait, as a worker does once the wait is over. */
  async function claimAgain(id: string): Promise<{ id: string; claim: number }> {
    await setRow(id, 'next_run_at = now()');
    const claimed = await claimJob(kdb, randomUUID());
    if (!claimed) throw new Error('nothing claimed');
    return { id, claim: claimed.claim };
  }

  it.each(['provider_unavailable', 'rate_limited'] as const)('queues the job again after %s while runs remain, and shows it waiting', async (category) => {
    const id = await queue(alice, five);
    const claimed = await claimJob(kdb, randomUUID());
    if (!claimed) throw new Error('nothing claimed');
    expect(await finishRun(kdb, claimed, { kind: 'transient', category })).toBe('queued');
    expect(await row(id)).toMatchObject({ state: 'queued', worker_id: null, lease_expires_at: null, finished_at: null, failure_category: null, run: 1 });
    const shown = await getJob(kdb, id);
    expect(shown).toMatchObject({ state: 'queued', run: 1, failure: null });
    expect(shown?.next_run_at).not.toBeNull();
    // Nobody can claim it before its wait is over.
    expect(await claimJob(kdb, randomUUID())).toBeNull();
  });

  it('waits 30 seconds, then 2 minutes, 8 minutes and 10 minutes, with up to a quarter more (research #6)', async () => {
    const id = await queue(alice, five);
    const waits: number[] = [];
    let held: { id: string; claim: number } | null = await claimJob(kdb, randomUUID());
    for (let run = 1; run <= 4; run++) {
      if (!held) throw new Error('nothing claimed');
      await finishRun(kdb, held, { kind: 'transient', category: 'provider_unavailable' });
      const { rows } = await db.query<{ wait: number }>('SELECT extract(epoch FROM next_run_at - now()) AS wait FROM jobs WHERE id = $1', [id]);
      waits.push(Number(rows[0]?.wait));
      held = await claimAgain(id);
    }
    const base = [30, 120, 480, 600];
    waits.forEach((wait, i) => {
      expect(wait).toBeGreaterThan((base[i] ?? 0) - 1);
      expect(wait).toBeLessThanOrEqual((base[i] ?? 0) * 1.25 + 1);
    });
  });

  it('fails the job on the last run instead of queueing it again', async () => {
    const id = await queue(alice, { ...SETTINGS, maxRuns: 2 });
    const first = await claimJob(kdb, randomUUID());
    if (!first) throw new Error('nothing claimed');
    expect(await finishRun(kdb, first, { kind: 'transient', category: 'rate_limited' })).toBe('queued');
    const second = await claimAgain(id);
    expect(await finishRun(kdb, second, { kind: 'transient', category: 'rate_limited' })).toBe('failed');
    const failed = await getJob(kdb, id);
    expect(failed).toMatchObject({ state: 'failed', run: 2, max_runs: 2 });
    expect(failed?.failure?.category).toBe('rate_limited');
    expect(failed?.finished_at).not.toBeNull();
  });

  it('ends a job at once after any other category, with runs left (FR-020)', async () => {
    for (const category of ['not_authorized', 'not_available', 'input_too_large', 'output_limit_reached', 'refused', 'rejected', 'invalid_output', 'not_configured', 'cap_reached', 'timed_out', 'job_error'] as const) {
      const id = await queue(alice, five);
      const held = await claimJob(kdb, randomUUID());
      if (!held) throw new Error('nothing claimed');
      expect(await finishRun(kdb, held, { kind: 'failed', category }), category).toBe('failed');
      expect((await row(id)).run).toBe(1);
      await db.query('TRUNCATE jobs, job_usage');
    }
  });

  it('ends as cancelled instead of queueing again when a cancel was asked (research #4)', async () => {
    const id = await queue(alice, five);
    const held = await claimJob(kdb, randomUUID());
    if (!held) throw new Error('nothing claimed');
    await cancelJob(kdb, id, bob);
    expect(await finishRun(kdb, held, { kind: 'transient', category: 'provider_unavailable' })).toBe('cancelled');
    expect(await row(id)).toMatchObject({ state: 'cancelled', failure_category: null, finished_at: expect.any(Date) as unknown });
  });
});

describe('sweep: a run lost with its worker (FR-007)', () => {
  const three: JobSettings = { ...SETTINGS, maxRuns: 3 };

  /** A job a worker claimed whose lease ran out. */
  async function lost(settings: JobSettings = three): Promise<string> {
    const id = await queue(alice, settings);
    await claimJob(kdb, randomUUID());
    await setRow(id, `lease_expires_at = now() - interval '1 second'`);
    return id;
  }

  it('queues the job again with a wait, and counts the lost run', async () => {
    const id = await lost();
    expect(await sweep(kdb)).toBe(1);
    expect(await row(id)).toMatchObject({ state: 'queued', worker_id: null, lease_expires_at: null, run: 1, failure_category: null });
    const { rows } = await db.query<{ wait: number }>('SELECT extract(epoch FROM next_run_at - now()) AS wait FROM jobs WHERE id = $1', [id]);
    expect(Number(rows[0]?.wait)).toBeGreaterThan(29);
    expect(await claimJob(kdb, randomUUID())).toBeNull();
  });

  it('fails the job as worker_lost when the lost run was its last', async () => {
    const id = await lost({ ...SETTINGS, maxRuns: 1 });
    expect(await sweep(kdb)).toBe(1);
    const failed = await getJob(kdb, id);
    expect(failed).toMatchObject({ state: 'failed', run: 1 });
    expect(failed?.failure?.category).toBe('worker_lost');
    expect(failed?.finished_at).not.toBeNull();
  });

  it('fails the job as timed_out when its deadline has passed', async () => {
    const id = await lost();
    await setRow(id, `deadline_at = now() - interval '1 second'`);
    await sweep(kdb);
    expect((await getJob(kdb, id))?.failure?.category).toBe('timed_out');
  });

  it('ends the job as cancelled when a cancel was asked, before anything else', async () => {
    const id = await lost({ ...SETTINGS, maxRuns: 1 });
    await setRow(id, `cancel_requested_at = now(), cancelled_by = ${bob}, deadline_at = now() - interval '1 second'`);
    await sweep(kdb);
    expect(await getJob(kdb, id)).toMatchObject({ state: 'cancelled', cancelled_by: { id: bob }, failure: null });
  });

  it('fails a job waiting for its next run once its deadline has passed', async () => {
    const id = await queue(alice, three);
    await claimJob(kdb, randomUUID());
    await setRow(id, `state = 'queued', worker_id = NULL, lease_expires_at = NULL, next_run_at = now() + interval '5 minutes', deadline_at = now() - interval '1 second'`);
    expect(await sweep(kdb)).toBe(1);
    const failed = await getJob(kdb, id);
    expect(failed?.state).toBe('failed');
    expect(failed?.failure?.category).toBe('timed_out');
  });

  it('leaves a job whose lease is live, a queued job that has not started, and a job that has ended', async () => {
    const live = await queue(alice, three);
    await claimJob(kdb, randomUUID());
    const fresh = await queue(alice, three);
    const ended = await queue(alice, three);
    await setRow(ended, `state = 'succeeded', finished_at = now()`);
    const before = [await row(live), await row(fresh), await row(ended)];
    expect(await sweep(kdb)).toBe(0);
    expect([await row(live), await row(fresh), await row(ended)]).toEqual(before);
  });

  it('is safe to run from several workers at once: each lost job is handled once', async () => {
    const ids = [await lost(), await lost(), await lost()];
    const counts = await Promise.all([sweep(kdb), sweep(kdb), sweep(kdb)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
    for (const id of ids) expect(await row(id)).toMatchObject({ state: 'queued', run: 1 });
  });
});

describe('handBack: a worker that is stopping gives its job back (FR-007)', () => {
  async function held(settings: JobSettings = SETTINGS): Promise<{ id: string; claim: number }> {
    const id = await queue(alice, settings);
    const claimed = await claimJob(kdb, randomUUID());
    if (!claimed) throw new Error('nothing claimed');
    return { id, claim: claimed.claim };
  }

  it('queues the job for at once and gives the run back, so a restart never uses up a run', async () => {
    const job = await held();
    expect(await handBack(kdb, job)).toBe('queued');
    expect(await row(job.id)).toMatchObject({ state: 'queued', run: 0, worker_id: null, lease_expires_at: null });
    const again = await claimJob(kdb, randomUUID());
    expect(again).toMatchObject({ id: job.id, run: 1, claim: job.claim + 1 });
  });

  it('works with one run in all: the handed-back job can still be claimed', async () => {
    const job = await held({ ...SETTINGS, maxRuns: 1 });
    expect(await handBack(kdb, job)).toBe('queued');
    expect((await claimJob(kdb, randomUUID()))?.id).toBe(job.id);
  });

  it('keeps the claim number going up, so the first worker cannot write after the second has the job', async () => {
    const job = await held();
    await handBack(kdb, job);
    await claimJob(kdb, randomUUID());
    expect(await writeProgress(kdb, job, { step: 'generation' })).toBe(false);
    expect(await finishRun(kdb, job, { kind: 'succeeded' })).toBe('lost');
  });

  it('ends the job as cancelled when a cancel was asked', async () => {
    const job = await held();
    await cancelJob(kdb, job.id, bob);
    expect(await handBack(kdb, job)).toBe('cancelled');
    expect(await getJob(kdb, job.id)).toMatchObject({ state: 'cancelled', failure: null });
  });

  it('does nothing for a job this worker no longer holds', async () => {
    const job = await held();
    expect(await handBack(kdb, { ...job, claim: job.claim - 1 })).toBe('lost');
    expect((await row(job.id)).state).toBe('running');
  });
});

describe('claiming under load (SC-005)', () => {
  it('gives each of 100 queued jobs to exactly one of two workers claiming at once', async () => {
    await db.query(
      `INSERT INTO jobs (kind, created_by, max_runs, time_limit_ms, token_cap, cost_cap_usd)
       SELECT 'provider_check', $1, 3, 3600000, 500000, 5 FROM generate_series(1, 100)`,
      [alice],
    );
    async function drain(workerId: string): Promise<string[]> {
      const mine: string[] = [];
      for (let job = await claimJob(kdb, workerId); job !== null; job = await claimJob(kdb, workerId)) mine.push(job.id);
      return mine;
    }
    const [a, b] = await Promise.all([drain(randomUUID()), drain(randomUUID())]);
    expect(a.length + b.length).toBe(100);
    expect(new Set([...a, ...b]).size).toBe(100);
    // Neither was starved: both got some.
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    const { rows } = await db.query<{ runs: number }>(`SELECT count(*)::int AS runs FROM jobs WHERE state = 'running' AND run = 1 AND claim = 1`);
    expect(rows[0]?.runs).toBe(100);
  });
});

describe('the cooldown between an account’s provider checks (FR-047, SC-011)', () => {
  const FIVE_MINUTES = 300_000;
  const withCooldown: JobSettings = { ...SETTINGS, providerCheckCooldownMs: FIVE_MINUTES };

  it('refuses a second check inside the period, with how long to wait in words and in seconds', async () => {
    await queue(alice, withCooldown);
    const refused = await queue(alice, withCooldown).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(JobLimitError);
    expect(refused).toMatchObject({ reason: 'cooldown', message: 'You can start the next provider check in 5 minutes' });
    expect((refused as JobLimitError).retryAfterSeconds).toBeGreaterThanOrEqual(299);
    expect((refused as JobLimitError).retryAfterSeconds).toBeLessThanOrEqual(300);
    expect((await db.query('SELECT 1 FROM jobs')).rowCount).toBe(1);
  });

  it('counts from when the last check was queued, whatever became of it: cancelling does not shorten the wait', async () => {
    const first = await queue(alice, withCooldown);
    await cancelJob(kdb, first, alice);
    await expect(queue(alice, withCooldown)).rejects.toMatchObject({ reason: 'cooldown' });
    // Nor does a check that ran to its end.
    const second = await queue(bob, withCooldown);
    await setRow(second, `state = 'succeeded', finished_at = now()`);
    await expect(queue(bob, withCooldown)).rejects.toMatchObject({ reason: 'cooldown' });
  });

  it('says the wait in seconds when it is under a minute, in minutes up to an hour, and in hours beyond', async () => {
    const first = await queue(alice, withCooldown);
    await setRow(first, `queued_at = now() - interval '270 seconds'`);
    await expect(queue(alice, withCooldown)).rejects.toMatchObject({ message: expect.stringMatching(/in (29|30) seconds$/) as unknown });
    await setRow(first, `queued_at = now() - interval '3 minutes'`);
    await expect(queue(alice, withCooldown)).rejects.toMatchObject({ message: 'You can start the next provider check in 2 minutes' });
    await setRow(first, `queued_at = now() - interval '4 minutes 30 seconds'`);
    await expect(queue(alice, { ...withCooldown, providerCheckCooldownMs: 3_600_000 })).rejects.toMatchObject({ message: 'You can start the next provider check in 56 minutes' });
    await setRow(first, `queued_at = now() - interval '1 minute'`);
    await expect(queue(alice, { ...withCooldown, providerCheckCooldownMs: 7_200_000 })).rejects.toMatchObject({ message: 'You can start the next provider check in 2 hours' });
  });

  it('accepts a check once the period has passed', async () => {
    const first = await queue(alice, withCooldown);
    await setRow(first, `queued_at = now() - interval '301 seconds'`);
    await expect(queue(alice, withCooldown)).resolves.toEqual(expect.any(String));
  });

  it('does not make one account wait for another', async () => {
    await queue(alice, withCooldown);
    await expect(queue(bob, withCooldown)).resolves.toEqual(expect.any(String));
  });

  it('is off with a period of 0: a check can follow a check at once', async () => {
    const off: JobSettings = { ...SETTINGS, providerCheckCooldownMs: 0 };
    await queue(alice, off);
    await queue(alice, off);
    expect((await db.query('SELECT 1 FROM jobs WHERE created_by = $1', [alice])).rowCount).toBe(2);
  });

  it('is checked after the limit on active jobs: with both in the way, the limit is what is reported', async () => {
    const both: JobSettings = { ...withCooldown, jobsPerAccount: 1 };
    await queue(alice, both);
    await expect(queue(alice, both)).rejects.toMatchObject({ reason: 'limit' });
  });

  it('lets exactly one of several starts at once through (SC-011)', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => queue(alice, withCooldown)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ reason: 'cooldown' });
    expect((await db.query('SELECT 1 FROM jobs WHERE created_by = $1', [alice])).rowCount).toBe(1);
  });

  describe('nextAllowedAt, for the Jobs page', () => {
    it('is null before any check, and when the period is off', async () => {
      expect(await nextAllowedAt(kdb, alice, withCooldown)).toBeNull();
      await queue(alice, withCooldown);
      expect(await nextAllowedAt(kdb, alice, { ...SETTINGS, providerCheckCooldownMs: 0 })).toBeNull();
    });

    it('is the end of the period after the last check was queued, for that account only', async () => {
      const id = await queue(alice, withCooldown);
      const next = await nextAllowedAt(kdb, alice, withCooldown);
      const { rows } = await db.query<{ queued_at: Date }>('SELECT queued_at FROM jobs WHERE id = $1', [id]);
      expect(next?.getTime()).toBe((rows[0]?.queued_at.getTime() ?? 0) + FIVE_MINUTES);
      expect(await nextAllowedAt(kdb, bob, withCooldown)).toBeNull();
    });

    it('is null once the period has passed', async () => {
      const id = await queue(alice, withCooldown);
      await setRow(id, `queued_at = now() - interval '6 minutes'`);
      expect(await nextAllowedAt(kdb, alice, withCooldown)).toBeNull();
    });
  });
});


// A run that ends with a commit (Phase 3 Milestone 3, research #2): the chunks of a source are written in the one transaction
// that ends the job, fenced by the same claim, so a lost run writes nothing, a cancel writes nothing, and a failure of the
// write ends nothing. The commit is three steps, in this order: lock the rows it will write, check what must hold, and, only
// if the job really succeeded, write.
describe('finishRun with a commit (research #2)', () => {
  async function ingestion(): Promise<{ id: string; claim: number; sourceId: string }> {
    const { rows: project } = await db.query<{ id: string }>('INSERT INTO projects (name, created_by) VALUES ($1, $2) RETURNING id', [`p-${randomUUID()}`, alice]);
    const { rows: model } = await db.query<{ id: string }>('INSERT INTO threat_models (project_id, name) VALUES ($1, $2) RETURNING id', [project[0]?.id, 'model']);
    const { rows: source } = await db.query<{ id: string }>(
      `INSERT INTO sources (threat_model_id, name, type, size_bytes, digest, added_by, original_key, stored_bytes)
       VALUES ($1, 'design.md', 'md', 100, $2, $3, $4, 100) RETURNING id`,
      [model[0]?.id, randomBytes(32), alice, `sources/${randomUUID()}`],
    );
    const sourceId = source[0]?.id as string;
    const { rows: job } = await db.query<{ id: string }>(
      `INSERT INTO jobs (kind, input, created_by, max_runs, time_limit_ms, token_cap, cost_cap_usd, threat_model_id, source_id)
       VALUES ('ingest_source', $1, $2, 3, 3600000, 500000, 5, $3, $4) RETURNING id`,
      [JSON.stringify({ source_id: sourceId }), alice, model[0]?.id, sourceId],
    );
    const claimed = await claimJob(kdb, randomUUID());
    if (!claimed || claimed.id !== job[0]?.id) throw new Error('the ingestion job was not claimed');
    return { id: claimed.id, claim: claimed.claim, sourceId };
  }

  /** A commit that records what it was asked, and what it could see. */
  function spyCommit(job: { id: string }, over: Partial<RunCommit> = {}): { commit: RunCommit; calls: string[]; seen: Record<string, unknown> } {
    const calls: string[] = [];
    const seen: Record<string, unknown> = {};
    const commit: RunCommit = {
      lock: (trx) => {
        calls.push('lock');
        return sql`SELECT 1`.execute(trx).then(() => true);
      },
      check: () => {
        calls.push('check');
        return Promise.resolve(undefined);
      },
      write: async (trx) => {
        calls.push('write');
        seen.insideState = (await sql<{ state: string }>`SELECT state FROM jobs WHERE id = ${job.id}`.execute(trx)).rows[0]?.state;
        // From another connection, the transaction has not committed.
        seen.outsideState = (await db.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [job.id])).rows[0]?.state;
      },
      ...over,
    };
    return { commit, calls, seen };
  }

  it('locks, checks, ends the job, and writes, in that order, in one transaction', async () => {
    const job = await ingestion();
    const { commit, calls, seen } = spyCommit(job);
    expect(await finishRun(kdb, job, { kind: 'succeeded' }, commit)).toBe('succeeded');
    expect(calls).toEqual(['lock', 'check', 'write']);
    expect(seen.insideState).toBe('succeeded');
    expect(seen.outsideState).toBe('running');
    expect((await row(job.id)).state).toBe('succeeded');
  });

  it('writes nothing when the run was lost to another worker, because the fenced update finds no row', async () => {
    const job = await ingestion();
    const { commit, calls } = spyCommit(job);
    expect(await finishRun(kdb, { id: job.id, claim: job.claim + 1 }, { kind: 'succeeded' }, commit)).toBe('lost');
    expect(calls).toEqual(['lock', 'check']);
    expect((await row(job.id)).state).toBe('running');
  });

  it('writes nothing when a cancel was asked, and the job ends as cancelled', async () => {
    const job = await ingestion();
    await setRow(job.id, 'cancel_requested_at = now()');
    const { commit, calls } = spyCommit(job);
    expect(await finishRun(kdb, job, { kind: 'succeeded' }, commit)).toBe('cancelled');
    expect(calls).not.toContain('write');
  });

  it('writes nothing when the run is to be queued again, or has failed', async () => {
    const queued = await ingestion();
    const a = spyCommit(queued);
    expect(await finishRun(kdb, queued, { kind: 'transient', category: 'provider_unavailable' }, a.commit)).toBe('queued');
    expect(a.calls).not.toContain('write');
    await db.query('TRUNCATE jobs, job_usage, workers');
    const failed = await ingestion();
    const b = spyCommit(failed);
    expect(await finishRun(kdb, failed, { kind: 'failed', category: 'damaged' }, b.commit)).toBe('failed');
    expect(b.calls).not.toContain('write');
  });

  it('turns a check that fails into the failure of the job, and writes nothing', async () => {
    const job = await ingestion();
    const { commit, calls } = spyCommit(job, {
      check: () => Promise.resolve({ category: 'document_space_full' as const }),
    });
    expect(await finishRun(kdb, job, { kind: 'succeeded' }, commit)).toBe('failed');
    expect(calls).not.toContain('write');
    expect(await getJob(kdb, job.id)).toMatchObject({ state: 'failed', failure: { category: 'document_space_full' } });
  });

  it('keeps the detail of a failure that a check names', async () => {
    const job = await ingestion();
    const { commit } = spyCommit(job, { check: () => Promise.resolve({ category: 'too_large' as const, detail: 'chars' as const }) });
    await finishRun(kdb, job, { kind: 'succeeded' }, commit);
    expect((await getJob(kdb, job.id))?.failure?.message).toMatch(/characters/);
  });

  it('ends the job as cancelled and writes nothing when the rows to write are gone (the lock finds no source)', async () => {
    const job = await ingestion();
    const { commit, calls } = spyCommit(job, { lock: () => Promise.resolve(false) });
    expect(await finishRun(kdb, job, { kind: 'succeeded' }, commit)).toBe('cancelled');
    expect(calls).not.toContain('write');
  });

  it('leaves the job running, and rolls back every row the write made, when the write fails', async () => {
    const job = await ingestion();
    const { commit } = spyCommit(job, {
      write: async (trx) => {
        await sql`UPDATE sources SET stored_bytes = 999 WHERE id = ${job.sourceId}`.execute(trx);
        throw new Error('the write failed');
      },
    });
    await expect(finishRun(kdb, job, { kind: 'succeeded' }, commit)).rejects.toThrow('the write failed');
    expect((await row(job.id)).state).toBe('running');
    expect(Number((await db.query<{ stored_bytes: string }>('SELECT stored_bytes FROM sources WHERE id = $1', [job.sourceId])).rows[0]?.stored_bytes)).toBe(100);
  });

  it('lets the check and the write run on the transaction they are given, not on a connection of their own', async () => {
    const job = await ingestion();
    let checkSawUncommittedEnd: unknown;
    const { commit } = spyCommit(job, {
      check: async (trx) => {
        // The fenced update has not run yet: the job is still running inside the transaction.
        checkSawUncommittedEnd = (await sql<{ state: string }>`SELECT state FROM jobs WHERE id = ${job.id}`.execute(trx)).rows[0]?.state;
        return undefined;
      },
    });
    await finishRun(kdb, job, { kind: 'succeeded' }, commit);
    expect(checkSawUncommittedEnd).toBe('running');
  });

  it('is the same as before for a run without a commit', async () => {
    const id = await queue();
    const claimed = await claimJob(kdb, randomUUID());
    expect(claimed?.id).toBe(id);
    expect(await finishRun(kdb, { id, claim: claimed?.claim ?? 0 }, { kind: 'succeeded' })).toBe('succeeded');
  });
});
