import { checkRequest, requestSize, worstCase, type Usage } from '@scrylux/llm';
import { openaiCompletion, resetCapabilityOverrides, startStub, type RecordedRequest, type Scripted, type Stub } from '@scrylux/llm/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kdb } from '../../src/db.js';
import { getDetail, getJob, recordUsage } from '../../src/jobs/store.js';
import { startWorker, type Worker } from '../../src/worker/loop.js';
import { FAST, SETTINGS, answerBoth, clientFor, generationRequests, embeddingRequests, localConfig, makeUser, queueCheck, resetJobTables, waitForState } from './helpers.js';

// The caps (Phase 3 Milestone 2, US2, FR-040 to FR-045, SC-004): before each model request the job asks whether the most
// that request could use fits under what is left of its caps, counting every earlier run, and does not send it if not.
// The figures are computed with the library's own worstCase, so the test follows the layer's constants and not a copy.

let stub: Stub;
let alice: number;
let worker: Worker | undefined;

beforeEach(async () => {
  resetCapabilityOverrides();
  await resetJobTables();
  alice = await makeUser();
  stub = await startStub();
});
afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await stub.close();
});

const fixed = checkRequest();
const generationSize = requestSize({ schema: fixed.generation.schema, schemaName: fixed.generation.schemaName, instructions: fixed.generation.instructions });
const embeddingSize = requestSize({ texts: [fixed.embedding.text] });

async function run(options: { embeddings?: boolean; extra?: Record<string, string> } = {}): Promise<void> {
  const config = localConfig(stub.url, { ...(options.embeddings === undefined ? {} : { embeddings: options.embeddings }), ...(options.extra === undefined ? {} : { extra: options.extra }) });
  worker = await startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings: FAST });
}

const usage = (over: Partial<Usage> = {}): Usage => ({
  operation: 'generate', provider: 'openai-compatible', model: 'llama3.2', outcome: 'ok', attempts: 1, inputTokens: 100, outputTokens: 20,
  tokensEstimated: false, costUsd: null, costEstimated: false, priceSource: 'none', temperatureApplied: true, durationMs: 100, ...over,
});

/** The worst case of the generation request and of the embedding request, for the configuration the test runs with. */
function worst(extra: Record<string, string> = {}): { generation: ReturnType<typeof worstCase>; embedding: ReturnType<typeof worstCase> } {
  const config = localConfig('http://127.0.0.1:1', { extra });
  return {
    generation: worstCase(config, { operation: 'generate', inputChars: generationSize }),
    embedding: worstCase(config, { operation: 'embed', inputChars: embeddingSize }),
  };
}

/** A cap is stored with six decimals. */
const dollars = (amount: number): number => Number(amount.toFixed(6));

async function expectUnderCaps(id: string): Promise<void> {
  const job = await getJob(kdb, id);
  expect((job?.totals.input_tokens ?? 0) + (job?.totals.output_tokens ?? 0)).toBeLessThanOrEqual(job?.caps.tokens ?? 0);
  if (job?.totals.cost_usd !== null && job?.totals.cost_usd !== undefined) expect(job.totals.cost_usd).toBeLessThanOrEqual(job.caps.cost_usd);
}

describe('the token cap', () => {
  it('refuses before sending anything when one request alone could pass it, and says the cap is lower than one request needs (FR-044)', async () => {
    stub.setFallback(answerBoth());
    const { generation, embedding } = worst();
    // Below the generation request, above the embedding request: the first request is the one that cannot fit.
    expect(embedding.tokens).toBeLessThan(generation.tokens - 1);
    const id = await queueCheck(alice, { ...SETTINGS, tokenCap: generation.tokens - 1 });
    await run();
    const done = await waitForState(id, ['failed', 'succeeded']);
    expect(done.state).toBe('failed');
    expect(done.failure?.category).toBe('cap_reached');
    expect(done.failure?.message).toMatch(/lower than one request/);
    expect(done.run).toBe(1);
    expect(stub.requests).toHaveLength(0);
    // The operations are shown as never sent, and nothing was used.
    expect((await getDetail(kdb, id))?.result).toEqual({ generation: { status: 'not_run' }, embeddings: { status: 'not_run' } });
    expect(done.totals.requests).toBe(0);
    await expectUnderCaps(id);
  });

  it('counts what earlier runs used: no request is sent when used plus the worst case would pass the cap (FR-041, FR-042)', async () => {
    stub.setFallback(answerBoth());
    const { generation } = worst();
    const id = await queueCheck(alice, { ...SETTINGS, tokenCap: generation.tokens + 100 });
    // An earlier run used 101 tokens, so the generation request no longer fits, though it would have on its own.
    await recordUsage(kdb, id, 1, usage({ inputTokens: 80, outputTokens: 21 }));
    await run();
    const done = await waitForState(id, ['failed', 'succeeded']);
    expect(done.state).toBe('failed');
    expect(done.failure?.category).toBe('cap_reached');
    expect(done.failure?.message).not.toMatch(/lower than one request/);
    expect(stub.requests).toHaveLength(0);
    await expectUnderCaps(id);
  });

  it('stops before the second request, not after it: the first request’s real usage counts', async () => {
    const { generation, embedding } = worst();
    const cap = generation.tokens + 100;
    // The generation answer reports most of the cap, so the embedding request, which fits on its own, does not fit now.
    const reported = cap - embedding.tokens + 20;
    stub.setFallback((r: RecordedRequest): Scripted =>
      r.path.endsWith('/embeddings') ? answerBoth()(r) : openaiCompletion({ content: '{"status":"ok"}', usage: { prompt_tokens: reported - 9, completion_tokens: 9, total_tokens: reported } }),
    );
    const id = await queueCheck(alice, { ...SETTINGS, tokenCap: cap });
    await run();
    const done = await waitForState(id, ['failed', 'succeeded']);
    expect(done.state).toBe('failed');
    expect(done.failure?.category).toBe('cap_reached');
    expect(generationRequests(stub)).toHaveLength(1);
    expect(embeddingRequests(stub)).toHaveLength(0);
    const detail = await getDetail(kdb, id);
    expect(detail?.result).toMatchObject({ generation: { status: 'ok' }, embeddings: { status: 'not_run' } });
    expect((detail?.totals.input_tokens ?? 0) + (detail?.totals.output_tokens ?? 0)).toBe(reported);
    await expectUnderCaps(id);
  });

  it('lets a job through that fits, and the recorded tokens stay under the cap (SC-004)', async () => {
    stub.setFallback(answerBoth());
    const { generation, embedding } = worst();
    const id = await queueCheck(alice, { ...SETTINGS, tokenCap: generation.tokens + embedding.tokens });
    await run();
    const done = await waitForState(id, ['failed', 'succeeded']);
    expect(done.state).toBe('succeeded');
    await expectUnderCaps(id);
  });
});

describe('the cost cap', () => {
  const PRICES = { LLM_PRICE_INPUT: '10', LLM_PRICE_OUTPUT: '50' };

  it('refuses before sending anything when one request alone could cost more than the cap (FR-044)', async () => {
    stub.setFallback(answerBoth());
    const { generation } = worst(PRICES);
    expect(generation.costUsd).not.toBeNull();
    const id = await queueCheck(alice, { ...SETTINGS, costCapUsd: dollars((generation.costUsd ?? 0) * 0.9) });
    await run({ extra: PRICES });
    const done = await waitForState(id, ['failed', 'succeeded']);
    expect(done.state).toBe('failed');
    expect(done.failure?.category).toBe('cap_reached');
    expect(done.failure?.message).toMatch(/lower than one request/);
    expect(stub.requests).toHaveLength(0);
  });

  it('counts what earlier runs cost: no request is sent when cost so far plus the worst case would pass the cap (FR-041)', async () => {
    stub.setFallback(answerBoth());
    const { generation } = worst(PRICES);
    const id = await queueCheck(alice, { ...SETTINGS, costCapUsd: dollars((generation.costUsd ?? 0) + 0.01) });
    await recordUsage(kdb, id, 1, usage({ costUsd: 0.02, priceSource: 'operator' }));
    await run({ extra: PRICES });
    const done = await waitForState(id, ['failed', 'succeeded']);
    expect(done.state).toBe('failed');
    expect(done.failure?.category).toBe('cap_reached');
    expect(done.failure?.message).not.toMatch(/lower than one request/);
    expect(stub.requests).toHaveLength(0);
  });

  it('keeps the cost under the cap for a job that fits', async () => {
    stub.setFallback(answerBoth());
    const { generation, embedding } = worst(PRICES);
    const id = await queueCheck(alice, { ...SETTINGS, costCapUsd: dollars((generation.costUsd ?? 0) + (embedding.costUsd ?? 0) + 1) });
    await run({ extra: PRICES, embeddings: false });
    const done = await waitForState(id, ['failed', 'succeeded']);
    expect(done.state).toBe('succeeded');
    expect(done.totals.cost_usd).not.toBeNull();
    await expectUnderCaps(id);
  });
});

describe('a price that is not known (FR-043)', () => {
  it('does not apply the cost cap, still applies the token cap, and says the cost is unknown', async () => {
    stub.setFallback(answerBoth());
    // The smallest cost cap there is: it would stop every priced request, and does not touch an unpriced one.
    const id = await queueCheck(alice, { ...SETTINGS, costCapUsd: 0.000001 });
    await run();
    const done = await waitForState(id, ['failed', 'succeeded']);
    expect(done.state).toBe('succeeded');
    expect(done.totals).toMatchObject({ cost_usd: null, cost_cap_applied: false, cost_known_usd: 0 });
  });

  it('still applies the cost cap to a request whose price is known, though another request’s price is not', async () => {
    stub.setFallback(answerBoth());
    // Generation is not priced and goes ahead. Embeddings are priced, and their worst case costs more than the cap.
    const prices = { EMBEDDING_PRICE_INPUT: '1000' };
    const cap = 0.03;
    expect(worst(prices).embedding.costUsd).toBeGreaterThan(cap);
    const id = await queueCheck(alice, { ...SETTINGS, costCapUsd: cap });
    await run({ extra: prices });
    const done = await waitForState(id, ['failed', 'succeeded']);
    expect(done.state).toBe('failed');
    expect(done.failure?.category).toBe('cap_reached');
    expect(done.failure?.message).toMatch(/lower than one request/);
    expect(generationRequests(stub)).toHaveLength(1);
    expect(embeddingRequests(stub)).toHaveLength(0);
    expect(done.totals).toMatchObject({ requests: 1, cost_usd: null });
  });
});

describe('tokens the provider did not report (US2 scenario 5)', () => {
  it('are estimated from the text and counted as reported, never as zero', async () => {
    stub.setFallback((r: RecordedRequest): Scripted =>
      r.path.endsWith('/embeddings') ? answerBoth()(r) : openaiCompletion({ content: '{"status":"ok"}', usage: null }),
    );
    const id = await queueCheck(alice);
    await run({ embeddings: false });
    const done = await waitForState(id, ['failed', 'succeeded']);
    expect(done.state).toBe('succeeded');
    expect(done.totals.tokens_estimated).toBe(true);
    expect(done.totals.input_tokens).toBeGreaterThan(0);
    expect(done.totals.output_tokens).toBeGreaterThan(0);
  });
});
