import { describe, expect, it } from 'vitest';
import { loadData, loadPrompt } from '../src/data.js';
import { parseModelsFile } from '../src/capabilities.js';
import { checkRequest } from '../src/check.js';
import { parsePriceFile } from '../src/pricing.js';

// Every shipped data file loads, and holds what its contract says (contracts/data-files.md).

// The names of the {{placeholders}} a text holds, in order of first appearance.
const placeholdersOf = (text: string): string[] => [...new Set([...text.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1] as string))];

describe('prompts', () => {
  it.each([
    ['content-section.md', ['nonce']],
    ['schema-retry.md', ['issues']],
    ['json-instructions.md', ['schema']],
    ['empty-turn.md', []],
  ])('%s has exactly its placeholders', (name, expected) => {
    const text = loadPrompt(name);
    expect(text.trim().length).toBeGreaterThan(0);
    expect(placeholdersOf(text)).toEqual(expected);
  });

  it('content-section.md holds the preamble, the start marker and the end marker', () => {
    const parts = loadPrompt('content-section.md').split(/\n%%%\n/);
    expect(parts).toHaveLength(3);
    expect(parts[1]?.trim()).toBe('<<<SCRYLUX-CONTENT {{nonce}}>>>');
    expect(parts[2]?.trim()).toBe('<<<END SCRYLUX-CONTENT {{nonce}}>>>');
  });
});

describe('models.yaml', () => {
  it('loads with the strict schema', () => {
    expect(() => parseModelsFile(loadData('models.yaml'))).not.toThrow();
  });
});

describe('check.yaml (FR-047)', () => {
  it('holds the fixed request of the check, and its one-field schema accepts only that field', () => {
    const fixed = checkRequest();
    expect(fixed.generation.instructions.length).toBeGreaterThan(20);
    expect(fixed.embedding.text.length).toBeGreaterThan(10);
    expect(fixed.generation.schema.safeParse({ status: 'ok' }).success).toBe(true);
    expect(fixed.generation.schema.safeParse({ status: 'ok', extra: 1 }).success).toBe(false);
    expect(fixed.generation.schema.safeParse({}).success).toBe(false);
  });
});

describe('prices.yaml (FR-033a)', () => {
  const file = parsePriceFile(loadData('prices.yaml'));
  const all = Object.entries(file.entries).flatMap(([provider, entries]) => entries.map((entry) => ({ provider, entry })));

  it('has exactly the four providers', () => {
    expect(Object.keys(file.entries).sort()).toEqual(['anthropic', 'bedrock', 'gemini', 'openai-compatible']);
  });

  it('has no model twice under one provider', () => {
    for (const [provider, entries] of Object.entries(file.entries)) {
      const models = entries.map((e) => e.model);
      expect(new Set(models).size, `${provider} lists a model twice`).toBe(models.length);
    }
  });

  it('dates every price with a day that has passed, and sources it with an https address', () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const { provider, entry } of all) {
      expect(entry.checked, `${provider} ${entry.model}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(entry.checked)), `${provider} ${entry.model}`).toBe(false);
      expect(entry.checked <= today, `${provider} ${entry.model} is dated in the future`).toBe(true);
      expect(entry.source, `${provider} ${entry.model}`).toMatch(/^https:\/\/\S+$/);
    }
  });

  it('gives an embedding model an input price only', () => {
    const embedding = all.filter(({ entry }) => /embed/i.test(entry.model));
    expect(embedding.length).toBeGreaterThan(0);
    for (const { entry } of embedding) expect(entry.output, entry.model).toBeUndefined();
    for (const { entry } of all.filter(({ entry }) => !/embed/i.test(entry.model))) expect(entry.output, entry.model).toBeDefined();
  });

  it('has a higher tier exactly when it has a threshold', () => {
    for (const { entry } of all) {
      expect(entry.above !== undefined, entry.model).toBe(entry.above_input_tokens !== undefined);
      if (entry.above) expect(entry.above.output !== undefined, entry.model).toBe(entry.output !== undefined);
    }
  });

  it('prices nothing below zero', () => {
    for (const { entry } of all) {
      expect(entry.input).toBeGreaterThanOrEqual(0);
      expect(entry.output ?? 0).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the strict schema for prices', () => {
  const valid = `
anthropic:
  - { model: a, input: 1, output: 2, checked: 2026-01-01, source: https://example.com/p }
openai-compatible:
  - { model: b, input: 1, output: 2, checked: 2026-01-01, source: https://example.com/p }
bedrock:
  - { model: c, input: 1, output: 2, checked: 2026-01-01, source: https://example.com/p }
gemini:
  - { model: d, input: 1, output: 2, checked: 2026-01-01, source: https://example.com/p }
`;

  it('accepts a minimal file', () => {
    expect(() => parsePriceFile(valid)).not.toThrow();
  });

  it('refuses a model twice, a future date, a non-https source, a negative price and an unknown field', () => {
    expect(() => parsePriceFile(valid.replace('gemini:', 'anthropic2:'))).toThrow();
    expect(() => parsePriceFile(valid.replace('anthropic:\n', 'anthropic:\n  - { model: a, input: 1, output: 2, checked: 2026-01-01, source: https://example.com/p }\n'))).toThrow(/twice|more than once/);
    expect(() => parsePriceFile(valid.replace('2026-01-01', '2999-01-01'))).toThrow(/future/);
    expect(() => parsePriceFile(valid.replace('https://example.com/p', 'http://example.com/p'))).toThrow();
    expect(() => parsePriceFile(valid.replace('input: 1,', 'input: -1,'))).toThrow();
    expect(() => parsePriceFile(valid.replace('output: 2,', 'output: 2, colour: red,'))).toThrow();
  });

  it('refuses a tier with only one half', () => {
    expect(() => parsePriceFile(valid.replace('output: 2,', 'output: 2, above_input_tokens: 100,'))).toThrow();
    expect(() => parsePriceFile(valid.replace('output: 2,', 'output: 2, above: { input: 2, output: 3 },'))).toThrow();
  });
});
