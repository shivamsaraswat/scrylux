import { readFileSync } from 'node:fs';
import { DraftAnswer } from '@scrylux/core';
import { parseLlmConfig, requestSize, worstCase } from '@scrylux/llm';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { parseExtractionConfig } from '../../src/extract-system/config.js';
import { buildContent, type ChunkForPrompt } from '../../src/extract-system/content.js';
import { loadExtractionPrompt } from '../../src/extract-system/prompt.js';

// The defaults are sized together (Phase 3 Milestone 4, FR-016, FR-043, research #5): one request at the default budget must fit the context of the
// documented local model, with its answer and some room to spare, and the worst case of five calls (three schema attempts and two transient retries)
// must fit the default caps for every model below the "pro" tier. This measures the real schema, the real instructions and the real price list: a
// change to any of them that breaks the sizing fails here, instead of failing an operator's first extraction.

const DEFAULTS = parseExtractionConfig({});
const CONTEXT_TOKENS = 32_768;
const SPARE = 0.15;
const DEFAULT_CAPS = { tokens: 500_000, costUsd: 5 };
const tokens = (chars: number): number => Math.ceil(chars / 4);

/** Chunks of 2,000 characters, as many as the default budget holds, each with a header of a typical length. */
function fullBudget(): { content: string; chunks: number } {
  const chunks: ChunkForPrompt[] = [];
  for (let used = 0; used + 2000 <= DEFAULTS.contextChars; used += 2000) {
    chunks.push({
      id: `chunk-${chunks.length}`,
      sourceId: 'source',
      sourceName: 'payments-platform-architecture-overview.md',
      pageFirst: null,
      pageLast: null,
      lineFirst: 1000 + chunks.length * 40,
      lineLast: 1040 + chunks.length * 40,
      heading: 'Deployment and network zones',
      text: 'x'.repeat(2000),
    });
  }
  return { content: buildContent(chunks).content, chunks: chunks.length };
}

function request() {
  const { content } = fullBudget();
  return { schema: DraftAnswer, schemaName: 'scrylux_draft', instructions: loadExtractionPrompt().instructions, content, maxOutputTokens: DEFAULTS.maxOutputTokens, attemptLimit: 3 as const };
}

/** The largest one attempt can be: the layer's own size, which holds the schema once, plus the schema again as pretty-printed JSON in the instructions of a provider that is not given it natively. */
function largestAttemptChars(): number {
  const schema = z.toJSONSchema(DraftAnswer, { target: 'draft-2020-12' });
  return requestSize(request()) + (JSON.stringify(schema, null, 2).length - JSON.stringify(schema).length);
}

describe('the defaults', () => {
  it('are a budget of 36,000 characters and an output limit of 12,000 tokens', () => {
    expect(DEFAULTS).toEqual({ contextChars: 36_000, maxOutputTokens: 12_000 });
  });

  it('fill the budget with the chunks the sizing assumes: 18 of 2,000 characters', () => {
    expect(fullBudget().chunks).toBe(18);
  });
});

describe('one request at the default budget (FR-016)', () => {
  it('fits a context of 32,768 tokens with its answer and 15% to spare, even with the schema counted twice and a full note for a retry', () => {
    const input = tokens(largestAttemptChars());
    const total = input + DEFAULTS.maxOutputTokens;
    expect(total, `${input} tokens in, ${DEFAULTS.maxOutputTokens} out`).toBeLessThanOrEqual(Math.floor(CONTEXT_TOKENS * (1 - SPARE)));
  });

  it('sends well under the instructions’ own share: the text of the sources is most of the input', () => {
    const { content } = fullBudget();
    expect(content.length).toBeGreaterThan(DEFAULTS.contextChars);
    expect(loadExtractionPrompt().instructions.length).toBeLessThan(6000);
  });
});

describe('the worst case against the default caps (FR-043)', () => {
  const prices = parse(readFileSync(new URL('../../../../packages/llm/data/prices.yaml', import.meta.url), 'utf8')) as Record<string, Array<{ model: string; output?: number }>>;
  const hostedBase: Record<string, string> = { 'openai-compatible': 'https://api.openai.com/v1' };

  function worst(provider: string, model: string) {
    const config = parseLlmConfig({
      LLM_PROVIDER: provider,
      LLM_MODEL: model,
      LLM_API_KEY: 'sk-test',
      ...(hostedBase[provider] === undefined ? {} : { LLM_BASE_URL: hostedBase[provider] }),
    });
    return worstCase(config, { operation: 'generate', inputChars: largestAttemptChars(), maxOutputTokens: DEFAULTS.maxOutputTokens });
  }

  it('is five calls of the largest attempt, and fits the token cap on its own', () => {
    const result = worst('anthropic', 'claude-haiku-5-5');
    expect(result.tokens).toBeLessThanOrEqual(DEFAULT_CAPS.tokens);
    // Five calls, each of at most the input and the whole output limit.
    expect(result.tokens).toBeGreaterThan(4 * (DEFAULTS.maxOutputTokens + tokens(largestAttemptChars())));
  });

  it('fits the default token and cost caps for every priced model that is not a "pro" model', () => {
    const generation = ['anthropic', 'openai-compatible', 'gemini'];
    const fits: string[] = [];
    const exceeds: string[] = [];
    for (const provider of generation) {
      for (const entry of prices[provider] ?? []) {
        // Embedding models have no output price, and are not asked for a draft.
        if (entry.output === undefined) continue;
        const result = worst(provider, entry.model);
        const ok = result.tokens <= DEFAULT_CAPS.tokens && (result.costUsd === null || result.costUsd <= DEFAULT_CAPS.costUsd);
        (ok ? fits : exceeds).push(entry.model);
      }
    }
    expect(fits.length).toBeGreaterThan(30);
    // What does not fit is the dearest tier, and a model whose list has a higher price above a size that one request never reaches. The worst case
    // takes the highest tier as a ceiling (M2 research #7), so gpt-6-astra, at $10 and $50 a million like the dearest model that fits, counts up to
    // about $6 for five attempts. Its job fails as "cap reached", with the hint to raise the caps, and nothing is sent (M2 FR-044). The operator's
    // guide says so (docs/ai-providers.md, "Extraction"). Any other model that stops fitting fails here and needs the same decision.
    const ceilingOnly = ['gpt-6-astra'];
    expect(exceeds.filter((model) => !/pro|^o1$|^gpt-4-0613$/.test(model) && !ceilingOnly.includes(model))).toEqual([]);
    for (const model of ceilingOnly) expect(exceeds, `${model} should be the one that exceeds only by its tier`).toContain(model);
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'gpt-5.5', 'gemini-2.5-pro']) expect(fits, model).toContain(model);
  });
});
