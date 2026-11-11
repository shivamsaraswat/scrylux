import { randomUUID } from 'node:crypto';
import { AssetRecord } from '@scrylux/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { captureWriteLog, client, seedChain, type ApiRecord, type Chain, type V1Client } from './helpers.js';

// Assets, a kind of threat-model record (Phase 3 Milestone 5, US5; FR-006, FR-020 to FR-022): list, create, edit and delete, every status of
// contracts/http-api.md, with the write log's one line per write and no text in it.

describe('/api/v1 assets', () => {
  let server: TestServer;
  let c: V1Client;
  let chain: Chain;
  let log: ReturnType<typeof captureWriteLog>;

  beforeAll(async () => {
    server = await startTestServer(app);
    c = client(server.baseUrl, await login(server.baseUrl));
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    chain = await seedChain(c);
    log = captureWriteLog();
  });
  afterEach(() => log.restore());

  const model = () => chain.model.id;
  const create = (body: Record<string, unknown>, threatModel = model()) => c.post<ApiRecord>(`/threat-models/${threatModel}/assets`, body);
  const asset = async (name: string, extra: Record<string, unknown> = {}): Promise<ApiRecord> => {
    const res = await create({ name, description: `About ${name}.`, ...extra });
    expect(res.status).toBe(201);
    return res.body;
  };

  describe('POST /threat-models/{id}/assets', () => {
    it('creates an asset with no holders by default, and with the elements that hold it', async () => {
      const plain = AssetRecord.parse(await asset('Session tokens'));
      expect(plain).toMatchObject({ name: 'Session tokens', description: 'About Session tokens.', holder_ids: [], threat_model_id: model() });
      const held = AssetRecord.parse(await asset('Notes', { holder_ids: [chain.nodeA.id, chain.nodeB.id] }));
      expect([...held.holder_ids].sort()).toEqual([chain.nodeA.id, chain.nodeB.id].sort());
    });

    it('writes one log line with ids only: the account, the action, the type and the id', async () => {
      const created = await asset('Secret asset name');
      const lines = log.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: 'write', action: 'create', type: 'asset', id: created.id });
      expect(log.raw().join('\n')).not.toContain('Secret asset name');
    });

    it('refuses a name that repeats another’s, ignoring case and surrounding whitespace, with a fixed message', async () => {
      await asset('Session tokens');
      const repeat = await create({ name: '  SESSION tokens ', description: 'x' });
      expect(repeat).toEqual({ status: 409, body: { error: 'An asset with this name already exists' } });
      expect((await create({ name: 'Session tokens', description: 'x' }, (await seedChain(c)).model.id)).status).toBe(201);
    });

    it('refuses a holder that is a data flow or a trust boundary, or of another threat model', async () => {
      const zone = (await c.post<ApiRecord>('/elements', { threat_model_id: model(), type: 'trust_boundary', name: 'Zone' })).body;
      const holderRule = { status: 400, body: { error: 'A holder must be a process, a data store or an external entity' } };
      expect(await create({ name: 'A', description: 'd', holder_ids: [chain.flow.id] })).toEqual(holderRule);
      expect(await create({ name: 'B', description: 'd', holder_ids: [zone.id] })).toEqual(holderRule);
      const other = await seedChain(c);
      expect(await create({ name: 'C', description: 'd', holder_ids: [other.nodeA.id] })).toEqual({ status: 400, body: { error: 'holder_ids must refer to elements in the same threat model' } });
      expect((await c.get<unknown[]>(`/threat-models/${model()}/assets`)).body).toEqual([]);
    });

    it('refuses the 201st asset', async () => {
      await db.query(`INSERT INTO assets (threat_model_id, name, description) SELECT $1, 'asset ' || n, 'text' FROM generate_series(1, 200) AS n`, [model()]);
      expect(await create({ name: 'one too many', description: 'd' })).toEqual({ status: 400, body: { error: 'A threat model can hold at most 200 assets' } });
    });

    it('refuses a body that does not match, including provenance and a threat model id, and answers 404 for an unknown threat model', async () => {
      for (const body of [{}, { name: 'n' }, { description: 'd' }, { name: ' ', description: 'd' }, { name: 'n', description: 'd', provenance: {} }, { name: 'n', description: 'd', threat_model_id: model() }, { name: 'n', description: 'd', holder_ids: ['x'] }]) {
        expect((await create(body)).status, JSON.stringify(body)).toBe(400);
      }
      expect(await create({ name: 'n', description: 'd' }, randomUUID())).toEqual({ status: 404, body: { error: 'Threat model not found' } });
      expect((await c.post('/threat-models/not-a-uuid/assets', { name: 'n', description: 'd' })).status).toBe(400);
    });
  });

  describe('GET /threat-models/{id}/assets', () => {
    it('lists the threat model’s assets, oldest first, with their holders', async () => {
      const first = await asset('First', { holder_ids: [chain.nodeA.id] });
      const second = await asset('Second');
      await create({ name: 'Elsewhere', description: 'd' }, (await seedChain(c)).model.id);
      const res = await c.get<unknown[]>(`/threat-models/${model()}/assets`);
      expect(res.status).toBe(200);
      const list = AssetRecord.array().parse(res.body);
      expect(list.map((a) => a.id)).toEqual([first.id, second.id]);
      expect(list[0]?.holder_ids).toEqual([chain.nodeA.id]);
    });

    it('answers 404 for an unknown threat model', async () => {
      expect((await c.get(`/threat-models/${randomUUID()}/assets`)).status).toBe(404);
    });
  });

  describe('PATCH /assets/{id}', () => {
    it('changes the fields sent, replaces the holders, and leaves the rest', async () => {
      const created = await asset('Tokens', { holder_ids: [chain.nodeA.id] });
      const renamed = await c.patch<ApiRecord>(`/assets/${created.id}`, { name: 'Auth tokens' });
      expect(AssetRecord.parse(renamed.body)).toMatchObject({ name: 'Auth tokens', description: 'About Tokens.', holder_ids: [chain.nodeA.id] });
      const moved = await c.patch<ApiRecord>(`/assets/${created.id}`, { holder_ids: [chain.nodeB.id] });
      expect(AssetRecord.parse(moved.body).holder_ids).toEqual([chain.nodeB.id]);
      const cleared = await c.patch<ApiRecord>(`/assets/${created.id}`, { holder_ids: [] });
      expect(AssetRecord.parse(cleared.body).holder_ids).toEqual([]);
      expect(log.lines().map((line) => line.action)).toEqual(['create', 'update', 'update', 'update']);
    });

    it('refuses an empty body, an unknown key and provenance, a repeated name and a holder that cannot hold', async () => {
      const created = await asset('Tokens');
      const other = await asset('Other');
      expect((await c.patch(`/assets/${created.id}`, {})).status).toBe(400);
      expect((await c.patch(`/assets/${created.id}`, { provenance: null })).status).toBe(400);
      expect(await c.patch(`/assets/${created.id}`, { name: other.name })).toEqual({ status: 409, body: { error: 'An asset with this name already exists' } });
      expect((await c.patch(`/assets/${created.id}`, { holder_ids: [chain.flow.id] })).status).toBe(400);
      expect(AssetRecord.parse((await c.get<unknown[]>(`/threat-models/${model()}/assets`)).body[0]).holder_ids).toEqual([]);
    });

    it('answers 404 for an asset that does not exist, and 400 for an id that is not one', async () => {
      expect(await c.patch(`/assets/${randomUUID()}`, { name: 'x' })).toEqual({ status: 404, body: { error: 'Asset not found' } });
      expect((await c.patch('/assets/not-a-uuid', { name: 'x' })).status).toBe(400);
    });
  });

  describe('DELETE /assets/{id}', () => {
    it('deletes the asset and its holder rows, and logs the delete', async () => {
      const created = await asset('Tokens', { holder_ids: [chain.nodeA.id] });
      expect((await c.del(`/assets/${created.id}`)).status).toBe(204);
      expect((await c.get<unknown[]>(`/threat-models/${model()}/assets`)).body).toEqual([]);
      expect((await db.query('SELECT 1 FROM asset_holders WHERE asset_id = $1', [created.id])).rowCount).toBe(0);
      expect(log.lines().at(-1)).toMatchObject({ action: 'delete', type: 'asset', id: created.id });
      expect(await c.del(`/assets/${created.id}`)).toEqual({ status: 404, body: { error: 'Asset not found' } });
    });

    it('leaves the asset, without that holder, when a holder element is deleted', async () => {
      const created = await asset('Tokens', { holder_ids: [chain.nodeA.id, chain.nodeB.id] });
      await c.del(`/elements/${chain.flow.id}`);
      await c.del(`/elements/${chain.nodeB.id}`);
      const list = AssetRecord.array().parse((await c.get<unknown[]>(`/threat-models/${model()}/assets`)).body);
      expect(list.map((a) => a.id)).toEqual([created.id]);
      expect(list[0]?.holder_ids).toEqual([chain.nodeA.id]);
    });
  });

  it('needs a sign-in for every operation', async () => {
    const created = await asset('Tokens');
    for (const [method, path] of [['GET', `/threat-models/${model()}/assets`], ['POST', `/threat-models/${model()}/assets`], ['PATCH', `/assets/${created.id}`], ['DELETE', `/assets/${created.id}`]] as const) {
      const res = await fetch(`${server.baseUrl}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});
