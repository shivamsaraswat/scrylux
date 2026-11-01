import { JobsStatus } from '@scrylux/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { client, type V1Client } from './helpers.js';

// The job routes with no provider configured (Phase 3 Milestone 2, FR-063, FR-072): the check is not offered and cannot be
// started, and nothing else in the API depends on AI.

describe('/api/v1/jobs with AI off', () => {
  let server: TestServer;
  let c: V1Client;

  beforeAll(async () => {
    for (const name of ['LLM_PROVIDER', 'LLM_MODEL', 'LLM_BASE_URL', 'LLM_LOCAL', 'LLM_REGION', 'EMBEDDING_PROVIDER', 'EMBEDDING_MODEL']) vi.stubEnv(name, '');
    server = await startTestServer(app);
    c = client(server.baseUrl, await login(server.baseUrl));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await server.close();
  });
  beforeEach(async () => {
    await db.query('TRUNCATE jobs, job_usage, workers');
  });

  it('reports no provider and does not offer the check', async () => {
    const res = await c.get('/jobs/status');
    expect(res.status).toBe(200);
    expect(JobsStatus.parse(res.body)).toMatchObject({ ai: { generation: null, embedding: null }, provider_check: { offered: false } });
  });

  it('refuses to start a provider check with 409, and queues nothing', async () => {
    const res = await c.post('/jobs', { kind: 'provider_check', input: {} });
    expect(res).toEqual({ status: 409, body: { error: 'AI is not configured on this install' } });
    expect((await db.query('SELECT 1 FROM jobs')).rowCount).toBe(0);
  });

  it('still lists jobs', async () => {
    expect((await c.get('/jobs')).status).toBe(200);
  });
});
