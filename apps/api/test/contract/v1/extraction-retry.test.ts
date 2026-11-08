import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { CHUNK_TEXTS } from '../../fixtures/extract-system/answers.js';
import { seedReadySource } from '../../fixtures/extract-system/seed.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { accountIdOf, client, type V1Client } from './helpers.js';
import { LOCAL_PROVIDER } from './jobs-helpers.js';

// Starting again after a failure (Phase 3 Milestone 4, US7; FR-045, SC-012): a start is a retry when the latest extraction failed, and it is refused
// where trying again is certain to fail the same way: a cap that has not been raised, an input that is as large for the same model, a draft that
// is as long for the same limit and model. Everything else may be tried again. No worker is needed: the failures are written to the job.

describe('starting again after a failure', () => {
  let server: TestServer;
  let c: V1Client;
  let account: number;
  let threatModel: string;

  beforeAll(async () => {
    server = await startTestServer(app);
    const token = await login(server.baseUrl);
    account = accountIdOf(token);
    c = client(server.baseUrl, token);
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    for (const [name, value] of Object.entries({ ...LOCAL_PROVIDER, JOBS_PER_ACCOUNT: '100', PROVIDER_CHECK_COOLDOWN: '0' })) vi.stubEnv(name, value);
    await db.query('TRUNCATE jobs, job_usage, workers, sources CASCADE');
    const project = (await c.post<{ id: string }>('/projects', { name: `p-${randomUUID()}` })).body;
    threatModel = (await c.post<{ id: string }>('/threat-models', { project_id: project.id, name: 'model' })).body.id;
    await seedReadySource(account, threatModel, { name: 'design.md', chunks: [CHUNK_TEXTS.c1, CHUNK_TEXTS.c2, CHUNK_TEXTS.c3] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** The latest extraction, as the worker leaves it when it ends this way, with the settings it kept and the model it asked last. */
  async function ended(
    state: 'failed' | 'cancelled',
    category: string | null,
    over: { tokenCap?: number; costCapUsd?: number; result?: Record<string, unknown>; model?: string } = {},
  ): Promise<void> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO jobs (kind, input, created_by, max_runs, time_limit_ms, token_cap, cost_cap_usd, threat_model_id, state, run, claim, started_at, deadline_at, finished_at, failure_category, result, cancelled_by)
       VALUES ('extract_system', '{}', $1, 3, 3600000, $2, $3, $4, $5, 1, 1, now(), now() + interval '1 hour', now(), $6, $7, $8) RETURNING id`,
      [account, over.tokenCap ?? 500_000, over.costCapUsd ?? 5, threatModel, state, category, over.result === undefined ? null : JSON.stringify(over.result), state === 'cancelled' ? account : null],
    );
    if (over.model !== undefined) {
      await db.query(
        `INSERT INTO job_usage (job_id, run, operation, provider, model, outcome, attempts, input_tokens, output_tokens, tokens_estimated, cost_usd, cost_estimated, price_source, duration_ms)
         VALUES ($1, 1, 'generate', 'openai-compatible', $2, 'ok', 1, 0, 0, true, NULL, false, 'none', 5)`,
        [rows[0]?.id, over.model],
      );
    }
  }
  const settings = (over: Record<string, unknown> = {}) => ({
    path: 'whole',
    chunks_read: 3,
    chunks_available: 3,
    sources_read: 1,
    sources_left_out: 0,
    items: { elements: 0, assets: 0, assumptions: 0 },
    context_chars: 36_000,
    max_output_tokens: 12_000,
    ...over,
  });
  const start = () => c.post<{ error?: string }>(`/threat-models/${threatModel}/extraction`);
  const offered = async () => (await c.get<{ start: { offered: boolean; reason?: string } }>(`/threat-models/${threatModel}/extraction`)).body.start;

  describe('where trying again can help', () => {
    it.each(['invalid_output', 'provider_unavailable', 'rate_limited', 'timed_out', 'not_configured', 'not_authorized', 'not_available', 'rejected', 'refused', 'job_error', 'worker_lost', 'no_ready_source', 'sources_changed'])(
      'allows a start after %s',
      async (category) => {
        await ended('failed', category);
        expect((await offered()).offered).toBe(true);
        expect((await start()).status).toBe(201);
      },
    );

    it('allows a start after a cancel', async () => {
      await ended('cancelled', null);
      expect((await start()).status).toBe(201);
    });

    it('allows a start after a success', async () => {
      await db.query(
        `INSERT INTO jobs (kind, input, created_by, max_runs, time_limit_ms, token_cap, cost_cap_usd, threat_model_id, state, run, claim, started_at, deadline_at, finished_at)
         VALUES ('extract_system', '{}', $1, 3, 3600000, 500000, 5, $2, 'succeeded', 1, 1, now(), now() + interval '1 hour', now())`,
        [account, threatModel],
      );
      expect((await start()).status).toBe(201);
    });
  });

  describe('cap reached (FR-045)', () => {
    it('is refused while the caps are the ones the job had, with the reason, and queues nothing', async () => {
      await ended('failed', 'cap_reached');
      const res = await start();
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Retrying would reach the same cap. Ask the operator to raise JOB_TOKEN_CAP or JOB_COST_CAP.');
      expect(await offered()).toMatchObject({ offered: false, reason: 'would_repeat' });
      expect((await db.query(`SELECT 1 FROM jobs WHERE kind = 'extract_system' AND state = 'queued'`)).rows).toHaveLength(0);
    });

    it('is refused when the caps are lower than the job’s', async () => {
      await ended('failed', 'cap_reached', { tokenCap: 900_000 });
      expect((await start()).status).toBe(409);
    });

    it('is allowed once the token cap is higher than the job’s, or the cost cap is', async () => {
      await ended('failed', 'cap_reached');
      vi.stubEnv('JOB_TOKEN_CAP', '600000');
      expect((await start()).status).toBe(201);
    });

    it('is allowed once the cost cap is higher', async () => {
      await ended('failed', 'cap_reached');
      vi.stubEnv('JOB_COST_CAP', '8');
      expect((await start()).status).toBe(201);
    });
  });

  describe('input too large (FR-016, FR-045)', () => {
    it('is refused while the budget and the model are what they were', async () => {
      await ended('failed', 'input_too_large', { result: settings(), model: 'llama3.2' });
      const res = await start();
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('The input was too large for this model. Ask the operator to lower EXTRACTION_CONTEXT_CHARS or choose another model.');
    });

    it('is allowed once the budget is different', async () => {
      await ended('failed', 'input_too_large', { result: settings(), model: 'llama3.2' });
      vi.stubEnv('EXTRACTION_CONTEXT_CHARS', '20000');
      expect((await start()).status).toBe(201);
    });

    it('is allowed once the model is different', async () => {
      await ended('failed', 'input_too_large', { result: settings(), model: 'llama3.2' });
      vi.stubEnv('LLM_MODEL', 'a-model-with-a-longer-context');
      expect((await start()).status).toBe(201);
    });
  });

  describe('output limit reached (FR-045)', () => {
    it('is refused while the limit and the model are what they were', async () => {
      await ended('failed', 'output_limit_reached', { result: settings(), model: 'llama3.2' });
      const res = await start();
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('The draft was larger than the output limit. Ask the operator to raise EXTRACTION_MAX_OUTPUT_TOKENS.');
    });

    it('is allowed once the limit is different', async () => {
      await ended('failed', 'output_limit_reached', { result: settings(), model: 'llama3.2' });
      vi.stubEnv('EXTRACTION_MAX_OUTPUT_TOKENS', '16000');
      expect((await start()).status).toBe(201);
    });

    it('is allowed once the model is different', async () => {
      await ended('failed', 'output_limit_reached', { result: settings(), model: 'llama3.2' });
      vi.stubEnv('LLM_MODEL', 'a-model-that-writes-less');
      expect((await start()).status).toBe(201);
    });
  });

  describe('embeddings out of date (FR-015)', () => {
    it('is refused while the sources’ embeddings are from another model than the configured one, if they are too large to be read whole', async () => {
      vi.stubEnv('EXTRACTION_CONTEXT_CHARS', '2000');
      vi.stubEnv('EMBEDDING_PROVIDER', 'openai-compatible');
      vi.stubEnv('EMBEDDING_MODEL', 'a-newer-model');
      vi.stubEnv('EMBEDDING_BASE_URL', 'http://127.0.0.1:9/v1');
      vi.stubEnv('EMBEDDING_LOCAL', 'true');
      await seedReadySource(account, threatModel, { name: 'large.md', chunks: ['a'.repeat(1500), 'b'.repeat(1500)] });
      await ended('failed', 'embeddings_out_of_date');
      const res = await start();
      expect(res.status).toBe(409);
      expect(await offered()).toMatchObject({ offered: false, reason: 'embeddings_out_of_date' });
    });

    it('is allowed once the sources fit the budget, which needs no embeddings', async () => {
      await ended('failed', 'embeddings_out_of_date');
      expect((await start()).status).toBe(201);
    });
  });

  it('looks only at the latest extraction: an earlier failure that would repeat does not hold back a start after a later one', async () => {
    await ended('failed', 'cap_reached');
    await ended('failed', 'invalid_output');
    expect((await start()).status).toBe(201);
  });
});
