import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openaiCompletion, openaiEmbeddings, openaiError, resetCapabilityOverrides, startStub, type RecordedRequest, type Scripted, type Stub } from '@scrylux/llm/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/app.js';
import db, { kdb } from '../../src/db.js';
import { cancelJob, getDetail, listJobs } from '../../src/jobs/store.js';
import { createStorage, type Storage } from '../../src/storage/index.js';
import { useStorage } from '../../src/storage/instance.js';
import { startWorker, type Worker } from '../../src/worker/loop.js';
import { pdf } from '../fixtures/sources/pdf.js';
import { docx } from '../fixtures/sources/zip.js';
import { startS3Stub, type S3Stub } from '../storage/s3-stub.js';
import { login, startTestServer, type TestServer } from '../contract/helpers.js';
import { client } from '../contract/v1/helpers.js';
import { FAST, SETTINGS, answerBoth, clientFor, localConfig, makeUser, queueCheck, resetJobTables, sleep, waitFor, waitForState } from './helpers.js';

// Guard test (Phase 3 Milestone 2, FR-051, FR-043, SC-007): a recognizable fake provider key and recognizable fake content,
// put where a provider could echo them (an answer, an error body), run through every way a job can end. Neither string appears
// in a log line, a job row, a usage row or an API answer. The Jobs pages render only those API answers, as text (FR-066), so
// the API answers stand for the pages. It checks what earlier tasks built, so it passes when written. Phase 3 Milestone 3 adds the
// same for documents (SC-008, below): a fake document text, file name and storage secret key.

const KEY = 'sk-canary-7f3e0a91c5d24b68';
const CONTENT = 'CANARY-CONTENT-91b2-ignore-previous-instructions';

let stub: Stub;
let alice: number;
let server: TestServer;
let token: string;
let worker: Worker | undefined;
let scenario: 'ok' | 'unauthorized' | 'unavailable' | 'hang' = 'ok';

beforeAll(async () => {
  vi.stubEnv('LLM_PROVIDER', 'openai-compatible');
  vi.stubEnv('LLM_MODEL', 'llama3.2');
  vi.stubEnv('LLM_BASE_URL', 'http://127.0.0.1:9/v1');
  vi.stubEnv('LLM_LOCAL', 'true');
  vi.stubEnv('PROVIDER_CHECK_COOLDOWN', '0');
  vi.stubEnv('JOBS_PER_ACCOUNT', '100');
  // The embedding provider the API reports (it holds no key); the worker below talks to the stub.
  vi.stubEnv('EMBEDDING_PROVIDER', 'openai-compatible');
  vi.stubEnv('EMBEDDING_MODEL', 'nomic-embed-text');
  vi.stubEnv('EMBEDDING_BASE_URL', 'http://127.0.0.1:9/v1');
  vi.stubEnv('EMBEDDING_LOCAL', 'true');
  vi.stubEnv('INGESTION_JOBS_PER_ACCOUNT', '100');
  server = await startTestServer(app);
  token = await login(server.baseUrl);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await server.close();
});

beforeEach(async () => {
  resetCapabilityOverrides();
  await resetJobTables();
  alice = await makeUser();
  stub = await startStub();
  scenario = 'ok';
  // Every answer and every error body carries the key and the content, as a careless provider might echo them.
  stub.setFallback((r: RecordedRequest): Scripted => {
    if (scenario === 'hang') return 'hang';
    if (scenario === 'unauthorized') return openaiError(401, `Incorrect API key provided: ${KEY}. Your prompt was: ${CONTENT}`);
    if (scenario === 'unavailable') return openaiError(503, `overloaded; key ${KEY}; prompt ${CONTENT}`, { type: 'server_error' });
    if (r.path.endsWith('/embeddings')) return answerBoth()(r);
    return openaiCompletion({ content: JSON.stringify({ status: CONTENT }), usage: { prompt_tokens: 64, completion_tokens: 9, total_tokens: 73 } });
  });
});
afterEach(async () => {
  await worker?.abandon();
  worker = undefined;
  await stub.close();
});

async function run(): Promise<void> {
  const config = localConfig(stub.url, { extra: { LLM_API_KEY: KEY } });
  worker = await startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings: FAST });
}

/** Everything a person or an operator could read after a job: the log, the rows, and the API's answers. */
async function everything(output: string[]): Promise<string> {
  const jobs = (await db.query('SELECT row_to_json(j) AS j FROM jobs j')).rows;
  const usage = (await db.query('SELECT row_to_json(u) AS u FROM job_usage u')).rows;
  const c = client(server.baseUrl, token);
  const list = (await c.get('/jobs')).body;
  const details = await Promise.all((await listJobs(kdb, { limit: 100, offset: 0 })).jobs.map(async (j) => [(await c.get(`/jobs/${j.id}`)).body, await getDetail(kdb, j.id)]));
  return JSON.stringify({ output, jobs, usage, list, details, status: (await c.get('/jobs/status')).body });
}

function capture(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const take = (...args: unknown[]): void => void lines.push(args.map(String).join(' '));
  const spies = [vi.spyOn(console, 'log').mockImplementation(take), vi.spyOn(console, 'error').mockImplementation(take), vi.spyOn(console, 'warn').mockImplementation(take)];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true));
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true));
  return {
    lines,
    restore: () => [...spies, out, err].forEach((spy) => spy.mockRestore()),
  };
}

describe('neither the key nor the content appears anywhere, whatever the job’s outcome', () => {
  it.each([
    ['it succeeds, and the model’s answer holds the content', async () => {
      const id = await queueCheck(alice);
      await run();
      expect((await waitForState(id, ['succeeded', 'failed'])).state).toBe('succeeded');
    }],
    ['the provider refuses the key, and its error echoes the key and the prompt', async () => {
      scenario = 'unauthorized';
      const id = await queueCheck(alice);
      await run();
      expect((await waitForState(id, ['failed', 'succeeded'])).failure?.category).toBe('not_authorized');
    }],
    ['the provider is unavailable until the last run, and its errors echo the key and the prompt', async () => {
      scenario = 'unavailable';
      const id = await queueCheck(alice, { ...SETTINGS, maxRuns: 1 });
      await run();
      expect((await waitForState(id, ['failed', 'succeeded'])).failure?.category).toBe('provider_unavailable');
    }],
    ['a cap stops it before a request', async () => {
      const id = await queueCheck(alice, { ...SETTINGS, tokenCap: 10 });
      await run();
      expect((await waitForState(id, ['failed', 'succeeded'])).failure?.category).toBe('cap_reached');
    }],
    ['it is cancelled in the middle of a request', async () => {
      scenario = 'hang';
      const id = await queueCheck(alice);
      await run();
      await waitFor(() => (stub.requests.length > 0 ? true : undefined), 5000, 'the request');
      await cancelJob(kdb, id, alice);
      expect((await waitForState(id, ['cancelled', 'failed', 'succeeded'])).state).toBe('cancelled');
    }],
    ['its deadline passes in the middle of a request', async () => {
      scenario = 'hang';
      const id = await queueCheck(alice, { ...SETTINGS, timeLimitMs: 300 });
      await run();
      expect((await waitForState(id, ['failed', 'cancelled', 'succeeded'])).failure?.category).toBe('timed_out');
    }],
  ])('when %s', async (_label, body) => {
    const log = capture();
    try {
      await body();
      await sleep(FAST.pollMs * 4);
    } finally {
      log.restore();
    }
    const seen = await everything(log.lines);
    expect(seen).not.toContain(KEY);
    expect(seen).not.toContain('sk-canary');
    expect(seen).not.toContain(CONTENT);
    expect(seen).not.toContain('CANARY');
    // The check is real: the worker did the work and wrote its lines, so an empty capture would prove nothing.
    expect(log.lines.some((line) => line.includes('"event":"job"'))).toBe(true);
  }, 20_000);

  it('also holds for a failed request’s provider text: the stored failure is the fixed message and hint', async () => {
    scenario = 'unauthorized';
    const id = await queueCheck(alice);
    await run();
    const job = await waitForState(id, ['failed']);
    expect(job.failure?.message).not.toMatch(/Incorrect API key|prompt/i);
    expect((await getDetail(kdb, id))?.result?.generation.message).not.toMatch(/Incorrect API key|prompt/i);
  });
});

// ---- Documents (Phase 3 Milestone 3, FR-061, SC-008) -------------------------------------------------------------------

const DOC_TEXT = 'CANARY-DOCUMENT-TEXT-3c9d71-the-merger-closes-on-friday';
const DOC_NAME = 'CANARY-NAME-confidential-merger-plan';
const S3_SECRET = 'canary-s3-secret-access-key-5b2e8f';

describe('a document’s name and text, and the storage secret, appear only where a person reads the document', () => {
  let dir: string;
  let s3: S3Stub | undefined;
  let storage: Storage;
  let threatModel: string;
  let docScenario: 'ok' | 'unavailable' | 'too_large';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scrylux-canary-'));
    s3 = await startS3Stub('canary-bucket');
    storage = createStorage({
      backend: 's3',
      bucket: 'canary-bucket',
      prefix: 'scrylux/',
      region: 'us-east-1',
      endpoint: s3.endpoint,
      forcePathStyle: true,
      accessKeyId: 'AKIACANARYACCESSKEY',
      secretAccessKey: S3_SECRET,
    });
    useStorage(storage);
    await db.query('TRUNCATE sources CASCADE');
    docScenario = 'ok';
    // Every error body echoes the text and the key, as a careless provider might.
    stub.setFallback((r: RecordedRequest): Scripted => {
      if (docScenario === 'unavailable') return openaiError(503, `overloaded; key ${KEY}; input ${DOC_TEXT}`, { type: 'server_error' });
      if (docScenario === 'too_large') return openaiError(400, `too long: ${DOC_TEXT}`, { code: 'context_length_exceeded' });
      const body = r.body as { input?: string | string[] } | undefined;
      const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? ''];
      return openaiEmbeddings(inputs.map(() => [0.1, 0.2, 0.3]), inputs.length * 3);
    });
    const c = client(server.baseUrl, token);
    const project = (await c.post<{ id: string }>('/projects', { name: `canary-${randomUUID()}` })).body;
    threatModel = (await c.post<{ id: string }>('/threat-models', { project_id: project.id, name: 'model' })).body.id;
  });
  afterEach(async () => {
    // Only what a case may have set; the suite's own settings stay.
    for (const name of ['JOB_MAX_RUNS', 'JOB_TOKEN_CAP', 'DOCUMENT_SPACE']) vi.stubEnv(name, undefined);
    await rm(dir, { recursive: true, force: true });
    await s3?.close();
  });

  async function runDocs(): Promise<void> {
    const config = localConfig(stub.url, { extra: { LLM_API_KEY: KEY } });
    worker = await startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings: FAST, storage });
  }
  const upload = async (bytes: Uint8Array, name = `${DOC_NAME}.md`) => {
    const data = new FormData();
    data.append('file', new Blob([new Uint8Array(bytes)]), name);
    const res = await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/sources`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: data });
    return { status: res.status, body: (await res.json()) as { id: string; error?: string } };
  };
  const markdown = (): Buffer => Buffer.from(`# ${DOC_TEXT}\n\n${DOC_TEXT} says more about the merger.\n`);
  const sourceState = async (id: string) => (await client(server.baseUrl, token).get<{ status: string; failure: { category: string } | null }>(`/sources/${id}`)).body;
  const settled = (id: string) => waitFor(async () => {
    const source = await sourceState(id);
    return source.status === 'ready' || source.status === 'failed' ? source : undefined;
  }, 30_000, 'the document to settle');

  /** What anyone could read besides the document's own answers: the log, the job and usage rows, the job answers, the failure and the stored objects. */
  async function elsewhere(output: string[], ids: string[]): Promise<string> {
    const c = client(server.baseUrl, token);
    const jobs = (await db.query('SELECT row_to_json(j) AS j FROM jobs j')).rows;
    const usage = (await db.query('SELECT row_to_json(u) AS u FROM job_usage u')).rows;
    const jobAnswers = await Promise.all((await listJobs(kdb, { limit: 100, offset: 0 })).jobs.map(async (j) => [(await c.get(`/jobs/${j.id}`)).body, await getDetail(kdb, j.id)]));
    // A document's failure is part of its own answer, but only as a fixed message and hint: its name is not in it.
    const failures = await Promise.all(ids.map(async (id) => ((await c.get<{ failure: unknown }>(`/sources/${id}`)).body.failure)));
    // The source rows without the name, which the document's own answers show.
    const sources = (await db.query('SELECT id, threat_model_id, type, size_bytes, original_key, ready_at, chunk_count FROM sources')).rows;
    return JSON.stringify({ output, jobs, usage, jobAnswers, failures, sources, status: (await c.get('/jobs/status')).body });
  }

  it.each([
    ['it becomes ready', async () => {
      const id = (await upload(markdown())).body.id;
      await runDocs();
      expect((await settled(id)).status).toBe('ready');
      return [id];
    }],
    ['it is a damaged PDF', async () => {
      const id = (await upload(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(DOC_TEXT)]), `${DOC_NAME}.pdf`)).body.id;
      await runDocs();
      expect((await settled(id)).failure?.category).toBe('damaged');
      return [id];
    }],
    ['it is an encrypted PDF', async () => {
      const id = (await upload(pdf({ pages: [DOC_TEXT], userPassword: 'hunter2' }), `${DOC_NAME}.pdf`)).body.id;
      await runDocs();
      expect((await settled(id)).failure?.category).toBe('encrypted');
      return [id];
    }],
    ['it is a Word file with macros', async () => {
      const id = (await upload(docx({ blocks: [{ paragraph: DOC_TEXT }], macro: true }), `${DOC_NAME}.docx`)).body.id;
      await runDocs();
      expect((await settled(id)).failure?.category).toBe('unsupported_type');
      return [id];
    }],
    ['it has no text', async () => {
      const id = (await upload(pdf({ pages: [null] }), `${DOC_NAME}.pdf`)).body.id;
      await runDocs();
      expect((await settled(id)).failure?.category).toBe('no_text_found');
      return [id];
    }],
    ['the provider is unavailable, and its errors echo the text and the key', async () => {
      docScenario = 'unavailable';
      vi.stubEnv('JOB_MAX_RUNS', '1');
      const id = (await upload(markdown())).body.id;
      await runDocs();
      expect((await settled(id)).failure?.category).toBe('provider_unavailable');
      return [id];
    }],
    ['the model refuses a chunk as too large, and its error echoes the text', async () => {
      docScenario = 'too_large';
      const id = (await upload(markdown())).body.id;
      await runDocs();
      expect((await settled(id)).failure?.category).toBe('input_too_large');
      return [id];
    }],
    ['storage cannot be read, and the storage secret is the one in use', async () => {
      vi.stubEnv('JOB_MAX_RUNS', '1');
      const id = (await upload(markdown())).body.id;
      s3?.failNext(1000);
      await runDocs();
      expect((await settled(id)).failure?.category).toBe('storage_unavailable');
      return [id];
    }],
    ['a cap stops it before a request', async () => {
      vi.stubEnv('JOB_TOKEN_CAP', '10');
      const id = (await upload(markdown())).body.id;
      await runDocs();
      expect((await settled(id)).failure?.category).toBe('cap_reached');
      return [id];
    }],
    ['its commit would pass the document space', async () => {
      vi.stubEnv('DOCUMENT_SPACE', '100MB');
      const id = (await upload(markdown())).body.id;
      await db.query(
        `INSERT INTO sources (threat_model_id, name, type, size_bytes, digest, added_by, stored_bytes, ready_at, text_chars, chunk_count, embedding_model, embedding_dimension)
         VALUES ($1, 'filler.md', 'md', 10, decode(repeat('ab', 32), 'hex'), $2, $3, now(), 1, 1, 'x', 3)`,
        [threatModel, alice, 100 * 1024 * 1024 - 20],
      );
      await runDocs();
      expect((await settled(id)).failure?.category).toBe('document_space_full');
      return [id];
    }],
    ['it is retried, refreshed and deleted', async () => {
      const c = client(server.baseUrl, token);
      docScenario = 'unavailable';
      vi.stubEnv('JOB_MAX_RUNS', '1');
      const id = (await upload(markdown())).body.id;
      await runDocs();
      expect((await settled(id)).failure?.category).toBe('provider_unavailable');
      docScenario = 'ok';
      expect((await c.post(`/sources/${id}/retry`)).status).toBe(200);
      expect((await waitFor(async () => ((await sourceState(id)).status === 'ready' ? true : undefined), 30_000, 'the retry')) === true).toBe(true);
      // A refusal of a refresh says why, and never says what the document is called.
      const refused = await c.post<{ error: string }>(`/sources/${id}/refresh`);
      expect(refused.status).toBe(409);
      expect((await c.del(`/sources/${id}`)).status).toBe(204);
      return [];
    }],
  ])('when %s', async (_label, body) => {
    const log = capture();
    let ids: string[];
    try {
      ids = await body();
      await sleep(FAST.pollMs * 4);
    } finally {
      log.restore();
    }
    const seen = await elsewhere(log.lines, ids);
    for (const secret of [DOC_TEXT, DOC_NAME, S3_SECRET, KEY, 'CANARY', 'canary-s3']) expect(seen, secret).not.toContain(secret);
    // The check is real: the worker did the work and wrote its lines, so an empty capture would prove nothing.
    expect(log.lines.some((line) => line.includes('"event":"job"'))).toBe(true);
  }, 60_000);

  it('keeps the name and the text in the document’s own records and in the answers that show them, and nowhere else', async () => {
    const id = (await upload(markdown())).body.id;
    await runDocs();
    await settled(id);
    const c = client(server.baseUrl, token);
    // The records: the source's name, and the chunks' text.
    expect((await db.query<{ name: string }>('SELECT name FROM sources WHERE id = $1', [id])).rows[0]?.name).toBe(`${DOC_NAME}.md`);
    expect(JSON.stringify((await db.query('SELECT text FROM chunks WHERE source_id = $1', [id])).rows)).toContain(DOC_TEXT);
    // The answers that show them.
    expect(JSON.stringify((await c.get(`/sources/${id}`)).body)).toContain(DOC_NAME);
    expect(JSON.stringify((await c.get(`/threat-models/${threatModel}/sources`)).body)).toContain(DOC_NAME);
    expect(JSON.stringify((await c.get(`/sources/${id}/chunks`)).body)).toContain(DOC_TEXT);
    // Every other table holds neither.
    const tables = (await db.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('sources', 'chunks')`)).rows;
    for (const { tablename } of tables) {
      const rows = JSON.stringify((await db.query(`SELECT row_to_json(t) AS r FROM "${tablename}" t`)).rows);
      expect(rows, tablename).not.toContain('CANARY');
    }
    // The jobs' own answers show neither.
    const detail = JSON.stringify((await c.get('/jobs')).body);
    expect(detail).not.toContain('CANARY');
  });

  it('shows the name of an earlier document only in the refusal of a duplicate, which is the one place that says it', async () => {
    const first = await upload(markdown());
    const again = await upload(markdown(), 'a-different-name.md');
    expect(first.status).toBe(201);
    expect(again.status).toBe(409);
    expect(again.body.error).toContain(DOC_NAME);
    expect(again.body.error).not.toContain(DOC_TEXT);
  });
});
