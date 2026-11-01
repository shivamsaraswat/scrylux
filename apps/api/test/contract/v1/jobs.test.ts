import { JobDetail, JobList, JobRecord, JobsStatus } from '@scrylux/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { accountIdOf, client, type V1Client } from './helpers.js';
import { LOCAL_PROVIDER, createAccount } from './jobs-helpers.js';

// The job routes with AI configured (Phase 3 Milestone 2, contracts/http-api.md): start, list, read. Cancel, the limit
// and the cooldown have their own files. The API only reports the provider; the worker is what talks to it.

describe('/api/v1/jobs (FR-013, FR-060, FR-063)', () => {
  let server: TestServer;
  let c: V1Client;
  let adminId: number;
  let token: string;

  beforeAll(async () => {
    for (const [name, value] of Object.entries({ ...LOCAL_PROVIDER, PROVIDER_CHECK_COOLDOWN: '0', JOBS_PER_ACCOUNT: '100' })) vi.stubEnv(name, value);
    server = await startTestServer(app);
    token = await login(server.baseUrl);
    adminId = accountIdOf(token);
    c = client(server.baseUrl, token);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await server.close();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE jobs, job_usage, workers');
  });

  const start = (body: unknown = { kind: 'provider_check', input: {} }) => c.post('/jobs', body);

  describe('GET /jobs/status', () => {
    it('reports the provider without a key or an address, and offers the check', async () => {
      const res = await c.get('/jobs/status');
      expect(res.status).toBe(200);
      const status = JobsStatus.parse(res.body);
      expect(status).toEqual({
        worker_alive: false,
        ai: { generation: { provider: 'openai-compatible', model: 'llama3.2', hosted: false }, embedding: null },
        provider_check: { offered: true, next_allowed_at: null },
      });
      expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|http:/);
    });

    it('says a worker is alive when one has reported lately, and not when it has not (FR-008)', async () => {
      await db.query(`INSERT INTO workers (id) VALUES (gen_random_uuid())`);
      expect(JobsStatus.parse((await c.get('/jobs/status')).body).worker_alive).toBe(true);
      await db.query(`UPDATE workers SET last_seen_at = now() - interval '2 minutes'`);
      expect(JobsStatus.parse((await c.get('/jobs/status')).body).worker_alive).toBe(false);
      await db.query(`UPDATE workers SET last_seen_at = now(), stopping = true`);
      expect(JobsStatus.parse((await c.get('/jobs/status')).body).worker_alive).toBe(false);
    });
  });

  describe('POST /jobs', () => {
    it('queues a provider check at once and answers with the job in the queued state (US1)', async () => {
      const res = await start();
      expect(res.status).toBe(201);
      const job = JobRecord.parse(res.body);
      expect(job).toMatchObject({
        kind: 'provider_check',
        state: 'queued',
        run: 0,
        started_by: { id: adminId },
        caps: { tokens: 500_000, cost_usd: 5 },
        max_runs: 3,
        failure: null,
        worker_lost: false,
      });
    });

    it('accepts the body without an input, as the empty input', async () => {
      expect((await start({ kind: 'provider_check' })).status).toBe(201);
    });

    it('writes one log line: who started which job, and nothing else (FR-060)', async () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
      try {
        const job = JobRecord.parse((await start()).body);
        const started = lines.filter((l) => l.includes('"action":"start"'));
        expect(started).toHaveLength(1);
        expect(JSON.parse(started[0] as string)).toEqual({ event: 'job', action: 'start', account_id: adminId, job_id: job.id, kind: 'provider_check' });
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      ['no kind', {}],
      ['an unknown kind', { kind: 'extraction', input: {} }],
      ['an input for a provider check (FR-093)', { kind: 'provider_check', input: { prompt: 'hello' } }],
      ['a cap in the body (FR-045)', { kind: 'provider_check', input: {}, token_cap: 1 }],
      ['an input that is not an object', { kind: 'provider_check', input: [] }],
    ])('refuses %s with 400, queues nothing and sends the usual error', async (_label, body) => {
      const res = await start(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) as unknown });
      expect((await db.query('SELECT 1 FROM jobs')).rowCount).toBe(0);
    });

    it('answers 401 without a token', async () => {
      const res = await fetch(`${server.baseUrl}/api/v1/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"kind":"provider_check"}' });
      expect(res.status).toBe(401);
      expect((await db.query('SELECT 1 FROM jobs')).rowCount).toBe(0);
    });
  });

  describe('GET /jobs', () => {
    it('lists every account’s jobs, newest first, with has_more', async () => {
      const other = await createAccount(server.baseUrl, token);
      const first = JobRecord.parse((await start()).body);
      const second = JobRecord.parse((await client(server.baseUrl, other.token).post('/jobs', { kind: 'provider_check' })).body);
      await db.query(`UPDATE jobs SET queued_at = now() - interval '1 minute' WHERE id = $1`, [first.id]);
      const res = await c.get('/jobs');
      expect(res.status).toBe(200);
      const list = JobList.parse(res.body);
      expect(list.jobs.map((j) => j.id)).toEqual([second.id, first.id]);
      expect(list.jobs.map((j) => j.started_by.id)).toEqual([other.id, adminId]);
      expect(list.has_more).toBe(false);
    });

    it('pages with limit and offset', async () => {
      for (let i = 0; i < 3; i++) await start();
      const page = JobList.parse((await c.get('/jobs?limit=2&offset=0')).body);
      expect(page.jobs).toHaveLength(2);
      expect(page.has_more).toBe(true);
      const rest = JobList.parse((await c.get('/jobs?limit=2&offset=2')).body);
      expect(rest.jobs).toHaveLength(1);
      expect(rest.has_more).toBe(false);
    });

    it.each(['limit=0', 'limit=101', 'offset=-1', 'limit=2.5', 'limit=many', 'page=2'])('refuses %s with 400 and one fixed message', async (query) => {
      const res = await c.get(`/jobs?${query}`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'limit must be a whole number from 1 to 100, and offset a whole number of 0 or more' });
    });
  });

  describe('POST /jobs/:id/cancel (FR-030, FR-032, FR-065)', () => {
    const cancel = (id: string, who: V1Client = c) => who.post(`/jobs/${id}/cancel`);

    it('cancels a queued job at once, and says who did it', async () => {
      const job = JobRecord.parse((await start()).body);
      const res = await cancel(job.id);
      expect(res.status).toBe(200);
      expect(JobRecord.parse(res.body)).toMatchObject({ id: job.id, state: 'cancelled', cancelled_by: { id: adminId }, cancel_requested: false });
      expect(JobRecord.parse(res.body).finished_at).not.toBeNull();
    });

    it('only records the request for a job that is running, which its worker then ends', async () => {
      const job = JobRecord.parse((await start()).body);
      await db.query(
        `UPDATE jobs SET state = 'running', run = 1, claim = 1, worker_id = gen_random_uuid(), lease_expires_at = now() + interval '30 seconds', started_at = now(), deadline_at = now() + interval '1 hour' WHERE id = $1`,
        [job.id],
      );
      const res = await cancel(job.id);
      expect(res.status).toBe(200);
      expect(JobRecord.parse(res.body)).toMatchObject({ state: 'running', cancel_requested: true, cancelled_by: { id: adminId }, finished_at: null });
    });

    it('lets any signed-in account cancel any job', async () => {
      const other = await createAccount(server.baseUrl, token);
      const job = JobRecord.parse((await start()).body);
      const res = await cancel(job.id, client(server.baseUrl, other.token));
      expect(res.status).toBe(200);
      expect(JobRecord.parse(res.body)).toMatchObject({ state: 'cancelled', started_by: { id: adminId }, cancelled_by: { id: other.id } });
    });

    it('answers 409 and changes nothing for a job that has already finished', async () => {
      const job = JobRecord.parse((await start()).body);
      await cancel(job.id);
      const before = (await c.get(`/jobs/${job.id}`)).body;
      expect(await cancel(job.id)).toEqual({ status: 409, body: { error: 'The job has already finished' } });
      expect((await c.get(`/jobs/${job.id}`)).body).toEqual(before);
    });

    it('writes one log line: who cancelled which job, and nothing else (FR-060)', async () => {
      const job = JobRecord.parse((await start()).body);
      const lines: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
      try {
        await cancel(job.id);
        await cancel(job.id); // refused: no second line
      } finally {
        spy.mockRestore();
      }
      const cancelled = lines.filter((l) => l.includes('"action":"cancel"'));
      expect(cancelled).toHaveLength(1);
      expect(JSON.parse(cancelled[0] as string)).toEqual({ event: 'job', action: 'cancel', account_id: adminId, job_id: job.id });
    });

    it('answers 404 for a job that does not exist, and 400 for an id that is not one', async () => {
      expect(await cancel('3f6b7c1e-8a52-4d0e-9c1a-0b6d2f4e5a77')).toEqual({ status: 404, body: { error: 'Job not found' } });
      expect(await cancel('abc')).toEqual({ status: 400, body: { error: 'Invalid id' } });
    });

    it('answers 401 without a token', async () => {
      const job = JobRecord.parse((await start()).body);
      const res = await fetch(`${server.baseUrl}/api/v1/jobs/${job.id}/cancel`, { method: 'POST' });
      expect(res.status).toBe(401);
      expect(JobDetail.parse((await c.get(`/jobs/${job.id}`)).body).state).toBe('queued');
    });
  });

  describe('GET /jobs/:id', () => {
    it('answers the job with its usage records and its result', async () => {
      const job = JobRecord.parse((await start()).body);
      const res = await c.get(`/jobs/${job.id}`);
      expect(res.status).toBe(200);
      expect(JobDetail.parse(res.body)).toMatchObject({ id: job.id, state: 'queued', usage: [], result: null });
    });

    it('answers 404 for a job that does not exist, and 400 for an id that is not one', async () => {
      expect(await c.get('/jobs/3f6b7c1e-8a52-4d0e-9c1a-0b6d2f4e5a77')).toEqual({ status: 404, body: { error: 'Job not found' } });
      expect(await c.get('/jobs/abc')).toEqual({ status: 400, body: { error: 'Invalid id' } });
    });
  });
});
