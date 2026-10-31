import { z } from 'zod';
import { LlmSchemaError } from './errors.js';
import type { ProviderName } from './types.js';

export type JsonSchema = Record<string, unknown>;

export type AnswerMode = 'native' | 'json_object' | 'instructions';

interface ZodDef {
  type: string;
  [key: string]: unknown;
}

function defOf(schema: unknown): ZodDef | undefined {
  return (schema as { _zod?: { def?: ZodDef } } | null)?._zod?.def;
}

/**
 * Every object in the caller's schema must refuse unknown keys, so an answer with extra fields is invalid instead of
 * being trimmed into a match (FR-013). This is read from the zod definition, not from the converted JSON Schema: zod
 * emits `additionalProperties: false` for a plain `z.object` too, while still stripping unknown keys when it parses.
 */
export function assertStrict(schema: z.ZodType): void {
  const seen = new Set<unknown>();
  const visit = (node: unknown, path: string): void => {
    const def = defOf(node);
    if (def === undefined || seen.has(node)) return;
    seen.add(node);
    switch (def.type) {
      case 'object': {
        if (defOf(def.catchall)?.type !== 'never') {
          throw new LlmSchemaError(
            `the schema's object at ${path === '' ? 'the top level' : `"${path}"`} is not strict: use z.strictObject, so extra fields are refused`,
          );
        }
        for (const [key, child] of Object.entries(def.shape as Record<string, unknown>)) visit(child, path === '' ? key : `${path}.${key}`);
        return;
      }
      case 'array':
        return visit(def.element, `${path}[]`);
      case 'union':
        return (def.options as unknown[]).forEach((o) => visit(o, path));
      case 'intersection':
        visit(def.left, path);
        return visit(def.right, path);
      case 'tuple':
        (def.items as unknown[]).forEach((o, i) => visit(o, `${path}[${i}]`));
        return visit(def.rest, `${path}[]`);
      case 'record':
        return visit(def.valueType, `${path}{}`);
      case 'lazy':
        return visit((def.getter as () => unknown)(), path);
      case 'pipe':
        visit(def.in, path);
        return visit(def.out, path);
      case 'optional':
      case 'nullable':
      case 'default':
      case 'prefault':
      case 'readonly':
      case 'nonoptional':
      case 'catch':
        return visit(def.innerType, path);
      default:
    }
  };
  visit(schema, '');
}

/** The caller's zod schema as draft 2020-12 JSON Schema. */
export function toJsonSchema(schema: z.ZodType): JsonSchema {
  try {
    return z.toJSONSchema(schema, { target: 'draft-2020-12' });
  } catch {
    throw new LlmSchemaError('the schema cannot be written as JSON Schema (transforms and custom checks cannot be sent to a provider)');
  }
}

// ---- Per-provider sanitizing --------------------------------------------------------------------------------------

type Keyword = 'minimum' | 'maximum' | 'exclusiveMinimum' | 'exclusiveMaximum' | 'multipleOf' | 'minLength' | 'maxLength' | 'maxItems' | 'minItems' | 'pattern';

const NOTES: Record<Keyword, (v: unknown) => string> = {
  minimum: (v) => `at least ${String(v)}`,
  maximum: (v) => `at most ${String(v)}`,
  exclusiveMinimum: (v) => `greater than ${String(v)}`,
  exclusiveMaximum: (v) => `less than ${String(v)}`,
  multipleOf: (v) => `a multiple of ${String(v)}`,
  minLength: (v) => `at least ${String(v)} characters`,
  maxLength: (v) => `at most ${String(v)} characters`,
  maxItems: (v) => `at most ${String(v)} items`,
  minItems: (v) => `at least ${String(v)} items`,
  pattern: (v) => `matching the pattern ${String(v)}`,
};

// zod writes these bounds for z.int() and similar; they say nothing to a model.
const isSafeIntegerBound = (v: unknown): boolean => v === Number.MAX_SAFE_INTEGER || v === -Number.MAX_SAFE_INTEGER;

const SUBSCHEMA_MAPS = ['properties', '$defs', 'definitions'];
const SUBSCHEMA_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];

/** Calls `fn` on every schema node, children first. */
function eachNode(node: unknown, fn: (n: JsonSchema) => void): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  const schema = node as JsonSchema;
  for (const key of SUBSCHEMA_MAPS) {
    const map = schema[key];
    if (map && typeof map === 'object') for (const child of Object.values(map)) eachNode(child, fn);
  }
  for (const key of SUBSCHEMA_LISTS) {
    const list = schema[key];
    if (Array.isArray(list)) for (const child of list) eachNode(child, fn);
  }
  if (Array.isArray(schema.items)) schema.items.forEach((child) => eachNode(child, fn));
  else eachNode(schema.items, fn);
  eachNode(schema.additionalProperties, fn);
  eachNode(schema.not, fn);
  fn(schema);
}

function describe(node: JsonSchema, notes: string[]): void {
  if (notes.length === 0) return;
  const text = `(${notes.join('; ')})`;
  node.description = typeof node.description === 'string' && node.description !== '' ? `${node.description} ${text}` : text;
}

/** Removes the given keywords from a node and writes each removed constraint into its description. */
function moveToDescription(node: JsonSchema, keywords: Keyword[]): void {
  const notes: string[] = [];
  for (const keyword of keywords) {
    if (!(keyword in node)) continue;
    const value = node[keyword];
    delete node[keyword];
    if ((keyword === 'minimum' || keyword === 'maximum') && isSafeIntegerBound(value)) continue;
    notes.push(NOTES[keyword](value));
  }
  describe(node, notes);
}

function everyObjectListsAllProperties(root: JsonSchema): boolean {
  let all = true;
  eachNode(root, (n) => {
    if (n.type !== 'object' && n.properties === undefined) return;
    const names = Object.keys((n.properties as Record<string, unknown> | undefined) ?? {});
    const required = new Set(Array.isArray(n.required) ? (n.required as string[]) : []);
    if (names.some((name) => !required.has(name))) all = false;
  });
  return all;
}

const GEMINI_KEEP = new Set([
  'type', 'title', 'description', 'anyOf', 'allOf', '$ref', '$defs', 'properties', 'required', 'additionalProperties',
  'enum', 'format', 'minimum', 'maximum', 'items', 'prefixItems', 'minItems', 'maxItems',
]);
const GEMINI_FORMATS = new Set(['date-time', 'date', 'time']);

/**
 * A copy of the schema with what the provider rejects removed, and the removed constraints written into each field's
 * description so the model still sees them. The caller's zod schema stays the only judge of validity (research #5).
 * `strict` is returned for OpenAI-compatible providers only.
 */
export function sanitizeFor(provider: ProviderName, json: JsonSchema): { schema: JsonSchema; strict?: boolean } {
  const schema = structuredClone(json);
  delete schema.$schema;

  switch (provider) {
    case 'anthropic':
    case 'bedrock':
      eachNode(schema, (n) => {
        const keywords: Keyword[] = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems'];
        if (typeof n.minItems === 'number' && n.minItems > 1) keywords.push('minItems');
        moveToDescription(n, keywords);
      });
      return { schema };

    case 'openai-compatible':
      return { schema, strict: everyObjectListsAllProperties(schema) };

    case 'gemini':
      eachNode(schema, (n) => {
        if ('const' in n) {
          n.enum = [n.const];
          delete n.const;
        }
        if (Array.isArray(n.oneOf)) {
          n.anyOf = n.oneOf;
          delete n.oneOf;
        }
        const moved: Keyword[] = ['exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern'];
        moveToDescription(n, moved);
        if (typeof n.format === 'string' && !GEMINI_FORMATS.has(n.format)) {
          describe(n, [`format: ${n.format}`]);
          delete n.format;
        }
        for (const key of Object.keys(n)) {
          if (!GEMINI_KEEP.has(key)) delete n[key];
        }
        for (const key of ['minimum', 'maximum'] as const) {
          if (isSafeIntegerBound(n[key])) delete n[key];
        }
      });
      return { schema };
  }
}

// ---- Answers ------------------------------------------------------------------------------------------------------

const FENCE = /^```[A-Za-z]*\n([\s\S]*?)\n?```$/;

/**
 * Parses a model's answer as JSON, or returns undefined when it is not JSON. In `instructions` mode, where the model
 * was only asked for JSON, one surrounding Markdown code fence is removed first. Nothing else is repaired.
 */
export function parseAnswer(text: string, mode: AnswerMode): unknown {
  let candidate = text.trim();
  if (mode === 'instructions') {
    const fenced = FENCE.exec(candidate);
    if (fenced) candidate = (fenced[1] ?? '').trim();
  }
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}
