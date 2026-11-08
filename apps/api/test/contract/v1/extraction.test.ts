import { randomUUID } from 'node:crypto';
import { ExtractionStatus, JobRecord } from '@scrylux/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { CHUNK_TEXTS } from '../../fixtures/extract-system/answers.js';
import { seedDraft, seedReadySource, seedUnreadySource } from '../../fixtures/extract-system/seed.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { accountIdOf, client, type V1Client } from './helpers.js';
import { LOCAL_PROVIDER } from './jobs-helpers.js';

// Starting an extraction and reading its status (Phase 3 Milestone 4, US1, US7; FR-001 to FR-004, FR-015, FR-042, FR-046, SC-012): the checks, in
// the order of the contract, each with its fixed answer; one job for two starts at once; and nothing that names a source. No worker runs here:
// a job that is started stays queued.

const EMBEDDINGS = {
  EMBEDDING_PROVIDER: 'openai-compatible',
  EMBEDDING_MODEL: 'nomic-embed-text',
  EMBEDDING_BASE_URL: 'http://127.0.0.1:9/v1',
  EMBEDDING_LOCAL: 'true',
} as const;

describe('/api/v1/threat-models/{id}/extraction', () => {
  let server: TestServer;
  let c: V1Client;
  let token: string;
  let account: number;
  let threatModel: string;

  beforeAll(async () => {
    server = await startTestServer(app);
    token = await login(server.baseUrl);
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
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const design = () => seedReadySource(account, threatModel, { name: 'design.md', chunks: [CHUNK_TEXTS.c1, CHUNK_TEXTS.c2, CHUNK_TEXTS.c3] });
  const status = () => c.get<ExtractionStatus>(`/threat-models/${threatModel}/extraction`);
  const startNow = () => c.post<{ error?: string } & Record<string, unknown>>(`/threat-models/${threatModel}/extraction`);
  const noProvider = (): void => {
    vi.stubEnv('LLM_PROVIDER', '');
    vi.stubEnv('LLM_MODEL', '');
    vi.stubEnv('LLM_BASE_URL', '');
    vi.stubEnv('LLM_LOCAL', '');
  };
  const jobsOf = async () => (await db.query<{ kind: string; state: string; input: unknown; threat_model_id: string; source_id: string | null; token_cap: string }>(`SELECT kind, state, input, threat_model_id, source_id, token_cap FROM jobs WHERE kind = 'extract_system'`)).rows;

  describe('the status', () => {
    it('offers a start, on the whole path, with nothing before it (FR-063)', async () => {
      await design();
      const res = await status();
      expect(res.status).toBe(200);
      expect(ExtractionStatus.parse(res.body)).toEqual({ latest: null, start: { offered: true, path: 'whole', replaces_draft: false }, chunks_available: 3, budget_chars: 36_000 });
    });

    it('says a start would replace the draft that exists (FR-052)', async () => {
      await seedDraft(account, threatModel, await design());
      expect((await status()).body.start).toEqual({ offered: true, path: 'whole', replaces_draft: true });
    });

    it('shows the latest extraction, as a job record, once one was started', async () => {
      await design();
      const started = await startNow();
      const res = await status();
      expect(res.body.latest).toEqual(started.body);
      expect(JobRecord.parse(res.body.latest)).toMatchObject({ kind: 'extract_system', state: 'queued', threat_model_id: threatModel, source_id: null });
      expect(res.body.start).toMatchObject({ offered: false, reason: 'extraction_active' });
    });

    it('answers 404 for a threat model that is not there, and 400 for an id that is not one', async () => {
      expect((await c.get(`/threat-models/${randomUUID()}/extraction`)).status).toBe(404);
      expect((await c.get('/threat-models/not-a-uuid/extraction')).status).toBe(400);
    });

    it('needs a sign-in', async () => {
      const res = await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/extraction`);
      expect(res.status).toBe(401);
    });
  });

  describe('a start', () => {
    it('queues one extraction job of the threat model and answers with it (FR-040, FR-041)', async () => {
      await design();
      const res = await startNow();
      expect(res.status).toBe(201);
      expect(JobRecord.parse(res.body)).toMatchObject({ kind: 'extract_system', state: 'queued', threat_model_id: threatModel, source_id: null, started_by: { id: account } });
      const rows = await jobsOf();
      expect(rows).toHaveLength(1);
      // The caps are the operator's, copied onto the job; the input holds nothing, and the threat model is the job's own column.
      expect(rows[0]).toMatchObject({ kind: 'extract_system', state: 'queued', input: {}, threat_model_id: threatModel, source_id: null, token_cap: '500000' });
    });

    it('writes one line, with who, what, which threat model and which job, and nothing of the sources (FR-065)', async () => {
      await design();
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
      const res = await startNow();
      const mine = lines.filter((line) => line.includes('"event":"extraction"'));
      expect(mine).toHaveLength(1);
      expect(JSON.parse(mine[0] as string)).toEqual({ event: 'extraction', action: 'start', account_id: account, threat_model_id: threatModel, job_id: res.body.id });
      expect(lines.join('\n')).not.toContain('design.md');
    });

    it('refuses with 409 when no generation provider is configured, and queues nothing (FR-002)', async () => {
      await design();
      noProvider();
      const res = await startNow();
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Extraction needs a generation provider. Ask the operator to set LLM_PROVIDER.');
      expect(await jobsOf()).toHaveLength(0);
      expect((await status()).body.start).toMatchObject({ offered: false, reason: 'no_generation_provider' });
    });

    it('refuses with 409 when there is no ready source (FR-003)', async () => {
      const res = await startNow();
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Extraction needs at least one ready source. Add a document on the Sources tab.');
      await seedUnreadySource(account, threatModel, 'failed');
      expect((await startNow()).body.error).toContain('at least one ready source');
    });

    it('refuses with 409 while a source is waiting or processing, counting them and naming none (FR-004)', async () => {
      await design();
      const waiting = await seedUnreadySource(account, threatModel, 'waiting', 'secret-plan-A.md');
      const processing = await seedUnreadySource(account, threatModel, 'processing', 'secret-plan-B.md');
      const res = await startNow();
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('2 sources of this threat model are still being processed. Wait until they are ready.');
      expect(JSON.stringify(res.body)).not.toContain('secret-plan');
      // The status carries the ids, so that the page can name them from the sources it already holds.
      const offered = (await status()).body.start;
      expect(offered).toMatchObject({ offered: false, reason: 'sources_processing' });
      expect((offered as { source_ids: string[] }).source_ids.sort()).toEqual([waiting, processing].sort());
      expect(JSON.stringify(await status())).not.toContain('secret-plan');
      expect(await jobsOf()).toHaveLength(0);
    });

    it('says "1 source … it is" for one', async () => {
      await design();
      await seedUnreadySource(account, threatModel, 'waiting');
      expect((await startNow()).body.error).toBe('1 source of this threat model is still being processed. Wait until it is ready.');
    });

    it('does not let a source that failed hold a start back: it is left out (FR-004)', async () => {
      await design();
      await seedUnreadySource(account, threatModel, 'failed');
      expect((await startNow()).status).toBe(201);
    });

    it('refuses with 409 a second start while one is queued or running, with the same fixed answer (FR-042)', async () => {
      await design();
      expect((await startNow()).status).toBe(201);
      const second = await startNow();
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('An extraction of this threat model is already queued or running.');
      expect(Object.keys(second.body)).toEqual(['error']);
      expect(await jobsOf()).toHaveLength(1);
    });

    it('queues exactly one job when two starts arrive at once, and refuses the other (FR-042, SC-012)', async () => {
      await design();
      const results = await Promise.all([startNow(), startNow(), startNow()]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(await jobsOf()).toHaveLength(1);
    });

    it('allows an extraction of another threat model at the same time', async () => {
      await design();
      expect((await startNow()).status).toBe(201);
      const project = (await c.post<{ id: string }>('/projects', { name: `p-${randomUUID()}` })).body;
      const other = (await c.post<{ id: string }>('/threat-models', { project_id: project.id, name: 'other' })).body.id;
      await seedReadySource(account, other, { chunks: [CHUNK_TEXTS.c1] });
      expect((await c.post(`/threat-models/${other}/extraction`)).status).toBe(201);
    });

    it('counts toward the account’s limit on jobs, and answers 429 with when to try again (FR-046)', async () => {
      await design();
      vi.stubEnv('JOBS_PER_ACCOUNT', '1');
      expect((await c.post('/jobs', { kind: 'provider_check' })).status).toBe(201);
      const res = await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/extraction`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(await jobsOf()).toHaveLength(0);
    });

    it('has no cooldown of its own: a second start follows a failed extraction at once (FR-046)', async () => {
      await design();
      expect((await startNow()).status).toBe(201);
      await db.query(`UPDATE jobs SET state = 'failed', run = 1, claim = 1, started_at = now(), deadline_at = now() + interval '1 hour', finished_at = now(), failure_category = 'invalid_output' WHERE kind = 'extract_system'`);
      expect((await startNow()).status).toBe(201);
    });

    it.each([
      ['generate', 'LLM_MODEL', 'EMBEDDING_MODEL'],
      ['select', 'EMBEDDING_MODEL', 'LLM_MODEL'],
    ])('names the settings of the provider that rejected it: a failure in the %s step points at %s, not %s', async (step, named, other) => {
      await design();
      const job = (await startNow()).body as { id: string };
      await db.query(
        `UPDATE jobs SET state = 'failed', run = 1, claim = 1, started_at = now(), deadline_at = now() + interval '1 hour', finished_at = now(), failure_category = 'rejected', progress = $1 WHERE id = $2`,
        [JSON.stringify({ step }), job.id],
      );
      const failed = (await c.get<{ failure: { hint: string } }>(`/jobs/${job.id}`)).body;
      expect(failed.failure.hint).toContain(named);
      expect(failed.failure.hint).not.toContain(other);
    });

    it('answers 404 for a threat model that is not there, 400 for an id that is not one, and 401 without a sign-in', async () => {
      expect((await c.post(`/threat-models/${randomUUID()}/extraction`)).status).toBe(404);
      expect((await c.post('/threat-models/not-a-uuid/extraction')).status).toBe(400);
      const res = await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/extraction`, { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('is not a job that Milestone 2’s route starts: POST /jobs refuses the kind (FR-045a)', async () => {
      await design();
      const res = await c.post<{ error?: string }>('/jobs', { kind: 'extract_system', input: {} });
      expect(res.status).toBe(400);
      expect(await jobsOf()).toHaveLength(0);
    });
  });

  describe('sources larger than the budget (FR-012, FR-015)', () => {
    // The smallest budget there is, and a source of 3,000 characters in two chunks, which do not fit it: a start takes the retrieval path.
    beforeEach(() => {
      vi.stubEnv('EXTRACTION_CONTEXT_CHARS', '2000');
    });
    const large = () => seedReadySource(account, threatModel, { name: 'large.md', chunks: ['a'.repeat(1500), 'b'.repeat(1500)] });

    it('needs an embedding provider, and says so (FR-015)', async () => {
      await large();
      const res = await startNow();
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('These sources are larger than the extraction budget, and choosing among them needs an embedding provider. Ask the operator to set EMBEDDING_PROVIDER.');
      expect((await status()).body.start).toMatchObject({ offered: false, reason: 'no_embedding_provider' });
    });

    it('refuses embeddings from another model, counting the sources, and offers nothing (FR-015)', async () => {
      for (const [name, value] of Object.entries({ ...EMBEDDINGS, EMBEDDING_MODEL: 'another-model' })) vi.stubEnv(name, value);
      const source = await large();
      const res = await startNow();
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('These sources are larger than the extraction budget, and 1 of them has embeddings from another model. Refresh its embeddings on the Sources tab.');
      const offered = (await status()).body.start as { reason: string; source_ids: string[] };
      expect(offered).toMatchObject({ offered: false, reason: 'embeddings_out_of_date' });
      expect(offered.source_ids).toEqual([source.sourceId]);
    });

    it('starts, and says the path is retrieval, when the embeddings are from the configured model', async () => {
      for (const [name, value] of Object.entries(EMBEDDINGS)) vi.stubEnv(name, value);
      await large();
      expect((await status()).body.start).toEqual({ offered: true, path: 'retrieval', replaces_draft: false });
      expect((await startNow()).status).toBe(201);
    });

    it('needs no embedding provider for sources that fit the budget: they are read whole', async () => {
      vi.stubEnv('EXTRACTION_CONTEXT_CHARS', '36000');
      await design();
      expect((await status()).body.start).toMatchObject({ offered: true, path: 'whole' });
    });
  });
});
