import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CallRecord } from '../src/attempts.js';
import { formatLogLine } from '../src/log.js';
import { buildUsage, estimateTokens } from '../src/usage.js';
import { createLlmWithEndpoints, resetCapabilityOverrides } from '../testing/index.js';
import { config, operation } from './helpers.js';
import { openaiCompletion, openaiError } from '../testing/stubs/openai.js';
import { startStub, type Stub } from '../testing/stubs/server.js';

const call = (over: Partial<CallRecord> = {}): CallRecord => ({ inputChars: 400, outputChars: 80, temperature: 0, answered: true, ...over });
const base = { operation: 'generate' as const, temperatureApplied: true as boolean | null, startedAt: 1000, now: 3500 };

describe('estimateTokens', () => {
  it('is the characters divided by four, rounded up', () => {
    expect(estimateTokens(400)).toBe(100);
    expect(estimateTokens(401)).toBe(101);
    expect(estimateTokens(1)).toBe(1);
  });

  it('is zero only for no text at all', () => {
    expect(estimateTokens(0)).toBe(0);
  });
});

describe('buildUsage', () => {
  const op = operation('anthropic', { model: 'claude-opus-5-5' });

  it('sums the tokens the provider reported over every attempt, failed ones included (FR-031)', () => {
    const usage = buildUsage({ ...base, op, attempts: 2, outcome: 'ok', calls: [call({ inputTokens: 100, outputTokens: 10 }), call({ inputTokens: 120, outputTokens: 12 })] });
    expect(usage).toMatchObject({ operation: 'generate', provider: 'anthropic', model: 'claude-opus-5-5', outcome: 'ok', attempts: 2, inputTokens: 220, outputTokens: 22, tokensEstimated: false, durationMs: 2500 });
  });

  it('estimates tokens the provider did not report, from what was sent and received, and marks them (FR-032)', () => {
    const usage = buildUsage({ ...base, op, attempts: 1, outcome: 'ok', calls: [call({ inputChars: 400, outputChars: 81 })] });
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 21, tokensEstimated: true });
  });

  it('estimates only the missing half when one is reported', () => {
    const usage = buildUsage({ ...base, op, attempts: 1, outcome: 'ok', calls: [call({ inputTokens: 50, outputChars: 40 })] });
    expect(usage).toMatchObject({ inputTokens: 50, outputTokens: 10, tokensEstimated: true });
  });

  it('never reports zero for an answered call without usage', () => {
    const usage = buildUsage({ ...base, op, attempts: 1, outcome: 'ok', calls: [call({ inputChars: 1, outputChars: 1 })] });
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
  });

  it('counts a call that failed without an answer as nothing, and does not call that an estimate', () => {
    const usage = buildUsage({ ...base, op, attempts: 2, outcome: 'ok', calls: [call({ answered: false, outputChars: 0 }), call({ inputTokens: 10, outputTokens: 5 })] });
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 5, tokensEstimated: false });
  });

  it('costs from the list and names it', () => {
    const usage = buildUsage({ ...base, op, attempts: 1, outcome: 'ok', calls: [call({ inputTokens: 1_000_000, outputTokens: 1_000_000 })] });
    expect(usage).toMatchObject({ costUsd: 24, priceSource: 'list', costEstimated: false });
  });

  it('costs from the operator price, even for a model in the list', () => {
    const priced = operation('anthropic', { model: 'claude-opus-5-5', operatorPrice: { input: 1, output: 1 } });
    expect(buildUsage({ ...base, op: priced, attempts: 1, outcome: 'ok', calls: [call({ inputTokens: 1_000_000, outputTokens: 1_000_000 })] })).toMatchObject({ costUsd: 2, priceSource: 'operator' });
  });

  it('reports an unknown cost as null with no source, never as zero (FR-033)', () => {
    const unknown = operation('gemini', { model: 'not-in-the-list' });
    expect(buildUsage({ ...base, op: unknown, attempts: 1, outcome: 'ok', calls: [call({ inputTokens: 10, outputTokens: 5 })] })).toMatchObject({ costUsd: null, priceSource: 'none', costEstimated: false });
  });

  it('marks a cost worked out from estimated tokens as estimated', () => {
    expect(buildUsage({ ...base, op, attempts: 1, outcome: 'ok', calls: [call()] })).toMatchObject({ tokensEstimated: true, costEstimated: true });
    const unknown = operation('gemini', { model: 'not-in-the-list' });
    expect(buildUsage({ ...base, op: unknown, attempts: 1, outcome: 'ok', calls: [call()] }).costEstimated).toBe(false);
  });

  it('describes a request that was never sent', () => {
    expect(buildUsage({ ...base, op: null, attempts: 0, outcome: 'not_configured', calls: [], temperatureApplied: false })).toMatchObject({
      provider: null,
      model: null,
      attempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      tokensEstimated: false,
      costUsd: null,
      priceSource: 'none',
    });
  });

  it('has no temperature for an embedding', () => {
    expect(buildUsage({ ...base, operation: 'embed', op: operation('gemini', { model: 'x' }), attempts: 1, outcome: 'ok', calls: [call({ outputChars: 0, inputTokens: 3 })], temperatureApplied: null })).toMatchObject({
      operation: 'embed',
      outputTokens: 0,
      temperatureApplied: null,
    });
  });
});

describe('formatLogLine (FR-034)', () => {
  it('writes the usage record’s fields and no other, as one JSON line', () => {
    const usage = buildUsage({ ...base, op: operation('anthropic', { model: 'claude-opus-5-5' }), attempts: 1, outcome: 'ok', calls: [call({ inputTokens: 10, outputTokens: 5 })] });
    const line = formatLogLine(usage);
    expect(line).not.toContain('\n');
    expect(Object.keys(JSON.parse(line) as object)).toEqual([
      'event', 'operation', 'provider', 'model', 'outcome', 'attempts', 'input_tokens', 'output_tokens', 'tokens_estimated',
      'cost_usd', 'cost_estimated', 'price_source', 'temperature_applied', 'duration_ms',
    ]);
    expect(JSON.parse(line)).toMatchObject({ event: 'llm_request', operation: 'generate', provider: 'anthropic', outcome: 'ok', input_tokens: 10, output_tokens: 5 });
  });
});

// One log line per request, for every way a request can end (SC-004), through the real client.
describe('one log line per request', () => {
  let stub: Stub;
  let lines: string[];
  const schema = z.strictObject({ name: z.string(), type: z.enum(['a', 'b']) });
  const GOOD = '{"name":"n","type":"a"}';
  const request = { schema, schemaName: 'thing', instructions: 'Do it.' };

  const llm = (over = {}) =>
    createLlmWithEndpoints(config({ generation: operation('openai-compatible', { model: 'm', baseUrl: `${stub.url}/v1`, local: true, hosted: false, ...over }) }), {
      log: (line) => lines.push(line),
      endpoints: {},
    });

  beforeEach(async () => {
    resetCapabilityOverrides();
    stub = await startStub();
    lines = [];
  });
  afterEach(() => stub.close());

  it('after a success', async () => {
    stub.enqueue(openaiCompletion({ content: GOOD }));
    const result = await llm().generate(request);
    expect(result.ok).toBe(true);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ outcome: 'ok', attempts: 1, input_tokens: 10, output_tokens: 5, cost_usd: null, price_source: 'none' });
  });

  it('after a retry, with the tokens of both attempts', async () => {
    stub.enqueue(openaiCompletion({ content: '{}' }), openaiCompletion({ content: GOOD }));
    await llm().generate(request);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ attempts: 2, input_tokens: 20, output_tokens: 10 });
  });

  it('after a failure, with the category as the outcome', async () => {
    stub.enqueue(openaiError(401, 'bad key'));
    const result = await llm().generate(request);
    expect(result.ok).toBe(false);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ outcome: 'not_authorized', attempts: 1 });
  });

  it('after the attempt limit is reached', async () => {
    stub.enqueue(openaiCompletion({ content: '{}' }), openaiCompletion({ content: '{}' }), openaiCompletion({ content: '{}' }));
    await llm().generate(request);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ outcome: 'invalid_output', attempts: 3 });
  });

  it('after a cut-off and after a refusal', async () => {
    stub.enqueue(openaiCompletion({ finish_reason: 'length' }), openaiCompletion({ content: null, refusal: 'no' }));
    await llm().generate(request);
    await llm().generate(request);
    expect(lines.map((l) => (JSON.parse(l) as { outcome: string }).outcome)).toEqual(['output_limit_reached', 'refused']);
  });

  it('after a cancel', async () => {
    stub.enqueue('hang');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const result = await llm().generate({ ...request, signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ outcome: 'cancelled' });
  });

  it('when nothing is configured', async () => {
    const result = await createLlmWithEndpoints(config(), { log: (l) => lines.push(l), endpoints: {} }).generate(request);
    expect(result.ok).toBe(false);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ outcome: 'not_configured', attempts: 0, provider: null, model: null, input_tokens: 0 });
  });

  it('estimates and marks tokens for a server that reports none', async () => {
    stub.enqueue(openaiCompletion({ content: GOOD, usage: null }));
    const result = await llm().generate({ ...request, content: 'x'.repeat(400) });
    expect(result.usage.tokensEstimated).toBe(true);
    expect(result.usage.inputTokens).toBeGreaterThan(100);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ tokens_estimated: true });
  });

  it('holds no prompt, content, answer, key or address', async () => {
    stub.enqueue(openaiCompletion({ content: GOOD }));
    await createLlmWithEndpoints(config({ generation: operation('openai-compatible', { model: 'm', baseUrl: `${stub.url}/v1`, apiKey: 'sk-secret-key' }) }), {
      log: (line) => lines.push(line),
      endpoints: {},
    }).generate({ ...request, instructions: 'SECRET-INSTRUCTIONS', content: 'SECRET-CONTENT' });
    expect(lines.join('')).not.toMatch(/SECRET-INSTRUCTIONS|SECRET-CONTENT|sk-secret-key|127\.0\.0\.1|"name":"n"/);
  });

  it('prices the request from the operator’s setting', async () => {
    stub.enqueue(openaiCompletion({ content: GOOD, usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000, total_tokens: 1_500_000 } }));
    const result = await llm({ operatorPrice: { input: 2, output: 4 } }).generate(request);
    expect(result.usage).toMatchObject({ costUsd: 4, priceSource: 'operator' });
    expect(JSON.parse(lines[0] as string)).toMatchObject({ cost_usd: 4, price_source: 'operator' });
  });
});
