import { randomUUID } from 'node:crypto';
import { ChunkPage, SourceRecord } from '@scrylux/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { storage } from '../../../src/storage/instance.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { client, type V1Client } from './helpers.js';
import { LOCAL_PROVIDER } from './jobs-helpers.js';

// Reading a source and its chunks (Phase 3 Milestone 3, US3, FR-022 to FR-024): the chunks come in position order, a page at a
// time, the same on every read, and not at all until the source is ready. A ready source is made here the way the worker's one
// commit leaves it (its original gone, its facts set, its chunks written), so that no worker or provider is needed.

const EMBEDDINGS = {
  EMBEDDING_PROVIDER: 'openai-compatible',
  EMBEDDING_MODEL: 'nomic-embed-text',
  EMBEDDING_BASE_URL: 'http://127.0.0.1:9/v1',
  EMBEDDING_LOCAL: 'true',
} as const;

describe('/api/v1 sources: reading (FR-022 to FR-024)', () => {
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
    for (const [name, value] of Object.entries({ ...LOCAL_PROVIDER, ...EMBEDDINGS, JOBS_PER_ACCOUNT: '100' })) vi.stubEnv(name, value);
    await db.query('TRUNCATE jobs, job_usage, workers, sources CASCADE');
    for await (const item of storage().list()) await storage().delete(item.key);
    const project = (await c.post<{ id: string }>('/projects', { name: `p-${randomUUID()}` })).body;
    threatModel = (await c.post<{ id: string }>('/threat-models', { project_id: project.id, name: 'model' })).body.id;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const addWaiting = async (): Promise<string> => {
    const data = new FormData();
    data.append('file', new Blob([Buffer.from(`# Design\n\n${randomUUID()}\n`)]), 'design.md');
    const res = await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/sources`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: data });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  // The ready state the worker's commit leaves: `count` chunks of five characters each; the first has a heading and a page.
  const makeReady = async (id: string, count: number): Promise<void> => {
    await db.query(
      `UPDATE sources SET original_key = NULL, ready_at = now(), text_chars = $2, chunk_count = $3, embedding_model = 'nomic-embed-text', embedding_dimension = 3 WHERE id = $1`,
      [id, count * 5, count],
    );
    for (let i = 0; i < count; i++) {
      await db.query(
        `INSERT INTO chunks (source_id, "position", start_offset, end_offset, text, embedding, page_first, page_last, line_first, line_last, heading)
         VALUES ($1, $2, $3, $4, $5, '[1,2,3]', $6, $7, $8, $9, $10)`,
        [id, i, i * 5, i * 5 + 5, `t${String(i).padStart(4, '0')}`, i === 0 ? 1 : null, i === 0 ? 2 : null, i === 0 ? null : i + 1, i === 0 ? null : i + 1, i === 0 ? 'Intro' : null],
      );
    }
  };

  describe('GET /sources/{id}', () => {
    it('answers with the source, ready, and with no embedding, key or path', async () => {
      const id = await addWaiting();
      await makeReady(id, 3);
      const res = await c.get(`/sources/${id}`);
      expect(res.status).toBe(200);
      const source = SourceRecord.parse(res.body);
      expect(source).toMatchObject({ id, status: 'ready', threat_model_id: threatModel });
      expect(source.ready).toMatchObject({ chunk_count: 3 });
      expect(JSON.stringify(res.body)).not.toMatch(/original_key|embedding"\s*:\s*\[|digest/);
    });

    it('answers 404 for an unknown id and 400 for a bad one', async () => {
      expect((await c.get(`/sources/${randomUUID()}`)).status).toBe(404);
      expect((await c.get('/sources/not-a-uuid')).status).toBe(400);
    });
  });

  describe('GET /sources/{id}/chunks', () => {
    it('pages by offset and limit in position order, with has_more, and a default page of 50', async () => {
      const id = await addWaiting();
      await makeReady(id, 120);
      const first = ChunkPage.parse((await c.get(`/sources/${id}/chunks`)).body);
      expect(first.chunks).toHaveLength(50);
      expect(first.has_more).toBe(true);
      expect(first.chunks.map((chunk) => chunk.position)).toEqual(Array.from({ length: 50 }, (_, i) => i));

      const second = ChunkPage.parse((await c.get(`/sources/${id}/chunks?offset=50&limit=50`)).body);
      expect(second.chunks[0]?.position).toBe(50);
      expect(second.has_more).toBe(true);

      const last = ChunkPage.parse((await c.get(`/sources/${id}/chunks?offset=100&limit=50`)).body);
      expect(last.chunks).toHaveLength(20);
      expect(last.has_more).toBe(false);
      expect(ChunkPage.parse((await c.get(`/sources/${id}/chunks?offset=500`)).body)).toEqual({ chunks: [], has_more: false });
    });

    it('gives each chunk its offsets, text, pages or lines, and heading, and never its embedding', async () => {
      const id = await addWaiting();
      await makeReady(id, 2);
      const res = await c.get(`/sources/${id}/chunks`);
      const page = ChunkPage.parse(res.body);
      expect(page.chunks[0]).toMatchObject({ position: 0, start_offset: 0, end_offset: 5, text: 't0000', pages: { first: 1, last: 2 }, lines: null, heading: 'Intro' });
      expect(page.chunks[1]).toMatchObject({ position: 1, start_offset: 5, end_offset: 10, text: 't0001', pages: null, lines: { first: 2, last: 2 }, heading: null });
      expect(JSON.stringify(res.body)).not.toContain('embedding');
    });

    it('gives the same ids and text on two reads (FR-023)', async () => {
      const id = await addWaiting();
      await makeReady(id, 5);
      const one = (await c.get(`/sources/${id}/chunks`)).body;
      const two = (await c.get(`/sources/${id}/chunks`)).body;
      expect(two).toEqual(one);
    });

    it('answers 409 "This source is not ready yet." while it waits, processes or has failed (FR-024)', async () => {
      const id = await addWaiting();
      const refused = await c.get<{ error: string }>(`/sources/${id}/chunks`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('This source is not ready yet.');

      const worker = (await db.query<{ id: string }>(`INSERT INTO workers (id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0]!.id;
      await db.query(
        `UPDATE jobs SET state = 'running', worker_id = $2, lease_expires_at = now() + interval '1 minute', started_at = now(), deadline_at = now() + interval '1 hour' WHERE source_id = $1`,
        [id, worker],
      );
      expect((await c.get(`/sources/${id}/chunks`)).status).toBe(409);

      await db.query(
        `UPDATE jobs SET state = 'failed', worker_id = NULL, lease_expires_at = NULL, finished_at = now(), failure_category = 'no_text_found' WHERE source_id = $1`,
        [id],
      );
      expect((await c.get(`/sources/${id}/chunks`)).status).toBe(409);
    });

    it('answers 404 for an unknown id, and 400 for a bad id or a bad page query that never repeats what was sent', async () => {
      expect((await c.get(`/sources/${randomUUID()}/chunks`)).status).toBe(404);
      expect((await c.get('/sources/not-a-uuid/chunks')).status).toBe(400);
      const id = await addWaiting();
      await makeReady(id, 1);
      for (const query of ['limit=0', 'limit=101', 'limit=zzqx', 'offset=-1', 'offset=1.5', 'zzqx=1']) {
        const res = await c.get<{ error: string }>(`/sources/${id}/chunks?${query}`);
        expect(res.status, query).toBe(400);
        expect(res.body.error).not.toContain('zzqx');
        expect(res.body.error).toBe('limit must be a whole number from 1 to 100, and offset a whole number of 0 or more');
      }
    });
  });
});
