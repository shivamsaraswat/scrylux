import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logJobAction, logJobState, logWorker } from '../../src/jobs/log.js';

// One JSON line per event on stdout, with ids and numbers only (Phase 3 Milestone 2, FR-009, contracts/worker.md and
// contracts/http-api.md). Nothing the caller passes beyond the documented fields can reach a line.

const JOB = '3f6b7c1e-8a52-4d0e-9c1a-0b6d2f4e5a77';
const WORKER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

let lines: string[];
beforeEach(() => {
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
});
afterEach(() => vi.restoreAllMocks());

const only = (): Record<string, unknown> => {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string) as Record<string, unknown>;
};

describe('logJobAction', () => {
  it('writes who started which kind of job', () => {
    logJobAction(7, 'start', JOB, 'provider_check');
    expect(only()).toEqual({ event: 'job', action: 'start', account_id: 7, job_id: JOB, kind: 'provider_check' });
  });

  it('writes who cancelled which job, with no kind', () => {
    logJobAction(7, 'cancel', JOB);
    expect(only()).toEqual({ event: 'job', action: 'cancel', account_id: 7, job_id: JOB });
  });
});

describe('logJobState', () => {
  it('writes the new state with the totals so far', () => {
    logJobState({ jobId: JOB, kind: 'provider_check', state: 'succeeded', run: 1, inputTokens: 310, outputTokens: 42, costUsd: 0.0021 });
    expect(only()).toEqual({
      event: 'job',
      job_id: JOB,
      kind: 'provider_check',
      state: 'succeeded',
      run: 1,
      input_tokens: 310,
      output_tokens: 42,
      cost_usd: 0.0021,
    });
  });

  it('writes the failure category for a failed job, and a cost of null when it is unknown', () => {
    logJobState({ jobId: JOB, kind: 'provider_check', state: 'failed', run: 3, failureCategory: 'provider_unavailable', inputTokens: 0, outputTokens: 0, costUsd: null });
    expect(only()).toEqual({
      event: 'job',
      job_id: JOB,
      kind: 'provider_check',
      state: 'failed',
      run: 3,
      failure_category: 'provider_unavailable',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: null,
    });
  });

  it('omits the failure category when there is none', () => {
    logJobState({ jobId: JOB, kind: 'provider_check', state: 'running', run: 1, inputTokens: 0, outputTokens: 0, costUsd: null });
    expect(only()).not.toHaveProperty('failure_category');
  });

  it('prints nothing it was not designed to carry', () => {
    logJobState({
      jobId: JOB,
      kind: 'provider_check',
      state: 'failed',
      run: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 1,
      // Not part of the signature: a caller that tried to log a message, a key or an address would find it dropped.
      ...({ message: 'sk-canary-key', baseUrl: 'http://canary', prompt: 'canary prompt' } as object),
    });
    expect(lines.join('\n')).not.toMatch(/canary/);
  });
});

describe('logWorker', () => {
  it('writes the start with its concurrency', () => {
    logWorker('start', { workerId: WORKER, concurrency: 2 });
    expect(only()).toEqual({ event: 'worker', action: 'start', worker_id: WORKER, concurrency: 2 });
  });

  it('writes the stop with the number of jobs handed back', () => {
    logWorker('stop', { workerId: WORKER, handedBack: 1 });
    expect(only()).toEqual({ event: 'worker', action: 'stop', worker_id: WORKER, handed_back: 1 });
  });
});
