import { JobRecord, JobsStatus } from '@scrylux/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { client, type V1Client } from './helpers.js';
import { LOCAL_PROVIDER, createAccount } from './jobs-helpers.js';

// The cooldown between one account's provider checks (Phase 3 Milestone 2, FR-047, SC-011): the default of 5 minutes, a
// start inside it refused with 429, a Retry-After and the time to wait, and the same time on the Jobs page's status.

describe('/api/v1/jobs: the cooldown between provider checks (FR-047)', () => {
  let server: TestServer;
  let token: string;
  let c: V1Client;

  beforeAll(async () => {
    for (const [name, value] of Object.entries({ ...LOCAL_PROVIDER, JOBS_PER_ACCOUNT: '100' })) vi.stubEnv(name, value);
    // The cooldown is left at its default: 5 minutes.
    vi.stubEnv('PROVIDER_CHECK_COOLDOWN', '');
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

  const status = async (who: V1Client = c) => JobsStatus.parse((await who.get('/jobs/status')).body);
  const start = (who: V1Client = c) => who.post('/jobs', { kind: 'provider_check', input: {} });

  it('offers a check at once, then says when the next is allowed: five minutes after the last was queued', async () => {
    expect((await status()).provider_check).toEqual({ offered: true, next_allowed_at: null });
    const before = Date.now();
    const job = JobRecord.parse((await start()).body);
    const next = (await status()).provider_check.next_allowed_at;
    expect(next).not.toBeNull();
    const at = new Date(next as string).getTime();
    expect(at).toBe(new Date(job.queued_at).getTime() + 300_000);
    expect(at).toBeGreaterThan(before + 299_000);
  });

  it('refuses a second start with 429, the time to wait, and Retry-After in whole seconds', async () => {
    await start();
    const res = await fetch(`${server.baseUrl}/api/v1/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'provider_check', input: {} }),
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'You can start the next provider check in 5 minutes' });
    const retry = Number(res.headers.get('Retry-After'));
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBeGreaterThanOrEqual(299);
    expect(retry).toBeLessThanOrEqual(300);
    expect((await db.query('SELECT 1 FROM jobs')).rowCount).toBe(1);
  });

  it('does not let cancelling the check shorten the wait', async () => {
    const job = JobRecord.parse((await start()).body);
    await c.post(`/jobs/${job.id}/cancel`);
    expect((await start()).status).toBe(429);
    expect((await status()).provider_check.next_allowed_at).not.toBeNull();
  });

  it('does not make another account wait', async () => {
    await start();
    const other = await createAccount(server.baseUrl, token);
    const who = client(server.baseUrl, other.token);
    expect((await status(who)).provider_check.next_allowed_at).toBeNull();
    expect((await start(who)).status).toBe(201);
  });

  it('accepts a start after the period, and the status no longer shows a wait', async () => {
    const job = JobRecord.parse((await start()).body);
    await db.query(`UPDATE jobs SET queued_at = now() - interval '301 seconds' WHERE id = $1`, [job.id]);
    expect((await status()).provider_check.next_allowed_at).toBeNull();
    expect((await start()).status).toBe(201);
  });

  it('writes no log line for a start that was refused', async () => {
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
});
