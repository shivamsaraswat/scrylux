import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Validator } from '@seriousme/openapi-schema-validator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import { LIST_ORDER_DESCRIPTION } from '../../../src/v1/operation.js';
import { allOperations, buildOpenApiDocument } from '../../../src/v1/openapi.js';
import { login, startTestServer, type TestServer } from '../helpers.js';

// The OpenAPI document is generated from the same operation table the router mounts (research #3).
// A generic validator cannot see most of what matters here, so these checks pin the rest.

// contracts/v1-api.md, "Operations".
const OPERATION_IDS = [
  'listProjects',
  'createProject',
  'getProject',
  'updateProject',
  'deleteProject',
  'listProjectThreatModels',
  'createThreatModel',
  'getThreatModel',
  'updateThreatModel',
  'deleteThreatModel',
  'listThreatModelElements',
  'listThreatModelThreats',
  'listThreatModelMitigations',
  'getThreatModelReport',
  'exportThreatModel',
  'checkImport',
  'importThreatModel',
  'createElement',
  'getElement',
  'updateElement',
  'deleteElement',
  'batchElements',
  'generateThreats',
  'createThreat',
  'getThreat',
  'updateThreat',
  'deleteThreat',
  'listThreatMitigations',
  'createMitigation',
  'getMitigation',
  'updateMitigation',
  'deleteMitigation',
  // Phase 3 Milestone 2, contracts/http-api.md.
  'getJobsStatus',
  'listJobs',
  'createJob',
  'getJob',
  'cancelJob',
  'getOpenApiDocument',
];
const METHODS = ['get', 'post', 'patch', 'delete'] as const;

interface OperationObject {
  operationId: string;
  description?: string;
  parameters?: { name: string; in: string; required: boolean; schema: Record<string, unknown> }[];
  requestBody?: unknown;
  responses: Record<string, { description?: string; content?: Record<string, { schema: unknown }> }>;
}

// Only what these tests read. The document is compared as plain JSON, as a client would receive it.
interface OpenApiDocument {
  openapi: string;
  security: unknown;
  paths: Record<string, Partial<Record<(typeof METHODS)[number], OperationObject>>>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, { properties?: Record<string, { maxLength?: number }> }>;
  };
}

const doc = (): OpenApiDocument => JSON.parse(JSON.stringify(buildOpenApiDocument())) as OpenApiDocument;

function operationsOf(document: OpenApiDocument): { path: string; method: string; op: OperationObject }[] {
  const found: { path: string; method: string; op: OperationObject }[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (op) found.push({ path, method, op });
    }
  }
  return found;
}

// Every value in the document, with the key path that leads to it.
function walk(value: unknown, visit: (value: unknown, path: string[]) => void, path: string[] = []): void {
  visit(value, path);
  if (Array.isArray(value)) value.forEach((item, i) => walk(item, visit, [...path, String(i)]));
  else if (typeof value === 'object' && value !== null)
    for (const [key, child] of Object.entries(value)) walk(child, visit, [...path, key]);
}

function resolvePointer(root: unknown, ref: string): boolean {
  if (!ref.startsWith('#/')) return false;
  let node: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, key)) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return true;
}

describe('the generated OpenAPI document (FR-020, FR-021, SC-006)', () => {
  it('is valid OpenAPI 3.1', async () => {
    const document = doc();
    expect(document.openapi).toBe('3.1.0');
    const result = await new Validator().validate(document as never);
    expect(result.valid, JSON.stringify(result.valid ? [] : result.errors, null, 2)).toBe(true);
  });

  it('has a reference for every schema it points at: each $ref resolves from the document root', () => {
    const document = doc();
    const refs: string[] = [];
    walk(document, (value) => {
      if (typeof value === 'object' && value !== null && '$ref' in value) refs.push(String(value.$ref));
    });
    expect(refs.length).toBeGreaterThan(0);
    const unresolved = [...new Set(refs)].filter((ref) => !resolvePointer(document, ref));
    expect(unresolved).toEqual([]);
  });

  it('contains no empty schema: nothing Zod could not represent was silently turned into {}', () => {
    const empty: string[] = [];
    walk(doc(), (value, path) => {
      const isEmptyObject = typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
      // A default or an example is data, and {} is a legitimate value for one.
      const pointer = '/' + path.join('/');
      // ThreatGenerationInput is deliberately the empty object (it takes no options), so its `properties` is {}.
      // The `file` of an import is deliberately any JSON object: it is bounded and then parsed by the format's own schema
      // (research #6), so what its members may hold is {}.
      // A provider check takes no input (Phase 3 Milestone 2, FR-093), so the input of JobCreateInput is deliberately the empty object.
      const intended =
        pointer === '/components/schemas/ThreatGenerationInput/properties' ||
        pointer === '/components/schemas/ImportInput/properties/file/additionalProperties' ||
        pointer === '/components/schemas/JobCreateInput/oneOf/0/properties/input/properties';
      if (isEmptyObject && !intended && !path.includes('default') && !path.includes('example')) empty.push(pointer);
    });
    expect(empty).toEqual([]);
  });

  describe('what a generic validator cannot see', () => {
    it('carries the input length limits', () => {
      expect(doc().components.schemas.ProjectCreateInput?.properties?.name?.maxLength).toBe(200);
    });

    it('declares bearer authentication for every operation, so generated clients send the token', () => {
      const document = doc();
      expect(document.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
      expect(document.security).toEqual([{ bearerAuth: [] }]);
    });

    it('writes every path in full, under /api/v1/', () => {
      for (const { path } of operationsOf(doc())) expect(path.startsWith('/api/v1/'), path).toBe(true);
    });

    it('describes exactly the operations of the contract', () => {
      const ids = operationsOf(doc()).map(({ op }) => op.operationId);
      expect(ids.sort()).toEqual([...OPERATION_IDS].sort());
    });

    it('states the order of each of the 6 lists (FR-003)', () => {
      // The jobs list states its own order (Phase 3 Milestone 2).
      const lists = operationsOf(doc()).filter(({ op }) => op.operationId.startsWith('list') && op.operationId !== 'listJobs');
      expect(lists).toHaveLength(6);
      for (const { op } of lists) expect(op.description, op.operationId).toBe(LIST_ORDER_DESCRIPTION);
    });

    it('documents 401 and 500 on every operation, and 400, 413 and 415 where there is a body', () => {
      for (const { op } of operationsOf(doc())) {
        const statuses = Object.keys(op.responses);
        expect(statuses, op.operationId).toEqual(expect.arrayContaining(['401', '500']));
        if (op.requestBody) expect(statuses, op.operationId).toEqual(expect.arrayContaining(['400', '413', '415']));
      }
    });

    it('documents batchElements with its body, its result and its errors (contracts/elements-batch.md)', () => {
      const document = doc();
      const path = document.paths['/api/v1/threat-models/{id}/elements/batch'];
      const op = path?.post;
      expect(op?.operationId).toBe('batchElements');
      expect(op?.requestBody).toBeDefined();
      expect(Object.keys(op?.responses ?? {})).toEqual(expect.arrayContaining(['200', '400', '401', '404', '409', '413', '500']));
      expect(document.components.schemas.ElementBatchInput).toBeDefined();
      expect(document.components.schemas.ElementBatchResult).toBeDefined();
      expect(op?.description).toContain('all or none');
      expect(op?.description).toContain('200');
    });

    it('documents getThreatModelReport with its format parameter, its text content and its errors (contracts/report-api.md)', () => {
      const op = doc().paths['/api/v1/threat-models/{id}/report']?.get;
      expect(op?.operationId).toBe('getThreatModelReport');
      expect(op?.requestBody).toBeUndefined();
      expect(op?.parameters?.map((p) => [p.name, p.in, p.required])).toEqual([
        ['id', 'path', true],
        ['format', 'query', true],
      ]);
      expect(op?.parameters?.[1]?.schema).toMatchObject({ type: 'string', enum: ['markdown', 'html'] });
      expect(Object.keys(op?.responses ?? {}).sort()).toEqual(['200', '400', '401', '404', '500']);
      expect(op?.responses['200']?.content).toEqual({ 'text/markdown': { schema: { type: 'string' } }, 'text/html': { schema: { type: 'string' } } });
      expect(op?.responses['404']?.content).toHaveProperty('application/json');
      expect(op?.description).toContain('attachment');
    });

    it('documents exportThreatModel with its format parameter, its JSON attachment and its errors (contracts/exchange-api.md)', () => {
      const op = doc().paths['/api/v1/threat-models/{id}/export']?.get;
      expect(op?.operationId).toBe('exportThreatModel');
      expect(op?.requestBody).toBeUndefined();
      expect(op?.parameters?.map((p) => [p.name, p.in, p.required])).toEqual([
        ['id', 'path', true],
        ['format', 'query', true],
      ]);
      expect(op?.parameters?.[1]?.schema).toMatchObject({ type: 'string', enum: ['scrylux', 'otm'] });
      expect(Object.keys(op?.responses ?? {}).sort()).toEqual(['200', '400', '401', '404', '500']);
      expect(op?.responses['200']?.content).toEqual({ 'application/json': { schema: { type: 'string' } } });
      expect(op?.description).toContain('attachment');
    });

    it('documents checkImport and importThreatModel with their body, their limit and their errors (contracts/exchange-api.md)', () => {
      const document = doc();
      const check = document.paths['/api/v1/projects/{id}/imports/check']?.post;
      const run = document.paths['/api/v1/projects/{id}/imports']?.post;
      expect(check?.operationId).toBe('checkImport');
      expect(run?.operationId).toBe('importThreatModel');
      expect(Object.keys(check?.responses ?? {}).sort()).toEqual(['200', '400', '401', '404', '413', '415', '500']);
      expect(Object.keys(run?.responses ?? {}).sort()).toEqual(['201', '400', '401', '404', '409', '413', '415', '500']);
      expect(document.components.schemas.ImportInput).toBeDefined();
      expect(document.components.schemas.ImportSummary).toBeDefined();
      expect(document.components.schemas.ImportResult).toBeDefined();
      expect(run?.description).toContain('all or nothing');
      expect(check?.description).toContain('creates nothing');
    });

    it('states the size limit of every request body as x-max-body-bytes, and in its 413 (research #2)', () => {
      for (const { op } of operationsOf(doc())) {
        if (!op.requestBody) continue;
        const isImport = op.operationId === 'checkImport' || op.operationId === 'importThreatModel';
        const limit = (op.requestBody as Record<string, unknown>)['x-max-body-bytes'];
        expect(limit, op.operationId).toBe(isImport ? 67_108_864 : 102_400);
        expect((op.responses['413'] as { description?: string }).description, op.operationId).toBe(
          isImport ? 'The body is over 64 MiB' : 'The body is over 100 KiB',
        );
      }
    });

    it('documents a query parameter on no other operation', () => {
      for (const { op } of operationsOf(doc())) {
        const inQuery = (op.parameters ?? []).filter((p) => p.in === 'query');
        if (!['getThreatModelReport', 'exportThreatModel', 'listJobs'].includes(op.operationId)) expect(inQuery, op.operationId).toEqual([]);
      }
    });

    it('documents the job operations with their query, their body, their errors and no key or address (Phase 3 Milestone 2, contracts/http-api.md)', () => {
      const document = doc();
      const list = document.paths['/api/v1/jobs']?.get;
      expect(list?.parameters?.map((p) => [p.name, p.in, p.required])).toEqual([
        ['limit', 'query', false],
        ['offset', 'query', false],
      ]);
      expect(list?.parameters?.[0]?.schema).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
      expect(list?.parameters?.[1]?.schema).toMatchObject({ type: 'integer', minimum: 0 });
      expect(Object.keys(list?.responses ?? {}).sort()).toEqual(['200', '400', '401', '500']);
      expect(Object.keys(document.paths['/api/v1/jobs']?.post?.responses ?? {}).sort()).toEqual(['201', '400', '401', '409', '413', '415', '429', '500']);
      expect(document.paths['/api/v1/jobs/status']?.get?.operationId).toBe('getJobsStatus');
      expect(Object.keys(document.paths['/api/v1/jobs/{id}']?.get?.responses ?? {}).sort()).toEqual(['200', '400', '401', '404', '500']);
      for (const name of ['JobsStatus', 'JobRecord', 'JobDetail', 'JobList', 'JobCreateInput']) expect(document.components.schemas[name], name).toBeDefined();
      // The records can hold neither a key nor an address (FR-051, FR-091).
      expect(JSON.stringify([document.components.schemas.JobsStatus, document.components.schemas.JobDetail])).not.toMatch(/api_key|base_url|apiKey|baseUrl/);
    });

    it('documents generateThreats with its {} body, its counts and its errors (contracts/generate-threats-api.md)', () => {
      const document = doc();
      const op = document.paths['/api/v1/threat-models/{id}/threats/generate']?.post;
      expect(op?.operationId).toBe('generateThreats');
      expect(op?.requestBody).toBeDefined();
      expect(Object.keys(op?.responses ?? {})).toEqual(expect.arrayContaining(['200', '400', '401', '404', '413', '415', '500']));
      expect(document.components.schemas.ThreatGenerationInput).toBeDefined();
      expect(document.components.schemas.ThreatGenerationResult).toBeDefined();
      expect(op?.description).toContain('all or nothing');
    });

    it('documents the read-only stale field of a threat record and its reasons (finding E3)', () => {
      const document = doc();
      expect(document.components.schemas.ThreatRecord?.properties?.stale).toBeDefined();
      const text = JSON.stringify(document.components.schemas.ThreatRecord);
      expect(text).toContain('conditions_unmet');
      expect(text).toContain('rule_retired');
      expect(text).toContain('rule_unknown');
    });

    // The generated schema cannot show a conditional rule, so the rules are in the descriptions (research #2).
    it('documents the threat lifecycle: status_reason on the record, and the rules and the 409 on the operations (Phase 2 M4)', () => {
      const document = doc();
      expect(document.components.schemas.ThreatRecord?.properties?.status_reason).toBeDefined();
      expect(document.components.schemas.ThreatCreateInput?.properties?.status_reason).toBeDefined();
      expect(document.components.schemas.ThreatUpdateInput?.properties?.status_reason).toBeDefined();

      const create = document.paths['/api/v1/threats']?.post;
      expect(create?.description).toContain('status_reason is required when status is accepted or not_applicable');
      expect(create?.description).toContain('created as mitigated');

      const update = document.paths['/api/v1/threats/{id}']?.patch;
      expect(Object.keys(update?.responses ?? {})).toEqual(expect.arrayContaining(['200', '400', '404', '409']));
      expect(update?.description).toContain('implemented or verified (409 otherwise)');
      expect(update?.description).toContain('status_reason');
    });

    it('leaves the statuses of mitigations and threat models free: no 409 on their updates', () => {
      const document = doc();
      expect(Object.keys(document.paths['/api/v1/mitigations/{id}']?.patch?.responses ?? {})).not.toContain('409');
      expect(document.paths['/api/v1/mitigations/{id}']?.patch?.description).toContain('Any status can be set at any time');
    });

    it('states the coordinate frame of layout and the vocabulary of properties', () => {
      const text = JSON.stringify(doc().components.schemas.ElementCreateInput);
      expect(text).toContain('relative to the parent boundary');
      expect(text).toContain('not assessed');
    });

    it('documents every operation the router mounts, under the same id', () => {
      const documented = new Map(operationsOf(doc()).map(({ path, method, op }) => [`${method} ${path}`, op.operationId]));
      for (const op of allOperations) {
        const path = '/api/v1' + op.path.replaceAll(/:(\w+)/g, '{$1}');
        expect(documented.get(`${op.method} ${path}`), op.operationId).toBe(op.operationId);
      }
      expect(allOperations).toHaveLength(OPERATION_IDS.length);
    });
  });

  it('matches the committed apps/api/openapi.json', () => {
    const committed: unknown = JSON.parse(readFileSync(new URL('../../../openapi.json', import.meta.url), 'utf8'));
    expect(committed, 'apps/api/openapi.json is out of date. Run: pnpm --filter @scrylux/api openapi').toEqual(doc());
  });
});

describe('the document and the server (FR-004, FR-021)', () => {
  let server: TestServer;
  let token: string;

  beforeAll(async () => {
    server = await startTestServer(app);
    token = await login(server.baseUrl);
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves every documented operation: none answers with the catch-all 404', async () => {
    for (const { path, method, op } of operationsOf(doc())) {
      const res = await fetch(`${server.baseUrl}${path.replace('{id}', randomUUID())}`, {
        method: method.toUpperCase(),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: method === 'post' || method === 'patch' ? '{}' : undefined,
      });
      const text = await res.text();
      const body = text ? (JSON.parse(text) as { error?: string }) : {};
      expect(res.status === 404 && body.error === 'Not found', `${op.operationId} is documented but not served`).toBe(false);
    }
  });

  it('requires a token to read the document', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/openapi.json`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Authentication required' });
  });

  it('serves the same document that is committed, to a signed-in client', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/openapi.json`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual(doc());
  });
});
