import { randomUUID } from 'node:crypto';
import { SourceRecord } from '@scrylux/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { storage } from '../../../src/storage/instance.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { client, type V1Client } from './helpers.js';
import { LOCAL_PROVIDER } from './jobs-helpers.js';

// Retrying a source that failed (Phase 3 Milestone 3, US5, FR-013, FR-044, SC-012, research #14): a new job with the caps that are
// set now, offered only where trying again can help. A failure that comes from the document itself, a cap that has not been raised
// and a model that refused the chunk size are refused with the reason. No worker is needed: the failures are written to the job.

const EMBEDDINGS = {
  EMBEDDING_PROVIDER: 'openai-compatible',
  EMBEDDING_MODEL: 'nomic-embed-text',
  EMBEDDING_BASE_URL: 'http://127.0.0.1:9/v1',
  EMBEDDING_LOCAL: 'true',
} as const;

describe('POST /api/v1/sources/{id}/retry', () => {
  let server: TestServer;
  let c: V1Client;
  let token: string;
  let threatModel: string;

  beforeAll(async () => {
    server = await startTestServer(app);
    token = await login(server.baseUrl);
    c = client(server.baseUrl, token);
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    for (const [name, value] of Object.entries({ ...LOCAL_PROVIDER, ...EMBEDDINGS, JOBS_PER_ACCOUNT: '100', PROVIDER_CHECK_COOLDOWN: '0' })) vi.stubEnv(name, value);
    await db.query('TRUNCATE jobs, job_usage, workers, sources CASCADE');
    for await (const item of storage().list()) await storage().delete(item.key);
    const project = (await c.post<{ id: string }>('/projects', { name: `p-${randomUUID()}` })).body;
    threatModel = (await c.post<{ id: string }>('/threat-models', { project_id: project.id, name: 'model' })).body.id;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const upload = async (text: string = randomUUID(), name = 'design.md') => {
    const data = new FormData();
    data.append('file', new Blob([Buffer.from(`# Design\n\n${text}\n`)]), name);
    const res = await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/sources`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: data });
    return { status: res.status, body: (await res.json()) as { id: string; error?: string } };
  };
  const fail = (sourceId: string, category: string): Promise<unknown> =>
    db.query(
      `UPDATE jobs SET state = 'failed', finished_at = now(), failure_category = $2, started_at = now(), deadline_at = now() + interval '1 hour', run = 1 WHERE source_id = $1`,
      [sourceId, category],
    );
  /** A source whose only job ended in this category, as the worker leaves it. */
  const failedWith = async (category: string, usageModel?: string): Promise<string> => {
    const added = await upload();
    await fail(added.body.id, category);
    if (usageModel !== undefined) {
      const { rows } = await db.query<{ id: string }>('SELECT id FROM jobs WHERE source_id = $1', [added.body.id]);
      await db.query(
        `INSERT INTO job_usage (job_id, run, operation, provider, model, outcome, attempts, input_tokens, output_tokens, tokens_estimated, cost_usd, cost_estimated, price_source, duration_ms)
         VALUES ($1, 1, 'embed', 'openai-compatible', $2, 'input_too_large', 1, 0, 0, true, NULL, false, 'none', 5)`,
        [rows[0]?.id, usageModel],
      );
    }
    return added.body.id;
  };
  const retry = (id: string) => c.post<{ error?: string } & Record<string, unknown>>(`/sources/${id}/retry`);
  const jobs = async () => (await db.query<{ state: string; kind: string; token_cap: string }>(`SELECT state, kind, token_cap FROM jobs WHERE source_id IS NOT NULL ORDER BY queued_at`)).rows;

  describe('where trying again can help', () => {
    it.each(['provider_unavailable', 'rate_limited', 'storage_unavailable', 'timed_out', 'not_configured', 'job_error', 'document_space_full', 'rejected', 'invalid_output'])(
      'queues a new job after %s, and the source is waiting again',
      async (category) => {
        const id = await failedWith(category);
        const res = await retry(id);
        expect(res.status, category).toBe(200);
        expect(SourceRecord.parse(res.body)).toMatchObject({ id, status: 'waiting', failure: null });
        expect(await jobs()).toHaveLength(2);
        expect((await jobs())[1]).toMatchObject({ kind: 'ingest_source', state: 'queued' });
      },
    );

    it('queues a new job for a source whose job was cancelled', async () => {
      const added = await upload();
      await db.query(`UPDATE jobs SET state = 'cancelled', finished_at = now(), cancelled_by = (SELECT id FROM users LIMIT 1) WHERE source_id = $1`, [added.body.id]);
      expect((await retry(added.body.id)).status).toBe(200);
    });

    it('queues the new job with the caps set now, not the caps of the job that failed', async () => {
      const id = await failedWith('provider_unavailable');
      vi.stubEnv('JOB_TOKEN_CAP', '123456');
      expect((await retry(id)).status).toBe(200);
      expect(Number((await jobs())[1]?.token_cap)).toBe(123456);
    });

    it('lets a cap-reached source be retried once a cap is raised, and not before (FR-042)', async () => {
      vi.stubEnv('JOB_TOKEN_CAP', '1000');
      const id = await failedWith('cap_reached');
      const refused = await retry(id);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('Retrying would reach the same cap. Ask the operator to raise JOB_TOKEN_CAP or JOB_COST_CAP.');
      expect(await jobs()).toHaveLength(1);
      vi.stubEnv('JOB_TOKEN_CAP', '2000');
      expect((await retry(id)).status).toBe(200);
    });

    it('lets an input-too-large source be retried once the embedding model has changed, and not before', async () => {
      const id = await failedWith('input_too_large', 'nomic-embed-text');
      const refused = await retry(id);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe("This embedding model does not accept Scrylux's chunk size. Ask the operator to choose another.");
      vi.stubEnv('EMBEDDING_MODEL', 'a-model-with-longer-input');
      expect((await retry(id)).status).toBe(200);
    });
  });

  describe('where trying again cannot help', () => {
    it.each(['unsupported_type', 'encrypted', 'damaged', 'no_text_found', 'too_large', 'too_large_unpacked'])('refuses %s, which comes from the document itself', async (category) => {
      const id = await failedWith(category);
      const res = await retry(id);
      expect(res.status, category).toBe(409);
      expect(res.body.error).toBe('This failure comes from the document itself. Fix the document and add it again.');
      expect(await jobs()).toHaveLength(1);
    });

    it('refuses a source that is waiting or ready, which has not failed', async () => {
      const waiting = (await upload()).body.id;
      const refused = await retry(waiting);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('This source has not failed, so there is nothing to retry.');

      const ready = (await upload()).body.id;
      await db.query(`UPDATE sources SET original_key = NULL, ready_at = now(), text_chars = 5, chunk_count = 1, embedding_model = 'nomic-embed-text', embedding_dimension = 3 WHERE id = $1`, [ready]);
      expect((await retry(ready)).status).toBe(409);
    });

    it('refuses everything while no embedding provider is configured', async () => {
      const id = await failedWith('provider_unavailable');
      for (const name of Object.keys(EMBEDDINGS)) vi.stubEnv(name, '');
      const res = await retry(id);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/embedding provider/);
    });

    it('answers 404 for an unknown source and 400 for a bad id', async () => {
      expect((await retry(randomUUID())).status).toBe(404);
      expect((await retry('not-a-uuid')).status).toBe(400);
    });
  });

  it('queues one job when two retries arrive at once, and answers the other with a refusal', async () => {
    const id = await failedWith('provider_unavailable');
    const [one, two] = await Promise.all([retry(id), retry(id)]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect(await jobs()).toHaveLength(2);
  });

  it('says a failed twin must be deleted before the same document is added again (SC-012)', async () => {
    const text = randomUUID();
    const first = await upload(text);
    await fail(first.body.id, 'provider_unavailable');
    const again = await upload(text, 'renamed.md');
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already a source of this threat model: design\.md\. Delete it first to add this document again\./);
  });

  it('writes one line for the retry, with the source and its threat model and no name', async () => {
    const id = await failedWith('provider_unavailable');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await retry(id);
    const lines = log.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('"event":"source"'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ action: 'retry', source: id, threat_model: threatModel, type: 'md' });
    expect(lines[0]).not.toContain('design.md');
  });
});
