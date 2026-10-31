import { afterEach, describe, expect, it } from 'vitest';
import { loadData } from '../src/data.js';
import {
  lookupCapability,
  parseModelsFile,
  rememberRefusal,
  resetCapabilityOverrides,
  resolveCapability,
} from '../src/capabilities.js';

const SRC = 'https://example.com/doc';

// A minimal valid file: every provider ends with "*", setting every field that applies to it.
const VALID = `
anthropic:
  - match: "claude-new-*"
    temperature: omit
    reason: "refuses any temperature"
    source: ${SRC}
  - match: "*"
    temperature: send
    structured_output: native
openai-compatible:
  - match: "emb-*"
    embedding_batch: 7
  - match: "*"
    temperature: send
    structured_output: native
    max_tokens_param: max_tokens
    embedding_batch: 256
bedrock:
  - match: "*"
    temperature: send
    structured_output: instructions
    embedding_batch: 1
gemini:
  - match: "*"
    temperature: omit
    reason: "left at its default"
    source: ${SRC}
    structured_output: native
    embedding_batch: 100
`;

afterEach(() => resetCapabilityOverrides());

describe('parseModelsFile', () => {
  it('accepts a minimal valid file', () => {
    expect(() => parseModelsFile(VALID)).not.toThrow();
  });

  it('matches with * as the only wildcard and takes the first match', () => {
    const file = parseModelsFile(VALID);
    expect(lookupCapability(file, 'anthropic', 'claude-new-1').temperature).toBe('omit');
    expect(lookupCapability(file, 'anthropic', 'claude-old').temperature).toBe('send');
    // a dot is not a wildcard
    const dotted = parseModelsFile(VALID.replace('claude-new-*', 'claude-1.5*'));
    expect(lookupCapability(dotted, 'anthropic', 'claude-1x5').temperature).toBe('send');
    expect(lookupCapability(dotted, 'anthropic', 'claude-1.5-a').temperature).toBe('omit');
  });

  it('takes a field the first match leaves out from the provider default, never from another entry', () => {
    const file = parseModelsFile(VALID);
    const cap = lookupCapability(file, 'openai-compatible', 'emb-small');
    expect(cap.embeddingBatch).toBe(7);
    expect(cap.temperature).toBe('send');
    expect(cap.maxTokensParam).toBe('max_tokens');
  });

  it('requires each provider to end with "*"', () => {
    const bad = VALID.replace(/bedrock:\n {2}- match: "\*"/, 'bedrock:\n  - match: "x-*"');
    expect(() => parseModelsFile(bad)).toThrow(/bedrock/);
  });

  it('requires the "*" entry to set every field that applies to its provider', () => {
    expect(() =>
      parseModelsFile(VALID.replace('    max_tokens_param: max_tokens\n', '')),
    ).toThrow(/max_tokens_param/);
    expect(() => parseModelsFile(VALID.replace('    embedding_batch: 100\n', ''))).toThrow(
      /embedding_batch/,
    );
  });

  it('refuses a field set for a provider it does not apply to', () => {
    expect(() =>
      parseModelsFile(VALID.replace('anthropic:\n', 'anthropic:\n  - match: "a"\n    embedding_batch: 4\n')),
    ).toThrow(/embedding_batch/);
    expect(() =>
      parseModelsFile(VALID.replace('gemini:\n', 'gemini:\n  - match: "g"\n    max_tokens_param: max_tokens\n')),
    ).toThrow(/max_tokens_param/);
  });

  it('refuses an omit without a reason or without an https source', () => {
    expect(() => parseModelsFile(VALID.replace('    reason: "refuses any temperature"\n', ''))).toThrow(
      /reason/,
    );
    expect(() => parseModelsFile(VALID.replace(`source: ${SRC}\n  - match: "*"\n    temperature: send`, 'source: http://example.com\n  - match: "*"\n    temperature: send'))).toThrow(
      /source/,
    );
  });

  it('refuses an unknown provider, an unknown field and a value out of range', () => {
    expect(() => parseModelsFile(VALID + 'mystery:\n  - match: "*"\n')).toThrow();
    expect(() => parseModelsFile(VALID.replace('embedding_batch: 7', 'embedding_batch: 5000'))).toThrow();
    expect(() => parseModelsFile(VALID.replace('embedding_batch: 7', 'embedding_batch: 7\n    colour: red'))).toThrow();
  });
});

describe('the runtime override', () => {
  it('wins over the file, per model, until reset', () => {
    expect(resolveCapability('openai-compatible', 'llama3.2').temperature).toBe('send');
    rememberRefusal('openai-compatible', 'llama3.2', 'temperature');
    expect(resolveCapability('openai-compatible', 'llama3.2').temperature).toBe('omit');
    expect(resolveCapability('openai-compatible', 'other-model').temperature).toBe('send');
    resetCapabilityOverrides();
    expect(resolveCapability('openai-compatible', 'llama3.2').temperature).toBe('send');
  });

  it('steps the output format native -> json_object -> instructions for openai-compatible', () => {
    expect(resolveCapability('openai-compatible', 'm').structuredOutput).toBe('native');
    rememberRefusal('openai-compatible', 'm', 'format');
    expect(resolveCapability('openai-compatible', 'm').structuredOutput).toBe('json_object');
    rememberRefusal('openai-compatible', 'm', 'format');
    expect(resolveCapability('openai-compatible', 'm').structuredOutput).toBe('instructions');
  });

  it('steps native -> instructions for the other providers', () => {
    rememberRefusal('anthropic', 'claude-x', 'format');
    expect(resolveCapability('anthropic', 'claude-x').structuredOutput).toBe('instructions');
  });

  it('switches the output parameter to max_completion_tokens', () => {
    rememberRefusal('openai-compatible', 'my-deployment', 'max_tokens');
    expect(resolveCapability('openai-compatible', 'my-deployment').maxTokensParam).toBe(
      'max_completion_tokens',
    );
  });
});

describe('the shipped models.yaml', () => {
  it('parses and meets every rule above', () => {
    expect(() => parseModelsFile(loadData('models.yaml'))).not.toThrow();
  });

  it.each([
    ['anthropic', 'claude-opus-5-5', 'omit'],
    ['anthropic', 'claude-opus-4-6', 'send'],
    ['anthropic', 'claude-sonnet-5-5', 'omit'],
    ['anthropic', 'claude-haiku-5-5', 'omit'],
    ['anthropic', 'claude-sonnet-4-6', 'send'],
    ['anthropic', 'claude-haiku-4-5', 'send'],
    ['gemini', 'gemini-2.5-flash', 'send'],
    ['gemini', 'gemini-3.8-flash', 'omit'],
    ['gemini', 'gemini-4-argon', 'omit'],
    ['openai-compatible', 'gpt-5', 'omit'],
    ['openai-compatible', 'o4-mini', 'omit'],
    ['openai-compatible', 'llama3.2', 'send'],
    ['openai-compatible', 'orca-mini', 'send'],
    ['bedrock', 'us.anthropic.claude-opus-5-5', 'omit'],
    ['bedrock', 'anthropic.claude-opus-5-5', 'omit'],
    ['bedrock', 'anthropic.claude-opus-4-6-v1', 'send'],
    ['bedrock', 'eu.anthropic.claude-opus-4-6-v1', 'send'],
  ] as const)('%s %s: temperature %s', (provider, model, expected) => {
    expect(resolveCapability(provider, model).temperature).toBe(expected);
  });

  it('uses max_completion_tokens for OpenAI reasoning models and max_tokens for local ones', () => {
    expect(resolveCapability('openai-compatible', 'gpt-5').maxTokensParam).toBe('max_completion_tokens');
    expect(resolveCapability('openai-compatible', 'o4-mini').maxTokensParam).toBe('max_completion_tokens');
    expect(resolveCapability('openai-compatible', 'llama3.2').maxTokensParam).toBe('max_tokens');
    expect(resolveCapability('openai-compatible', 'orca-mini').maxTokensParam).toBe('max_tokens');
  });

  it('knows the embedding facts', () => {
    const titan = resolveCapability('bedrock', 'amazon.titan-embed-text-v2:0');
    expect(titan.embeddingBody).toBe('titan-v2');
    expect(titan.embeddingBatch).toBe(1);
    expect(resolveCapability('bedrock', 'amazon.nova-lite-v1:0').embeddingBody).toBeNull();
    expect(resolveCapability('gemini', 'gemini-embedding-001').embeddingBatch).toBe(100);
    expect(resolveCapability('openai-compatible', 'text-embedding-3-small').embeddingBatch).toBe(256);
  });

  it('mirrors the Anthropic list for Claude on Bedrock, in order and first', () => {
    const doc = parseModelsFile(loadData('models.yaml'));
    const anthropic = doc.entries.anthropic.filter((e) => e.match !== '*');
    const bedrock = doc.entries.bedrock;
    anthropic.forEach((entry, i) => {
      const mirror = bedrock[i];
      expect(mirror?.match, `bedrock entry ${i} should mirror ${entry.match}`).toBe(`*anthropic.${entry.match}`);
      expect(mirror?.temperature).toBe(entry.temperature);
      expect(mirror?.reason).toBe(entry.reason);
      expect(mirror?.source).toBe(entry.source);
    });
  });
});
