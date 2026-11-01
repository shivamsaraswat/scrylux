import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, createUser, escapeIdentifier, expectPgError, pool } from './helpers.js';

// jobs, job_usage and workers (016): the checks here are what the worker and the API rely on, so they are tested
// directly rather than through either (Phase 3 Milestone 2, data-model.md). This package's own database is used, which
// no test of apps/api touches, so running both packages at once cannot interfere.

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

const COLUMNS = {
  jobs: [
    'cancel_requested_at',
    'cancelled_by',
    'claim',
    'cost_cap_usd',
    'created_by',
    'deadline_at',
    'failure_category',
    'failure_detail',
    'finished_at',
    'id',
    'input',
    'kind',
    'lease_expires_at',
    'max_runs',
    'next_run_at',
    'progress',
    'queued_at',
    'result',
    'run',
    'started_at',
    'state',
    'time_limit_ms',
    'token_cap',
    'worker_id',
  ],
  job_usage: [
    'attempts',
    'cost_estimated',
    'cost_usd',
    'duration_ms',
    'id',
    'input_tokens',
    'job_id',
    'model',
    'operation',
    'outcome',
    'output_tokens',
    'price_source',
    'provider',
    'recorded_at',
    'run',
    'temperature_applied',
    'tokens_estimated',
  ],
  workers: ['id', 'last_seen_at', 'started_at', 'stopping'],
};

let userId: number;

beforeAll(async () => {
  userId = (await createUser()).id;
});
afterAll(closePool);

// Column names come from this file's own fixed values, checked and escaped like an identifier in production code
// (Principle I). The values are always parameters.
async function insertInto(table: 'jobs' | 'job_usage' | 'workers', row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const columns = Object.keys(row);
  if (!columns.every((column) => IDENTIFIER_PATTERN.test(column))) throw new Error('insert(): bad column name');
  const { rows } = await pool().query<Record<string, unknown>>(
    `INSERT INTO ${escapeIdentifier(table)} (${columns.map(escapeIdentifier).join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(row),
  );
  const created = rows[0];
  if (!created) throw new Error('insert returned no row');
  return created;
}

const insertJob = (values: Record<string, unknown> = {}) =>
  insertInto('jobs', {
    kind: 'provider_check',
    created_by: userId,
    max_runs: 3,
    time_limit_ms: 3_600_000,
    token_cap: 500_000,
    cost_cap_usd: 5,
    ...values,
  });

const running = (values: Record<string, unknown> = {}) => ({
  state: 'running',
  run: 1,
  claim: 1,
  worker_id: '00000000-0000-4000-8000-000000000001',
  lease_expires_at: new Date(Date.now() + 30_000),
  started_at: new Date(),
  deadline_at: new Date(Date.now() + 3_600_000),
  ...values,
});

const finished = (state: 'succeeded' | 'failed' | 'cancelled', values: Record<string, unknown> = {}) => ({
  state,
  run: 1,
  claim: 1,
  started_at: new Date(),
  deadline_at: new Date(Date.now() + 3_600_000),
  finished_at: new Date(),
  ...values,
});

const insertUsage = async (jobId: string, values: Record<string, unknown> = {}) =>
  insertInto('job_usage', {
    job_id: jobId,
    run: 1,
    operation: 'generate',
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    outcome: 'ok',
    attempts: 1,
    input_tokens: 100,
    output_tokens: 20,
    tokens_estimated: false,
    cost_usd: 0.000123,
    cost_estimated: false,
    price_source: 'list',
    temperature_applied: true,
    duration_ms: 800,
    ...values,
  });

async function columnsOf(table: string): Promise<string[]> {
  const { rows } = await pool().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return rows.map((r) => r.column_name).sort();
}

describe('the tables', () => {
  it.each(Object.entries(COLUMNS))('%s has exactly the documented columns', async (table, expected) => {
    expect(await columnsOf(table)).toEqual(expected);
  });
});

describe('jobs defaults', () => {
  it('queues a new job with the documented defaults', async () => {
    const job = await insertJob();
    expect(job).toMatchObject({
      state: 'queued',
      input: {},
      run: 0,
      claim: '0',
      worker_id: null,
      lease_expires_at: null,
      started_at: null,
      deadline_at: null,
      finished_at: null,
      cancel_requested_at: null,
      cancelled_by: null,
      progress: null,
      failure_category: null,
      failure_detail: null,
      result: null,
    });
    expect(job.queued_at).toBeInstanceOf(Date);
    expect(job.next_run_at).toBeInstanceOf(Date);
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('jobs checks', () => {
  it.each([
    ['a kind that is not provider_check', { kind: 'extraction' }, 'jobs_kind_check'],
    ['a state outside the five', { state: 'paused' }, 'jobs_state_check'],
    ['an input that is not an object', { input: JSON.stringify([]) }, 'jobs_input_check'],
    ['max_runs of 0', { max_runs: 0 }, 'jobs_max_runs_check'],
    ['max_runs of 6', { max_runs: 6 }, 'jobs_max_runs_check'],
    ['a time_limit_ms of 0', { time_limit_ms: 0 }, 'jobs_time_limit_check'],
    ['a token_cap of 0', { token_cap: 0 }, 'jobs_token_cap_check'],
    ['a cost_cap_usd of 0', { cost_cap_usd: 0 }, 'jobs_cost_cap_check'],
    ['a negative cost_cap_usd', { cost_cap_usd: -1 }, 'jobs_cost_cap_check'],
    // A running job, because a queued one with no run left would break jobs_queued_runs_check first.
    ['run above max_runs', { ...running(), run: 4 }, 'jobs_run_check'],
    ['a negative run', { run: -1 }, 'jobs_run_check'],
  ])('rejects %s', async (_label, values, constraint) => {
    await expectPgError(insertJob(values), { code: '23514', constraint });
  });

  it('accepts the edges of max_runs', async () => {
    await insertJob({ max_runs: 1 });
    await insertJob({ max_runs: 5 });
  });

  it('requires worker_id and lease_expires_at exactly while running', async () => {
    await expectPgError(insertJob({ ...running(), worker_id: null }), { code: '23514', constraint: 'jobs_running_check' });
    await expectPgError(insertJob({ ...running(), lease_expires_at: null }), { code: '23514', constraint: 'jobs_running_check' });
    await expectPgError(insertJob({ worker_id: '00000000-0000-4000-8000-000000000001' }), {
      code: '23514',
      constraint: 'jobs_running_check',
    });
    await expectPgError(insertJob({ lease_expires_at: new Date() }), { code: '23514', constraint: 'jobs_running_check' });
    expect((await insertJob(running())).state).toBe('running');
  });

  it('requires finished_at exactly in a final state', async () => {
    for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
      const values = state === 'failed' ? { failure_category: 'job_error' } : {};
      await expectPgError(insertJob({ ...finished(state, values), finished_at: null }), {
        code: '23514',
        constraint: 'jobs_finished_check',
      });
      expect((await insertJob(finished(state, values))).state).toBe(state);
    }
    await expectPgError(insertJob({ finished_at: new Date() }), { code: '23514', constraint: 'jobs_finished_check' });
  });

  it('requires a failure category exactly when the job failed', async () => {
    await expectPgError(insertJob(finished('failed')), { code: '23514', constraint: 'jobs_failure_check' });
    await expectPgError(insertJob(finished('succeeded', { failure_category: 'job_error' })), {
      code: '23514',
      constraint: 'jobs_failure_check',
    });
    await expectPgError(insertJob({ failure_category: 'job_error' }), { code: '23514', constraint: 'jobs_failure_check' });
  });

  it('accepts the fourteen failure categories and no other', async () => {
    const categories = [
      'not_configured',
      'not_authorized',
      'not_available',
      'rate_limited',
      'provider_unavailable',
      'input_too_large',
      'output_limit_reached',
      'refused',
      'rejected',
      'invalid_output',
      'cap_reached',
      'timed_out',
      'worker_lost',
      'job_error',
    ];
    for (const failure_category of categories) await insertJob(finished('failed', { failure_category }));
    // A cancel ends the job in the cancelled state, so "cancelled" is not a failure category.
    for (const failure_category of ['cancelled', 'unknown']) {
      await expectPgError(insertJob(finished('failed', { failure_category })), {
        code: '23514',
        constraint: 'jobs_failure_category_check',
      });
    }
  });

  it('allows failure_detail only as cap_below_one_request on cap_reached', async () => {
    await insertJob(finished('failed', { failure_category: 'cap_reached', failure_detail: 'cap_below_one_request' }));
    await expectPgError(insertJob(finished('failed', { failure_category: 'cap_reached', failure_detail: 'other' })), {
      code: '23514',
      constraint: 'jobs_failure_detail_check',
    });
    await expectPgError(insertJob(finished('failed', { failure_category: 'timed_out', failure_detail: 'cap_below_one_request' })), {
      code: '23514',
      constraint: 'jobs_failure_detail_check',
    });
  });

  it('allows cancelled_by only on a cancelled job, or a running one with a cancel asked', async () => {
    await insertJob(finished('cancelled', { cancelled_by: userId }));
    await insertJob(running({ cancel_requested_at: new Date(), cancelled_by: userId }));
    await expectPgError(insertJob({ cancelled_by: userId }), { code: '23514', constraint: 'jobs_cancelled_by_check' });
    await expectPgError(insertJob(running({ cancelled_by: userId })), { code: '23514', constraint: 'jobs_cancelled_by_check' });
    await expectPgError(insertJob(finished('succeeded', { cancelled_by: userId })), {
      code: '23514',
      constraint: 'jobs_cancelled_by_check',
    });
  });

  it('allows a cancel to be asked only of a running or cancelled job', async () => {
    await expectPgError(insertJob({ cancel_requested_at: new Date() }), {
      code: '23514',
      constraint: 'jobs_cancel_requested_check',
    });
    await expectPgError(insertJob(finished('succeeded', { cancel_requested_at: new Date() })), {
      code: '23514',
      constraint: 'jobs_cancel_requested_check',
    });
    await insertJob(running({ cancel_requested_at: new Date() }));
    await insertJob(finished('cancelled', { cancel_requested_at: new Date() }));
  });

  it('keeps a queued job below max_runs', async () => {
    await expectPgError(insertJob({ run: 3, max_runs: 3 }), { code: '23514', constraint: 'jobs_queued_runs_check' });
    await insertJob({ run: 2, max_runs: 3 });
    // Running and final jobs may have used every run.
    await insertJob(running({ run: 3, max_runs: 3 }));
  });

  it('sets started_at and deadline_at together', async () => {
    await expectPgError(insertJob({ started_at: new Date() }), { code: '23514', constraint: 'jobs_started_deadline_check' });
    await expectPgError(insertJob({ deadline_at: new Date() }), { code: '23514', constraint: 'jobs_started_deadline_check' });
  });
});

describe('jobs references', () => {
  it('restricts deleting a user who started or cancelled a job', async () => {
    const starter = (await createUser()).id;
    const canceller = (await createUser()).id;
    await insertJob({ created_by: starter });
    await insertJob(finished('cancelled', { cancelled_by: canceller }));
    await expectPgError(pool().query('DELETE FROM users WHERE id = $1', [starter]), { code: '23503', constraint: 'jobs_created_by_fkey' });
    await expectPgError(pool().query('DELETE FROM users WHERE id = $1', [canceller]), {
      code: '23503',
      constraint: 'jobs_cancelled_by_fkey',
    });
  });

  it('refuses a created_by that is not a user', async () => {
    await expectPgError(insertJob({ created_by: 2_147_483_000 }), { code: '23503', constraint: 'jobs_created_by_fkey' });
  });
});

describe('jobs_final_is_final', () => {
  it.each([
    ['succeeded', {}],
    ['failed', { failure_category: 'job_error' }],
    ['cancelled', {}],
  ] as const)('refuses every update of a %s job, even one that changes nothing', async (state, extra) => {
    const job = await insertJob(finished(state, extra));
    await expectPgError(pool().query('UPDATE jobs SET progress = $2 WHERE id = $1', [job.id, JSON.stringify({ step: 'generation' })]), {
      code: '23514',
      constraint: 'jobs_final_is_final',
    });
    await expectPgError(pool().query('UPDATE jobs SET state = state WHERE id = $1', [job.id]), {
      code: '23514',
      constraint: 'jobs_final_is_final',
    });
  });

  it('allows updates to a queued and a running job, and to a job that becomes final', async () => {
    const job = await insertJob(running());
    await pool().query('UPDATE jobs SET progress = $2 WHERE id = $1', [job.id, JSON.stringify({ step: 'generation' })]);
    await pool().query(
      `UPDATE jobs SET state = 'succeeded', worker_id = NULL, lease_expires_at = NULL, finished_at = now() WHERE id = $1`,
      [job.id],
    );
    const { rows } = await pool().query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [job.id]);
    expect(rows[0]?.state).toBe('succeeded');
  });
});

describe('job_usage', () => {
  it('accepts a usage record and stores a known cost', async () => {
    const job = await insertJob();
    const row = await insertUsage(job.id as string);
    expect(row).toMatchObject({ operation: 'generate', price_source: 'list', tokens_estimated: false });
    expect(Number(row.cost_usd)).toBeCloseTo(0.000123, 8);
  });

  it('accepts an embedding record without a temperature, and an unknown cost with price source none', async () => {
    const job = await insertJob();
    await insertUsage(job.id as string, { operation: 'embed', temperature_applied: null, output_tokens: 0, cost_usd: null, price_source: 'none' });
  });

  it.each([
    ['an operation outside generate and embed', { operation: 'chat' }, 'job_usage_operation_check'],
    ['a provider outside the four', { provider: 'mistral' }, 'job_usage_provider_check'],
    ['an empty model', { model: '  ' }, 'job_usage_model_check'],
    ['an outcome outside ok and the categories', { outcome: 'weird' }, 'job_usage_outcome_check'],
    ['attempts above 5', { attempts: 6 }, 'job_usage_attempts_check'],
    ['negative attempts', { attempts: -1 }, 'job_usage_attempts_check'],
    ['negative input tokens', { input_tokens: -1 }, 'job_usage_tokens_check'],
    ['negative output tokens', { output_tokens: -1 }, 'job_usage_tokens_check'],
    ['a negative duration', { duration_ms: -1 }, 'job_usage_duration_check'],
    ['a price source outside the three', { price_source: 'guess' }, 'job_usage_price_source_check'],
    ['price source none with a cost', { price_source: 'none', cost_usd: 0.1 }, 'job_usage_cost_check'],
    ['an unknown cost with a price source', { cost_usd: null, price_source: 'list' }, 'job_usage_cost_check'],
    ['a negative cost', { cost_usd: -0.1 }, 'job_usage_cost_check'],
    ['a run below 1', { run: 0 }, 'job_usage_run_check'],
  ])('rejects %s', async (_label, values, constraint) => {
    const job = await insertJob();
    await expectPgError(insertUsage(job.id as string, values), { code: '23514', constraint });
  });

  it('accepts cancelled and each failure category as an outcome', async () => {
    const job = await insertJob();
    for (const outcome of ['ok', 'cancelled', 'not_authorized', 'invalid_output', 'rate_limited']) {
      await insertUsage(job.id as string, { outcome });
    }
  });

  it('is deleted with its job and refuses a job that does not exist', async () => {
    const job = await insertJob();
    await insertUsage(job.id as string);
    await pool().query('DELETE FROM jobs WHERE id = $1', [job.id]);
    const { rows } = await pool().query<{ n: number }>('SELECT count(*)::int AS n FROM job_usage WHERE job_id = $1', [job.id]);
    expect(rows[0]?.n).toBe(0);
    await expectPgError(insertUsage('00000000-0000-4000-8000-0000000000ff'), { code: '23503', constraint: 'job_usage_job_id_fkey' });
  });
});

describe('workers', () => {
  it('defaults started_at, last_seen_at and stopping', async () => {
    const worker = await insertInto('workers', { id: '00000000-0000-4000-8000-0000000000a1' });
    expect(worker).toMatchObject({ stopping: false });
    expect(worker.started_at).toBeInstanceOf(Date);
    expect(worker.last_seen_at).toBeInstanceOf(Date);
  });
});

describe('indexes', () => {
  it('has the five indexes of the data model, with their predicates', async () => {
    const { rows } = await pool().query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('jobs', 'job_usage')`,
    );
    const defs = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    expect(defs.get('jobs_claim_idx')).toMatch(/\(next_run_at, queued_at, id\) WHERE \(state = 'queued'/);
    expect(defs.get('jobs_lease_idx')).toMatch(/\(lease_expires_at\) WHERE \(state = 'running'/);
    expect(defs.get('jobs_list_idx')).toMatch(/\(queued_at DESC, id DESC\)/);
    expect(defs.get('jobs_account_idx')).toMatch(/\(created_by, kind, queued_at DESC\)/);
    expect(defs.get('job_usage_job_idx')).toMatch(/\(job_id, id\)/);
  });
});
