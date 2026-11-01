import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openaiEmbeddings, resetCapabilityOverrides, startStub, type RecordedRequest, type Scripted, type Stub } from '@scrylux/llm/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import db, { kdb } from '../../src/db.js';
import type { IngestionSettings } from '../../src/jobs/store.js';
import { parseSourceConfig } from '../../src/sources/config.js';
import { addSource, deleteSource, type SourcesContext } from '../../src/sources/store.js';
import { createStorage, type Storage } from '../../src/storage/index.js';
import { useStorage } from '../../src/storage/instance.js';
import { startWorker, type Worker } from '../../src/worker/loop.js';
import { FAST, clientFor, embeddingRequests, localConfig, makeUser, resetJobTables, sleep, waitFor } from '../worker/helpers.js';

// A source deleted while the worker is ingesting it (Phase 3 Milestone 3, US4, FR-054, research #2): the job ends cancelled and
// writes nothing, and a deletion and a commit that start together never deadlock and never leave a chunk or an original behind.

const JOB_SETTINGS: IngestionSettings = { tokenCap: 500_000, costCapUsd: 5, maxRuns: 3, timeLimitMs: 3_600_000, jobsPerAccount: 1000, providerCheckCooldownMs: 0, ingestionJobsPerAccount: 1000 };

let dir: string;
let storage: Storage;
let stub: Stub;
let alice: number;
let threatModel: string;
let worker: Worker | undefined;

const context = (): SourcesContext => ({ storage, config: parseSourceConfig({}), jobs: JOB_SETTINGS, embeddingModel: 'nomic-embed-text' });
const vectors = (r: RecordedRequest): Scripted => {
  const body = r.body as { input?: string | string[] } | undefined;
  const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? ''];
  return openaiEmbeddings(inputs.map(() => [0.1, 0.2, 0.3]), inputs.length * 3);
};

async function startWorkerNow(): Promise<void> {
  const config = localConfig(stub.url);
  worker = await startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings: FAST, storage });
}
const add = () => addSource(kdb, context(), { threatModelId: threatModel, accountId: alice, name: 'design.md', type: 'md', bytes: Buffer.from(`# Design\n\n${randomUUID()}\n`) });
const jobOf = async (sourceId: string) => (await db.query<{ id: string }>(`SELECT id FROM jobs WHERE source_id = $1`, [sourceId])).rows[0]!.id;
const stateOf = async (jobId: string) => (await db.query<{ state: string }>(`SELECT state FROM jobs WHERE id = $1`, [jobId])).rows[0]?.state;
const count = async (table: string): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);
async function stored(): Promise<string[]> {
  const keys: string[] = [];
  for await (const item of storage.list()) keys.push(item.key);
  return keys;
}

beforeEach(async () => {
  resetCapabilityOverrides();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await resetJobTables();
  await db.query('TRUNCATE sources CASCADE');
  dir = await mkdtemp(join(tmpdir(), 'scrylux-ingest-delete-'));
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
  await rm(dir, { recursive: true, force: true });
});

describe('a source deleted while its job embeds', () => {
  it('ends the job cancelled, writes no chunk, and leaves no original', async () => {
    // The embedding request is held, so the job is in the middle of it when the source goes.
    stub.setFallback((r) => ({ delay: 60_000, then: vectors(r) }));
    const source = await add();
    const job = await jobOf(source.id);
    await startWorkerNow();
    await waitFor(() => embeddingRequests(stub)[0], 10_000, 'the embedding request');

    expect(await deleteSource(kdb, context(), { sourceId: source.id, accountId: alice })).toBe(true);

    await waitFor(async () => ((await stateOf(job)) === 'cancelled' ? true : undefined), 10_000, 'the job to end cancelled');
    expect(await count('chunks')).toBe(0);
    expect(await count('sources')).toBe(0);
    expect(await stored()).toEqual([]);
  });

  it('does not bring the source back when the held request finally answers', async () => {
    stub.setFallback((r) => ({ delay: 400, then: vectors(r) }));
    const source = await add();
    await startWorkerNow();
    await waitFor(() => embeddingRequests(stub)[0], 10_000, 'the embedding request');
    await deleteSource(kdb, context(), { sourceId: source.id, accountId: alice });
    await sleep(800);
    expect(await count('sources')).toBe(0);
    expect(await count('chunks')).toBe(0);
  });
});

describe('a deletion and a commit that start together', () => {
  it('never deadlock, and leave no source, no chunk and no original, whichever won (research #2)', async () => {
    stub.setFallback(vectors);
    await startWorkerNow();
    for (let round = 0; round < 25; round++) {
      const source = await add();
      const job = await jobOf(source.id);
      // Spread the deletion across the whole life of the job, from before it is claimed to after it is done.
      await sleep((round % 10) * 6);
      expect(await deleteSource(kdb, context(), { sourceId: source.id, accountId: alice })).toBe(true);
      await waitFor(async () => (['cancelled', 'succeeded'].includes((await stateOf(job)) ?? '') ? true : undefined), 15_000, `job ${round} to end`);
    }
    expect(await count('sources')).toBe(0);
    expect(await count('chunks')).toBe(0);
    expect(await stored()).toEqual([]);
    // A deadlock is an error of the database; the worker would have failed the job rather than cancelled or finished it.
    expect(await count('jobs')).toBe(25);
    expect(Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM jobs WHERE state = 'failed'`)).rows[0]?.n)).toBe(0);
  }, 120_000);
});
