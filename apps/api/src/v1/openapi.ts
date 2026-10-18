import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jsonValue, toJsonSchemaOverride } from '@scrylux/core';
import { z } from 'zod';
import { DEFAULT_BODY_LIMIT, defineOperation, type Operation } from './operation.js';
import { resourceOperations } from './operations.js';

// Builds the OpenAPI 3.1 document from the same operation table the router mounts, so the two
// cannot describe different APIs (FR-020). The schemas come from the shared Zod definitions through
// z.toJSONSchema, in two passes (request bodies as inputs, records as outputs) over dedicated
// registries that name each schema as a component. research.md #4 explains each choice here.

type JsonObject = Record<string, unknown>;

const SCHEMA_REF = '#/components/schemas/';
const ref = (name: string): JsonObject => ({ $ref: SCHEMA_REF + name });

const STATUS_DESCRIPTIONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'Deleted; there is no body',
  400: 'The request is not valid',
  401: 'There is no valid token',
  404: 'No such record',
  409: 'The request conflicts with existing records',
  415: 'The content encoding is not supported',
  500: 'An unexpected failure',
};

function componentSchemas(): Record<string, JsonObject> {
  const schemas: Record<string, JsonObject> = {};
  for (const io of ['input', 'output'] as const) {
    const registry = z.registry<{ id: string }>();
    // The JSON value is recursive, so it can only be a component that others point at.
    registry.add(jsonValue, { id: 'JsonValue' });
    const named = new Map<string, z.ZodType>();
    for (const op of resourceOperations) {
      const entry = io === 'input' ? op.body : op.response;
      if (!entry) continue;
      const existing = named.get(entry.name);
      if (existing !== undefined && existing !== entry.schema) {
        throw new Error(`Two different schemas are both named ${entry.name}`);
      }
      if (existing === undefined) {
        named.set(entry.name, entry.schema);
        registry.add(entry.schema, { id: entry.name });
      }
    }
    const converted = z.toJSONSchema(registry, {
      io,
      target: 'draft-2020-12',
      // Zod cannot represent a few things (a Date, a transform). `timestamp` is the only one in the
      // shared definitions, and the override gives it its real shape. openapi.test.ts fails if
      // anything else ever comes out as an empty schema.
      unrepresentable: 'any',
      override: toJsonSchemaOverride,
      uri: (id) => SCHEMA_REF + id,
    });
    for (const [id, schema] of Object.entries(converted.schemas)) {
      // $id and $schema describe a standalone schema, not a component of a document.
      const component: JsonObject = { ...schema };
      delete component.$id;
      delete component.$schema;
      schemas[id] = component;
    }
  }
  schemas.Error = {
    type: 'object',
    properties: { error: { type: 'string' } },
    required: ['error'],
    additionalProperties: false,
  };
  return schemas;
}

// A limit as a person reads it: 102400 bytes is 100 KiB, and 67108864 is 64 MiB.
function limitText(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes / 1024} KiB`;
}

function documentedResponse(op: Operation<unknown>, status: number): JsonObject {
  const description = status === 413 ? `The body is over ${limitText(op.bodyLimit ?? DEFAULT_BODY_LIMIT)}` : (STATUS_DESCRIPTIONS[status] ?? 'An error');
  if (status !== op.status) return { description, content: { 'application/json': { schema: ref('Error') } } };
  if (status === 204) return { description };
  // A download is text, in one of the media types the operation lists.
  if (op.text) return { description, content: Object.fromEntries(op.text.mediaTypes.map((type) => [type, { schema: { type: 'string' } }])) };
  // The OpenAPI document itself has no Zod schema, so it is described as a plain object.
  let schema: JsonObject = { type: 'object' };
  if (op.response) schema = op.response.list ? { type: 'array', items: ref(op.response.name) } : ref(op.response.name);
  return { description, content: { 'application/json': { schema } } };
}

// The query parameters of an operation, one per property of its schema, from the same JSON Schema conversion the
// bodies use.
function queryParameters(op: Operation<unknown>): JsonObject[] {
  if (op.query === undefined) return [];
  const converted = z.toJSONSchema(op.query.schema, { io: 'input', target: 'draft-2020-12', unrepresentable: 'any' }) as {
    properties?: Record<string, JsonObject>;
    required?: string[];
  };
  return Object.entries(converted.properties ?? {}).map(([name, schema]) => ({
    name,
    in: 'query',
    required: converted.required?.includes(name) ?? false,
    schema,
  }));
}

function documentedOperation(op: Operation<unknown>): JsonObject {
  // 401 and 500 are possible on every operation, and 400, 413 and 415 on every body.
  const statuses = new Set([op.status, 401, 500, ...op.errors, ...(op.body ? [400, 413, 415] : [])]);
  const responses: JsonObject = {};
  for (const status of [...statuses].sort((a, b) => a - b)) responses[String(status)] = documentedResponse(op, status);

  const parameters = [
    ...[...op.path.matchAll(/:(\w+)/g)].map(([, name]) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    })),
    ...queryParameters(op),
  ];
  return {
    operationId: op.operationId,
    summary: op.summary,
    ...(op.description === undefined ? {} : { description: op.description }),
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(op.body === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            // The most bytes the body may hold; it is read only after the request is authenticated (research #2).
            'x-max-body-bytes': op.bodyLimit ?? DEFAULT_BODY_LIMIT,
            content: { 'application/json': { schema: ref(op.body.name) } },
          },
        }),
    responses,
  };
}

export function buildOpenApiDocument(): JsonObject {
  const paths: Record<string, JsonObject> = {};
  for (const op of allOperations) {
    const path = '/api/v1' + op.path.replaceAll(/:(\w+)/g, '{$1}');
    (paths[path] ??= {})[op.method] = documentedOperation(op);
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Scrylux API', version: '1' },
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: componentSchemas(),
    },
  };
}

// Built once: the operation table does not change while the process runs.
let cached: JsonObject | undefined;

const openApiOperation = defineOperation({
  method: 'get',
  path: '/openapi.json',
  operationId: 'getOpenApiDocument',
  summary: 'Get this OpenAPI document',
  status: 200,
  errors: [],
  handler: () => Promise.resolve((cached ??= buildOpenApiDocument())),
});

// Everything the router mounts: the resource operations, and the document that describes them.
export const allOperations: Operation<unknown>[] = [...resourceOperations, openApiOperation];

// `pnpm --filter @scrylux/api openapi` rewrites the committed copy. The server never reads it.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  const target = fileURLToPath(new URL('../../openapi.json', import.meta.url));
  writeFileSync(target, JSON.stringify(buildOpenApiDocument(), null, 2) + '\n');
  console.log(`Wrote ${target}`);
}
