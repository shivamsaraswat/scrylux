import { ElementRecord } from '@scrylux/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { client, seedChain, type ApiRecord, type Chain, type V1Client } from './helpers.js';

describe('/api/v1/elements (FR-001)', () => {
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

  it('creates a process with empty properties and no layout by default', async () => {
    const res = await c.post('/elements', { threat_model_id: chain.model.id, type: 'process', name: 'API' });
    expect(res.status).toBe(201);
    expect(ElementRecord.parse(res.body)).toMatchObject({
      type: 'process',
      name: 'API',
      properties: {},
      layout: null,
      source_element_id: null,
      target_element_id: null,
      parent_boundary_id: null,
    });
  });

  it('creates a data flow between two elements', async () => {
    expect(ElementRecord.parse(chain.flow)).toMatchObject({
      type: 'data_flow',
      source_element_id: chain.nodeA.id,
      target_element_id: chain.nodeB.id,
    });
    const read = await c.get(`/elements/${chain.flow.id}`);
    expect(read.status).toBe(200);
  });

  it('puts an element inside a trust boundary', async () => {
    const boundary = (
      await c.post<ApiRecord>('/elements', { threat_model_id: chain.model.id, type: 'trust_boundary', name: 'DMZ' })
    ).body;
    const node = (
      await c.post<ApiRecord>('/elements', { threat_model_id: chain.model.id, type: 'data_store', name: 'DB' })
    ).body;
    const res = await c.patch(`/elements/${node.id}`, { parent_boundary_id: boundary.id });
    expect(res.status).toBe(200);
    expect(ElementRecord.parse(res.body).parent_boundary_id).toBe(boundary.id);
  });

  it('updates properties alone without touching the layout', async () => {
    const element = (
      await c.post<ApiRecord>('/elements', {
        threat_model_id: chain.model.id,
        type: 'external_entity',
        name: 'Customer',
        layout: { x: 10, y: 20 },
      })
    ).body;
    const res = await c.patch(`/elements/${element.id}`, { properties: { flags: { authenticated: true } } });
    expect(res.status).toBe(200);
    expect(ElementRecord.parse(res.body)).toMatchObject({
      properties: { flags: { authenticated: true } },
      layout: { x: 10, y: 20 },
    });
  });

  it('deletes an element with no threats, along with the flows that used it', async () => {
    const res = await c.del(`/elements/${chain.nodeB.id}`);
    expect(res).toEqual({ status: 204, body: null });
    expect(await c.get(`/elements/${chain.nodeB.id}`)).toEqual({ status: 404, body: { error: 'Element not found' } });
    expect(await c.get(`/elements/${chain.flow.id}`)).toEqual({ status: 404, body: { error: 'Element not found' } });
  });
  describe('properties and layout follow the vocabulary (FR-017, data-model.md)', () => {
    const create = (overrides: Record<string, unknown>) =>
      c.post<{ error: string } & ApiRecord>('/elements', { threat_model_id: chain.model.id, type: 'process', name: 'V', ...overrides });

    it('stores tags and flags, keeping false distinct from an absent flag', async () => {
      const res = await create({
        type: 'data_store',
        properties: { tags: [' PostgreSQL 16 '], flags: { stores_sensitive_data: true, encrypted_at_rest: false } },
        layout: { x: 5, y: 6 },
      });
      expect(res.status).toBe(201);
      expect(ElementRecord.parse(res.body).properties).toEqual({
        tags: ['PostgreSQL 16'],
        flags: { stores_sensitive_data: true, encrypted_at_rest: false },
      });
    });

    it.each([
      ['an unknown key', { properties: { color: 'red' } }, 'properties: unknown key', 'color'],
      ['an unknown flag', { properties: { flags: { zzflag: true } } }, 'properties: unknown flag', 'zzflag'],
      ['a flag of another type', { type: 'data_store', properties: { flags: { runs_privileged: true } } }, 'properties: flag runs_privileged does not apply to data_store', undefined],
      ['a non-boolean flag', { properties: { flags: { runs_privileged: 'yes' } } }, 'each flag must be true or false', 'runs_privileged'],
      ['a flag on a trust boundary', { type: 'trust_boundary', properties: { flags: { internet_facing: true } } }, 'properties: flag internet_facing does not apply to trust_boundary', undefined],
      ['a duplicate tag', { properties: { tags: ['Nginx', 'nginx'] } }, 'properties.tags', undefined],
      ['a boundary layout on a node', { layout: { x: 1, y: 2, width: 90, height: 90 } }, 'layout: unknown key', undefined],
      ['a layout on a data flow', { type: 'data_flow', layout: { x: 1, y: 2 } }, 'layout', undefined],
      ['a layout out of range', { layout: { x: 100_001, y: 0 } }, 'layout.x', undefined],
    ])('rejects %s on create, naming the problem without echoing request input', async (_label, body, message, echoed) => {
      const res = await create(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(message);
      if (echoed) expect(res.body.error).not.toContain(echoed);
    });

    it('validates properties and layout on update, against the merged row', async () => {
      const node = (await create({ type: 'data_store', name: 'DB' })).body;
      expect((await c.patch(`/elements/${node.id}`, { properties: { flags: { runs_privileged: true } } })).status).toBe(400);
      expect((await c.patch(`/elements/${node.id}`, { layout: { x: 1, y: 2, width: 100, height: 100 } })).status).toBe(400);
      const ok = await c.patch(`/elements/${node.id}`, { properties: { flags: { encrypted_at_rest: true } } });
      expect(ok.status).toBe(200);
      // A name change leaves properties alone, and they stay valid for the type.
      const renamed = await c.patch(`/elements/${node.id}`, { name: 'DB2' });
      expect(ElementRecord.parse(renamed.body).properties).toEqual({ flags: { encrypted_at_rest: true } });
    });

    it('rejects a type change that would strand a flag, writing nothing', async () => {
      const node = (await create({ properties: { flags: { runs_privileged: true } } })).body;
      const res = await c.patch<{ error: string }>(`/elements/${node.id}`, { type: 'data_store' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('properties: flag runs_privileged does not apply to data_store');
      expect((await c.get<ApiRecord>(`/elements/${node.id}`)).body.type).toBe('process');
    });

    it('accepts a type change that sends properties valid for the new type', async () => {
      const node = (await create({ properties: { flags: { runs_privileged: true, internet_facing: true } } })).body;
      const res = await c.patch(`/elements/${node.id}`, { type: 'data_store', properties: { flags: { internet_facing: true } } });
      expect(res.status).toBe(200);
      expect(ElementRecord.parse(res.body)).toMatchObject({ type: 'data_store', properties: { flags: { internet_facing: true } } });
    });

    it('keeps linked threats linked when a node changes type', async () => {
      const node = (await create({ name: 'Linked' })).body;
      const threat = (
        await c.post<ApiRecord>('/threats', {
          threat_model_id: chain.model.id,
          element_id: node.id,
          category: 'Spoofing',
          title: 'Impersonation',
          likelihood: 'Low',
          impact: 'Low',
          origin: 'manual',
        })
      ).body;
      expect((await c.patch(`/elements/${node.id}`, { type: 'data_store' })).status).toBe(200);
      expect((await c.get<ApiRecord>(`/threats/${threat.id}`)).body.element_id).toBe(node.id);
    });

    describe('rows written before this milestone (research #3)', () => {
      async function legacy(): Promise<string> {
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO elements (threat_model_id, type, name, properties, layout) VALUES ($1, 'process', 'Legacy', $2::jsonb, $3::jsonb) RETURNING id`,
          [chain.model.id, JSON.stringify({ color: 'red' }), JSON.stringify({ anything: 1 })],
        );
        return rows[0]?.id as string;
      }

      it('are listed and fetched unchanged', async () => {
        const id = await legacy();
        const one = await c.get<ApiRecord>(`/elements/${id}`);
        expect(one.status).toBe(200);
        expect(one.body).toMatchObject({ properties: { color: 'red' }, layout: { anything: 1 } });
        const list = await c.get<ApiRecord[]>(`/threat-models/${chain.model.id}/elements`);
        expect(list.status).toBe(200);
        expect(list.body.some((e) => e.id === id)).toBe(true);
      });

      it('can be renamed and moved to a boundary without being re-validated', async () => {
        const id = await legacy();
        const res = await c.patch(`/elements/${id}`, { name: 'Renamed' });
        expect(res.status).toBe(200);
        expect(ElementRecord.parse(res.body)).toMatchObject({ name: 'Renamed', properties: { color: 'red' } });
      });

      it('are validated once their properties are written', async () => {
        const id = await legacy();
        const res = await c.patch(`/elements/${id}`, { properties: { color: 'red' } });
        expect(res.status).toBe(400);
        const fixed = await c.patch(`/elements/${id}`, { properties: { tags: ['legacy'] } });
        expect(ElementRecord.parse(fixed.body).properties).toEqual({ tags: ['legacy'] });
      });
    });
  });
});
