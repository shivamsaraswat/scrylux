import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmSchemaError } from '../src/errors.js';
import { assertStrict, parseAnswer, sanitizeFor, toJsonSchema } from '../src/schema.js';

const rich = z.strictObject({
  name: z.string().min(2).max(200),
  score: z.number().min(1).max(5).multipleOf(0.5),
  tags: z.array(z.string()).min(2).max(10),
  one: z.array(z.string()).min(1),
  kind: z.enum(['a', 'b']),
  lit: z.literal('x'),
  note: z.string().optional(),
});

// Collects every key used anywhere in a JSON value.
function keys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keys(v, into));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keys(v, into);
    }
  }
  return into;
}

describe('assertStrict', () => {
  it('passes for strictObject at every level', () => {
    expect(() =>
      assertStrict(z.strictObject({ a: z.array(z.strictObject({ b: z.string() })), c: z.union([z.strictObject({ d: z.string() }), z.string()]) })),
    ).not.toThrow();
  });

  it('throws LlmSchemaError for a non-strict object at the top', () => {
    expect(() => assertStrict(z.object({ a: z.string() }))).toThrow(LlmSchemaError);
  });

  it('throws for a non-strict object inside an array, a union, an optional or a record', () => {
    expect(() => assertStrict(z.strictObject({ a: z.array(z.object({ b: z.string() })) }))).toThrow(LlmSchemaError);
    expect(() => assertStrict(z.strictObject({ a: z.union([z.object({ b: z.string() }), z.string()]) }))).toThrow(LlmSchemaError);
    expect(() => assertStrict(z.strictObject({ a: z.object({ b: z.string() }).optional() }))).toThrow(LlmSchemaError);
    expect(() => assertStrict(z.strictObject({ a: z.record(z.string(), z.object({ b: z.string() })) }))).toThrow(LlmSchemaError);
  });

  it('throws for a loose object', () => {
    expect(() => assertStrict(z.looseObject({ a: z.string() }))).toThrow(LlmSchemaError);
  });

  it('names the path of the offending object', () => {
    expect(() => assertStrict(z.strictObject({ items: z.array(z.object({ b: z.string() })) }))).toThrow(/items/);
  });
});

describe('toJsonSchema', () => {
  it('converts with draft 2020-12 and keeps additionalProperties false', () => {
    const json = toJsonSchema(z.strictObject({ a: z.string() })) as Record<string, unknown>;
    expect(json.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(json.additionalProperties).toBe(false);
  });
});

describe('sanitizers for Anthropic and Bedrock', () => {
  for (const provider of ['anthropic', 'bedrock'] as const) {
    it(`${provider}: removes what the provider rejects and describes it`, () => {
      const { schema } = sanitizeFor(provider, toJsonSchema(rich));
      const used = keys(schema);
      for (const gone of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems', '$schema'])
        expect(used.has(gone), gone).toBe(false);
      const props = (schema as { properties: Record<string, { description?: string; minItems?: number }> }).properties;
      expect(props.name?.description).toContain('at most 200 characters');
      expect(props.name?.description).toContain('at least 2 characters');
      expect(props.score?.description).toContain('at most 5');
      expect(props.score?.description).toContain('a multiple of 0.5');
      expect(props.tags?.description).toContain('at most 10 items');
      expect(props.tags?.description).toContain('at least 2 items');
      expect(props.tags?.minItems).toBeUndefined();
      expect(props.one?.minItems).toBe(1);
      expect((schema as { additionalProperties: unknown }).additionalProperties).toBe(false);
    });
  }

  it('does not change the schema it was given', () => {
    const json = toJsonSchema(rich);
    const before = JSON.stringify(json);
    sanitizeFor('anthropic', json);
    expect(JSON.stringify(json)).toBe(before);
  });
});

describe('sanitizer for OpenAI-compatible', () => {
  it('is strict only when every object lists all its properties as required', () => {
    expect(sanitizeFor('openai-compatible', toJsonSchema(z.strictObject({ a: z.string(), b: z.number() }))).strict).toBe(true);
    expect(sanitizeFor('openai-compatible', toJsonSchema(z.strictObject({ a: z.string(), b: z.number().optional() }))).strict).toBe(false);
    expect(
      sanitizeFor('openai-compatible', toJsonSchema(z.strictObject({ l: z.array(z.strictObject({ x: z.string().optional() })) }))).strict,
    ).toBe(false);
  });
});

describe('sanitizer for Gemini', () => {
  it('keeps only the documented subset and describes what it removes', () => {
    const { schema } = sanitizeFor('gemini', toJsonSchema(rich));
    const used = keys(schema);
    for (const gone of ['multipleOf', 'minLength', 'maxLength', 'const', '$schema']) expect(used.has(gone), gone).toBe(false);
    const props = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.score?.maximum).toBe(5);
    expect(props.score?.description).toContain('a multiple of 0.5');
    expect(props.name?.description).toContain('at most 200 characters');
    expect(props.tags?.maxItems).toBe(10);
    expect(props.lit?.enum).toEqual(['x']);
  });

  it('removes a string format Gemini does not document, and keeps date-time', () => {
    const { schema } = sanitizeFor(
      'gemini',
      toJsonSchema(z.strictObject({ e: z.email(), d: z.iso.datetime(), p: z.string().regex(/^a+$/) })),
    );
    const props = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.e?.format).toBeUndefined();
    expect(props.d?.format).toBe('date-time');
    expect(props.p?.pattern).toBeUndefined();
  });
});

describe('local validation stays the judge', () => {
  it('rejects an answer that violates a constraint the sanitizer removed', () => {
    const schema = z.strictObject({ s: z.string().max(200) });
    const { schema: sent } = sanitizeFor('anthropic', toJsonSchema(schema));
    expect(keys(sent).has('maxLength')).toBe(false);
    expect(schema.safeParse({ s: 'x'.repeat(300) }).success).toBe(false);
  });
});

describe('parseAnswer', () => {
  it('parses plain JSON in every mode', () => {
    for (const mode of ['native', 'json_object', 'instructions'] as const) expect(parseAnswer('{"a":1}', mode)).toEqual({ a: 1 });
  });

  it('strips one surrounding Markdown code fence only in instructions mode', () => {
    const fenced = '```json\n{"a":1}\n```';
    expect(parseAnswer(fenced, 'instructions')).toEqual({ a: 1 });
    expect(parseAnswer('```\n{"a":1}\n```\n', 'instructions')).toEqual({ a: 1 });
    expect(parseAnswer(fenced, 'native')).toBeUndefined();
    expect(parseAnswer(fenced, 'json_object')).toBeUndefined();
  });

  it('repairs nothing else', () => {
    expect(parseAnswer('Here you go: {"a":1}', 'instructions')).toBeUndefined();
    expect(parseAnswer('{"a":1,}', 'instructions')).toBeUndefined();
    expect(parseAnswer('', 'native')).toBeUndefined();
    expect(parseAnswer('```json\n```json\n{"a":1}\n```\n```', 'instructions')).toBeUndefined();
  });
});
