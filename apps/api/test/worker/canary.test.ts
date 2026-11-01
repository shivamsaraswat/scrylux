import { openaiCompletion, openaiError, resetCapabilityOverrides, startStub, type RecordedRequest, type Scripted, type Stub } from '@scrylux/llm/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/app.js';
import db, { kdb } from '../../src/db.js';
import { cancelJob, getDetail, listJobs } from '../../src/jobs/store.js';
import { startWorker, type Worker } from '../../src/worker/loop.js';
import { login, startTestServer, type TestServer } from '../contract/helpers.js';
import { client } from '../contract/v1/helpers.js';
import { FAST, SETTINGS, answerBoth, clientFor, localConfig, makeUser, queueCheck, resetJobTables, sleep, waitFor, waitForState } from './helpers.js';

// Guard test (Phase 3 Milestone 2, FR-051, FR-043, SC-007): a recognizable fake provider key and recognizable fake content,
// put where a provider could echo them (an answer, an error body), run through every way a job can end. Neither string appears
// in a log line, a job row, a usage row or an API answer. The Jobs pages render only those API answers, as text (FR-066), so
// the API answers stand for the pages. It checks what earlier tasks built, so it passes when written.

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
