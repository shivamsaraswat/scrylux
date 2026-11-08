import { openaiCompletion, openaiEmbeddings, resetCapabilityOverrides, startStub, type RecordedRequest, type Scripted, type Stub } from '@scrylux/llm/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import db, { kdb } from '../../src/db.js';
import { loadExtractionPrompt } from '../../src/extract-system/prompt.js';
import { rankChunks } from '../../src/extract-system/retrieve.js';
import { enqueueExtraction, getDetail, type JobSettings } from '../../src/jobs/store.js';
import { startWorker, type Worker } from '../../src/worker/loop.js';
import { FAST, clientFor, embeddingRequests, generationRequests, localConfig, resetJobTables, waitForState } from '../worker/helpers.js';
import { readDraft } from '../../src/extract-system/draft.js';
import { seedAccount, seedReadySource, seedThreatModel } from '../fixtures/extract-system/seed.js';

// The retrieval path (Phase 3 Milestone 4, US4; FR-012 to FR-015, SC-007, research #6, #7): sources larger than the budget are read in part, by the
// chunks nearest to the retrieval queries, within the budget, in the order of the documents, and the draft says so. The vectors are chosen so that
// the right ranking is known: a chunk's vector points where the test says it does.

const SETTINGS: JobSettings = { tokenCap: 500_000, costCapUsd: 5, maxRuns: 3, timeLimitMs: 3_600_000, jobsPerAccount: 100, providerCheckCooldownMs: 0 };

let stub: Stub;
let alice: number;
let threatModel: string;
let worker: Worker | undefined;

const usage = { prompt_tokens: 900, completion_tokens: 500, total_tokens: 1400 };

/** A chunk text of exactly `n` characters that starts with a marker, so that a test can see which chunks were sent. */
const chunkText = (marker: string, n = 1500): string => `${marker} `.padEnd(n, '.');

/**
 * Every retrieval query is embedded as the same vector, [1, 0], and a chunk's vector is [cos, sin] of an angle, so the nearest chunks to the queries
 * are the ones with the smallest angle. The ranking is then the order of the angles, whatever the number of queries.
 */
const angle = (degrees: number): number[] => [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];

function answerFor(request: RecordedRequest): Scripted {
  if (request.path.endsWith('/embeddings')) {
    const input = (request.body as { input?: string | string[] }).input;
    return openaiEmbeddings((Array.isArray(input) ? input : [input ?? '']).map(() => [1, 0]), 8);
  }
  // A draft with nothing in it is a valid answer, and needs no citation: these tests are about what was read.
  return openaiCompletion({ content: JSON.stringify({ elements: [], assets: [], assumptions: [], nothing_found: 'Nothing here.' }), usage });
}

beforeEach(async () => {
  resetCapabilityOverrides();
  await resetJobTables();
  await db.query('TRUNCATE sources CASCADE');
  alice = await seedAccount();
  threatModel = (await seedThreatModel(alice)).threatModelId;
  stub = await startStub();
  stub.setFallback(answerFor);
  // The smallest budget: 2,000 characters, so that a source of a few chunks of 1,500 does not fit.
  vi.stubEnv('EXTRACTION_CONTEXT_CHARS', '2000');
});

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await stub.close();
  vi.unstubAllEnvs();
});

async function run(extra: Record<string, string> = {}) {
  const config = localConfig(stub.url, { extra });
  worker = await startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings: FAST });
  const id = await kdb.transaction().execute((trx) => enqueueExtraction(trx, { threatModelId: threatModel, accountId: alice }, SETTINGS));
  return waitForState(id, ['succeeded', 'failed', 'cancelled'], 30_000);
}

const user = (r: RecordedRequest): string => (r.body as { messages: Array<{ role: string; content: string }> }).messages.find((m) => m.role === 'user')?.content ?? '';

describe('rankChunks (research #6)', () => {
  it('ranks the chunks of the ready sources for each query by distance, nearest first, ties by source and position', async () => {
    const a = await seedReadySource(alice, threatModel, { name: 'a.md', chunks: ['a0', 'a1', 'a2'], dimension: 2, vector: (p) => angle([50, 10, 30][p] as number) });
    const b = await seedReadySource(alice, threatModel, { name: 'b.md', chunks: ['b0', 'b1'], dimension: 2, vector: (p) => angle([20, 70][p] as number) });
    const order = new Map([[a.sourceId, 0], [b.sourceId, 1]]);
    const lists = await rankChunks(kdb, [a.sourceId, b.sourceId], [[1, 0], [0, 1]], order);
    expect(lists).toHaveLength(2);
    // Nearest to [1, 0]: the smallest angle (a1 at 10, b0 at 20, a2 at 30, a0 at 50, b1 at 70).
    expect(lists[0]?.map((c) => c.id)).toEqual([a.chunkIds[1], b.chunkIds[0], a.chunkIds[2], a.chunkIds[0], b.chunkIds[1]]);
    // Nearest to [0, 1]: the largest angle, so the reverse.
    expect(lists[1]?.map((c) => c.id)).toEqual([b.chunkIds[1], a.chunkIds[0], a.chunkIds[2], b.chunkIds[0], a.chunkIds[1]]);
    expect(lists[0]?.[0]).toMatchObject({ sourceOrder: 0, position: 1, chars: 2 });
  });

  it('keeps only the nearest of each query, up to the number asked', async () => {
    const a = await seedReadySource(alice, threatModel, { chunks: ['a', 'b', 'c', 'd'], dimension: 2, vector: (p) => angle(p * 20) });
    const lists = await rankChunks(kdb, [a.sourceId], [[1, 0]], new Map([[a.sourceId, 0]]), 2);
    expect(lists[0]?.map((c) => c.id)).toEqual([a.chunkIds[0], a.chunkIds[1]]);
  });

  it('compares only the chunks of the sources it is given: those of another source, or threat model, are never in the ranking', async () => {
    const mine = await seedReadySource(alice, threatModel, { chunks: ['mine'], dimension: 2, vector: () => angle(80) });
    const otherModel = (await seedThreatModel(alice)).threatModelId;
    await seedReadySource(alice, otherModel, { chunks: ['theirs'], dimension: 2, vector: () => angle(0) });
    const lists = await rankChunks(kdb, [mine.sourceId], [[1, 0]], new Map([[mine.sourceId, 0]]));
    expect(lists[0]?.map((c) => c.id)).toEqual([mine.chunkIds[0]]);
  });

  it('is the same every time for the same data', async () => {
    const a = await seedReadySource(alice, threatModel, { chunks: ['a', 'b', 'c'], dimension: 2, vector: () => angle(45) });
    const order = new Map([[a.sourceId, 0]]);
    const first = await rankChunks(kdb, [a.sourceId], [[1, 0]], order);
    expect(await rankChunks(kdb, [a.sourceId], [[1, 0]], order)).toEqual(first);
    expect(first[0]?.map((c) => c.id)).toEqual(a.chunkIds);
  });

  it('gives an empty list for each query when there is nothing to rank', async () => {
    expect(await rankChunks(kdb, [], [[1, 0], [0, 1]], new Map())).toEqual([[], []]);
  });
});

describe('an extraction of sources larger than the budget', () => {
  // Three sources of three chunks of 1,500 characters each: 13,500 characters, far over the 2,000 budget.
  async function seedLarge(model = 'nomic-embed-text') {
    const sources = [];
    for (const [name, angles] of [['first.md', [60, 5, 80]], ['second.md', [40, 25, 85]], ['third.md', [75, 35, 15]]] as const) {
      sources.push(
        await seedReadySource(alice, threatModel, {
          name,
          model,
          dimension: 2,
          chunks: angles.map((_, p) => chunkText(`${name}#${p}`)),
          vector: (p) => angle(angles[p] as number),
        }),
      );
    }
    return sources;
  }

  it('reads part of the chunks, within the budget, and records which and how many (FR-012, FR-014, SC-007)', async () => {
    const [first, second, third] = await seedLarge();
    const job = await run();
    expect(job.state).toBe('succeeded');
    const draft = await readDraft(kdb, threatModel);
    expect(draft).toMatchObject({ path: 'retrieval', chunks_available: 9, nothing_found: 'Nothing here.' });
    expect(draft?.chunks_read).toBeGreaterThanOrEqual(1);
    expect(draft?.chunks_read).toBeLessThan(9);
    // Within the budget: 2,000 characters hold one chunk of 1,500.
    expect(draft?.chunks_read).toBe(1);
    expect(draft?.read_chunks.length).toBe(draft?.chunks_read);
    expect(draft?.sources.map((s) => s.name)).toEqual(['first.md', 'second.md', 'third.md']);
    expect([first, second, third]).toHaveLength(3);
  });

  it('sends the nearest chunk when the budget holds one, not a first chunk that the seeds would have taken', async () => {
    await seedLarge();
    await run();
    const requests = generationRequests(stub);
    expect(requests).toHaveLength(1);
    // A seed (the first chunk of a source) would not fit a quarter of 2,000 characters, so the ranked chunk is sent: the nearest to the queries is
    // the one at 5 degrees, the second chunk of first.md.
    expect(user(requests[0] as RecordedRequest)).toContain('first.md#1');
    expect(user(requests[0] as RecordedRequest)).not.toContain('third.md#2');
  });

  it('embeds the retrieval queries once, as Scrylux’s own fixed text, and sends no text of a source for embeddings (FR-071)', async () => {
    await seedLarge();
    await run();
    const embeds = embeddingRequests(stub);
    expect(embeds).toHaveLength(1);
    const input = (embeds[0]?.body as { input: string[] }).input;
    expect(input).toEqual(loadExtractionPrompt().queries);
    expect(embeds[0]?.raw).not.toContain('first.md');
  });

  it('sends the chosen chunks in the order of the documents, not of the ranking (FR-012)', async () => {
    // A larger budget that holds two chunks: the two nearest are third.md#2 (15 degrees) and first.md#1 (5 degrees).
    vi.stubEnv('EXTRACTION_CONTEXT_CHARS', '3000');
    await seedLarge();
    await run();
    const text = user(generationRequests(stub)[0] as RecordedRequest);
    expect(text.indexOf('first.md#1')).toBeGreaterThan(-1);
    expect(text.indexOf('third.md#2')).toBeGreaterThan(text.indexOf('first.md#1'));
    expect(text.indexOf('[c1] first.md')).toBeGreaterThan(-1);
    expect(text.indexOf('[c2] third.md')).toBeGreaterThan(-1);
  });

  it('counts the embedding request in the job’s usage, and the generation in it too', async () => {
    await seedLarge();
    const job = await run();
    const detail = await getDetail(kdb, job.id);
    expect(detail?.usage.map((u) => u.operation)).toEqual(['embed', 'generate']);
    expect(detail?.extraction).toMatchObject({ path: 'retrieval', chunks_available: 9, sources_read: 3 });
  });

  it('fails as "embeddings out of date", reading nothing, when a source’s embeddings are from another model (FR-015)', async () => {
    await seedLarge('an-older-model');
    const job = await run();
    expect(job).toMatchObject({ state: 'failed', failure: { category: 'embeddings_out_of_date' } });
    expect(embeddingRequests(stub)).toHaveLength(0);
    expect(generationRequests(stub)).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM drafts')).rows).toHaveLength(0);
  });

  it('fails as "embeddings out of date" when the model has the same name but vectors of another size', async () => {
    await seedLarge();
    stub.setFallback((r) => (r.path.endsWith('/embeddings') ? openaiEmbeddings([[1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0]], 8) : answerFor(r)));
    const job = await run();
    expect(job).toMatchObject({ state: 'failed', failure: { category: 'embeddings_out_of_date' } });
    expect(generationRequests(stub)).toHaveLength(0);
  });

  it('fails as "not configured" when the embedding provider was removed after the job was queued (FR-015)', async () => {
    await seedLarge();
    const config = localConfig(stub.url, { embeddings: false });
    worker = await startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings: FAST });
    const id = await kdb.transaction().execute((trx) => enqueueExtraction(trx, { threatModelId: threatModel, accountId: alice }, SETTINGS));
    expect(await waitForState(id, ['succeeded', 'failed', 'cancelled'], 30_000)).toMatchObject({ state: 'failed', failure: { category: 'not_configured' } });
    expect(generationRequests(stub)).toHaveLength(0);
  });

  it('never mixes the vectors of two models: only its own threat model’s sources are compared', async () => {
    await seedLarge();
    const otherModel = (await seedThreatModel(alice)).threatModelId;
    await seedReadySource(alice, otherModel, { chunks: [chunkText('elsewhere')], model: 'a-model-of-another-size', dimension: 5, vector: () => [1, 2, 3, 4, 5] });
    expect((await run()).state).toBe('succeeded');
    expect(user(generationRequests(stub)[0] as RecordedRequest)).not.toContain('elsewhere');
  });
});
