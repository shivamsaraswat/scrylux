import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openaiEmbeddings, resetCapabilityOverrides, startStub, type RecordedRequest, type Scripted, type Stub } from '@scrylux/llm/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import db, { kdb } from '../../src/db.js';
import type { IngestionSettings } from '../../src/jobs/store.js';
import { chunkDocument } from '../../src/sources/chunk.js';
import { parseSourceConfig } from '../../src/sources/config.js';
import { documentFromText } from '../../src/sources/document.js';
import { addSource, getChunks, getSource, type SourcesContext } from '../../src/sources/store.js';
import { codePointLength, normalizeText } from '../../src/sources/text.js';
import { createStorage, StorageUnavailable, type Storage } from '../../src/storage/index.js';
import { useStorage } from '../../src/storage/instance.js';
import { startWorker, type Worker } from '../../src/worker/loop.js';
import { pdf, textPages } from '../fixtures/sources/pdf.js';
import { docx } from '../fixtures/sources/zip.js';
import { FAST, captureLog, clientFor, embeddingRequests, localConfig, makeUser, resetJobTables, waitFor } from '../worker/helpers.js';

// Ingestion end to end (Phase 3 Milestone 3, US1, US5, SC-002, SC-006): the real worker, in-process, against a stub embedding
// provider and a real storage directory. A source goes from the API's add to its last chunk, and the tests look at what a
// person and the next milestone depend on: the steps, the requests, what is stored, what is not, and what a failure leaves.

const JOB_SETTINGS: IngestionSettings = { tokenCap: 500_000, costCapUsd: 5, maxRuns: 3, timeLimitMs: 3_600_000, jobsPerAccount: 100, providerCheckCooldownMs: 0, ingestionJobsPerAccount: 50 };

let dir: string;
let storage: Storage;
let stub: Stub;
let alice: number;
let threatModel: string;
let worker: Worker | undefined;

const context = (over: Partial<SourcesContext> = {}): SourcesContext => ({ storage, config: parseSourceConfig({}), jobs: JOB_SETTINGS, embeddingModel: 'nomic-embed-text', ...over });

/** An /embeddings answer with one vector of `dimension` numbers per input, in order. */
const embedWith = (dimension = 3, tokens?: number) => (r: RecordedRequest): Scripted => {
  const body = r.body as { input?: string | string[] } | undefined;
  const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? ''];
  return openaiEmbeddings(inputs.map((_, i) => Array.from({ length: dimension }, (__, d) => ((i + d) % 10) / 10)), tokens ?? inputs.length * 3);
};

async function startWorkerFor(options: { embeddings?: boolean; storage?: Storage } = {}): Promise<Worker> {
  const config = localConfig(stub.url, { embeddings: options.embeddings ?? true });
  if (options.storage) useStorage(options.storage);
  worker = await startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings: FAST });
  return worker;
}

beforeEach(async () => {
  resetCapabilityOverrides();
  await resetJobTables();
  await db.query('TRUNCATE sources CASCADE');
  dir = await mkdtemp(join(tmpdir(), 'scrylux-ingest-'));
  storage = createStorage({ backend: 'local', dir });
  useStorage(storage);
  alice = await makeUser();
  const { rows: project } = await db.query<{ id: string }>('INSERT INTO projects (name, created_by) VALUES ($1, $2) RETURNING id', [`p-${randomUUID()}`, alice]);
  threatModel = (await db.query<{ id: string }>('INSERT INTO threat_models (project_id, name) VALUES ($1, $2) RETURNING id', [project[0]?.id, 'model'])).rows[0]?.id as string;
  stub = await startStub();
  stub.setFallback(embedWith());
});

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await stub.close();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function add(name: string, type: 'md' | 'txt' | 'pdf' | 'docx' | 'text', bytes: Buffer) {
  return addSource(kdb, context(), { threatModelId: threatModel, accountId: alice, name, type, bytes });
}

/** A job that failed for a reason that may pass waits before its next run; the test does not. */
async function expedite(sourceId: string): Promise<void> {
  await waitFor(async () => ((await jobOf(sourceId))?.state === 'queued' && (await jobOf(sourceId))?.run === 1 ? true : undefined), 30_000, 'the first run to end');
  await db.query(`UPDATE jobs SET next_run_at = now() WHERE source_id = $1`, [sourceId]);
}

/** The source once its ingestion has ended one way or the other. */
const settled = (id: string, timeoutMs = 30_000) =>
  waitFor(async () => {
    const source = await getSource(kdb, context(), id);
    return source !== undefined && (source.status === 'ready' || source.status === 'failed') ? source : undefined;
  }, timeoutMs, `source ${id} to be ready or failed`);

const jobOf = async (sourceId: string) => (await db.query<{ id: string; state: string; run: number; result: unknown }>(`SELECT id, state, run, result FROM jobs WHERE source_id = $1 AND kind = 'ingest_source'`, [sourceId])).rows[0];
const chunkRows = async (sourceId: string) => (await db.query<Record<string, unknown>>('SELECT * FROM chunks WHERE source_id = $1 ORDER BY position', [sourceId])).rows;
async function stored(): Promise<string[]> {
  const keys: string[] = [];
  for await (const item of storage.list()) keys.push(item.key);
  return keys;
}

const PROSE = Array.from({ length: 120 }, (_, i) => `Section ${i}: the gateway forwards each request to service ${i} and stores the record.`).join('\n');

describe('a Markdown file that is ingested', () => {
  const markdown = `# Gateway\n\n${PROSE.slice(0, 3000)}\n\n## Storage\n\n${PROSE.slice(3000)}\n`;

  it('goes through the steps extract, chunk and embed, with how many chunks are done (FR-040)', async () => {
    // Every change of the job's progress is recorded by the database itself, so that a step as short as cutting the text into
    // chunks cannot be missed by a sampler.
    await db.query('CREATE TABLE IF NOT EXISTS progress_log (n BIGSERIAL PRIMARY KEY, job_id UUID, step TEXT, done INTEGER, total INTEGER)');
    await db.query('TRUNCATE progress_log');
    await db.query(`CREATE OR REPLACE FUNCTION log_progress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO progress_log (job_id, step, done, total) VALUES (NEW.id, NEW.progress->>'step', (NEW.progress->>'done')::int, (NEW.progress->>'total')::int);
      RETURN NEW; END $$`);
    await db.query('DROP TRIGGER IF EXISTS log_progress ON jobs');
    await db.query('CREATE TRIGGER log_progress AFTER UPDATE OF progress ON jobs FOR EACH ROW WHEN (NEW.progress IS NOT NULL AND NEW.progress IS DISTINCT FROM OLD.progress) EXECUTE FUNCTION log_progress()');
    try {
      const source = await add('design.md', 'md', Buffer.from(markdown));
      const job = (await jobOf(source.id))?.id as string;
      await startWorkerFor();
      await settled(source.id);
      const { rows } = await db.query<{ step: string; done: number | null; total: number | null }>('SELECT step, done, total FROM progress_log WHERE job_id = $1 ORDER BY n', [job]);
      const steps = rows.map((row) => row.step).filter((step, i, all) => all[i - 1] !== step);
      expect(steps).toEqual(['extract', 'chunk', 'embed']);
      // The embed step counts the chunks done out of all of them, from none to every one.
      const embed = rows.filter((row) => row.step === 'embed');
      expect(embed[0]).toMatchObject({ done: 0 });
      expect(embed.at(-1)?.done).toBe(embed.at(-1)?.total);
    } finally {
      await db.query('DROP TRIGGER IF EXISTS log_progress ON jobs');
      await db.query('DROP FUNCTION IF EXISTS log_progress()');
      await db.query('DROP TABLE IF EXISTS progress_log');
    }
  });

  it('becomes ready with the facts of its ingestion, each chunk once, and no original left (FR-024, FR-057)', async () => {
    const source = await add('design.md', 'md', Buffer.from(markdown));
    await startWorkerFor();
    const ready = await settled(source.id);

    const text = normalizeText(markdown);
    const expected = chunkDocument(documentFromText('md', markdown));
    expect(ready.status).toBe('ready');
    expect(ready.ready).toMatchObject({ text_chars: codePointLength(text), chunk_count: expected.length, pages_without_text: null, embedding: { model: 'nomic-embed-text', dimension: 3, state: 'current' } });

    const rows = await chunkRows(source.id);
    expect(rows).toHaveLength(expected.length);
    expect(rows.map((r) => r.position)).toEqual(expected.map((c) => c.position));
    expect(rows.map((r) => r.text).join('')).toBe(text);

    const { rows: s } = await db.query<{ original_key: string | null; stored_bytes: string }>('SELECT original_key, stored_bytes FROM sources WHERE id = $1', [source.id]);
    expect(s[0]?.original_key).toBeNull();
    expect(Number(s[0]?.stored_bytes)).toBe(Buffer.byteLength(text, 'utf8') + expected.length * 3 * 4);
    expect(await stored()).toEqual([]);
    expect(await jobOf(source.id)).toMatchObject({ state: 'succeeded', run: 1, result: { chunks: expected.length, pages_without_text: null } });
  });

  it('records the lines of each chunk as received and the heading it is under', async () => {
    const source = await add('design.md', 'md', Buffer.from(markdown));
    await startWorkerFor();
    await settled(source.id);
    const page = await getChunks(kdb, source.id, { offset: 0, limit: 100 });
    expect(page?.chunks[0]).toMatchObject({ lines: { first: 1 }, heading: 'Gateway', pages: null });
    expect(page?.chunks.some((c) => c.heading === 'Storage')).toBe(true);
    for (const chunk of page?.chunks ?? []) expect(chunk.lines?.last).toBeGreaterThanOrEqual(chunk.lines?.first ?? 0);
  });

  it('embeds the chunks 64 at a time, so more than 128 chunks take three requests (FR-040)', async () => {
    const long = Array.from({ length: 9000 }, (_, i) => `Paragraph ${i}: the gateway forwards each request.`).join('\n\n').slice(0, 150 * 2000);
    const source = await add('long.md', 'md', Buffer.from(long));
    await startWorkerFor();
    const ready = await settled(source.id);
    const chunks = ready.ready?.chunk_count ?? 0;
    expect(chunks).toBeGreaterThan(128);
    const requests = embeddingRequests(stub);
    expect(requests).toHaveLength(Math.ceil(chunks / 64));
    for (const request of requests) expect(((request.body as { input: string[] }).input).length).toBeLessThanOrEqual(64);
  });

  it('stores the usage of every request, which the job shows (FR-050)', async () => {
    const source = await add('design.md', 'md', Buffer.from(markdown));
    await startWorkerFor();
    await settled(source.id);
    const { rows } = await db.query<{ operation: string; model: string; outcome: string }>('SELECT operation, model, outcome FROM job_usage');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.operation === 'embed' && r.outcome === 'ok' && r.model === 'nomic-embed-text')).toBe(true);
  });
});

describe('text with unusual characters', () => {
  it('counts characters outside the basic plane as one, so the stored text always has the length its offsets say', async () => {
    const emoji = Array.from({ length: 800 }, (_, i) => `Zürich \u{1F600} 日本語 line ${i}`).join('\n');
    const source = await add('emoji.txt', 'txt', Buffer.from(emoji));
    await startWorkerFor();
    const ready = await settled(source.id);
    expect(ready.status).toBe('ready');
    for (const row of await chunkRows(source.id)) {
      expect(codePointLength(row.text as string)).toBe((row.end_offset as number) - (row.start_offset as number));
    }
  });

  it('numbers the lines of a Windows file as it was received, and stores no carriage return', async () => {
    const windows = Array.from({ length: 300 }, (_, i) => `line ${i + 1} ${'word '.repeat(20)}`).join('\r\n');
    const source = await add('windows.txt', 'txt', Buffer.from(`\u{feff}${windows}`));
    await startWorkerFor();
    await settled(source.id);
    const rows = await chunkRows(source.id);
    expect(rows.every((r) => !(r.text as string).includes('\r'))).toBe(true);
    expect(rows[0]?.line_first).toBe(1);
    expect(rows.at(-1)?.line_last).toBe(300);
  });

  it('removes a NUL that a text layer gave, so Postgres can store the chunk', async () => {
    const source = await add('nul.pdf', 'pdf', pdf({ pages: ['before\u0000after'], nul: true }));
    await startWorkerFor();
    const ready = await settled(source.id);
    expect(ready.status).toBe('ready');
    expect((await chunkRows(source.id))[0]?.text).toBe('beforeafter');
  });
});

describe('a PDF and a Word file', () => {
  it('records the pages of a PDF, and counts the pages that had no text (FR-014)', async () => {
    const source = await add('design.pdf', 'pdf', pdf({ pages: ['The gateway forwards requests.', null, 'Storage keeps the records.'] }));
    await startWorkerFor();
    const ready = await settled(source.id);
    expect(ready.ready).toMatchObject({ pages_without_text: 1 });
    const page = await getChunks(kdb, source.id, { offset: 0, limit: 10 });
    expect(page?.chunks[0]?.pages).toEqual({ first: 1, last: 3 });
    expect(page?.chunks[0]?.lines).toBeNull();
    expect(await jobOf(source.id)).toMatchObject({ result: { pages_without_text: 1 } });
  });

  it('records the headings of a Word file', async () => {
    const blocks = [
      { paragraph: 'Gateway', style: 'Heading1' as const },
      ...Array.from({ length: 40 }, (_, i) => ({ paragraph: `Paragraph ${i} describes how the gateway forwards a request to the service and waits.` })),
      { paragraph: 'Storage', style: 'Heading1' as const },
      ...Array.from({ length: 40 }, (_, i) => ({ paragraph: `Row ${i} is kept in the database with its owner and its time of creation.` })),
    ];
    const source = await add('design.docx', 'docx', docx({ blocks }));
    await startWorkerFor();
    await settled(source.id);
    const page = await getChunks(kdb, source.id, { offset: 0, limit: 50 });
    expect(page?.chunks[0]?.heading).toBe('Gateway');
    expect(page?.chunks.some((c) => c.heading === 'Storage')).toBe(true);
  });

  it('becomes ready at the largest default size within five minutes, under the default caps (SC-002)', async () => {
    const big = pdf({ pages: textPages(1_000_000), padTo: 10 * 1024 * 1024 - 4096 });
    expect(big.length).toBeLessThanOrEqual(10 * 1024 * 1024);
    const source = await add('big.pdf', 'pdf', big);
    const started = Date.now();
    await startWorkerFor();
    const done = await settled(source.id, 290_000);
    expect(done.failure).toBeNull();
    expect(done.status).toBe('ready');
    expect(Date.now() - started).toBeLessThan(300_000);
    expect(done.ready?.chunk_count).toBeGreaterThan(500);
    // The job used a fraction of its caps.
    const { rows } = await db.query<{ tokens: string }>('SELECT sum(input_tokens + output_tokens) AS tokens FROM job_usage');
    expect(Number(rows[0]?.tokens)).toBeLessThan(500_000);
  }, 300_000);
});

describe('what is written when a run does not succeed (FR-024, SC-006)', () => {
  it('writes no chunk, keeps the original and fails as rejected when the provider answers with two sizes of vector', async () => {
    let calls = 0;
    stub.setFallback((r) => embedWith(++calls === 1 ? 3 : 4)(r));
    // More than 64 chunks, so that there are two requests, the second with vectors of another size.
    const long = Array.from({ length: 3000 }, (_, i) => `Paragraph ${i}: the gateway forwards each request to the service.`).join('\n\n');
    const source = await add('long.md', 'md', Buffer.from(long));
    await startWorkerFor();
    const done = await settled(source.id);
    expect(done.failure?.category).toBe('rejected');
    expect(await chunkRows(source.id)).toEqual([]);
    expect(await stored()).toHaveLength(1);
  });

  it('writes no chunk when a vector holds a number that is not finite: the provider layer refuses it, and the job tries again later', async () => {
    stub.setFallback(() => ({ status: 200, text: '{"object":"list","model":"stub","data":[{"object":"embedding","index":0,"embedding":[1e999,0.5,0.25]}],"usage":{"prompt_tokens":3,"total_tokens":3}}' }));
    const source = await add('small.md', 'md', Buffer.from('# Small\n\nOne short paragraph.\n'));
    await startWorkerFor();
    // The layer reports an answer it cannot use as the provider being unavailable, which may pass: the job waits for its next run.
    const job = await waitFor(async () => {
      const found = await jobOf(source.id);
      return found?.state === 'queued' && found.run === 1 ? found : undefined;
    }, 15_000, 'the first run to end and the job to wait');
    expect(job.run).toBe(1);
    expect(await chunkRows(source.id)).toEqual([]);
    expect(await stored()).toHaveLength(1);
    expect((await getSource(kdb, context(), source.id))?.status).toBe('waiting');
  });

  it('writes no chunk, and keeps the original, when the commit would pass the install’s document space (FR-009)', async () => {
    vi.stubEnv('DOCUMENT_SPACE', '100MB');
    const cap = 100 * 1024 * 1024;
    const content = Buffer.from('A short design document about the gateway and its storage.\n');
    // The space already holds all but a few bytes more than this upload: the add is let in, the commit is not.
    await db.query(
      `INSERT INTO sources (threat_model_id, name, type, size_bytes, digest, added_by, stored_bytes, ready_at, text_chars, chunk_count, embedding_model, embedding_dimension)
       VALUES ($1, 'big.md', 'md', 1000, $2, $3, $4, now(), 10, 1, 'nomic-embed-text', 3)`,
      [threatModel, Buffer.alloc(32, 7), alice, cap - content.length - 5],
    );
    const source = await addSource(kdb, context({ config: parseSourceConfig({ DOCUMENT_SPACE: '100MB' }) }), { threatModelId: threatModel, accountId: alice, name: 'small.md', type: 'md', bytes: content });
    await startWorkerFor();
    const done = await settled(source.id);
    expect(done.failure).toMatchObject({ category: 'document_space_full', retryable: true });
    expect(await chunkRows(source.id)).toEqual([]);
    expect(await stored()).toHaveLength(1);
  });

  it('writes each chunk once when the first run failed for a reason that may pass and the second succeeded', async () => {
    // The provider layer tries a request three times before it gives up, so three answers fail the run.
    let calls = 0;
    stub.setFallback((r) => (++calls <= 3 ? { status: 503, json: { error: { message: 'overloaded' } } } : embedWith()(r)));
    const source = await add('design.md', 'md', Buffer.from(`# Design\n\n${PROSE}\n`));
    await startWorkerFor();
    await expedite(source.id);
    const ready = await settled(source.id, 60_000);
    expect(ready.status).toBe('ready');
    const rows = await chunkRows(source.id);
    expect(new Set(rows.map((r) => r.position)).size).toBe(rows.length);
    expect(rows.length).toBe(ready.ready?.chunk_count);
    expect((await jobOf(source.id))?.run).toBe(2);
  }, 90_000);

  it('runs again, then succeeds, when storage cannot be read the first time (FR-013)', async () => {
    let failures = 1;
    const flaky: Storage = {
      ...storage,
      get: (key) => (failures-- > 0 ? Promise.reject(new StorageUnavailable()) : storage.get(key)),
    };
    const source = await add('design.md', 'md', Buffer.from('# Design\n\nThe gateway forwards requests.\n'));
    await startWorkerFor({ storage: flaky });
    await expedite(source.id);
    const ready = await settled(source.id, 60_000);
    expect(ready.status).toBe('ready');
    expect((await jobOf(source.id))?.run).toBe(2);
  }, 90_000);
});

describe('the failures of a document', () => {
  it.each([
    ['a PDF whose pages only draw', 'pdf' as const, () => pdf({ pages: [null, null] }), 'no_text_found'],
    ['a Word file with no text', 'docx' as const, () => docx({ blocks: [{ paragraph: '   ' }] }), 'no_text_found'],
    ['a Markdown file of nothing but spaces and new lines', 'md' as const, () => Buffer.from('   \n\n  \n'), 'no_text_found'],
    ['a text file of nothing but Windows line ends and tabs', 'txt' as const, () => Buffer.from('\r\n\r\n \t\r\n'), 'no_text_found'],
    ['a text file that holds only a byte order mark and a line end', 'txt' as const, () => Buffer.from('\ufeff\n'), 'no_text_found'],
    ['a Word file with macros', 'docx' as const, () => docx({ blocks: [{ paragraph: 'text' }], macro: true }), 'unsupported_type'],
    ['an encrypted PDF', 'pdf' as const, () => pdf({ pages: ['secret'], userPassword: 'hunter2' }), 'encrypted'],
    ['a damaged PDF', 'pdf' as const, () => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('this is not a pdf at all, only text')]), 'damaged'],
  ])('fails %s as %s, without writing a chunk', async (_label, type, build, category) => {
    const source = await add(`file.${type}`, type, build());
    await startWorkerFor();
    const done = await settled(source.id);
    expect(done.failure?.category).toBe(category);
    expect(await chunkRows(source.id)).toEqual([]);
    expect(await stored()).toHaveLength(1);
    // Ends at once, with one run (FR-013).
    expect((await jobOf(source.id))?.run).toBe(1);
  });

  it('fails a text past SOURCE_MAX_CHARS as too large, naming the characters, and never ingests a part of it (FR-005)', async () => {
    vi.stubEnv('SOURCE_MAX_CHARS', '1000');
    const source = await add('long.txt', 'txt', Buffer.from('x'.repeat(1500)));
    await startWorkerFor();
    const done = await settled(source.id);
    expect(done.failure?.category).toBe('too_large');
    expect(done.failure?.message).toMatch(/characters/i);
    expect(await chunkRows(source.id)).toEqual([]);
  });

  it('fails as not configured, and retryable once configured, when there is no embedding provider', async () => {
    const source = await add('design.md', 'md', Buffer.from('# Design\n\nText.\n'));
    await startWorkerFor({ embeddings: false });
    const done = await settled(source.id);
    expect(done.failure?.category).toBe('not_configured');
    expect(embeddingRequests(stub)).toHaveLength(0);
  });

  it('keeps the text and the name of a document out of the log and out of the job (SC-008)', async () => {
    const log = captureLog();
    const source = await add('confidential-merger-plan.md', 'md', Buffer.from('# Merger\n\nCANARY-DOCUMENT-TEXT is the secret of the merger.\n'));
    await startWorkerFor();
    await settled(source.id);
    const everything = JSON.stringify(log.lines());
    log.restore();
    expect(everything).not.toContain('CANARY');
    expect(everything).not.toContain('confidential-merger');
    const { rows } = await db.query<{ input: unknown; result: unknown }>('SELECT input, result FROM jobs');
    expect(JSON.stringify(rows)).not.toContain('CANARY');
    expect(JSON.stringify(rows)).not.toContain('confidential');
  });
});
