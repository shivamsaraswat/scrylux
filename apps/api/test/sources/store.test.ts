import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import db, { kdb } from '../../src/db.js';
import { claimJob, enqueue, finishRun, writeProgress, type IngestionSettings } from '../../src/jobs/store.js';
import { parseSourceConfig, type SourceConfig } from '../../src/sources/config.js';
import { SourceRefusal, addSource, deleteSource, getChunks, getSource, listSources, refreshSource, retrySource, type SourcesContext } from '../../src/sources/store.js';
import { createStorage, newOriginalKey, StorageUnavailable, type Storage } from '../../src/storage/index.js';

// The sources store against the real database and a real directory (Phase 3 Milestone 3, data-model.md, contracts/http-api.md).
// This file runs in the `jobs` group, one file at a time, because adding a source queues an ingestion job that a worker could
// claim. Every test starts from empty job and source tables.

const JOB_SETTINGS: IngestionSettings = {
  tokenCap: 500_000,
  costCapUsd: 5,
  maxRuns: 3,
  timeLimitMs: 3_600_000,
  jobsPerAccount: 100,
  providerCheckCooldownMs: 0,
  ingestionJobsPerAccount: 20,
};

let dir: string;
let storage: Storage;
let alice: number;
let bob: number;
let threatModel: string;

const context = (over: Partial<SourcesContext> = {}): SourcesContext => ({
  storage,
  config: parseSourceConfig({}),
  jobs: JOB_SETTINGS,
  embeddingModel: 'nomic-embed-text',
  ...over,
});
const withConfig = (over: Partial<SourceConfig>): SourceConfig => ({ ...parseSourceConfig({}), ...over });

async function makeUser(name: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>('INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id', [`${name}-${randomUUID()}`, 'not-a-real-hash']);
  return rows[0]?.id as number;
}

async function makeThreatModel(userId: number): Promise<string> {
  const { rows: project } = await db.query<{ id: string }>('INSERT INTO projects (name, created_by) VALUES ($1, $2) RETURNING id', [`p-${randomUUID()}`, userId]);
  const { rows } = await db.query<{ id: string }>('INSERT INTO threat_models (project_id, name) VALUES ($1, $2) RETURNING id', [project[0]?.id, 'model']);
  return rows[0]?.id as string;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scrylux-sources-store-'));
  storage = createStorage({ backend: 'local', dir });
});
afterAll(() => rm(dir, { recursive: true, force: true }));

beforeEach(async () => {
  // The originals of the last test would be counted by this one.
  await rm(dir, { recursive: true, force: true });
  await db.query('TRUNCATE jobs, job_usage, workers, sources CASCADE');
  alice = await makeUser('alice');
  bob = await makeUser('bob');
  threatModel = await makeThreatModel(alice);
});

const bytes = (text: string = randomUUID()): Buffer => Buffer.from(`# Design\n\n${text}\n`);
const input = (over: Record<string, unknown> = {}) => ({ threatModelId: threatModel, accountId: alice, name: 'design.md', type: 'md' as const, bytes: bytes(), ...over });
const add = (over: Record<string, unknown> = {}, ctx: SourcesContext = context()) => addSource(kdb, ctx, input(over));

async function stored(): Promise<string[]> {
  const keys: string[] = [];
  for await (const item of storage.list()) keys.push(item.key);
  return keys;
}
async function count(table: 'sources' | 'jobs'): Promise<number> {
  return Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);
}
const refusal = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a refusal'); }, (e: unknown) => e as SourceRefusal);

/** A source that is ready: no original, the facts of its ingestion, and `chunks` chunks of dimension 3. */
async function readySource(over: { model?: string; threatModelId?: string; chunks?: number; accountId?: number } = {}): Promise<string> {
  const tm = over.threatModelId ?? threatModel;
  const chunks = over.chunks ?? 3;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sources (threat_model_id, name, type, size_bytes, digest, added_by, stored_bytes, ready_at, text_chars, chunk_count, embedding_model, embedding_dimension)
     VALUES ($1, 'ready.md', 'md', 500, $2, $3, $4, now(), $5, $6, $7, 3) RETURNING id`,
    [tm, randomBytes(32), over.accountId ?? alice, 100 + chunks * 12, chunks * 5, chunks, over.model ?? 'nomic-embed-text'],
  );
  const id = rows[0]?.id as string;
  for (let i = 0; i < chunks; i++) {
    await db.query(`INSERT INTO chunks (source_id, "position", start_offset, end_offset, text, embedding, line_first, line_last, heading) VALUES ($1, $2, $3, $4, 'hello', '[1,2,3]', 1, 1, $5)`, [id, i, i * 5, i * 5 + 5, i === 0 ? 'Intro' : null]);
  }
  return id;
}

/** The ingestion job of a source, claimed by a worker and run to the state asked. */
async function ingestionJobOf(sourceId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM jobs WHERE source_id = $1 AND kind = 'ingest_source' ORDER BY queued_at DESC LIMIT 1`, [sourceId]);
  return rows[0]?.id as string;
}
async function endJob(sourceId: string, outcome: Parameters<typeof finishRun>[2], kind: 'ingest_source' | 'refresh_embeddings' = 'ingest_source'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM jobs WHERE source_id = $1 AND kind = $2 ORDER BY queued_at DESC LIMIT 1`, [sourceId, kind]);
  const id = rows[0]?.id as string;
  const claimed = await claimJob(kdb, randomUUID());
  expect(claimed?.id).toBe(id);
  await finishRun(kdb, { id, claim: claimed?.claim ?? 0 }, outcome);
  return id;
}

describe('addSource', () => {
  it('stores the original, adds a waiting source and queues its ingestion job, together', async () => {
    const content = bytes('The gateway forwards each request.');
    const source = await add({ bytes: content });
    expect(source).toMatchObject({ threat_model_id: threatModel, name: 'design.md', type: 'md', size_bytes: content.length, status: 'waiting', progress: null, failure: null, ready: null, refresh: null, refresh_failure: null, refreshable: false });
    expect(source.added_by.id).toBe(alice);
    expect(await stored()).toHaveLength(1);
    const { rows } = await db.query<Record<string, unknown>>(`SELECT * FROM jobs WHERE source_id = $1`, [source.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'ingest_source', state: 'queued', threat_model_id: threatModel, created_by: alice, input: { source_id: source.id }, max_runs: 3, token_cap: '500000' });
  });

  it('keeps the digest of what was received, and the stored original’s key apart from the name', async () => {
    const content = bytes('hash me');
    const source = await add({ bytes: content, name: '../../etc/passwd.md' });
    const { rows } = await db.query<{ digest: Buffer; original_key: string; name: string }>('SELECT digest, original_key, name FROM sources WHERE id = $1', [source.id]);
    expect(rows[0]?.digest.toString('hex')).toBe(createHash('sha256').update(content).digest('hex'));
    expect(rows[0]?.original_key).toMatch(/^sources\/[0-9a-f-]{36}$/);
    expect(rows[0]?.original_key).not.toContain('passwd');
    expect(await stored()).toEqual([rows[0]?.original_key]);
  });

  it('holds the job’s input to the source’s identifier alone (FR-041)', async () => {
    const source = await add({ name: 'confidential-merger.md' });
    const { rows } = await db.query<{ input: unknown }>(`SELECT input FROM jobs WHERE source_id = $1`, [source.id]);
    expect(rows[0]?.input).toEqual({ source_id: source.id });
    expect(JSON.stringify(rows[0]?.input)).not.toContain('confidential');
  });

  it('refuses the same content on the same threat model, naming the source already there, and stores nothing', async () => {
    const content = bytes('twice');
    const first = await add({ bytes: content, name: 'first.md' });
    const second = await refusal(add({ bytes: content, name: 'second.md' }));
    expect(second).toBeInstanceOf(SourceRefusal);
    expect(second).toMatchObject({ status: 409 });
    expect(second.message).toContain('first.md');
    expect(second.message).not.toContain('second.md');
    expect(await count('sources')).toBe(1);
    expect(await count('jobs')).toBe(1);
    expect(await stored()).toHaveLength(1);
    expect(first.status).toBe('waiting');
  });

  it('adds the same content to another threat model as another source', async () => {
    const content = bytes('shared');
    await add({ bytes: content });
    await add({ bytes: content, threatModelId: await makeThreatModel(alice) });
    expect(await count('sources')).toBe(2);
  });

  it('tells a failed source that it has to be deleted first when the same bytes are added again', async () => {
    const content = bytes('broken');
    const source = await add({ bytes: content, name: 'broken.pdf', type: 'pdf' });
    await endJob(source.id, { kind: 'failed', category: 'damaged' });
    const again = await refusal(add({ bytes: content, name: 'again.pdf', type: 'pdf' }));
    expect(again.message).toContain('broken.pdf');
    expect(again.message).toContain('Delete it first to add this document again.');
  });

  it('refuses one source too many on a threat model (FR-005), and says the limit', async () => {
    const ctx = context({ config: withConfig({ sourcesPerThreatModel: 2 }) });
    await add({}, ctx);
    await add({}, ctx);
    const third = await refusal(add({}, ctx));
    expect(third).toMatchObject({ status: 409 });
    expect(third.message).toContain('2');
    expect(await count('sources')).toBe(2);
    expect(await stored()).toHaveLength(2);
  });

  it('refuses a source that would pass the install’s document space (FR-009), counting what every threat model holds', async () => {
    const ctx = context({ config: withConfig({ documentSpaceBytes: 1000 }) });
    await readySource({ threatModelId: await makeThreatModel(bob), accountId: bob, chunks: 60 });
    const refused = await refusal(add({ bytes: Buffer.alloc(300, 0x61) }, ctx));
    expect(refused).toMatchObject({ status: 507 });
    expect(refused.message).toContain('document space');
    expect(await stored()).toEqual([]);
    expect(await count('jobs')).toBe(0);
  });

  it('accepts a source that exactly fills the document space', async () => {
    const used = Number((await db.query<{ n: string }>('SELECT coalesce(sum(stored_bytes), 0) AS n FROM sources')).rows[0]?.n);
    const ctx = context({ config: withConfig({ documentSpaceBytes: used + 300 }) });
    await add({ bytes: Buffer.alloc(300, 0x62) }, ctx);
    expect(await count('sources')).toBe(1);
  });

  it('refuses an account’s ingestion job past its own limit (FR-043), with how long to wait, and leaves nothing behind', async () => {
    const ctx = context({ jobs: { ...JOB_SETTINGS, ingestionJobsPerAccount: 2 } });
    await add({}, ctx);
    await add({}, ctx);
    const third = await refusal(add({}, ctx));
    expect(third).toMatchObject({ status: 429 });
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
    expect(await count('sources')).toBe(2);
    expect(await count('jobs')).toBe(2);
    expect(await stored()).toHaveLength(2);
  });

  it('counts the ingestion limit per account, not for the install', async () => {
    const ctx = context({ jobs: { ...JOB_SETTINGS, ingestionJobsPerAccount: 1 } });
    await add({}, ctx);
    await add({ accountId: bob }, ctx);
    expect(await count('sources')).toBe(2);
  });

  it('keeps Milestone 2’s limit and the ingestion limit apart (FR-043)', async () => {
    const ctx = context({ jobs: { ...JOB_SETTINGS, jobsPerAccount: 1, ingestionJobsPerAccount: 5 } });
    await enqueue(kdb, { kind: 'provider_check', input: {}, accountId: alice }, ctx.jobs);
    // The account is at Milestone 2's limit of one, and can still add documents.
    await add({}, ctx);
    await add({}, ctx);
    expect(await count('sources')).toBe(2);
    // And a full ingestion limit does not stop a provider check.
    const full = context({ jobs: { ...JOB_SETTINGS, jobsPerAccount: 5, ingestionJobsPerAccount: 2 } });
    await db.query('TRUNCATE jobs, job_usage, workers, sources CASCADE');
    await add({}, full);
    await add({}, full);
    await refusal(add({}, full));
    await expect(enqueue(kdb, { kind: 'provider_check', input: {}, accountId: alice }, full.jobs)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses when no embedding provider is configured (FR-030), whatever else is configured', async () => {
    const refused = await refusal(add({}, context({ embeddingModel: null })));
    expect(refused).toMatchObject({ status: 409 });
    expect(refused.message).toMatch(/embedding provider/);
    expect(await count('sources')).toBe(0);
    expect(await stored()).toEqual([]);
  });

  it('refuses a threat model that does not exist, and stores nothing', async () => {
    const refused = await refusal(add({ threatModelId: randomUUID() }));
    expect(refused).toMatchObject({ status: 404 });
    expect(await stored()).toEqual([]);
  });

  it('refuses with a message about storage, and queues nothing, when the original cannot be stored', async () => {
    const down: Storage = { ...storage, put: () => Promise.reject(new StorageUnavailable()) };
    const refused = await refusal(add({}, context({ storage: down })));
    expect(refused).toMatchObject({ status: 503 });
    expect(refused.message).toMatch(/storage/i);
    expect(refused.message).not.toContain(dir);
    expect(await count('sources')).toBe(0);
    expect(await count('jobs')).toBe(0);
  });

  it('removes the original it stored when the transaction refuses, even if removing it fails once', async () => {
    const ctx = context({ jobs: { ...JOB_SETTINGS, ingestionJobsPerAccount: 1 } });
    await add({}, ctx);
    await refusal(add({}, ctx));
    expect(await stored()).toHaveLength(1);
  });

  it('adds one source when the same content arrives twice at once, and removes the loser’s original', async () => {
    const content = bytes('race');
    const results = await Promise.allSettled([add({ bytes: content }), add({ bytes: content })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409 });
    expect(await count('sources')).toBe(1);
    expect(await count('jobs')).toBe(1);
    expect(await stored()).toHaveLength(1);
  });

  it('never goes past a limit when many adds race: 8 at once against a limit of 3 add exactly 3', async () => {
    const ctx = context({ config: withConfig({ sourcesPerThreatModel: 3 }) });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => add({}, ctx)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(await count('sources')).toBe(3);
    expect(await stored()).toHaveLength(3);
  });
});

describe('the status of a source, read from its latest job (research #1)', () => {
  it('is waiting while the job is queued, and processing with its step once it runs', async () => {
    const source = await add();
    expect((await getSource(kdb, context(), source.id))?.status).toBe('waiting');
    const claimed = await claimJob(kdb, randomUUID());
    await writeProgress(kdb, { id: claimed?.id as string, claim: claimed?.claim as number }, { step: 'embed', done: 3, total: 10 });
    expect(await getSource(kdb, context(), source.id)).toMatchObject({ status: 'processing', progress: { step: 'embed', done: 3, total: 10 } });
  });

  it.each([
    ['damaged', false],
    ['encrypted', false],
    ['unsupported_type', false],
    ['no_text_found', false],
    ['too_large', false],
    ['too_large_unpacked', false],
    ['provider_unavailable', true],
    ['not_authorized', true],
    ['timed_out', true],
    ['worker_lost', true],
    ['unreadable', true],
    ['storage_unavailable', true],
    ['document_space_full', true],
  ] as const)('is failed with the message and hint of %s, and retryable: %s (FR-045)', async (category, retryable) => {
    const source = await add();
    await endJob(source.id, { kind: 'failed', category });
    const shown = await getSource(kdb, context(), source.id);
    expect(shown?.status).toBe('failed');
    expect(shown?.failure).toMatchObject({ category, retryable });
    expect(shown?.failure?.message.length).toBeGreaterThan(10);
    expect(shown?.failure?.hint.length).toBeGreaterThan(10);
  });

  it('is not retryable when no embedding provider is configured, whatever failed', async () => {
    const source = await add();
    await endJob(source.id, { kind: 'failed', category: 'provider_unavailable' });
    expect((await getSource(kdb, context({ embeddingModel: null }), source.id))?.failure?.retryable).toBe(false);
  });

  it('is retryable after cap_reached only once an operator’s cap is higher than the job’s (FR-045)', async () => {
    const source = await add();
    await endJob(source.id, { kind: 'failed', category: 'cap_reached' });
    expect((await getSource(kdb, context(), source.id))?.failure?.retryable).toBe(false);
    expect((await getSource(kdb, context({ jobs: { ...JOB_SETTINGS, tokenCap: 600_000 } }), source.id))?.failure?.retryable).toBe(true);
    expect((await getSource(kdb, context({ jobs: { ...JOB_SETTINGS, costCapUsd: 6 } }), source.id))?.failure?.retryable).toBe(true);
    expect((await getSource(kdb, context({ jobs: { ...JOB_SETTINGS, tokenCap: 100 } }), source.id))?.failure?.retryable).toBe(false);
  });

  it('is retryable after input_too_large only once the embedding model is not the one that refused (FR-045)', async () => {
    const source = await add();
    const id = await ingestionJobOf(source.id);
    await db.query(
      `INSERT INTO job_usage (job_id, run, operation, provider, model, outcome, attempts, input_tokens, output_tokens, tokens_estimated, cost_usd, cost_estimated, price_source, temperature_applied, duration_ms)
       VALUES ($1, 1, 'embed', 'openai-compatible', 'small-model', 'input_too_large', 1, 10, 0, true, NULL, false, 'none', NULL, 5)`,
      [id],
    );
    await endJob(source.id, { kind: 'failed', category: 'input_too_large' });
    expect((await getSource(kdb, context({ embeddingModel: 'small-model' }), source.id))?.failure?.retryable).toBe(false);
    expect((await getSource(kdb, context({ embeddingModel: 'bigger-model' }), source.id))?.failure?.retryable).toBe(true);
  });

  it('shows the ingestion hint for a chunk that is too large, and the settings of the embedding provider for a failure', async () => {
    const source = await add();
    await endJob(source.id, { kind: 'failed', category: 'input_too_large' });
    expect((await getSource(kdb, context(), source.id))?.failure?.hint).toContain('2,000 characters');
    const other = await add();
    await endJob(other.id, { kind: 'failed', category: 'not_authorized' });
    expect((await getSource(kdb, context(), other.id))?.failure?.hint).toContain('EMBEDDING_API_KEY');
  });

  it('names the bound a document passed (FR-011)', async () => {
    const source = await add();
    await endJob(source.id, { kind: 'failed', category: 'too_large', detail: 'pages' });
    expect((await getSource(kdb, context(), source.id))?.failure?.message).toMatch(/pages/i);
  });

  it('is failed with the category cancelled, and retryable, when the job was cancelled from the Jobs page (FR-044)', async () => {
    const source = await add();
    await db.query(`UPDATE jobs SET state = 'cancelled', finished_at = now(), cancelled_by = $2 WHERE id = $1`, [await ingestionJobOf(source.id), bob]);
    const shown = await getSource(kdb, context(), source.id);
    expect(shown?.status).toBe('failed');
    expect(shown?.failure).toMatchObject({ category: 'cancelled', retryable: true });
    expect(shown?.failure?.hint).toMatch(/retry/i);
  });

  it('is failed, and retryable, for a source that has no job at all, which would otherwise wait for ever', async () => {
    const source = await add();
    await db.query(`DELETE FROM jobs WHERE source_id = $1`, [source.id]);
    expect((await getSource(kdb, context(), source.id))?.failure).toMatchObject({ category: 'job_error', retryable: true });
  });

  it('is ready whatever its jobs say, and shows the facts of its ingestion', async () => {
    const id = await readySource({ chunks: 4 });
    const shown = await getSource(kdb, context(), id);
    expect(shown).toMatchObject({ status: 'ready', progress: null, failure: null, refresh: null, refresh_failure: null });
    expect(shown?.ready).toMatchObject({ chunk_count: 4, text_chars: 20, pages_without_text: null, embedding: { model: 'nomic-embed-text', dimension: 3, state: 'current' } });
  });

  it('judges the embeddings against the configured model: current, out of date, or no provider (FR-033)', async () => {
    const id = await readySource();
    expect((await getSource(kdb, context(), id))?.ready?.embedding.state).toBe('current');
    expect((await getSource(kdb, context({ embeddingModel: 'another-model' }), id))?.ready?.embedding.state).toBe('out_of_date');
    expect((await getSource(kdb, context({ embeddingModel: null }), id))?.ready?.embedding.state).toBe('no_provider');
  });

  it('can be refreshed only when out of date, with a provider, and no refresh already queued', async () => {
    const id = await readySource();
    expect((await getSource(kdb, context(), id))?.refreshable).toBe(false);
    expect((await getSource(kdb, context({ embeddingModel: null }), id))?.refreshable).toBe(false);
    const stale = context({ embeddingModel: 'another-model' });
    expect((await getSource(kdb, stale, id))?.refreshable).toBe(true);
    await refreshSource(kdb, stale, { sourceId: id, accountId: alice });
    const refreshing = await getSource(kdb, stale, id);
    expect(refreshing?.refreshable).toBe(false);
    expect(refreshing?.refresh).toMatchObject({ state: 'queued' });
  });

  it('shows the last refresh that failed, and nothing once a later refresh succeeded', async () => {
    const id = await readySource();
    const stale = context({ embeddingModel: 'another-model' });
    await refreshSource(kdb, stale, { sourceId: id, accountId: alice });
    await endJob(id, { kind: 'failed', category: 'provider_unavailable' }, 'refresh_embeddings');
    const failed = await getSource(kdb, stale, id);
    expect(failed?.refresh).toBeNull();
    expect(failed?.refresh_failure).toMatchObject({ category: 'provider_unavailable', retryable: true });
    await retrySource(kdb, stale, { sourceId: id, accountId: alice });
    await endJob(id, { kind: 'succeeded' }, 'refresh_embeddings');
    expect((await getSource(kdb, stale, id))?.refresh_failure).toBeNull();
  });
});

describe('listSources', () => {
  it('lists a threat model’s sources oldest first, with the limits the add form shows', async () => {
    const a = await add({ name: 'a.md' });
    const b = await add({ name: 'b.md' });
    const list = await listSources(kdb, context(), threatModel);
    expect(list.sources.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(list.limits).toEqual({ max_bytes: 10 * 1024 * 1024, per_threat_model: 20, used_bytes: expect.any(Number) as unknown, document_space_bytes: 2 * 1024 ** 3 });
  });

  it('counts the install’s used space across every threat model, not this one’s', async () => {
    await readySource({ threatModelId: await makeThreatModel(bob), accountId: bob, chunks: 5 });
    await add();
    const { rows } = await db.query<{ n: string }>('SELECT sum(stored_bytes) AS n FROM sources');
    expect((await listSources(kdb, context(), threatModel)).limits.used_bytes).toBe(Number(rows[0]?.n));
  });

  it('lists nothing for a threat model without sources, and for one that does not exist', async () => {
    expect((await listSources(kdb, context(), threatModel)).sources).toEqual([]);
    expect((await listSources(kdb, context(), randomUUID())).sources).toEqual([]);
  });

  it('answers undefined for a source that does not exist', async () => {
    expect(await getSource(kdb, context(), randomUUID())).toBeUndefined();
  });
});

describe('getChunks', () => {
  it('refuses a source that is not ready, so that no part of a set is ever served (FR-024)', async () => {
    const source = await add();
    const refused = await refusal(getChunks(kdb, source.id, { offset: 0, limit: 50 }));
    expect(refused).toMatchObject({ status: 409 });
    expect(refused.message).toBe('This source is not ready yet.');
  });

  it('serves the chunks of a ready source in order, a page at a time, without their embeddings', async () => {
    const id = await readySource({ chunks: 5 });
    const first = await getChunks(kdb, id, { offset: 0, limit: 2 });
    expect(first?.has_more).toBe(true);
    expect(first?.chunks.map((c) => c.position)).toEqual([0, 1]);
    expect(first?.chunks[0]).toEqual({ id: expect.any(String) as unknown, position: 0, start_offset: 0, end_offset: 5, text: 'hello', pages: null, lines: { first: 1, last: 1 }, heading: 'Intro' });
    const last = await getChunks(kdb, id, { offset: 4, limit: 2 });
    expect(last?.chunks.map((c) => c.position)).toEqual([4]);
    expect(last?.has_more).toBe(false);
    expect(JSON.stringify(first)).not.toContain('embedding');
  });

  it('serves the same ids and texts every time (FR-023)', async () => {
    const id = await readySource();
    expect(await getChunks(kdb, id, { offset: 0, limit: 50 })).toEqual(await getChunks(kdb, id, { offset: 0, limit: 50 }));
  });

  it('answers undefined for a source that does not exist', async () => {
    expect(await getChunks(kdb, randomUUID(), { offset: 0, limit: 50 })).toBeUndefined();
  });
});

describe('deleteSource', () => {
  it('removes the source, its chunks and its original, and cancels its job', async () => {
    const source = await add();
    const key = (await stored())[0];
    expect(await deleteSource(kdb, context(), { sourceId: source.id, accountId: bob })).toBe(true);
    expect(await count('sources')).toBe(0);
    expect(await stored()).toEqual([]);
    const { rows } = await db.query<{ state: string; source_id: string | null; cancelled_by: number }>(`SELECT state, source_id, cancelled_by FROM jobs`);
    expect(rows).toEqual([{ state: 'cancelled', source_id: null, cancelled_by: bob }]);
    expect(key).toBeDefined();
  });

  it('asks a running job to stop rather than ending it from under its worker (FR-044)', async () => {
    const source = await add();
    await claimJob(kdb, randomUUID());
    await deleteSource(kdb, context(), { sourceId: source.id, accountId: alice });
    const { rows } = await db.query<{ state: string; cancel_requested_at: Date | null }>(`SELECT state, cancel_requested_at FROM jobs`);
    expect(rows[0]?.state).toBe('running');
    expect(rows[0]?.cancel_requested_at).toBeInstanceOf(Date);
  });

  it('removes the chunks of a ready source, which has no original any more', async () => {
    const id = await readySource({ chunks: 4 });
    expect(await deleteSource(kdb, context(), { sourceId: id, accountId: alice })).toBe(true);
    expect(Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM chunks')).rows[0]?.n)).toBe(0);
  });

  it('succeeds for the person when storage fails to remove the original, which the sweep removes later (FR-055)', async () => {
    const source = await add();
    const down: Storage = { ...storage, delete: () => Promise.reject(new StorageUnavailable()) };
    expect(await deleteSource(kdb, context({ storage: down }), { sourceId: source.id, accountId: alice })).toBe(true);
    expect(await count('sources')).toBe(0);
    expect(await stored()).toHaveLength(1);
  });

  it('answers false for a source that is not there, and the second time', async () => {
    const source = await add();
    expect(await deleteSource(kdb, context(), { sourceId: source.id, accountId: alice })).toBe(true);
    expect(await deleteSource(kdb, context(), { sourceId: source.id, accountId: alice })).toBe(false);
    expect(await deleteSource(kdb, context(), { sourceId: randomUUID(), accountId: alice })).toBe(false);
  });

  it('frees the space it held at once', async () => {
    const ctx = context({ config: withConfig({ documentSpaceBytes: 1000 }) });
    const big = await add({ bytes: Buffer.alloc(900, 0x63) }, ctx);
    await refusal(add({ bytes: Buffer.alloc(900, 0x64) }, ctx));
    await deleteSource(kdb, ctx, { sourceId: big.id, accountId: alice });
    await add({ bytes: Buffer.alloc(900, 0x65) }, ctx);
    expect(await count('sources')).toBe(1);
  });
});

describe('retrySource', () => {
  async function failed(category: Parameters<typeof endJob>[1] extends infer O ? (O extends { category: infer C } ? C : never) : never) {
    const source = await add();
    await endJob(source.id, { kind: 'failed', category });
    return source;
  }

  it('queues a new ingestion job with the caps that are set now, and the source waits again', async () => {
    const source = await failed('provider_unavailable');
    const ctx = context({ jobs: { ...JOB_SETTINGS, tokenCap: 700_000 } });
    const retried = await retrySource(kdb, ctx, { sourceId: source.id, accountId: bob });
    expect(retried?.status).toBe('waiting');
    const { rows } = await db.query<{ state: string; token_cap: string; created_by: number }>(`SELECT state, token_cap, created_by FROM jobs WHERE source_id = $1 ORDER BY queued_at`, [source.id]);
    expect(rows.map((r) => r.state)).toEqual(['failed', 'queued']);
    expect(rows[1]).toMatchObject({ token_cap: '700000', created_by: bob });
  });

  it.each(['damaged', 'encrypted', 'unsupported_type', 'no_text_found', 'too_large', 'too_large_unpacked'] as const)(
    'refuses a failure that the document causes: %s',
    async (category) => {
      const source = await failed(category);
      const refused = await refusal(retrySource(kdb, context(), { sourceId: source.id, accountId: alice }));
      expect(refused).toMatchObject({ status: 409 });
      expect(refused.message).toBe('This failure comes from the document itself. Fix the document and add it again.');
      expect(await count('jobs')).toBe(1);
    },
  );

  it('refuses cap_reached while the caps are the same, with the reason', async () => {
    const source = await failed('cap_reached');
    const refused = await refusal(retrySource(kdb, context(), { sourceId: source.id, accountId: alice }));
    expect(refused.message).toBe('Retrying would reach the same cap. Ask the operator to raise JOB_TOKEN_CAP or JOB_COST_CAP.');
    await expect(retrySource(kdb, context({ jobs: { ...JOB_SETTINGS, tokenCap: 900_000 } }), { sourceId: source.id, accountId: alice })).resolves.toBeDefined();
  });

  it('refuses a source that has not failed, and one that does not exist', async () => {
    const waiting = await add();
    expect(await refusal(retrySource(kdb, context(), { sourceId: waiting.id, accountId: alice }))).toMatchObject({ status: 409 });
    expect(await retrySource(kdb, context(), { sourceId: randomUUID(), accountId: alice })).toBeUndefined();
  });

  it('refuses when no embedding provider is configured', async () => {
    const source = await failed('provider_unavailable');
    const refused = await refusal(retrySource(kdb, context({ embeddingModel: null }), { sourceId: source.id, accountId: alice }));
    expect(refused).toMatchObject({ status: 409 });
    expect(refused.message).toMatch(/embedding provider/);
  });

  it('queues one job when two retries arrive at once', async () => {
    const source = await failed('provider_unavailable');
    const results = await Promise.allSettled([
      retrySource(kdb, context(), { sourceId: source.id, accountId: alice }),
      retrySource(kdb, context(), { sourceId: source.id, accountId: alice }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as SourceRefusal).status).toBe(409);
    const { rows } = await db.query(`SELECT 1 FROM jobs WHERE source_id = $1 AND state = 'queued'`, [source.id]);
    expect(rows).toHaveLength(1);
  });

  it('respects the ingestion limit (FR-043)', async () => {
    const source = await failed('provider_unavailable');
    const ctx = context({ jobs: { ...JOB_SETTINGS, ingestionJobsPerAccount: 1 } });
    await add({}, { ...ctx, jobs: { ...ctx.jobs, ingestionJobsPerAccount: 5 } });
    expect(await refusal(retrySource(kdb, ctx, { sourceId: source.id, accountId: alice }))).toMatchObject({ status: 429 });
  });

  it('refuses when the install’s document space is already full', async () => {
    const source = await failed('provider_unavailable');
    const ctx = context({ config: withConfig({ documentSpaceBytes: 10 }) });
    expect(await refusal(retrySource(kdb, ctx, { sourceId: source.id, accountId: alice }))).toMatchObject({ status: 507 });
  });

  it('queues a refresh for a ready source whose last refresh failed', async () => {
    const id = await readySource();
    const stale = context({ embeddingModel: 'another-model' });
    await refreshSource(kdb, stale, { sourceId: id, accountId: alice });
    await endJob(id, { kind: 'failed', category: 'provider_unavailable' }, 'refresh_embeddings');
    const retried = await retrySource(kdb, stale, { sourceId: id, accountId: alice });
    expect(retried?.refresh).toMatchObject({ state: 'queued' });
  });
});

describe('refreshSource', () => {
  it('queues a refresh for a ready source whose embeddings are out of date', async () => {
    const id = await readySource();
    const refreshed = await refreshSource(kdb, context({ embeddingModel: 'another-model' }), { sourceId: id, accountId: alice });
    expect(refreshed?.refresh).toMatchObject({ state: 'queued' });
    const { rows } = await db.query<Record<string, unknown>>(`SELECT kind, input, threat_model_id FROM jobs WHERE source_id = $1`, [id]);
    expect(rows[0]).toMatchObject({ kind: 'refresh_embeddings', input: { source_id: id }, threat_model_id: threatModel });
  });

  it.each([
    ['embeddings that are current', () => context(), 'current'],
    ['no embedding provider', () => context({ embeddingModel: null }), 'embedding provider'],
  ])('refuses a source with %s', async (_label, ctx, mention) => {
    const id = await readySource();
    const refused = await refusal(refreshSource(kdb, ctx(), { sourceId: id, accountId: alice }));
    expect(refused).toMatchObject({ status: 409 });
    expect(refused.message).toContain(mention);
  });

  it('refuses a source that is not ready, one already being refreshed, and one that does not exist', async () => {
    const waiting = await add();
    expect(await refusal(refreshSource(kdb, context({ embeddingModel: 'another-model' }), { sourceId: waiting.id, accountId: alice }))).toMatchObject({ status: 409 });
    const id = await readySource();
    const stale = context({ embeddingModel: 'another-model' });
    await refreshSource(kdb, stale, { sourceId: id, accountId: alice });
    expect(await refusal(refreshSource(kdb, stale, { sourceId: id, accountId: alice }))).toMatchObject({ status: 409 });
    expect(await refreshSource(kdb, stale, { sourceId: randomUUID(), accountId: alice })).toBeUndefined();
  });

  it('queues one job when two refreshes arrive at once', async () => {
    const id = await readySource();
    const stale = context({ embeddingModel: 'another-model' });
    const results = await Promise.allSettled([refreshSource(kdb, stale, { sourceId: id, accountId: alice }), refreshSource(kdb, stale, { sourceId: id, accountId: alice })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await count('jobs')).toBe(1);
  });
});

describe('a key that is not a stored original', () => {
  it('is never made from a name', () => {
    expect(newOriginalKey()).not.toContain('design');
  });
});
