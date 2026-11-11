import { randomUUID } from 'node:crypto';
import { AssumptionRecord } from '@scrylux/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { captureWriteLog, client, seedChain, type ApiRecord, type Chain, type V1Client } from './helpers.js';

// Assumptions, a kind of threat-model record (Phase 3 Milestone 5, US5; FR-006, FR-020 to FR-022): the same four operations as assets, with a
// statement in place of a name, a description and holders.

describe('/api/v1 assumptions', () => {
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
  const create = (body: Record<string, unknown>, threatModel = model()) => c.post<ApiRecord>(`/threat-models/${threatModel}/assumptions`, body);
  const assumption = async (statement: string): Promise<ApiRecord> => {
    const res = await create({ statement });
    expect(res.status).toBe(201);
    return res.body;
  };

  it('creates an assumption, lists a threat model’s oldest first, and writes one log line with ids only', async () => {
    const first = await assumption('The database is not exposed.');
    const second = await assumption('Staff are trusted.');
    await assumption(`Elsewhere ${randomUUID()}`);
    expect(AssumptionRecord.parse(first)).toMatchObject({ statement: 'The database is not exposed.', threat_model_id: model() });
    const list = AssumptionRecord.array().parse((await c.get<unknown[]>(`/threat-models/${model()}/assumptions`)).body);
    expect(list.map((a) => a.id)).toEqual([first.id, second.id, list[2]?.id]);
    expect(log.lines().filter((line) => line.action === 'create' && line.type === 'assumption')).toHaveLength(3);
    expect(log.raw().join('\n')).not.toContain('database is not exposed');
  });

  it('refuses a statement that repeats another’s, ignoring case and surrounding whitespace', async () => {
    await assumption('The database is not exposed.');
    expect(await create({ statement: '  THE database is NOT exposed. ' })).toEqual({ status: 409, body: { error: 'This assumption already exists' } });
    expect((await create({ statement: 'The database is not exposed.' }, (await seedChain(c)).model.id)).status).toBe(201);
  });

  it('refuses the 201st, and a body that does not match, and answers 404 and 400 for the ids', async () => {
    for (const body of [{}, { statement: ' ' }, { statement: 's', provenance: {} }, { statement: 's', threat_model_id: model() }, { statement: 's'.repeat(10_001) }]) {
      expect((await create(body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect(await create({ statement: 's' }, randomUUID())).toEqual({ status: 404, body: { error: 'Threat model not found' } });
    expect((await c.get(`/threat-models/${randomUUID()}/assumptions`)).status).toBe(404);
    expect((await c.post('/threat-models/not-a-uuid/assumptions', { statement: 's' })).status).toBe(400);
    await db.query(`INSERT INTO assumptions (threat_model_id, statement) SELECT $1, 'statement ' || n FROM generate_series(1, 200) AS n`, [model()]);
    expect(await create({ statement: 'one too many' })).toEqual({ status: 400, body: { error: 'A threat model can hold at most 200 assumptions' } });
  });

  it('changes the statement, refuses an empty body, an unknown key and a repeated statement, and answers 404 and 400', async () => {
    const created = await assumption('Staff are trusted.');
    const other = await assumption('The network is private.');
    const changed = await c.patch<ApiRecord>(`/assumptions/${created.id}`, { statement: 'Staff are vetted.' });
    expect(AssumptionRecord.parse(changed.body).statement).toBe('Staff are vetted.');
    expect((await c.patch(`/assumptions/${created.id}`, {})).status).toBe(400);
    expect((await c.patch(`/assumptions/${created.id}`, { statement: 's', provenance: null })).status).toBe(400);
    expect(await c.patch(`/assumptions/${created.id}`, { statement: other.statement })).toEqual({ status: 409, body: { error: 'This assumption already exists' } });
    expect(await c.patch(`/assumptions/${randomUUID()}`, { statement: 'x' })).toEqual({ status: 404, body: { error: 'Assumption not found' } });
    expect((await c.patch('/assumptions/not-a-uuid', { statement: 'x' })).status).toBe(400);
    expect(log.lines().filter((line) => line.action === 'update')).toHaveLength(1);
  });

  it('deletes an assumption, logs it, and answers 404 the second time', async () => {
    const created = await assumption('Staff are trusted.');
    expect((await c.del(`/assumptions/${created.id}`)).status).toBe(204);
    expect((await c.get<unknown[]>(`/threat-models/${model()}/assumptions`)).body).toEqual([]);
    expect(log.lines().at(-1)).toMatchObject({ action: 'delete', type: 'assumption', id: created.id });
    expect(await c.del(`/assumptions/${created.id}`)).toEqual({ status: 404, body: { error: 'Assumption not found' } });
  });

  it('needs a sign-in for every operation', async () => {
    const created = await assumption('Staff are trusted.');
    for (const [method, path] of [['GET', `/threat-models/${model()}/assumptions`], ['POST', `/threat-models/${model()}/assumptions`], ['PATCH', `/assumptions/${created.id}`], ['DELETE', `/assumptions/${created.id}`]] as const) {
      const res = await fetch(`${server.baseUrl}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});
