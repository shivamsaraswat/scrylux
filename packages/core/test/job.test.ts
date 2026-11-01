import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  JOB_FAILURE_CATEGORIES,
  JobCreateInput,
  JobDetail,
  JobList,
  JobListQuery,
  JobRecord,
  JobTotals,
  JobsStatus,
  ProviderCheckResult,
} from '../src/index.js';

// The records of the job routes (Phase 3 Milestone 2, contracts/http-api.md). The API parses every success body with
// them, and the web app parses what it receives, so a stray column is a server bug and not a leak.

const AT = '2026-11-01T10:00:00.000Z';

const totals = (over: Record<string, unknown> = {}) => ({
  requests: 2,
  input_tokens: 300,
  output_tokens: 40,
  tokens_estimated: false,
  cost_usd: 0.0021,
  cost_known_usd: 0.0021,
  cost_estimated: false,
  cost_cap_applied: true,
  duration_ms: 1800,
  ...over,
});

const job = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  kind: 'provider_check',
  state: 'running',
  started_by: { id: 7, username: 'alice' },
  cancelled_by: null,
  cancel_requested: false,
  worker_lost: false,
  queued_at: AT,
  started_at: AT,
  finished_at: null,
  next_run_at: null,
  deadline_at: AT,
  run: 1,
  max_runs: 3,
  caps: { tokens: 500_000, cost_usd: 5 },
  progress: { step: 'generation' },
  failure: null,
  totals: totals(),
  threat_model_id: null,
  source_id: null,
  ...over,
});

const operation = (over: Record<string, unknown> = {}) => ({
  status: 'ok',
  provider: 'openai-compatible',
  model: 'llama3.2',
  hosted: false,
  usage_id: 12,
  ...over,
});

const usageRow = (over: Record<string, unknown> = {}) => ({
  id: 12,
  run: 1,
  operation: 'generate',
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  outcome: 'ok',
  attempts: 1,
  input_tokens: 300,
  output_tokens: 40,
  tokens_estimated: false,
  cost_usd: 0.0021,
  cost_estimated: false,
  price_source: 'list',
  temperature_applied: true,
  duration_ms: 900,
  recorded_at: AT,
  ...over,
});

describe('JobRecord', () => {
  it('parses a running job', () => {
    expect(JobRecord.parse(job())).toMatchObject({ state: 'running', worker_lost: false, caps: { tokens: 500_000, cost_usd: 5 } });
  });

  it('parses a queued job waiting for its next run, and a failed job with its message and hint', () => {
    expect(JobRecord.parse(job({ state: 'queued', started_at: null, next_run_at: AT, progress: null })).next_run_at).toBe(AT);
    const failed = JobRecord.parse(
      job({ state: 'failed', finished_at: AT, failure: { category: 'cap_reached', message: 'The job stopped.', hint: 'Raise the cap.' } }),
    );
    expect(failed.failure?.category).toBe('cap_reached');
  });

  it('parses a cancelled job with who cancelled it', () => {
    expect(JobRecord.parse(job({ state: 'cancelled', finished_at: AT, cancelled_by: { id: 8, username: 'bob' } })).cancelled_by?.username).toBe('bob');
  });

  it('converts a Date from the database to an ISO string', () => {
    expect(JobRecord.parse(job({ queued_at: new Date(AT) })).queued_at).toBe(AT);
  });

  it('refuses an extra field at the top and inside a nested object', () => {
    expect(JobRecord.safeParse({ ...job(), worker_id: randomUUID() }).success).toBe(false);
    expect(JobRecord.safeParse(job({ started_by: { id: 7, username: 'a', password_hash: 'x' } })).success).toBe(false);
    expect(JobRecord.safeParse(job({ caps: { tokens: 1, cost_usd: 1, extra: 1 } })).success).toBe(false);
  });

  it.each([
    ['an unknown state', { state: 'paused' }],
    ['an unknown kind', { kind: 'extraction' }],
    ['an unknown failure category', { failure: { category: 'cancelled', message: 'm', hint: 'h' } }],
    ['a progress step outside the kind’s', { progress: { step: 'chunking' } }],
    ['an id that is not a uuid', { id: 'abc' }],
    ['a timestamp that is not ISO', { queued_at: 'yesterday' }],
    ['a run that is not a whole number', { run: 1.5 }],
  ])('refuses %s', (_label, over) => {
    expect(JobRecord.safeParse(job(over)).success).toBe(false);
  });

  it('knows the twenty-three failure categories a job can carry: Milestone 2’s fourteen and the nine of ingestion', () => {
    expect([...JOB_FAILURE_CATEGORIES].sort()).toEqual(
      [
        'cap_reached',
        'input_too_large',
        'invalid_output',
        'job_error',
        'not_authorized',
        'not_available',
        'not_configured',
        'output_limit_reached',
        'provider_unavailable',
        'rate_limited',
        'refused',
        'rejected',
        'timed_out',
        'worker_lost',
        // Phase 3 Milestone 3.
        'damaged',
        'document_space_full',
        'encrypted',
        'no_text_found',
        'storage_unavailable',
        'too_large',
        'too_large_unpacked',
        'unreadable',
        'unsupported_type',
      ].sort(),
    );
  });

  it('parses an ingestion job, which belongs to a threat model and a source, and one whose source was deleted', () => {
    const threatModel = randomUUID();
    const source = randomUUID();
    const ingestion = job({ kind: 'ingest_source', threat_model_id: threatModel, source_id: source, progress: { step: 'embed', done: 3, total: 10 } });
    expect(JobRecord.parse(ingestion)).toMatchObject({ threat_model_id: threatModel, source_id: source });
    expect(JobRecord.parse({ ...ingestion, source_id: null }).source_id).toBeNull();
  });

  it('refuses a job without its threat_model_id and source_id, which the API always sends', () => {
    const withoutThreatModel: Record<string, unknown> = job();
    delete withoutThreatModel.threat_model_id;
    expect(JobRecord.safeParse(withoutThreatModel).success).toBe(false);
    const withoutSource: Record<string, unknown> = job();
    delete withoutSource.source_id;
    expect(JobRecord.safeParse(withoutSource).success).toBe(false);
  });
});

describe('JobTotals', () => {
  it('parses a known cost and an unknown one with the known part', () => {
    expect(JobTotals.parse(totals()).cost_usd).toBe(0.0021);
    expect(JobTotals.parse(totals({ cost_usd: null, cost_known_usd: 0.001, cost_cap_applied: false }))).toMatchObject({ cost_usd: null, cost_cap_applied: false });
  });

  it('refuses a missing field and an extra one', () => {
    const without: Record<string, unknown> = totals();
    delete without.requests;
    expect(JobTotals.safeParse(without).success).toBe(false);
    expect(JobTotals.safeParse(totals({ extra: 1 })).success).toBe(false);
  });
});

describe('JobDetail', () => {
  it('parses a job with usage rows and a provider check result', () => {
    const detail = JobDetail.parse({
      ...job({ state: 'succeeded', finished_at: AT }),
      usage: [usageRow(), usageRow({ id: 13, operation: 'embed', temperature_applied: null, output_tokens: 0, cost_usd: null, price_source: 'none' })],
      result: { generation: operation(), embeddings: { status: 'not_configured' } },
      ingestion: null,
    });
    expect(detail.usage).toHaveLength(2);
    expect(detail.result?.embeddings.status).toBe('not_configured');
  });

  it('accepts a job with no result yet', () => {
    expect(JobDetail.parse({ ...job(), usage: [], result: null, ingestion: null }).result).toBeNull();
  });

  it('refuses an extra field in a usage row', () => {
    expect(JobDetail.safeParse({ ...job(), usage: [usageRow({ api_key: 'k' })], result: null, ingestion: null }).success).toBe(false);
  });

  it('keeps what an ingestion kept of its run apart from a provider check’s result, as counts only (FR-051)', () => {
    const detail = JobDetail.parse({ ...job({ kind: 'ingest_source' }), usage: [], result: null, ingestion: { chunks: 12, pages_without_text: 2 } });
    expect(detail.ingestion).toEqual({ chunks: 12, pages_without_text: 2 });
    expect(JobDetail.safeParse({ ...job(), usage: [], result: null, ingestion: { chunks: 12, pages_without_text: null, text: 'a document' } }).success).toBe(false);
    expect(JobDetail.safeParse({ ...job(), usage: [], result: null }).success).toBe(false);
  });
});

describe('ProviderCheckResult', () => {
  it('parses an operation that failed, with its message and hint, and one that did not run', () => {
    const parsed = ProviderCheckResult.parse({
      generation: operation({ status: 'not_authorized', message: 'The provider refused the key.', hint: 'Check LLM_API_KEY.' }),
      embeddings: { status: 'not_run' },
    });
    expect(parsed.generation.status).toBe('not_authorized');
    expect(parsed.embeddings.status).toBe('not_run');
  });

  it('refuses a status outside the known ones, and a field that could hold a key or an address', () => {
    expect(ProviderCheckResult.safeParse({ generation: operation({ status: 'weird' }), embeddings: { status: 'ok' } }).success).toBe(false);
    expect(ProviderCheckResult.safeParse({ generation: operation({ base_url: 'http://x' }), embeddings: { status: 'ok' } }).success).toBe(false);
    expect(ProviderCheckResult.safeParse({ generation: operation({ api_key: 'k' }), embeddings: { status: 'ok' } }).success).toBe(false);
  });
});

describe('JobList and JobListQuery', () => {
  it('parses a list with has_more', () => {
    expect(JobList.parse({ jobs: [job()], has_more: true }).has_more).toBe(true);
    expect(JobList.safeParse({ jobs: [job()] }).success).toBe(false);
  });

  it('applies the defaults of 25 and 0, and reads numbers from a query string', () => {
    expect(JobListQuery.parse({})).toEqual({ limit: 25, offset: 0 });
    expect(JobListQuery.parse({ limit: '100', offset: '50' })).toEqual({ limit: 100, offset: 50 });
  });

  it.each([{ limit: '0' }, { limit: '101' }, { offset: '-1' }, { limit: '2.5' }, { limit: 'many' }, { page: '2' }])('refuses %o', (query) => {
    expect(JobListQuery.safeParse(query).success).toBe(false);
  });
});

describe('JobsStatus', () => {
  const status = (over: Record<string, unknown> = {}) => ({
    worker_alive: true,
    ai: { generation: { provider: 'openai-compatible', model: 'llama3.2', hosted: false }, embedding: null },
    provider_check: { offered: true, next_allowed_at: null },
    ...over,
  });

  it('parses the status with AI configured and with it off', () => {
    expect(JobsStatus.parse(status()).provider_check.offered).toBe(true);
    expect(JobsStatus.parse(status({ ai: { generation: null, embedding: null }, provider_check: { offered: false, next_allowed_at: AT } })).ai.generation).toBeNull();
  });

  it('refuses a key or an address in the AI part', () => {
    const ai = { generation: { provider: 'anthropic', model: 'm', hosted: true, api_key: 'k' }, embedding: null };
    expect(JobsStatus.safeParse(status({ ai })).success).toBe(false);
    const withAddress = { generation: { provider: 'anthropic', model: 'm', hosted: true, base_url: 'x' }, embedding: null };
    expect(JobsStatus.safeParse(status({ ai: withAddress })).success).toBe(false);
  });
});

describe('JobCreateInput', () => {
  it('accepts a provider check with the empty input, or with none', () => {
    expect(JobCreateInput.parse({ kind: 'provider_check', input: {} })).toEqual({ kind: 'provider_check', input: {} });
    expect(JobCreateInput.parse({ kind: 'provider_check' })).toEqual({ kind: 'provider_check', input: {} });
  });

  it('refuses any input for a provider check (FR-093)', () => {
    expect(JobCreateInput.safeParse({ kind: 'provider_check', input: { prompt: 'hello' } }).success).toBe(false);
    expect(JobCreateInput.safeParse({ kind: 'provider_check', input: [] }).success).toBe(false);
  });

  it('refuses an unknown kind, a missing kind and an extra field', () => {
    expect(JobCreateInput.safeParse({ kind: 'extraction', input: {} }).success).toBe(false);
    expect(JobCreateInput.safeParse({ input: {} }).success).toBe(false);
    expect(JobCreateInput.safeParse({ kind: 'provider_check', input: {}, token_cap: 1 }).success).toBe(false);
  });

  it('cannot set the caps (FR-045)', () => {
    for (const field of ['token_cap', 'cost_cap_usd', 'caps', 'max_runs', 'time_limit_ms']) {
      expect(JobCreateInput.safeParse({ kind: 'provider_check', input: {}, [field]: 1 }).success).toBe(false);
    }
  });
});
