import { openaiCompletion, openaiEmbeddings, openaiError, resetCapabilityOverrides, startStub, type RecordedRequest, type Scripted, type Stub } from '@scrylux/llm/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/app.js';
import db, { kdb } from '../../src/db.js';
import { readDraft } from '../../src/extract-system/draft.js';
import { cancelJob, enqueueExtraction, getDetail, getJob, listJobs, type JobSettings } from '../../src/jobs/store.js';
import { startWorker, type Worker } from '../../src/worker/loop.js';
import { login, startTestServer, type TestServer } from '../contract/helpers.js';
import { client } from '../contract/v1/helpers.js';
import { FAST, clientFor, localConfig, resetJobTables, sleep, waitFor, waitForState } from '../worker/helpers.js';
import { seedAccount, seedReadySource, seedThreatModel } from '../fixtures/extract-system/seed.js';

// Each test here runs an extraction through a real worker against a stand-in provider, which takes more than vitest's 5 s on a busy CI runner
// (kind.test.ts timed out there at 5000 ms on a test that passes in about a second on a developer machine).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Guard test (Phase 3 Milestone 4, SC-009, FR-065): a recognizable fake document text, source name, provider key and model-written draft text, put
// where a provider could echo them (an answer, an error body), run through every way an extraction can end. They appear where they belong, in the
// document's own records and in the draft and the answers that show them, and in no log line, no job row, no usage row, no failure message and
// no answer about a job or about starting one. It checks what the earlier tasks built, so it passes when written.

const SETTINGS: JobSettings = { tokenCap: 500_000, costCapUsd: 5, maxRuns: 3, timeLimitMs: 3_600_000, jobsPerAccount: 100, providerCheckCooldownMs: 0 };

const KEY = 'sk-canary-4d8e19a07b3c5f62';
const DOC_TEXT = 'CANARY-DOC-77c1e0 the merger of Initech and Hooli';
const DOC_NAME = 'CANARY-NAME-9a4d3b';
const DRAFT_NAME = 'CANARY-DRAFT-5d2e7f';
const DRAFT_WHY = 'CANARY-WHY-c30a18';
const SECRETS = [DOC_TEXT, DOC_NAME, DRAFT_NAME, DRAFT_WHY, KEY, 'CANARY', 'canary'];

const CHUNK = `${DOC_TEXT}. The API stores threats in a database. Nothing else is said.`;
const usage = { prompt_tokens: 900, completion_tokens: 500, total_tokens: 1400 };
const draft = (over: Record<string, unknown> = {}) => ({
  elements: [
    {
      ref: 'db',
      type: 'data_store',
      name: DRAFT_NAME,
      boundary: null,
      source: null,
      target: null,
      flags: [],
      rationale: DRAFT_WHY,
      citations: [{ chunk: 'c1', quote: 'The API stores threats in a database' }],
    },
  ],
  assets: [],
  assumptions: [],
  nothing_found: null,
  ...over,
});

type Scenario = 'ok' | 'bad_answer' | 'unavailable' | 'too_large' | 'cut_off' | 'unauthorized' | 'hang';

let stub: Stub;
let alice: number;
let threatModel: string;
let server: TestServer;
let token: string;
let worker: Worker | undefined;
let scenario: Scenario = 'ok';

beforeAll(async () => {
  vi.stubEnv('LLM_PROVIDER', 'openai-compatible');
  vi.stubEnv('LLM_MODEL', 'llama3.2');
  vi.stubEnv('LLM_BASE_URL', 'http://127.0.0.1:9/v1');
  vi.stubEnv('LLM_LOCAL', 'true');
  vi.stubEnv('PROVIDER_CHECK_COOLDOWN', '0');
  vi.stubEnv('JOBS_PER_ACCOUNT', '100');
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
  await db.query('TRUNCATE sources CASCADE');
  alice = await seedAccount();
  threatModel = (await seedThreatModel(alice)).threatModelId;
  stub = await startStub();
  scenario = 'ok';
  // Every error body carries the key and the text, as a careless provider might echo them.
  stub.setFallback((r: RecordedRequest): Scripted => {
    if (r.path.endsWith('/embeddings')) return openaiEmbeddings([[1, 2, 3]], 3);
    switch (scenario) {
      case 'hang':
        return 'hang';
      case 'unauthorized':
        return openaiError(401, `Incorrect API key provided: ${KEY}. Your prompt was: ${DOC_TEXT}`);
      case 'unavailable':
        return openaiError(503, `overloaded; key ${KEY}; prompt ${DOC_TEXT}`, { type: 'server_error' });
      case 'too_large':
        return openaiError(400, `This input is longer than the model accepts: ${DOC_TEXT}`, { code: 'context_length_exceeded' });
      case 'cut_off':
        return openaiCompletion({ finish_reason: 'length', content: `{"elements":[{"name":"${DRAFT_NAME}"`, usage });
      case 'bad_answer':
        // Every field a model could echo, in a shape that is not valid.
        return openaiCompletion({ content: JSON.stringify({ [`${DRAFT_NAME}_${KEY}`]: DOC_TEXT, elements: [{ name: DRAFT_NAME, ref: DRAFT_WHY, citations: [{ chunk: 'c1', quote: DOC_TEXT }] }] }), usage });
      default:
        return openaiCompletion({ content: JSON.stringify(draft()), usage });
    }
  });
});

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await stub.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('LLM_PROVIDER', 'openai-compatible');
  vi.stubEnv('LLM_MODEL', 'llama3.2');
  vi.stubEnv('LLM_BASE_URL', 'http://127.0.0.1:9/v1');
  vi.stubEnv('LLM_LOCAL', 'true');
  vi.stubEnv('PROVIDER_CHECK_COOLDOWN', '0');
  vi.stubEnv('JOBS_PER_ACCOUNT', '100');
});

const seedDoc = () => seedReadySource(alice, threatModel, { name: `${DOC_NAME}.md`, chunks: [CHUNK] });
const start = (): Promise<string> => kdb.transaction().execute((trx) => enqueueExtraction(trx, { threatModelId: threatModel, accountId: alice }, SETTINGS));
async function startWorkerNow(): Promise<void> {
  const config = localConfig(stub.url, { extra: { LLM_API_KEY: KEY } });
  worker = await startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings: FAST });
}
const ended = (id: string) => waitForState(id, ['succeeded', 'failed', 'cancelled'], 30_000);

/** The log lines a test produces, from the worker and the API alike. */
function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spies = (['log', 'error', 'warn', 'info'] as const).map((method) => vi.spyOn(console, method).mockImplementation((line: unknown) => void lines.push(String(line))));
  return { lines, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

/** Everything that anyone could read besides the document's own records and the draft: the log, the job and usage rows, and every answer about jobs and extractions. */
async function elsewhere(output: string[]): Promise<string> {
  const c = client(server.baseUrl, token);
  const jobs = (await db.query('SELECT row_to_json(j) AS j FROM jobs j')).rows;
  const usageRows = (await db.query('SELECT row_to_json(u) AS u FROM job_usage u')).rows;
  const jobAnswers = await Promise.all((await listJobs(kdb, { limit: 100, offset: 0 })).jobs.map(async (j) => [(await c.get(`/jobs/${j.id}`)).body, await getDetail(kdb, j.id)]));
  const status = (await c.get(`/threat-models/${threatModel}/extraction`)).body;
  // A start that is refused says why, and never what the documents are called or say.
  const refusal = (await c.post(`/threat-models/${threatModel}/extraction`)).body;
  return JSON.stringify({ output, jobs, usageRows, jobAnswers, status, refusal, list: (await c.get('/jobs')).body, jobsStatus: (await c.get('/jobs/status')).body });
}

describe('when an extraction ends', () => {
  it.each<[string, () => Promise<void>]>([
    ['it succeeds and the draft quotes the document', async () => {
      await seedDoc();
      await startWorkerNow();
      const id = await start();
      expect((await ended(id)).state).toBe('succeeded');
    }],
    ['the model keeps answering in a shape that is not valid, with every field echoing the text and the key', async () => {
      scenario = 'bad_answer';
      await seedDoc();
      await startWorkerNow();
      expect(await ended(await start())).toMatchObject({ state: 'failed', failure: { category: 'invalid_output' } });
    }],
    ['the provider is unavailable, and its errors echo the text and the key', async () => {
      scenario = 'unavailable';
      vi.stubEnv('JOB_MAX_RUNS', '1');
      await seedDoc();
      await startWorkerNow();
      const id = await kdb.transaction().execute((trx) => enqueueExtraction(trx, { threatModelId: threatModel, accountId: alice }, { ...SETTINGS, maxRuns: 1 }));
      expect(await ended(id)).toMatchObject({ state: 'failed', failure: { category: 'provider_unavailable' } });
    }],
    ['the model refuses the input as too large, and its error echoes the text', async () => {
      scenario = 'too_large';
      await seedDoc();
      await startWorkerNow();
      expect(await ended(await start())).toMatchObject({ state: 'failed', failure: { category: 'input_too_large' } });
    }],
    ['the draft is cut off at the output limit, and what came back holds the draft text', async () => {
      scenario = 'cut_off';
      await seedDoc();
      await startWorkerNow();
      expect(await ended(await start())).toMatchObject({ state: 'failed', failure: { category: 'output_limit_reached' } });
    }],
    ['the provider refuses the key, and its error echoes the key and the text', async () => {
      scenario = 'unauthorized';
      await seedDoc();
      await startWorkerNow();
      expect(await ended(await start())).toMatchObject({ state: 'failed', failure: { category: 'not_authorized' } });
    }],
    ['a cap stops it before a request', async () => {
      await seedDoc();
      await db.query('SELECT 1');
      const id = await kdb.transaction().execute((trx) => enqueueExtraction(trx, { threatModelId: threatModel, accountId: alice }, { ...SETTINGS, tokenCap: 10 }));
      await startWorkerNow();
      expect(await ended(id)).toMatchObject({ state: 'failed', failure: { category: 'cap_reached' } });
    }],
    ['there is no ready source when it runs', async () => {
      await startWorkerNow();
      expect(await ended(await start())).toMatchObject({ state: 'failed', failure: { category: 'no_ready_source' } });
    }],
    ['it is cancelled while the model answers', async () => {
      scenario = 'hang';
      await seedDoc();
      await startWorkerNow();
      const id = await start();
      await waitFor(async () => ((await getJob(kdb, id))?.state === 'running' ? true : undefined), 15_000, 'the job to run');
      await sleep(150);
      await cancelJob(kdb, id, alice);
      expect((await ended(id)).state).toBe('cancelled');
    }],
  ])('%s', async (_label, body) => {
    const log = capture();
    try {
      await body();
      await sleep(FAST.pollMs * 4);
    } finally {
      log.restore();
    }
    const seen = await elsewhere(log.lines);
    for (const secret of SECRETS) expect(seen, secret).not.toContain(secret);
    // The check is real: the worker did the work and wrote its lines, so an empty capture would prove nothing.
    expect(log.lines.some((line) => line.includes('"event":"job"'))).toBe(true);
  }, 60_000);
});

describe('where the text does belong', () => {
  it('keeps the document’s text, its name and the draft’s text in their own records and in the answers that show them, and in no other table', async () => {
    await seedDoc();
    await startWorkerNow();
    const id = await start();
    await ended(id);
    const c = client(server.baseUrl, token);

    // The records: the source's name, the chunk's text, and what the model wrote in the draft.
    expect((await db.query<{ name: string }>('SELECT name FROM sources WHERE threat_model_id = $1', [threatModel])).rows[0]?.name).toBe(`${DOC_NAME}.md`);
    expect(JSON.stringify((await db.query('SELECT text FROM chunks')).rows)).toContain(DOC_TEXT);
    expect(JSON.stringify((await db.query('SELECT name, rationale FROM draft_items')).rows)).toContain(DRAFT_NAME);
    // The answer that shows the draft.
    const answer = JSON.stringify((await c.get(`/threat-models/${threatModel}/draft`)).body);
    expect(answer).toContain(DRAFT_NAME);
    expect(answer).toContain(DRAFT_WHY);
    expect(answer).toContain(DOC_NAME);
    expect(answer).toContain('The API stores threats in a database');
    // Every other table holds none of it: not the citations (they keep a span, never a quote), not the sources the draft read, not the jobs.
    const tables = (await db.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('sources', 'chunks', 'draft_items')`)).rows;
    for (const { tablename } of tables) {
      const rows = JSON.stringify((await db.query(`SELECT row_to_json(t) AS r FROM "${tablename}" t`)).rows);
      expect(rows, tablename).not.toContain('CANARY');
    }
    expect((await readDraft(kdb, threatModel))?.elements[0]?.citations[0]?.quote).toBe('The API stores threats in a database');
  });
});
