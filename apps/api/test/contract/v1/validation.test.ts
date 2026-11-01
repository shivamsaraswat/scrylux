import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import { resourceOperations } from '../../../src/v1/operations.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { client, seedChain, uniqueName, type ApiRecord, type Chain, type V1Client } from './helpers.js';

// The smallest request an import operation accepts, so a test can see what comes after validation.
const EMPTY_IMPORT = {
  format: 'scrylux',
  file: {
    format: 'scrylux',
    format_version: 1,
    exported_at: '2026-10-10T00:00:00.000Z',
    project: { name: 'P' },
    threat_model: { name: 'M', methodology: 'STRIDE', status: 'draft' },
    elements: [],
    threats: [],
    mitigations: [],
  },
};

// Spec Story 2: every kind of mistake gets its contract status and message, and nothing is written.
describe('rejecting invalid requests (FR-005, FR-006, FR-007, FR-009, FR-010, FR-012)', () => {
  let server: TestServer;
  let c: V1Client;
  let chain: Chain;

  beforeAll(async () => {
    server = await startTestServer(app);
    c = client(server.baseUrl, await login(server.baseUrl));
    chain = await seedChain(c);
  });

  afterAll(async () => {
    await server.close();
  });

  // What a request needs to get past validation, per resource. `list` is the record list that must
  // not grow when a create is rejected.
  const resources = {
    projects: {
      entity: 'Project',
      create: () => ({ name: uniqueName('Valid') }),
      patch: { description: 'changed' },
      id: () => chain.project.id,
      // The project list is shared with files running in parallel, so a project is "written" if one
      // with a name this file submits appears: a valid-looking name, a marker, or a blank one.
      list: () => '/projects',
      owns: (p: ApiRecord) => /^(Valid|MARKER)/.test(p.name as string) || (p.name as string).trim() === '',
    },
    'threat-models': {
      entity: 'Threat model',
      create: () => ({ project_id: chain.project.id, name: uniqueName('Valid') }),
      patch: { name: 'Changed' },
      id: () => chain.model.id,
      list: () => `/projects/${chain.project.id}/threat-models`,
    },
    elements: {
      entity: 'Element',
      create: () => ({ threat_model_id: chain.model.id, type: 'process', name: 'Valid' }),
      patch: { name: 'Changed' },
      id: () => chain.nodeA.id,
      list: () => `/threat-models/${chain.model.id}/elements`,
    },
    threats: {
      entity: 'Threat',
      create: () => ({
        threat_model_id: chain.model.id,
        category: 'Spoofing',
        title: 'Valid',
        likelihood: 'Low',
        impact: 'Low',
        origin: 'manual',
      }),
      patch: { title: 'Changed' },
      id: () => chain.threat.id,
      list: () => `/threat-models/${chain.model.id}/threats`,
    },
    mitigations: {
      entity: 'Mitigation',
      create: () => ({ threat_id: chain.threat.id, description: 'Valid' }),
      patch: { description: 'Changed' },
      id: () => chain.mitigation.id,
      list: () => `/threats/${chain.threat.id}/mitigations`,
    },
  } as const;
  type ResourceKey = keyof typeof resources;
  const keys = Object.keys(resources) as ResourceKey[];

  const resourceOf = (path: string): ResourceKey => path.split('/')[1] as ResourceKey;
  const withId = (path: string, id: string) => path.replace(':id', id);
  const sizeOf = async (key: ResourceKey) => {
    const records = (await c.get<ApiRecord[]>(resources[key].list())).body;
    const resource = resources[key];
    return ('owns' in resource ? records.filter(resource.owns) : records).length;
  };

  // Runs `rejected`, and checks it changed nothing in the list it could have written to.
  async function expectNothingWritten(key: ResourceKey, rejected: () => Promise<void>): Promise<void> {
    const before = await sizeOf(key);
    await rejected();
    expect(await sizeOf(key)).toBe(before);
  }

  it('covers every resource operation', () => {
    // 32 operations on the five records, the 5 job operations of Phase 3 Milestone 2, which jobs.test.ts covers, and the 8 source
    // operations of Milestone 3, which sources.test.ts and its siblings cover.
    expect(resourceOperations).toHaveLength(45);
  });

  describe('path ids', () => {
    it('rejects a malformed id on every operation that takes one, before any query', async () => {
      for (const op of resourceOperations.filter((o) => o.path.includes(':id'))) {
        const res = await c.raw(withId(op.path, 'not-a-uuid'), {
          method: op.method.toUpperCase(),
          body: op.method === 'post' || op.method === 'patch' ? '{}' : undefined,
        });
        expect(res, op.operationId).toEqual({ status: 400, body: { error: 'Invalid id' } });
      }
    });

    // Express decodes path parameters itself, so an id that cannot be percent-decoded fails before
    // parseId ever sees it. It is still a malformed id (FR-007), not a server error.
    it.each([
      ['get', '/projects/%zz'],
      ['patch', '/threat-models/%E0%A4%A'],
      ['delete', '/elements/%'],
      ['get', '/projects/%zz/threat-models'],
      ['get', '/threat-models/%zz/mitigations'],
    ])('rejects an id that cannot be percent-decoded: %s %s', async (method, path) => {
      const res = await c.raw(path, { method: method.toUpperCase(), body: method === 'patch' ? '{}' : undefined });
      expect(res).toEqual({ status: 400, body: { error: 'Invalid id' } });
    });

    it('answers 404, naming the entity, for a well-formed id that matches nothing', async () => {
      // The batch endpoint needs a valid body to get past validation; elements-batch.test.ts covers its 404.
      // The source operations take a file or a body of their own: their 404s are checked in sources*.test.ts.
      const sourceOperations = ['listSources', 'uploadSource', 'pasteSource', 'getSource', 'listChunks', 'retrySource', 'refreshSource', 'deleteSource'];
      const records = resourceOperations.filter((o) => o.path.includes(':id') && o.operationId !== 'batchElements' && !sourceOperations.includes(o.operationId) && keys.includes(resourceOf(o.path)));
      // A job and a source are not one of the five records: their 404s are checked in jobs.test.ts and sources*.test.ts.
      expect(
        resourceOperations
          .filter((o) => o.path.includes(':id') && !records.includes(o) && o.operationId !== 'batchElements')
          .map((o) => o.operationId)
          .sort(),
      ).toEqual(['cancelJob', 'getJob', ...sourceOperations].sort());
      for (const op of records) {
        const key = resourceOf(op.path);
        // The report and the export are asked for in a format; the id and the format are checked before the threat model is looked up.
        const formats: Record<string, string> = { getThreatModelReport: '?format=markdown', exportThreatModel: '?format=scrylux' };
        const path = `${withId(op.path, randomUUID())}${formats[op.operationId] ?? ''}`;
        // An import is checked, file included, before the project is looked up, so it needs a file that is valid.
        const isImport = op.operationId === 'checkImport' || op.operationId === 'importThreatModel';
        const res = await c.raw(path, {
          method: op.method.toUpperCase(),
          body: op.method === 'patch' ? JSON.stringify(resources[key].patch) : isImport ? JSON.stringify(EMPTY_IMPORT) : undefined,
        });
        // A child list names its parent, which is the first path segment too.
        expect(res, op.operationId).toEqual({ status: 404, body: { error: `${resources[key].entity} not found` } });
      }
    });
  });

  describe.each(keys)('%s', (key) => {
    const r = resources[key];

    it('rejects an unknown field on create, and writes nothing', async () => {
      await expectNothingWritten(key, async () => {
        const res = await c.post(`/${key}`, { ...r.create(), bogus: 1 });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: expect.stringContaining('unknown field "bogus"') as unknown });
      });
    });

    it('rejects an unknown field on update', async () => {
      const res = await c.patch(`/${key}/${r.id()}`, { ...r.patch, bogus: 1 });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.stringContaining('unknown field "bogus"') as unknown });
    });

    it('rejects an empty update', async () => {
      expect(await c.patch(`/${key}/${r.id()}`, {})).toEqual({
        status: 400,
        body: { error: 'No updatable fields provided' },
      });
    });

    it('rejects a create that is missing a required field, naming it', async () => {
      const required = Object.keys(r.create()).filter((field) => !['origin'].includes(field));
      for (const field of required) {
        await expectNothingWritten(key, async () => {
          const body: Record<string, unknown> = { ...r.create() };
          delete body[field];
          const res = await c.post<{ error: string }>(`/${key}`, body);
          expect(res.status, field).toBe(400);
          expect(res.body.error, field).toContain(field);
        });
      }
    });
  });

  describe('values outside what is allowed', () => {
    // The rejected values are markers, so a test can tell if one is ever echoed back.
    const MARKER = 'MARKER-SUBMITTED-VALUE';
    const tooLong = (limit: number) => MARKER.repeat(Math.ceil((limit + 1) / MARKER.length));

    const cases: [key: ResourceKey, field: string, value: unknown][] = [
      ['projects', 'name', tooLong(200)],
      ['projects', 'name', '   '],
      ['projects', 'description', tooLong(10_000)],
      ['threat-models', 'name', tooLong(200)],
      ['threat-models', 'methodology', MARKER],
      ['threat-models', 'status', MARKER],
      ['elements', 'name', tooLong(200)],
      ['elements', 'type', MARKER],
      ['elements', 'properties', MARKER],
      ['elements', 'properties', { MARKER }],
      ['elements', 'properties', { flags: { MARKER: true } }],
      ['elements', 'properties', { flags: { runs_privileged: MARKER } }],
      ['elements', 'layout', { x: 1, y: 2, MARKER: 3 }],
      ['threats', 'title', tooLong(200)],
      ['threats', 'category', MARKER],
      ['threats', 'likelihood', MARKER],
      ['threats', 'impact', MARKER],
      ['threats', 'status', MARKER],
      ['threats', 'library_ref', tooLong(200)],
      ['mitigations', 'description', tooLong(10_000)],
      ['mitigations', 'status', MARKER],
      ['mitigations', 'external_ref', MARKER],
    ];

    it.each(cases)('rejects %s.%s, naming the field and never echoing the value', async (key, field, value) => {
      await expectNothingWritten(key, async () => {
        const res = await c.post<{ error: string }>(`/${key}`, { ...resources[key].create(), [field]: value });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain(field);
        expect(res.body.error).not.toContain('MARKER');
      });
    });

    it('rejects the same values on update, without echoing them', async () => {
      const res = await c.patch<{ error: string }>(`/threats/${chain.threat.id}`, { category: MARKER });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('category');
      expect(res.body.error).not.toContain('MARKER');
    });
  });

  describe('threat origin (FR-009)', () => {
    const threat = (overrides: Record<string, unknown>) => ({ ...resources.threats.create(), ...overrides });

    it.each(['ai', 'rule'])('rejects a create with origin "%s"', async (origin) => {
      await expectNothingWritten('threats', async () => {
        const res = await c.post<{ error: string }>('/threats', threat({ origin }));
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('origin');
      });
    });

    it('rejects a create that leaves origin out: it has no default', async () => {
      await expectNothingWritten('threats', async () => {
        const body: Record<string, unknown> = threat({});
        delete body.origin;
        const res = await c.post<{ error: string }>('/threats', body);
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('origin');
      });
    });

    it('rejects any attempt to change origin on update', async () => {
      const res = await c.patch(`/threats/${chain.threat.id}`, { origin: 'manual' });
      expect(res).toEqual({ status: 400, body: { error: 'unknown field "origin"' } });
    });

    it('never accepts risk as input (FR-010)', async () => {
      const res = await c.post('/threats', threat({ risk: 'Low' }));
      expect(res).toEqual({ status: 400, body: { error: 'unknown field "risk"' } });
    });
  });

  describe('moving a record to another parent', () => {
    it.each([
      ['threat-models', 'project_id', () => chain.project.id],
      ['elements', 'threat_model_id', () => chain.model.id],
      ['threats', 'threat_model_id', () => chain.model.id],
      ['mitigations', 'threat_id', () => chain.threat.id],
    ] as const)('rejects %s.%s on update as an unknown field', async (key, field, value) => {
      const res = await c.patch(`/${key}/${resources[key].id()}`, { [field]: value() });
      expect(res).toEqual({ status: 400, body: { error: `unknown field "${field}"` } });
    });
  });

  describe('request bodies that are not usable', () => {
    it('answers 415, with a fixed message, for a content encoding it cannot read', async () => {
      const res = await c.raw('/projects', { method: 'POST', body: '{}', headers: { 'Content-Encoding': 'bogus' } });
      expect(res).toEqual({ status: 415, body: { error: 'Unsupported Media Type' } });
    });

    it('rejects invalid JSON', async () => {
      expect(await c.raw('/projects', { method: 'POST', body: '{"name":' })).toEqual({
        status: 400,
        body: { error: 'Invalid JSON' },
      });
    });

    it('rejects a body over 100 kb', async () => {
      const res = await c.raw('/projects', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(150_000) }) });
      expect(res).toEqual({ status: 413, body: { error: 'Payload too large' } });
    });

    it.each([
      ['an array', '[]'],
      ['a string', '"text"'],
      ['no body at all', undefined],
    ])('rejects %s where an object is expected', async (_label, body) => {
      const res = await c.raw('/projects', { method: 'POST', body });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) as unknown });
    });
  });
});

// Research #2: a v1 request is authenticated before its body is read, so a body is parsed, and sized, only for a
// signed-in account. Without it, raising an operation's body limit would make the server read large bodies for anyone.
describe('bodies are read after authentication (research #2)', () => {
  let server: TestServer;
  let token: string;

  beforeAll(async () => {
    server = await startTestServer(app);
    token = await login(server.baseUrl);
  });

  afterAll(async () => {
    await server.close();
  });

  const post = (path: string, body: string, bearer?: string) =>
    fetch(`${server.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }) },
      body,
    });

  it('answers 401, not 400, to malformed JSON without a token', async () => {
    const res = await post('/api/v1/projects', '{"name":');
    expect(res.status).toBe(401);
  });

  it('answers 401, not 413, to a body over the limit without a token', async () => {
    const res = await post('/api/v1/projects', JSON.stringify({ name: 'x'.repeat(200_000) }));
    expect(res.status).toBe(401);
  });

  it('keeps the 400 and 413 answers for a signed-in account', async () => {
    expect(await (await post('/api/v1/projects', '{"name":', token)).json()).toEqual({ error: 'Invalid JSON' });
    const big = await post('/api/v1/projects', JSON.stringify({ name: 'x'.repeat(200_000) }), token);
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'Payload too large' });
  });

  it('still reads the body of the routes outside /api/v1 first', async () => {
    const res = await post('/api/login', '{not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON' });
  });
});
