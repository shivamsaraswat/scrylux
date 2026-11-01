import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openaiEmbeddings, openaiError, plainError, resetCapabilityOverrides, startStub, type RecordedRequest, type Scripted, type Stub } from '@scrylux/llm/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import db, { kdb } from '../../src/db.js';
import { cancelJob, type IngestionSettings } from '../../src/jobs/store.js';
import { worstCase } from '@scrylux/llm';
import { chunkDocument } from '../../src/sources/chunk.js';
import { documentFromText } from '../../src/sources/document.js';
import { parseSourceConfig } from '../../src/sources/config.js';
import { addSource, getSource, retrySource, type SourcesContext } from '../../src/sources/store.js';
import { StorageUnavailable, createStorage, type Storage } from '../../src/storage/index.js';
import { useStorage } from '../../src/storage/instance.js';
import { startWorker, type Worker } from '../../src/worker/loop.js';
import { FAST, clientFor, embeddingRequests, localConfig, makeUser, resetJobTables, waitFor } from '../worker/helpers.js';

// What a run that does not succeed leaves, and what a retry does (Phase 3 Milestone 3, US5, FR-013, FR-042, FR-044, SC-006): the
// real worker against a stub provider and a real storage directory. A failure keeps the original and writes no chunk; a retry
// runs the work again and writes each chunk once.

const JOB_SETTINGS: IngestionSettings = { tokenCap: 500_000, costCapUsd: 5, maxRuns: 3, timeLimitMs: 3_600_000, jobsPerAccount: 1000, providerCheckCooldownMs: 0, ingestionJobsPerAccount: 1000 };

let dir: string;
let storage: Storage;
let stub: Stub;
let alice: number;
let threatModel: string;
let worker: Worker | undefined;

const context = (over: Partial<SourcesContext> = {}): SourcesContext => ({ storage, config: parseSourceConfig({}), jobs: JOB_SETTINGS, embeddingModel: 'nomic-embed-text', ...over });
const vectors = (r: RecordedRequest): Scripted => {
  const body = r.body as { input?: string | string[] } | undefined;
  const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? ''];
  return openaiEmbeddings(inputs.map(() => [0.1, 0.2, 0.3]), inputs.length * 3);
};
async function startWorkerFor(over: { storage?: Storage } = {}): Promise<void> {
  const config = localConfig(stub.url);
  if (over.storage) useStorage(over.storage);
  worker = await startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings: FAST, storage: over.storage ?? storage });
}
const add = (text = '# Design\n\nThe gateway forwards requests.\n', ctx: SourcesContext = context()) =>
  addSource(kdb, ctx, { threatModelId: threatModel, accountId: alice, name: 'design.md', type: 'md', bytes: Buffer.from(text) });
const jobOf = async (sourceId: string) => (await db.query<{ id: string; state: string; run: number; failure_category: string | null }>(`SELECT id, state, run, failure_category FROM jobs WHERE source_id = $1 ORDER BY queued_at DESC`, [sourceId])).rows[0]!;
const chunkCount = async (sourceId: string): Promise<number> => Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM chunks WHERE source_id = $1', [sourceId])).rows[0]?.n);
const settled = (id: string, timeoutMs = 30_000) =>
  waitFor(async () => {
    const source = await getSource(kdb, context(), id);
    return source !== undefined && (source.status === 'ready' || source.status === 'failed') ? source : undefined;
  }, timeoutMs, `source ${id} to be ready or failed`);
/** After a run that failed for a reason that may pass, the next waits; the test does not. */
const expedite = async (sourceId: string, run: number): Promise<void> => {
  await waitFor(async () => ((await jobOf(sourceId)).state === 'queued' && (await jobOf(sourceId)).run === run ? true : undefined), 30_000, `run ${run} to end`);
  await db.query('UPDATE jobs SET next_run_at = now() WHERE source_id = $1', [sourceId]);
};
async function stored(): Promise<string[]> {
  const keys: string[] = [];
  for await (const item of storage.list()) keys.push(item.key);
  return keys;
}
/** Enough text for several chunks, so that there are several embedding requests. */
const longText = (chunksWanted: number): string => Array.from({ length: chunksWanted }, (_, i) => `Section ${i}\n\n${'The gateway forwards each request to the payment service and stores the record. '.repeat(24)}`).join('\n\n');

beforeEach(async () => {
  resetCapabilityOverrides();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await resetJobTables();
  await db.query('TRUNCATE sources CASCADE');
  dir = await mkdtemp(join(tmpdir(), 'scrylux-ingest-failures-'));
  storage = createStorage({ backend: 'local', dir });
  useStorage(storage);
  alice = await makeUser();
  const { rows: project } = await db.query<{ id: string }>('INSERT INTO projects (name, created_by) VALUES ($1, $2) RETURNING id', [`p-${randomUUID()}`, alice]);
  threatModel = (await db.query<{ id: string }>('INSERT INTO threat_models (project_id, name) VALUES ($1, $2) RETURNING id', [project[0]?.id, 'model'])).rows[0]!.id;
  stub = await startStub();
  stub.setFallback(vectors);
});
afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await stub.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('storage that cannot be read', () => {
  it('runs again after a wait, then becomes ready once storage answers (FR-013)', async () => {
    let failures = 1;
    const flaky: Storage = { ...storage, get: (key) => (failures-- > 0 ? Promise.reject(new StorageUnavailable()) : storage.get(key)) };
    const source = await add();
    await startWorkerFor({ storage: flaky });
    await expedite(source.id, 1);
    expect((await settled(source.id)).status).toBe('ready');
    expect((await jobOf(source.id)).run).toBe(2);
  }, 90_000);

  it('fails as storage unavailable when it never answers, keeps the original, and a retry succeeds once it does', async () => {
    let down = true;
    const flaky: Storage = { ...storage, get: (key) => (down ? Promise.reject(new StorageUnavailable()) : storage.get(key)) };
    const source = await add();
    await startWorkerFor({ storage: flaky });
    await expedite(source.id, 1);
    await expedite(source.id, 2);
    const failed = await settled(source.id, 60_000);
    expect(failed.failure).toMatchObject({ category: 'storage_unavailable', retryable: true });
    expect(await chunkCount(source.id)).toBe(0);
    expect(await stored()).toHaveLength(1);

    down = false;
    expect(await retrySource(kdb, context(), { sourceId: source.id, accountId: alice })).toBeDefined();
    expect((await settled(source.id, 60_000)).status).toBe('ready');
  }, 120_000);
});

describe('a provider that is unavailable', () => {
  it('fails as provider unavailable after the runs, writes no chunk, keeps the original, and a retry writes each chunk once (SC-006)', async () => {
    // The provider layer tries a request three times itself, so each run uses up three answers.
    stub.setFallback(() => plainError(503, 'unavailable'));
    const text = longText(3);
    const source = await add(text);
    await startWorkerFor();
    await expedite(source.id, 1);
    await expedite(source.id, 2);
    const failed = await settled(source.id, 60_000);
    expect(failed.failure).toMatchObject({ category: 'provider_unavailable', retryable: true });
    expect(await chunkCount(source.id)).toBe(0);
    expect(await stored()).toHaveLength(1);
    expect((await jobOf(source.id)).run).toBe(3);

    stub.setFallback(vectors);
    expect(await retrySource(kdb, context(), { sourceId: source.id, accountId: alice })).toBeDefined();
    const ready = await settled(source.id, 60_000);
    expect(ready.status).toBe('ready');
    const { rows } = await db.query<{ position: number }>('SELECT position FROM chunks WHERE source_id = $1 ORDER BY position', [source.id]);
    expect(rows.map((r) => r.position)).toEqual(rows.map((_, i) => i));
    expect(rows.length).toBe(ready.ready?.chunk_count);
    expect(await stored()).toEqual([]);
  }, 180_000);
});

describe('a chunk the model cannot take', () => {
  it('fails as input too large with the hint for documents, and is not retryable until the model changes', async () => {
    stub.setFallback(() => openaiError(400, 'This input is too long for the model.', { code: 'context_length_exceeded' }));
    const source = await add();
    await startWorkerFor();
    const failed = await settled(source.id);
    expect(failed.failure).toMatchObject({ category: 'input_too_large', retryable: false });
    expect(failed.failure?.hint).toMatch(/embedding model|chunk/i);
    expect(await chunkCount(source.id)).toBe(0);
    expect(await stored()).toHaveLength(1);
    // Ends at once: another run would meet the same refusal (FR-013).
    expect((await jobOf(source.id)).run).toBe(1);
  });
});

describe('a job cancelled from the Jobs page (FR-044)', () => {
  it('leaves the source failed as cancelled, and retryable, with its original', async () => {
    // The first embedding request is held, so the job is in the middle of it.
    stub.setFallback((r) => ({ delay: 60_000, then: vectors(r) }));
    const source = await add();
    const job = await jobOf(source.id);
    await startWorkerFor();
    await waitFor(() => embeddingRequests(stub)[0], 10_000, 'the embedding request');
    await cancelJob(kdb, job.id, alice);
    const done = await settled(source.id, 15_000);
    expect(done.failure).toMatchObject({ category: 'cancelled', retryable: true });
    expect(await chunkCount(source.id)).toBe(0);
    expect(await stored()).toHaveLength(1);
  });
});

describe('a worker that is lost in the middle of a run (SC-006)', () => {
  it('lets another worker take the document, which ends ready with each chunk once, and none of the lost run', async () => {
    // The first embedding request is held for the worker that is lost; every later one is answered at once.
    let first = true;
    stub.setFallback((r) => {
      if (first) {
        first = false;
        return { delay: 60_000, then: vectors(r) };
      }
      return vectors(r);
    });
    const source = await add(longText(3));
    const job = await jobOf(source.id);
    await startWorkerFor();
    const lost = worker as Worker;
    await waitFor(() => embeddingRequests(stub)[0], 10_000, 'the embedding request of the first worker');
    // It is gone as a crashed one is: nothing more is written, and its lease is left to run out.
    await lost.abandon();
    worker = undefined;
    expect(await chunkCount(source.id)).toBe(0);

    // Another worker finds the lease run out and queues the job again, after the wait a lost run is given; the test does not wait.
    await startWorkerFor();
    await expedite(source.id, 1);
    const ready = await settled(source.id, 30_000);
    expect(ready.status).toBe('ready');
    expect((await jobOf(source.id)).run).toBe(2);

    const { rows } = await db.query<{ id: string; position: number }>('SELECT id, position FROM chunks WHERE source_id = $1 ORDER BY position', [source.id]);
    expect(rows.length).toBe(ready.ready?.chunk_count);
    expect(rows.map((row) => row.position)).toEqual(rows.map((_, i) => i));
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(await stored()).toEqual([]);
    // Left alone, nothing changes: the lost worker's request does not come back to write a second copy.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await db.query<{ id: string }>('SELECT id FROM chunks WHERE source_id = $1 ORDER BY position', [source.id])).rows).toEqual(rows.map((row) => ({ id: row.id })));
    expect(job.id).toBe((await jobOf(source.id)).id);
  }, 60_000);
});

describe('a job that would pass its caps (FR-042)', () => {
  it('fails as cap reached, writes no chunk, and sends nothing past the cap, with the usage of what was sent kept', async () => {
    stub.setFallback(vectors);
    // Three requests' worth of chunks, and a cap that holds the first request's worst case but not the second's.
    const text = longText(180);
    const chunks = chunkDocument(documentFromText('md', text));
    const worstOf = (from: number, to: number): number => worstCase(localConfig(stub.url), { operation: 'embed', inputChars: chunks.slice(from, to).reduce((sum, chunk) => sum + chunk.text.length, 0) }).tokens;
    expect(chunks.length).toBeGreaterThan(128);
    // What the stub reports for the first request is 3 tokens a chunk, so the second does not fit.
    const cap = worstOf(0, 64) + 50;
    expect(64 * 3 + worstOf(64, 128)).toBeGreaterThan(cap);
    const source = await add(text, context({ jobs: { ...JOB_SETTINGS, tokenCap: cap } }));
    await startWorkerFor();
    const failed = await settled(source.id, 60_000);
    expect(failed.failure?.category).toBe('cap_reached');
    expect(await chunkCount(source.id)).toBe(0);
    expect(await stored()).toHaveLength(1);

    const { rows: usage } = await db.query<{ tokens: string }>(`SELECT coalesce(sum(input_tokens + output_tokens), 0)::text AS tokens FROM job_usage WHERE job_id = $1`, [(await jobOf(source.id)).id]);
    // The usage of every request that was sent is stored, and it never passed the cap.
    expect(Number(usage[0]?.tokens)).toBeGreaterThan(0);
    expect(Number(usage[0]?.tokens)).toBeLessThanOrEqual(cap);
    const { rows: requests } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM job_usage WHERE job_id = $1`, [(await jobOf(source.id)).id]);
    // Every request that reached the provider has a usage record: none was sent that the gate had not let through.
    expect(embeddingRequests(stub)).toHaveLength(Number(requests[0]?.n));
    expect(embeddingRequests(stub).length).toBeLessThan(Math.ceil(180 / 64));
  }, 90_000);
});
