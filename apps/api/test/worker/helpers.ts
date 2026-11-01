import { randomUUID } from 'node:crypto';
import { parseLlmConfig, type Llm, type LlmConfig } from '@scrylux/llm';
import { createLlmWithEndpoints, openaiCompletion, openaiEmbeddings, type RecordedRequest, type Scripted, type Stub } from '@scrylux/llm/testing';
import type { JobRecord } from '@scrylux/core';
import { vi } from 'vitest';
import db, { kdb } from '../../src/db.js';
import { enqueue, getJob, type JobSettings } from '../../src/jobs/store.js';
import type { Timings } from '../../src/worker/timing.js';

// Shared by the worker tests (Phase 3 Milestone 2). Not a test file: the jobs group runs one file at a time and each
// starts from empty job tables, because a worker claims any queued job in the shared test database.

export const SETTINGS: JobSettings = {
  tokenCap: 500_000,
  costCapUsd: 5,
  maxRuns: 3,
  timeLimitMs: 3_600_000,
  jobsPerAccount: 1000,
  providerCheckCooldownMs: 0,
};

/** Fast timings, so a test of a lease, a heartbeat or a poll does not sleep. */
export const FAST: Timings = { pollMs: 15, heartbeatMs: 25, leaseMs: 400, reportMs: 40, aliveWithinMs: 250, graceMs: 300 };

export async function makeUser(): Promise<number> {
  const { rows } = await db.query<{ id: number }>('INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id', [
    `jobs-test-worker-${randomUUID()}`,
    'not-a-real-hash',
  ]);
  const row = rows[0];
  if (!row) throw new Error('no user');
  return row.id;
}

export const resetJobTables = (): Promise<unknown> => db.query('TRUNCATE jobs, job_usage, workers');

/** A provider configuration whose models are served by the stub at `url`, declared local so plain http is accepted. */
export function localConfig(url: string, options: { embeddings?: boolean; extra?: Record<string, string> } = {}): LlmConfig {
  return parseLlmConfig({
    LLM_PROVIDER: 'openai-compatible',
    LLM_MODEL: 'llama3.2',
    LLM_BASE_URL: `${url}/v1`,
    LLM_LOCAL: 'true',
    ...(options.embeddings === false
      ? {}
      : {
          EMBEDDING_PROVIDER: 'openai-compatible',
          EMBEDDING_MODEL: 'nomic-embed-text',
          EMBEDDING_BASE_URL: `${url}/v1`,
          EMBEDDING_LOCAL: 'true',
        }),
    ...options.extra,
  });
}

/** A client that talks to the stub and never sleeps between retries, and writes none of Milestone 1's lines. */
export const clientFor = (config: LlmConfig): Llm =>
  createLlmWithEndpoints(config, { log: () => undefined, endpoints: {}, deps: { sleep: () => Promise.resolve(), random: () => 0 } });

/** Routes by path: a chat completion gets the check's answer, an embedding request gets a vector. */
export const answerBoth = (delayMs = 0): ((r: RecordedRequest) => Scripted) => (r) => {
  const answer: Scripted = r.path.endsWith('/embeddings')
    ? openaiEmbeddings([[0.1, 0.2, 0.3]], 9)
    : openaiCompletion({ content: '{"status":"ok"}', usage: { prompt_tokens: 64, completion_tokens: 9, total_tokens: 73 } });
  return delayMs > 0 ? { delay: delayMs, then: answer } : answer;
};

export const generationRequests = (stub: Stub): RecordedRequest[] => stub.requests.filter((r) => r.path.endsWith('/chat/completions'));
export const embeddingRequests = (stub: Stub): RecordedRequest[] => stub.requests.filter((r) => r.path.endsWith('/embeddings'));

export const queueCheck = (accountId: number, settings: JobSettings = SETTINGS): Promise<string> =>
  enqueue(kdb, { kind: 'provider_check', input: {}, accountId }, settings);

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` returns something other than undefined, or fails after `timeoutMs`. */
export async function waitFor<T>(check: () => Promise<T | undefined> | T | undefined, timeoutMs = 5000, what = 'the condition'): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

export const waitForState = (id: string, states: JobRecord['state'][], timeoutMs = 5000): Promise<JobRecord> =>
  waitFor(async () => {
    const job = await getJob(kdb, id);
    return job !== undefined && states.includes(job.state) ? job : undefined;
  }, timeoutMs, `job ${id} to be ${states.join(' or ')}`);

/** Records every distinct state and progress step a job shows while a test runs. `stop` takes one last look first. */
export function watch(id: string): { states: string[]; steps: string[]; stop(): Promise<void> } {
  const states: string[] = [];
  const steps: string[] = [];
  const sample = async (): Promise<void> => {
    const job = await getJob(kdb, id);
    if (job === undefined) return;
    if (states.at(-1) !== job.state) states.push(job.state);
    if (job.progress !== null && steps.at(-1) !== job.progress.step) steps.push(job.progress.step);
  };
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void sample().finally(() => {
      busy = false;
    });
  }, 4);
  return {
    states,
    steps,
    stop: async () => {
      clearInterval(timer);
      while (busy) await sleep(2);
      await sample();
    },
  };
}

/** Captures what the worker and the API write with console.log, as parsed JSON lines. */
export function captureLog(): { lines: () => Record<string, unknown>[]; restore(): void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
  return {
    lines: () =>
      lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      }),
    restore: () => spy.mockRestore(),
  };
}
