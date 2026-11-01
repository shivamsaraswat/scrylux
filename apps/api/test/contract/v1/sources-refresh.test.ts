import { randomUUID } from 'node:crypto';
import { ChunkPage, SourceRecord } from '@scrylux/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { storage } from '../../../src/storage/instance.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { client, type V1Client } from './helpers.js';
import { LOCAL_PROVIDER } from './jobs-helpers.js';

// Refreshing the embeddings of a ready source (Phase 3 Milestone 3, US6, FR-034, FR-061): offered when the configured model is not
// the one that made them, refused with the reason otherwise, and never a reason to hide a source's text. No worker is needed: a
// ready source is made here the way the worker's commit leaves it.

const EMBEDDINGS = {
  EMBEDDING_PROVIDER: 'openai-compatible',
  EMBEDDING_MODEL: 'nomic-embed-text',
  EMBEDDING_BASE_URL: 'http://127.0.0.1:9/v1',
  EMBEDDING_LOCAL: 'true',
} as const;

describe('POST /api/v1/sources/{id}/refresh', () => {
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

  const upload = async (): Promise<string> => {
    const data = new FormData();
    data.append('file', new Blob([Buffer.from(`# Design\n\n${randomUUID()}\n`)]), 'design.md');
    const res = await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/sources`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: data });
    return ((await res.json()) as { id: string }).id;
  };
  /** A ready source whose embeddings were made by `model`, as the worker's commit leaves it. */
  const ready = async (model = 'nomic-embed-text'): Promise<string> => {
    const id = await upload();
    await db.query(`UPDATE sources SET original_key = NULL, ready_at = now(), text_chars = 10, chunk_count = 2, embedding_model = $2, embedding_dimension = 3 WHERE id = $1`, [id, model]);
    for (let i = 0; i < 2; i++) {
      await db.query(`INSERT INTO chunks (source_id, "position", start_offset, end_offset, text, embedding) VALUES ($1, $2, $3, $4, $5, '[1,2,3]')`, [id, i, i * 5, i * 5 + 5, `t000${i}`]);
    }
    await db.query(`UPDATE jobs SET state = 'succeeded', finished_at = now(), started_at = now(), deadline_at = now() + interval '1 hour', run = 1 WHERE source_id = $1`, [id]);
    return id;
  };
  const refresh = (id: string) => c.post<{ error?: string } & Record<string, unknown>>(`/sources/${id}/refresh`);
  const refreshJobs = async () => (await db.query<{ state: string }>(`SELECT state FROM jobs WHERE kind = 'refresh_embeddings'`)).rows;

  it('queues a refresh for a ready source whose embeddings are out of date, and the source shows it', async () => {
    const id = await ready('an-older-model');
    const before = SourceRecord.parse((await c.get(`/sources/${id}`)).body);
    expect(before.ready?.embedding.state).toBe('out_of_date');
    expect(before.refreshable).toBe(true);

    const res = await refresh(id);
    expect(res.status).toBe(200);
    const after = SourceRecord.parse(res.body);
    expect(after.status).toBe('ready');
    expect(after.refresh).toMatchObject({ state: 'queued' });
    expect(after.refreshable).toBe(false);
    expect(await refreshJobs()).toEqual([{ state: 'queued' }]);
  });

  it('refuses a source that is not ready', async () => {
    const id = await upload();
    const res = await refresh(id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This source is not ready yet.');
    expect(await refreshJobs()).toEqual([]);
  });

  it('refuses a source whose embeddings are current', async () => {
    const id = await ready('nomic-embed-text');
    const res = await refresh(id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('The embeddings of this source are current.');
  });

  it('refuses a source that is already being refreshed, and queues only one job when two ask at once', async () => {
    const id = await ready('an-older-model');
    const [one, two] = await Promise.all([refresh(id), refresh(id)]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect(await refreshJobs()).toHaveLength(1);
    const again = await refresh(id);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('This source is already being refreshed.');
  });

  it('refuses everything while no embedding provider is configured, and still lists the source and serves its chunks', async () => {
    const id = await ready('an-older-model');
    for (const name of Object.keys(EMBEDDINGS)) vi.stubEnv(name, '');
    const res = await refresh(id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/embedding provider/);

    const shown = SourceRecord.parse((await c.get(`/sources/${id}`)).body);
    expect(shown.status).toBe('ready');
    expect(shown.ready?.embedding.state).toBe('no_provider');
    expect(shown.refreshable).toBe(false);
    const list = (await c.get<{ sources: { id: string }[] }>(`/threat-models/${threatModel}/sources`)).body;
    expect(list.sources.map((s) => s.id)).toEqual([id]);
    const chunks = ChunkPage.parse((await c.get(`/sources/${id}/chunks`)).body);
    expect(chunks.chunks.map((chunk) => chunk.text)).toEqual(['t0000', 't0001']);
  });

  it('answers 404 for an unknown source and 400 for a bad id', async () => {
    expect((await refresh(randomUUID())).status).toBe(404);
    expect((await refresh('not-a-uuid')).status).toBe(400);
  });

  it('writes one line for the refresh, with the source and its threat model and no name', async () => {
    const id = await ready('an-older-model');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await refresh(id);
    const lines = log.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('"event":"source"'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ action: 'refresh', source: id, threat_model: threatModel, type: 'md' });
    expect(lines[0]).not.toContain('design.md');
  });
});
