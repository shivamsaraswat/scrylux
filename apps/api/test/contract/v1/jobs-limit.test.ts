import { JobRecord } from '@scrylux/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { client, type V1Client } from './helpers.js';
import { LOCAL_PROVIDER, createAccount } from './jobs-helpers.js';

// The limit on one account's active jobs (Phase 3 Milestone 2, FR-046): a start beyond it is refused with 429, a
// Retry-After and a fixed message, and queues nothing. Its own file because it runs with a limit of 1.

describe('/api/v1/jobs: the limit on active jobs per account (FR-046)', () => {
  let server: TestServer;
  let token: string;
  let c: V1Client;

  beforeAll(async () => {
    for (const [name, value] of Object.entries({ ...LOCAL_PROVIDER, PROVIDER_CHECK_COOLDOWN: '0', JOBS_PER_ACCOUNT: '1' })) vi.stubEnv(name, value);
    server = await startTestServer(app);
    token = await login(server.baseUrl);
    c = client(server.baseUrl, token);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await server.close();
  });
  beforeEach(async () => {
    await db.query('TRUNCATE jobs, job_usage, workers');
  });

  const start = (who: V1Client = c) => who.raw('/jobs', { method: 'POST', body: JSON.stringify({ kind: 'provider_check', input: {} }) });

  it('refuses a second start while one is active: 429, a fixed message that names the limit, and a Retry-After of 30', async () => {
    expect((await start()).status).toBe(201);
    const res = await fetch(`${server.baseUrl}/api/v1/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'provider_check', input: {} }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({ error: 'You already have 1 job queued or running. Wait for one to finish, or cancel one.' });
    expect((await db.query('SELECT 1 FROM jobs')).rowCount).toBe(1);
  });

  it('does not log a start that was refused', async () => {
    await start();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    try {
      await start();
    } finally {
      spy.mockRestore();
    }
    expect(lines.filter((l) => l.includes('"action":"start"'))).toEqual([]);
  });

  it('does not count another account’s jobs', async () => {
    const other = await createAccount(server.baseUrl, token);
    expect((await start()).status).toBe(201);
    const res = await start(client(server.baseUrl, other.token));
    expect(res.status).toBe(201);
    expect(JobRecord.parse(res.body).started_by.id).toBe(other.id);
  });

  it('accepts a start again once the job has ended', async () => {
    const first = JobRecord.parse((await start()).body);
    expect((await start()).status).toBe(429);
    await db.query(`UPDATE jobs SET state = 'succeeded', finished_at = now() WHERE id = $1`, [first.id]);
    expect((await start()).status).toBe(201);
  });

  it('answers 400 for a bad body before it looks at the limit', async () => {
    await start();
    const res = await c.raw('/jobs', { method: 'POST', body: JSON.stringify({ kind: 'nope' }) });
    expect(res.status).toBe(400);
  });
});
