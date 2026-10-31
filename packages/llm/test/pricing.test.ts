import { describe, expect, it } from 'vitest';
import { costOf, findPrice, priceList } from '../src/pricing.js';
import { operation } from './helpers.js';

const OPENAI_HOST = 'https://api.openai.com/v1';

describe('findPrice: the list', () => {
  it('finds a model by its exact id', () => {
    expect(findPrice(operation('anthropic', { model: 'claude-opus-5-5' }))).toMatchObject({ input: 4, output: 20, source: 'list' });
  });

  it('does not match a longer id, a different case or a prefix', () => {
    for (const model of ['claude-opus-5-5-x', 'CLAUDE-OPUS-5-5', 'claude-opus', 'claude-opus-5-5 ']) {
      expect(findPrice(operation('anthropic', { model })), model).toBeNull();
    }
  });

  it('prices a Bedrock inference profile only if the list names it', () => {
    expect(findPrice(operation('bedrock', { model: 'zz.anthropic.claude-opus-5-5' }))).toBeNull();
    const listed = priceList().entries.bedrock[0];
    expect(listed).toBeDefined();
    expect(findPrice(operation('bedrock', { model: listed?.model ?? '' }))).toMatchObject({ source: 'list' });
  });

  it("uses OpenAI's prices only for OpenAI's own address", () => {
    const model = priceList().entries['openai-compatible'][0]?.model ?? '';
    expect(model).not.toBe('');
    expect(findPrice(operation('openai-compatible', { model, baseUrl: OPENAI_HOST }))).toMatchObject({ source: 'list' });
    expect(findPrice(operation('openai-compatible', { model, baseUrl: 'https://r.openai.azure.com/openai/v1/' }))).toBeNull();
    expect(findPrice(operation('openai-compatible', { model, baseUrl: 'https://gateway.example/v1' }))).toBeNull();
    expect(findPrice(operation('openai-compatible', { model, baseUrl: 'http://ollama:11434/v1', local: true, hosted: false }))).toBeNull();
    expect(findPrice(operation('openai-compatible', { model, baseUrl: 'https://api.openai.com.evil.example/v1' }))).toBeNull();
  });

  it('is unknown for a model nobody priced', () => {
    expect(findPrice(operation('gemini', { model: 'no-such-model' }))).toBeNull();
    expect(findPrice(operation('openai-compatible', { model: 'llama3.2', baseUrl: 'http://ollama:11434/v1', local: true, hosted: false }))).toBeNull();
  });
});

describe('findPrice: the operator', () => {
  it('wins over the list, and names itself as the source', () => {
    const price = findPrice(operation('anthropic', { model: 'claude-opus-5-5', operatorPrice: { input: 1, output: 2 } }));
    expect(price).toMatchObject({ input: 1, output: 2, source: 'operator' });
    expect(price?.above).toBeUndefined();
  });

  it('prices a model the list lacks', () => {
    expect(findPrice(operation('openai-compatible', { model: 'my-deployment', baseUrl: 'https://r.openai.azure.com/openai/v1/', operatorPrice: { input: 3, output: 12 } }))).toMatchObject({
      source: 'operator',
      input: 3,
      output: 12,
    });
  });

  it('counts a local model as free only when the operator says zero (FR-033c)', () => {
    const local = { model: 'llama3.2', baseUrl: 'http://ollama:11434/v1', local: true, hosted: false };
    expect(findPrice(operation('openai-compatible', local))).toBeNull();
    const free = findPrice(operation('openai-compatible', { ...local, operatorPrice: { input: 0, output: 0 } }));
    expect(free).toMatchObject({ input: 0, output: 0, source: 'operator' });
    expect(costOf([{ inputTokens: 5000, outputTokens: 700 }], free)).toBe(0);
  });

  it('takes an input price alone for embeddings', () => {
    expect(findPrice(operation('gemini', { model: 'x', operatorPrice: { input: 0.15, output: null } }))).toMatchObject({ input: 0.15, output: null, source: 'operator' });
  });
});

describe('costOf', () => {
  const price = { input: 4, output: 20, source: 'list' as const };

  it('is the tokens times the price per million, summed over every attempt', () => {
    const calls = [
      { inputTokens: 1000, outputTokens: 500 },
      { inputTokens: 2000, outputTokens: 100 },
    ];
    expect(costOf(calls, price)).toBe(0.024);
  });

  it('rounds to 6 decimal places', () => {
    expect(costOf([{ inputTokens: 1, outputTokens: 0 }], { input: 1.2345, output: 1, source: 'operator' })).toBe(0.000001);
    expect(costOf([{ inputTokens: 1_000_000, outputTokens: 1_000_000 }], { input: 0.1, output: 0.2, source: 'operator' })).toBe(0.3);
  });

  it('uses the higher tier for an attempt above the threshold, and not at or below it', () => {
    const tiered = { input: 0.1, output: 0.5, aboveInputTokens: 100_000, above: { input: 0.5, output: 2.5 }, source: 'list' as const };
    expect(costOf([{ inputTokens: 100_000, outputTokens: 1_000_000 }], tiered)).toBeCloseTo(0.51, 6);
    expect(costOf([{ inputTokens: 100_001, outputTokens: 1_000_000 }], tiered)).toBeCloseTo(2.55, 5);
  });

  it('chooses the tier for each attempt on its own', () => {
    const tiered = { input: 1, output: 1, aboveInputTokens: 1000, above: { input: 2, output: 2 }, source: 'list' as const };
    const calls = [
      { inputTokens: 1000, outputTokens: 0 },
      { inputTokens: 1001, outputTokens: 0 },
    ];
    expect(costOf(calls, tiered)).toBeCloseTo(0.003002, 6);
  });

  it('counts only input for an embedding price', () => {
    expect(costOf([{ inputTokens: 2_000_000, outputTokens: 0 }], { input: 0.15, output: null, source: 'list' })).toBe(0.3);
  });

  it('is null when there is no price: unknown is never zero (FR-033)', () => {
    expect(costOf([{ inputTokens: 1000, outputTokens: 1000 }], null)).toBeNull();
  });
});

describe('SC-004a: every listed model costs what its price says', () => {
  const all = Object.entries(priceList().entries).flatMap(([provider, entries]) => entries.map((entry) => ({ provider, entry })));

  it('has entries to check', () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it.each(all.map(({ provider, entry }) => [`${provider} ${entry.model}`, provider, entry] as const))('%s', (_name, provider, entry) => {
    const op = operation(provider as 'anthropic', { model: entry.model, baseUrl: provider === 'openai-compatible' ? OPENAI_HOST : null });
    const price = findPrice(op);
    expect(price).toMatchObject({ source: 'list', input: entry.input });
    // At or below the tier threshold, so the base prices apply.
    const inputTokens = Math.min(1_000_000, entry.above_input_tokens ?? 1_000_000);
    const outputTokens = entry.output === undefined ? 0 : 500_000;
    const expected = Math.round((inputTokens * entry.input + outputTokens * (entry.output ?? 0)) ) / 1e6;
    expect(costOf([{ inputTokens, outputTokens }], price)).toBeCloseTo(expected, 6);
    if (entry.above_input_tokens === undefined) {
      expect(costOf([{ inputTokens: 1_000_000, outputTokens }], price)).toBeCloseTo(entry.input + (entry.output ?? 0) / 2, 6);
    }
  });
});
