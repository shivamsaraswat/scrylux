import { randomUUID } from 'node:crypto';
import { ElementBatchResult, type ElementRecord } from '@scrylux/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { captureWriteLog, client, uniqueName, type ApiRecord, type V1Client } from './helpers.js';

// contracts/elements-batch.md §1: POST /api/v1/threat-models/{id}/elements/batch.

describe('POST /api/v1/threat-models/{id}/elements/batch (FR-020a)', () => {
  let server: TestServer;
  let token: string;
  let c: V1Client;

  beforeAll(async () => {
    server = await startTestServer(app);
    token = await login(server.baseUrl);
    c = client(server.baseUrl, token);
  });

  afterAll(async () => {
    await server.close();
  });

  // Each test works in its own project and threat model: files run in parallel on a shared database.
  async function newModel(): Promise<string> {
    const project = (await c.post<ApiRecord>('/projects', { name: uniqueName('Batch') })).body;
    return (await c.post<ApiRecord>('/threat-models', { project_id: project.id, name: 'Model' })).body.id;
  }
  const batch = (model: string, operations: unknown[]) =>
    c.post<{ error: string } & { elements: ElementRecord[]; deleted: string[] }>(`/threat-models/${model}/elements/batch`, { operations });
  const elementsOf = async (model: string) => (await c.get<ApiRecord[]>(`/threat-models/${model}/elements`)).body;
  const create = (element: Record<string, unknown>) => ({ op: 'create', element });
  const node = (name: string, extra: Record<string, unknown> = {}) => create({ type: 'process', name, ...extra });

  it('requires a token', async () => {
    const model = await newModel();
    const res = await fetch(`${server.baseUrl}/api/v1/threat-models/${model}/elements/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations: [node('A')] }),
    });
    expect(res.status).toBe(401);
  });

  it('answers 404 for a threat model that does not exist', async () => {
    const res = await batch(randomUUID(), [node('A')]);
    expect(res).toEqual({ status: 404, body: { error: 'Threat model not found' } });
  });

  it('answers 400 for a malformed id', async () => {
    const res = await c.post('/threat-models/not-a-uuid/elements/batch', { operations: [node('A')] });
    expect(res).toEqual({ status: 400, body: { error: 'Invalid id' } });
  });

  describe('the request body', () => {
    it.each([
      ['no operations', []],
      ['201 operations', Array.from({ length: 201 }, (_, i) => node(`n${i}`))],
    ])('rejects %s', async (_label, operations) => {
      const model = await newModel();
      const res = await batch(model, operations);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('operations');
      expect(res.body.error).toContain('must have 1 to 200 items');
      expect(await elementsOf(model)).toHaveLength(0);
    });

    it('accepts 200 operations', async () => {
      const model = await newModel();
      const res = await batch(model, Array.from({ length: 200 }, (_, i) => node(`n${i}`)));
      expect(res.status).toBe(200);
      expect(res.body.elements).toHaveLength(200);
    });

    it('rejects an unknown op and a create that carries threat_model_id', async () => {
      const model = await newModel();
      expect((await batch(model, [{ op: 'move', id: randomUUID() }])).status).toBe(400);
      expect((await batch(model, [create({ type: 'process', name: 'A', threat_model_id: model })])).status).toBe(400);
    });

    it('rejects properties outside the vocabulary, naming the operation and applying nothing', async () => {
      const model = await newModel();
      const res = await batch(model, [node('Fine'), create({ type: 'data_store', name: 'DB', properties: { flags: { runs_privileged: true } } })]);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('operations.1');
      expect(await elementsOf(model)).toHaveLength(0);
    });
  });

  describe('applying operations', () => {
    it('applies them in order, so a flow can refer to nodes created earlier in the same batch', async () => {
      const model = await newModel();
      const a = randomUUID();
      const b = randomUUID();
      const res = await batch(model, [
        node('A', { id: a, layout: { x: 0, y: 0 } }),
        node('B', { id: b, layout: { x: 300, y: 0 } }),
        create({ type: 'data_flow', name: 'A to B', source_element_id: a, target_element_id: b }),
      ]);
      expect(res.status).toBe(200);
      const parsed = ElementBatchResult.parse(res.body);
      expect(parsed.elements.map((e) => e.name).sort()).toEqual(['A', 'A to B', 'B']);
      expect(parsed.elements.find((e) => e.name === 'A')?.id).toBe(a);
      expect(parsed.deleted).toEqual([]);
    });

    it('lists each touched element once, in its final state, and the deleted ids', async () => {
      const model = await newModel();
      const keep = randomUUID();
      const gone = (await c.post<ApiRecord>('/elements', { threat_model_id: model, type: 'process', name: 'Gone' })).body.id;
      const res = await batch(model, [
        node('Draft', { id: keep }),
        { op: 'update', id: keep, changes: { name: 'Final', layout: { x: 7, y: 8 } } },
        { op: 'delete', id: gone },
      ]);
      expect(res.status).toBe(200);
      expect(res.body.elements).toHaveLength(1);
      expect(res.body.elements[0]).toMatchObject({ id: keep, name: 'Final', layout: { x: 7, y: 8 } });
      expect(res.body.deleted).toEqual([gone]);
      expect((await elementsOf(model)).map((e) => e.name)).toEqual(['Final']);
    });

    it('uses a client-generated id, and answers 409 when that id is taken', async () => {
      const model = await newModel();
      const id = randomUUID();
      expect((await batch(model, [node('First', { id })])).body.elements[0]?.id).toBe(id);

      const again = await batch(model, [node('Second', { id })]);
      expect(again).toEqual({ status: 409, body: { error: 'Operation 0: An element with this id already exists' } });
      expect(await elementsOf(model)).toHaveLength(1);
    });
  });

  describe('all or nothing', () => {
    it('rolls everything back when the last operation breaks a database rule, naming its position', async () => {
      const model = await newModel();
      const a = randomUUID();
      const res = await batch(model, [
        node('Kept?', { id: a }),
        node('Also kept?'),
        create({ type: 'data_flow', name: 'Loop', source_element_id: a, target_element_id: a }),
      ]);
      expect(res).toEqual({ status: 400, body: { error: 'Operation 2: A data flow cannot start and end at the same element' } });
      expect(await elementsOf(model)).toHaveLength(0);
    });

    it('rolls back an update and a delete that came before a failure', async () => {
      const model = await newModel();
      const one = (await c.post<ApiRecord>('/elements', { threat_model_id: model, type: 'process', name: 'One' })).body.id;
      const two = (await c.post<ApiRecord>('/elements', { threat_model_id: model, type: 'process', name: 'Two' })).body.id;
      const res = await batch(model, [
        { op: 'update', id: one, changes: { name: 'Changed' } },
        { op: 'delete', id: two },
        { op: 'update', id: randomUUID(), changes: { name: 'Nobody' } },
      ]);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Operation 2: Element not found');
      expect((await elementsOf(model)).map((e) => e.name).sort()).toEqual(['One', 'Two']);
    });

    it('validates an update against the merged row, naming its position', async () => {
      const model = await newModel();
      const id = (await c.post<ApiRecord>('/elements', { threat_model_id: model, type: 'process', name: 'P', properties: { flags: { runs_privileged: true } } })).body.id;
      const res = await batch(model, [{ op: 'update', id, changes: { type: 'data_store' } }]);
      expect(res).toEqual({ status: 400, body: { error: 'Operation 0: properties: flag runs_privileged does not apply to data_store' } });
    });
  });

  describe('scope: an element of another threat model is never touched', () => {
    it.each([
      ['update', (id: string) => ({ op: 'update', id, changes: { name: 'Hijacked' } })],
      ['delete', (id: string) => ({ op: 'delete', id })],
    ])('answers 404 for a %s of it', async (_label, op) => {
      const mine = await newModel();
      const theirs = await newModel();
      const foreign = (await c.post<ApiRecord>('/elements', { threat_model_id: theirs, type: 'process', name: 'Theirs' })).body.id;

      const res = await batch(mine, [op(foreign)]);
      expect(res).toEqual({ status: 404, body: { error: 'Operation 0: Element not found' } });
      expect((await elementsOf(theirs)).map((e) => e.name)).toEqual(['Theirs']);
    });
  });

  describe('threats', () => {
    it('answers 409 when a delete would orphan a threat, applying nothing', async () => {
      const model = await newModel();
      const target = (await c.post<ApiRecord>('/elements', { threat_model_id: model, type: 'process', name: 'Target' })).body.id;
      await c.post('/threats', {
        threat_model_id: model, element_id: target, category: 'Tampering', title: 'T', likelihood: 'Low', impact: 'Low', origin: 'manual',
      });
      const res = await batch(model, [node('New one'), { op: 'delete', id: target }]);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/^Operation 1: This element still has threats/);
      expect(await elementsOf(model)).toHaveLength(1);
    });
  });

  describe('the element limit (FR-001a)', () => {
    it('rejects a batch that would cross 1,000, naming the operation and applying nothing', async () => {
      const model = await newModel();
      await db.query(
        `INSERT INTO elements (threat_model_id, type, name) SELECT $1, 'process', 'p' || g FROM generate_series(1, 999) g`,
        [model],
      );
      const res = await batch(model, [node('Fits'), node('Does not fit')]);
      expect(res).toEqual({ status: 400, body: { error: 'Operation 1: A threat model can hold at most 1,000 elements' } });
      expect(await elementsOf(model)).toHaveLength(999);
    });
  });

  describe('locking (research #6)', () => {
    it('completes a batch that runs in parallel with a boundary re-parent on the same model', async () => {
      const model = await newModel();
      const outer = (await c.post<ApiRecord>('/elements', { threat_model_id: model, type: 'trust_boundary', name: 'Outer' })).body.id;
      const inner = (await c.post<ApiRecord>('/elements', { threat_model_id: model, type: 'trust_boundary', name: 'Inner' })).body.id;

      const rounds = await Promise.all(
        Array.from({ length: 6 }, (_, round) => [
          batch(model, Array.from({ length: 20 }, (_, i) => node(`r${round}-${i}`))),
          c.patch(`/elements/${inner}`, { parent_boundary_id: round % 2 === 0 ? outer : null }),
        ]).flat(),
      );
      expect(rounds.map((r) => r.status)).toEqual(Array(12).fill(200));
      expect(await elementsOf(model)).toHaveLength(2 + 6 * 20);
    });
  });
  describe('deleting a trust boundary (FR-022)', () => {
    // outer (100,50) holds inner (20,30, 300x200), which holds a node (10,10); and a node (40,60) straight in outer.
    async function nested() {
      const model = await newModel();
      const ids = { outer: randomUUID(), inner: randomUUID(), deep: randomUUID(), direct: randomUUID(), bare: randomUUID() };
      await batch(model, [
        create({ id: ids.outer, type: 'trust_boundary', name: 'Outer', layout: { x: 100, y: 50, width: 800, height: 600 } }),
        create({ id: ids.inner, type: 'trust_boundary', name: 'Inner', layout: { x: 20, y: 30, width: 300, height: 200 }, parent_boundary_id: ids.outer }),
        node('Deep', { id: ids.deep, layout: { x: 10, y: 10 }, parent_boundary_id: ids.inner }),
        node('Direct', { id: ids.direct, layout: { x: 40, y: 60 }, parent_boundary_id: ids.outer }),
        node('Bare', { id: ids.bare }),
      ]);
      const byId = async () => new Map((await elementsOf(model)).map((e) => [e.id, e]));
      return { model, ids, byId };
    }

    it('moves its members up to its own parent, keeping their place on the diagram', async () => {
      const { model, ids, byId } = await nested();
      const res = await batch(model, [{ op: 'delete', id: ids.inner }]);
      expect(res.status).toBe(200);
      const after = await byId();
      expect(after.has(ids.inner)).toBe(false);
      expect(after.get(ids.deep)).toMatchObject({ parent_boundary_id: ids.outer, layout: { x: 30, y: 40 } });
      // The response lists the members it moved, and the deleted id.
      expect(res.body.elements.map((e) => e.id)).toEqual([ids.deep]);
      expect(res.body.deleted).toEqual([ids.inner]);
    });

    it('moves the members of a top-level boundary to the top level, in diagram coordinates', async () => {
      const { model, ids, byId } = await nested();
      await batch(model, [{ op: 'delete', id: ids.outer }]);
      const after = await byId();
      expect(after.get(ids.direct)).toMatchObject({ parent_boundary_id: null, layout: { x: 140, y: 110 } });
      // The nested boundary is a member too, and keeps its own members.
      expect(after.get(ids.inner)).toMatchObject({ parent_boundary_id: null, layout: { x: 120, y: 80, width: 300, height: 200 } });
      expect(after.get(ids.deep)).toMatchObject({ parent_boundary_id: ids.inner, layout: { x: 10, y: 10 } });
    });

    it('leaves a member that has no layout without one', async () => {
      const model = await newModel();
      const outer = randomUUID();
      const bare = randomUUID();
      await batch(model, [create({ id: outer, type: 'trust_boundary', name: 'B', layout: { x: 5, y: 5, width: 100, height: 100 } }), node('Bare', { id: bare, parent_boundary_id: outer })]);
      await batch(model, [{ op: 'delete', id: outer }]);
      const member = (await elementsOf(model)).find((e) => e.id === bare);
      expect(member).toMatchObject({ parent_boundary_id: null, layout: null });
    });

    it('logs one update per member and one delete, through the batch and the single endpoint alike', async () => {
      const viaBatch = await nested();
      const viaSingle = await nested();

      const log = captureWriteLog();
      try {
        await batch(viaBatch.model, [{ op: 'delete', id: viaBatch.ids.inner }]);
        expect(log.lines().map(({ action, id }) => `${action} ${id}`).sort()).toEqual(
          [`delete ${viaBatch.ids.inner}`, `update ${viaBatch.ids.deep}`].sort(),
        );
      } finally {
        log.restore();
      }

      const single = captureWriteLog();
      try {
        expect((await c.del(`/elements/${viaSingle.ids.inner}`)).status).toBe(204);
        expect((await viaSingle.byId()).get(viaSingle.ids.deep)).toMatchObject({ parent_boundary_id: viaSingle.ids.outer, layout: { x: 30, y: 40 } });
        expect(single.lines().map(({ action, id }) => `${action} ${id}`).sort()).toEqual(
          [`delete ${viaSingle.ids.inner}`, `update ${viaSingle.ids.deep}`].sort(),
        );
      } finally {
        single.restore();
      }
    });
  });
});
