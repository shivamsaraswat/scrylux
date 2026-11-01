import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../src/app.js';
import db, { kdb } from '../../../src/db.js';
import { claimJob, registerWorker } from '../../../src/jobs/store.js';
import { StorageUnavailable, assertOriginalKey } from '../../../src/storage/index.js';
import { storage } from '../../../src/storage/instance.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { client, type V1Client } from './helpers.js';
import { LOCAL_PROVIDER } from './jobs-helpers.js';

// Deleting a source, a threat model or a project removes the originals, the text and the chunks, and asks the jobs to stop
// (Phase 3 Milestone 3, US4, FR-054, FR-055, FR-061). A storage that cannot remove an original does not fail the deletion: the
// sweep removes it later.

const EMBEDDINGS = {
  EMBEDDING_PROVIDER: 'openai-compatible',
  EMBEDDING_MODEL: 'nomic-embed-text',
  EMBEDDING_BASE_URL: 'http://127.0.0.1:9/v1',
  EMBEDDING_LOCAL: 'true',
} as const;

describe('/api/v1 sources: deleting (FR-054, FR-055)', () => {
  let server: TestServer;
  let c: V1Client;
  let token: string;
  let project: string;
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
    project = (await c.post<{ id: string }>('/projects', { name: `p-${randomUUID()}` })).body.id;
    threatModel = (await c.post<{ id: string }>('/threat-models', { project_id: project, name: 'model' })).body.id;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const add = async (tm = threatModel): Promise<string> => {
    const data = new FormData();
    data.append('file', new Blob([Buffer.from(`# Design\n\n${randomUUID()}\n`)]), 'design.md');
    const res = await fetch(`${server.baseUrl}/api/v1/threat-models/${tm}/sources`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: data });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const makeReady = async (id: string): Promise<void> => {
    // As the worker's commit does: the original is forgotten and removed.
    const key = (await db.query<{ original_key: string }>('SELECT original_key FROM sources WHERE id = $1', [id])).rows[0]!.original_key;
    await storage().delete(assertOriginalKey(key));
    await db.query(`UPDATE sources SET original_key = NULL, ready_at = now(), text_chars = 10, chunk_count = 2, embedding_model = 'nomic-embed-text', embedding_dimension = 3 WHERE id = $1`, [id]);
    for (let i = 0; i < 2; i++) {
      await db.query(`INSERT INTO chunks (source_id, "position", start_offset, end_offset, text, embedding) VALUES ($1, $2, $3, $4, 'hello', '[1,2,3]')`, [id, i, i * 5, i * 5 + 5]);
    }
  };
  const keys = async (): Promise<string[]> => {
    const found: string[] = [];
    for await (const item of storage().list()) found.push(item.key);
    return found;
  };
  const count = async (table: string): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);
  const logged = (spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] =>
    spy.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, unknown>);

  describe('DELETE /sources/{id}', () => {
    it('answers 204 and removes the source, its original and its queued job’s work', async () => {
      const id = await add();
      expect(await keys()).toHaveLength(1);
      const res = await c.del(`/sources/${id}`);
      expect(res.status).toBe(204);
      expect(await count('sources')).toBe(0);
      expect(await keys()).toEqual([]);
      expect((await c.get(`/sources/${id}`)).status).toBe(404);
      // The job is kept as a record of what was asked, cancelled, and no longer points at a source.
      const { rows } = await db.query(`SELECT state, source_id, cancelled_by IS NOT NULL AS by FROM jobs`);
      expect(rows).toEqual([{ state: 'cancelled', source_id: null, by: true }]);
    });

    it('removes a ready source’s chunks', async () => {
      const id = await add();
      await makeReady(id);
      expect(await count('chunks')).toBe(2);
      expect((await c.del(`/sources/${id}`)).status).toBe(204);
      expect(await count('chunks')).toBe(0);
    });

    it('asks a running job to stop, and does not end it before its worker has', async () => {
      const id = await add();
      const worker = randomUUID();
      await registerWorker(kdb, worker);
      const claimed = await claimJob(kdb, worker, 60_000);
      expect(claimed).not.toBeNull();
      expect((await c.del(`/sources/${id}`)).status).toBe(204);
      const { rows } = await db.query(`SELECT state, cancel_requested_at IS NOT NULL AS asked FROM jobs`);
      expect(rows).toEqual([{ state: 'running', asked: true }]);
      expect(await count('sources')).toBe(0);
    });

    it('answers 404 the second time, 404 for an unknown id and 400 for a bad one', async () => {
      const id = await add();
      expect((await c.del(`/sources/${id}`)).status).toBe(204);
      expect((await c.del(`/sources/${id}`)).status).toBe(404);
      expect((await c.del(`/sources/${randomUUID()}`)).status).toBe(404);
      expect((await c.del('/sources/not-a-uuid')).status).toBe(400);
    });

    it('still succeeds when storage cannot remove the original, and leaves it for the sweep (FR-055)', async () => {
      const id = await add();
      vi.spyOn(storage(), 'delete').mockRejectedValue(new StorageUnavailable());
      expect((await c.del(`/sources/${id}`)).status).toBe(204);
      expect(await count('sources')).toBe(0);
      expect(await keys()).toHaveLength(1);
    });

    it('writes one line, with the source, its threat model, its type and its size, and neither its name nor its text', async () => {
      const id = await add();
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await c.del(`/sources/${id}`);
      const lines = logged(log).filter((line) => line.event === 'source');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ action: 'delete', source: id, threat_model: threatModel, type: 'md' });
      expect(JSON.stringify(lines)).not.toContain('design.md');
    });
  });

  describe('deleting what holds sources', () => {
    it('a threat model: every original, chunk, source and job of it goes, and another threat model’s stay', async () => {
      const other = (await c.post<{ id: string }>('/threat-models', { project_id: project, name: 'other' })).body.id;
      const waiting = await add();
      const ready = await add();
      await makeReady(ready);
      const kept = await add(other);
      expect(waiting).not.toBe(kept);
      expect((await c.del(`/threat-models/${threatModel}`)).status).toBe(204);
      const { rows } = await db.query<{ id: string }>('SELECT id FROM sources');
      expect(rows.map((r) => r.id)).toEqual([kept]);
      expect(await count('chunks')).toBe(0);
      expect(await keys()).toHaveLength(1);
      expect(await count('jobs')).toBe(1);
    });

    it('a project: the originals of every threat model in it go', async () => {
      const second = (await c.post<{ id: string }>('/threat-models', { project_id: project, name: 'second' })).body.id;
      await add();
      await add(second);
      await add(second);
      const otherProject = (await c.post<{ id: string }>('/projects', { name: `p-${randomUUID()}` })).body.id;
      const otherModel = (await c.post<{ id: string }>('/threat-models', { project_id: otherProject, name: 'elsewhere' })).body.id;
      const safe = await add(otherModel);
      expect(await keys()).toHaveLength(4);
      expect((await c.del(`/projects/${project}`)).status).toBe(204);
      expect((await db.query<{ id: string }>('SELECT id FROM sources')).rows.map((r) => r.id)).toEqual([safe]);
      expect(await keys()).toHaveLength(1);
    });

    it('a threat model or a project that is not there is 404, and nothing is removed', async () => {
      await add();
      expect((await c.del(`/threat-models/${randomUUID()}`)).status).toBe(404);
      expect((await c.del(`/projects/${randomUUID()}`)).status).toBe(404);
      expect(await count('sources')).toBe(1);
      expect(await keys()).toHaveLength(1);
    });

    it('still deletes when storage cannot remove an original, and leaves it for the sweep', async () => {
      await add();
      vi.spyOn(storage(), 'delete').mockRejectedValue(new StorageUnavailable());
      expect((await c.del(`/threat-models/${threatModel}`)).status).toBe(204);
      expect(await count('sources')).toBe(0);
      expect(await keys()).toHaveLength(1);
    });

    it('a threat model with a running ingestion job: the job goes with it and the delete does not wait for the worker', async () => {
      await add();
      const worker = randomUUID();
      await registerWorker(kdb, worker);
      await claimJob(kdb, worker, 60_000);
      expect((await c.del(`/threat-models/${threatModel}`)).status).toBe(204);
      expect(await count('jobs')).toBe(0);
    });
  });
});
