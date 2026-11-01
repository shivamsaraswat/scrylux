import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openaiEmbeddings, openaiError, plainError, resetCapabilityOverrides, startStub, type RecordedRequest, type Scripted, type Stub } from '@scrylux/llm/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import db, { kdb } from '../../src/db.js';
import { cancelJob, type IngestionSettings } from '../../src/jobs/store.js';
import { parseSourceConfig } from '../../src/sources/config.js';
import { addSource, getSource, refreshSource, retrySource, type SourcesContext } from '../../src/sources/store.js';
import { createStorage, type Storage } from '../../src/storage/index.js';
import { useStorage } from '../../src/storage/instance.js';
import { startWorker, type Worker } from '../../src/worker/loop.js';
import { FAST, clientFor, embeddingRequests, localConfig, makeUser, resetJobTables, waitFor } from '../worker/helpers.js';

// Keeping embeddings in step with the configured model (Phase 3 Milestone 3, US6, FR-034, SC-007): when the model changes, a
// source's embeddings are out of date, and a refresh replaces every one of them in one commit without changing a chunk. A refresh
// that does not finish leaves the source ready with the embeddings it had, so a source never holds two models' vectors.

const OLD_MODEL = 'nomic-embed-text';
const NEW_MODEL = 'a-newer-embedding-model';
const JOB_SETTINGS: IngestionSettings = { tokenCap: 500_000, costCapUsd: 5, maxRuns: 1, timeLimitMs: 3_600_000, jobsPerAccount: 1000, providerCheckCooldownMs: 0, ingestionJobsPerAccount: 1000 };

let dir: string;
let storage: Storage;
let stub: Stub;
let alice: number;
let threatModel: string;
let worker: Worker | undefined;

const context = (model: string | null = OLD_MODEL): SourcesContext => ({ storage, config: parseSourceConfig({}), jobs: JOB_SETTINGS, embeddingModel: model });
/** An /embeddings answer whose vectors have `dimension` numbers, and say which model made them by their first number. */
const embedWith = (dimension: number) => (r: RecordedRequest): Scripted => {
  const body = r.body as { model?: string; input?: string | string[] } | undefined;
  const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? ''];
  const first = body?.model === NEW_MODEL ? 0.9 : 0.1;
  return openaiEmbeddings(inputs.map(() => Array.from({ length: dimension }, (_, d) => first + d / 1000)), inputs.length * 3);
};
async function startWorkerFor(model: string): Promise<void> {
  const config = localConfig(stub.url, { extra: { EMBEDDING_MODEL: model } });
  worker = await startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings: FAST, storage });
}
const settled = (id: string, model = OLD_MODEL) =>
  waitFor(async () => {
    const source = await getSource(kdb, context(model), id);
    return source !== undefined && (source.status === 'ready' || source.status === 'failed') ? source : undefined;
  }, 30_000, 'the source to be ready');
/** A ready source, ingested for real with the old model and a vector of three numbers. */
async function readySource(): Promise<string> {
  stub.setFallback(embedWith(3));
  const text = `# Design\n\n${Array.from({ length: 40 }, (_, i) => `Part ${i}: the gateway forwards request ${i} to service ${i}.`).join('\n')}\n`;
  const added = await addSource(kdb, context(), { threatModelId: threatModel, accountId: alice, name: 'design.md', type: 'md', bytes: Buffer.from(text) });
  await startWorkerFor(OLD_MODEL);
  await settled(added.id);
  await worker?.stop();
  worker = undefined;
  return added.id;
}
const refreshJob = async (sourceId: string) =>
  (await db.query<{ id: string; state: string }>(`SELECT id, state FROM jobs WHERE source_id = $1 AND kind = 'refresh_embeddings' ORDER BY queued_at DESC`, [sourceId])).rows[0];
const jobEnded = (sourceId: string) =>
  waitFor(async () => {
    const job = await refreshJob(sourceId);
    return job !== undefined && ['succeeded', 'failed', 'cancelled'].includes(job.state) ? job : undefined;
  }, 30_000, 'the refresh to end');
const chunks = async (sourceId: string) => (await db.query<{ id: string; text: string; position: number; dims: number; first: number }>(`SELECT id, text, position, vector_dims(embedding) AS dims, (embedding::real[])[1] AS first FROM chunks WHERE source_id = $1 ORDER BY position`, [sourceId])).rows;
const sourceRow = async (sourceId: string) => (await db.query<{ embedding_model: string; embedding_dimension: number; stored_bytes: string; chunk_count: number }>(`SELECT embedding_model, embedding_dimension, stored_bytes, chunk_count FROM sources WHERE id = $1`, [sourceId])).rows[0]!;

/** SC-007: every chunk of a source has the dimension its source says, and the source names one model. */
async function expectOneModel(sourceId: string, model: string, dimension: number): Promise<void> {
  const mismatched = await db.query(`SELECT 1 FROM chunks c JOIN sources s ON s.id = c.source_id WHERE s.id = $1 AND vector_dims(c.embedding) <> s.embedding_dimension`, [sourceId]);
  expect(mismatched.rowCount).toBe(0);
  const row = await sourceRow(sourceId);
  expect(row).toMatchObject({ embedding_model: model, embedding_dimension: dimension });
  const made = new Set((await chunks(sourceId)).map((c) => Math.round(c.first * 10)));
  // The first number of a vector tells which model made it: every chunk has the same one.
  expect(made.size).toBe(1);
}

beforeEach(async () => {
  resetCapabilityOverrides();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await resetJobTables();
  await db.query('TRUNCATE sources CASCADE');
  dir = await mkdtemp(join(tmpdir(), 'scrylux-ingest-refresh-'));
  storage = createStorage({ backend: 'local', dir });
  useStorage(storage);
  alice = await makeUser();
  const { rows: project } = await db.query<{ id: string }>('INSERT INTO projects (name, created_by) VALUES ($1, $2) RETURNING id', [`p-${randomUUID()}`, alice]);
  threatModel = (await db.query<{ id: string }>('INSERT INTO threat_models (project_id, name) VALUES ($1, $2) RETURNING id', [project[0]?.id, 'model'])).rows[0]!.id;
  stub = await startStub();
});
afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await stub.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('a refresh after the configured model changed', () => {
  it('shows the embeddings as out of date, then replaces every one, keeping every id and every text', async () => {
    const id = await readySource();
    const before = await chunks(id);
    expect(before.length).toBeGreaterThan(0);
    expect((await getSource(kdb, context(OLD_MODEL), id))?.ready?.embedding.state).toBe('current');
    const outOfDate = await getSource(kdb, context(NEW_MODEL), id);
    expect(outOfDate?.ready?.embedding.state).toBe('out_of_date');
    expect(outOfDate?.refreshable).toBe(true);

    stub.setFallback(embedWith(3));
    await refreshSource(kdb, context(NEW_MODEL), { sourceId: id, accountId: alice });
    await startWorkerFor(NEW_MODEL);
    expect((await jobEnded(id)).state).toBe('succeeded');

    const after = await chunks(id);
    expect(after.map((c) => [c.id, c.text, c.position])).toEqual(before.map((c) => [c.id, c.text, c.position]));
    expect(after.every((c, i) => Math.abs(c.first - 0.9) < 0.001 && Math.abs((before[i]?.first ?? 0) - 0.1) < 0.001)).toBe(true);
    await expectOneModel(id, NEW_MODEL, 3);
    const refreshed = await getSource(kdb, context(NEW_MODEL), id);
    expect(refreshed?.ready?.embedding).toMatchObject({ model: NEW_MODEL, state: 'current' });
    expect(refreshed?.refreshable).toBe(false);
  }, 60_000);

  it('sets the new dimension, and stored bytes that count the text and the new vectors', async () => {
    const id = await readySource();
    stub.setFallback(embedWith(8));
    await refreshSource(kdb, context(NEW_MODEL), { sourceId: id, accountId: alice });
    await startWorkerFor(NEW_MODEL);
    await jobEnded(id);
    const rows = await chunks(id);
    const textBytes = rows.reduce((sum, c) => sum + Buffer.byteLength(c.text, 'utf8'), 0);
    expect(Number((await sourceRow(id)).stored_bytes)).toBe(textBytes + rows.length * 8 * 4);
    expect(rows.every((c) => c.dims === 8)).toBe(true);
    await expectOneModel(id, NEW_MODEL, 8);
  }, 60_000);

  it('embeds only the stored chunks, in order, and never reads an original (there is none)', async () => {
    const id = await readySource();
    const before = (await chunks(id)).map((c) => c.text);
    stub.requests.length = 0;
    stub.setFallback(embedWith(3));
    await refreshSource(kdb, context(NEW_MODEL), { sourceId: id, accountId: alice });
    await startWorkerFor(NEW_MODEL);
    await jobEnded(id);
    const sent = embeddingRequests(stub).flatMap((r) => (r.body as { input: string[] }).input);
    expect(sent).toEqual(before);
    const keys: string[] = [];
    for await (const item of storage.list()) keys.push(item.key);
    expect(keys).toEqual([]);
  }, 60_000);
});

describe('a refresh that does not finish', () => {
  it('fails as document space full, when larger vectors would pass the install’s space, and the old embeddings stay', async () => {
    const id = await readySource();
    const used = Number((await sourceRow(id)).stored_bytes);
    // Another source fills the install to within a little of its space, so that this one cannot grow.
    vi.stubEnv('DOCUMENT_SPACE', '100MB');
    const cap = 100 * 1024 * 1024;
    await db.query(
      `INSERT INTO sources (threat_model_id, name, type, size_bytes, digest, added_by, stored_bytes, ready_at, text_chars, chunk_count, embedding_model, embedding_dimension)
       VALUES ($1, 'filler.md', 'md', 10, $2, $3, $4, now(), 1, 1, 'x', 3)`,
      [threatModel, randomBytes(32), alice, cap - used - 100],
    );
    stub.setFallback(embedWith(512));
    await refreshSource(kdb, context(NEW_MODEL), { sourceId: id, accountId: alice });
    await startWorkerFor(NEW_MODEL);
    expect((await jobEnded(id)).state).toBe('failed');

    const shown = await getSource(kdb, context(NEW_MODEL), id);
    expect(shown?.status).toBe('ready');
    expect(shown?.refresh_failure).toMatchObject({ category: 'document_space_full' });
    await expectOneModel(id, OLD_MODEL, 3);
    expect((await chunks(id)).every((c) => c.dims === 3)).toBe(true);
  }, 60_000);

  it('leaves the source ready with its earlier embeddings, and a failure that can be retried, when the provider is unavailable', async () => {
    const id = await readySource();
    stub.setFallback(() => plainError(503, 'unavailable'));
    await refreshSource(kdb, context(NEW_MODEL), { sourceId: id, accountId: alice });
    await startWorkerFor(NEW_MODEL);
    expect((await jobEnded(id)).state).toBe('failed');

    const shown = await getSource(kdb, context(NEW_MODEL), id);
    expect(shown?.status).toBe('ready');
    expect(shown?.refresh_failure).toMatchObject({ category: 'provider_unavailable', retryable: true });
    expect(shown?.ready?.embedding.state).toBe('out_of_date');
    await expectOneModel(id, OLD_MODEL, 3);
  }, 60_000);

  it('leaves the source ready with its earlier embeddings when the refresh is cancelled', async () => {
    const id = await readySource();
    stub.setFallback((r) => ({ delay: 60_000, then: embedWith(3)(r) }));
    await refreshSource(kdb, context(NEW_MODEL), { sourceId: id, accountId: alice });
    await startWorkerFor(NEW_MODEL);
    await waitFor(() => embeddingRequests(stub)[0], 10_000, 'the embedding request');
    const job = (await refreshJob(id))!;
    await cancelJob(kdb, job.id, alice);
    expect((await jobEnded(id)).state).toBe('cancelled');

    const shown = await getSource(kdb, context(NEW_MODEL), id);
    expect(shown?.status).toBe('ready');
    expect(shown?.refresh_failure).toMatchObject({ category: 'cancelled' });
    await expectOneModel(id, OLD_MODEL, 3);
  }, 60_000);

  it('fails as input too large when the new model refuses the chunk size, keeps the earlier embeddings, and is retried only once the model changes', async () => {
    const id = await readySource();
    stub.setFallback(() => openaiError(400, 'This input is longer than the model accepts.', { code: 'context_length_exceeded' }));
    await refreshSource(kdb, context(NEW_MODEL), { sourceId: id, accountId: alice });
    await startWorkerFor(NEW_MODEL);
    expect((await jobEnded(id)).state).toBe('failed');

    const shown = await getSource(kdb, context(NEW_MODEL), id);
    expect(shown?.status).toBe('ready');
    expect(shown?.ready?.embedding.state).toBe('out_of_date');
    expect(shown?.refresh_failure).toMatchObject({ category: 'input_too_large', retryable: false });
    expect(shown?.refresh_failure?.hint).toMatch(/chunk/i);
    await expectOneModel(id, OLD_MODEL, 3);
    // The same model would refuse again, so no job is queued for it.
    const refused = await retrySource(kdb, context(NEW_MODEL), { sourceId: id, accountId: alice }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 409 });
    expect((await db.query(`SELECT 1 FROM jobs WHERE kind = 'refresh_embeddings'`)).rowCount).toBe(1);
    // Another model is worth trying, and the retry is a refresh.
    const retried = await retrySource(kdb, context('a-third-embedding-model'), { sourceId: id, accountId: alice });
    expect(retried?.refresh).toMatchObject({ state: 'queued' });
    expect((await db.query(`SELECT 1 FROM jobs WHERE kind = 'refresh_embeddings'`)).rowCount).toBe(2);
  }, 60_000);

  it('fails as not configured, and changes nothing, when the worker has no embedding provider', async () => {
    const id = await readySource();
    await refreshSource(kdb, context(NEW_MODEL), { sourceId: id, accountId: alice });
    const config = localConfig(stub.url, { embeddings: false });
    worker = await startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings: FAST, storage });
    expect((await jobEnded(id)).state).toBe('failed');
    await expectOneModel(id, OLD_MODEL, 3);
    expect(embeddingRequests(stub).filter((r) => (r.body as { model?: string }).model === NEW_MODEL)).toHaveLength(0);
  }, 60_000);

  it('does nothing, and ends cancelled, when the source was deleted while the refresh waited', async () => {
    const id = await readySource();
    await refreshSource(kdb, context(NEW_MODEL), { sourceId: id, accountId: alice });
    await db.query('DELETE FROM sources WHERE id = $1', [id]);
    expect((await db.query('SELECT 1 FROM chunks')).rowCount).toBe(0);
    await startWorkerFor(NEW_MODEL);
    await waitFor(async () => (await db.query(`SELECT 1 FROM jobs WHERE kind = 'refresh_embeddings' AND state IN ('cancelled', 'failed', 'succeeded')`)).rowCount || undefined, 30_000, 'the refresh to end');
    expect((await db.query(`SELECT state FROM jobs WHERE kind = 'refresh_embeddings'`)).rows).toEqual([{ state: 'cancelled' }]);
  }, 60_000);
});
