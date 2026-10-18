import { ThreatRecord } from '@scrylux/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { client, uniqueName, type ApiRecord, type V1Client } from './helpers.js';

// Phase 2 / Milestone 4, US3: the web app now lets a manual threat be linked to an element and moved between
// them. The API has always allowed it; these cases guard what the UI relies on (spec FR-018, US3 scenarios 2 to 5).

const SAME_MODEL = 'element_id must refer to an element in the same threat model';

describe('linking a manual threat to an element', () => {
  let server: TestServer;
  let c: V1Client;
  let modelId: string;
  let a: ApiRecord;
  let b: ApiRecord;

  beforeAll(async () => {
    server = await startTestServer(app);
    c = client(server.baseUrl, await login(server.baseUrl));
    const project = (await c.post<ApiRecord>('/projects', { name: uniqueName('Link') })).body;
    modelId = (await c.post<ApiRecord>('/threat-models', { project_id: project.id, name: 'Model' })).body.id;
    a = (await c.post<ApiRecord>('/elements', { threat_model_id: modelId, type: 'process', name: 'A' })).body;
    b = (await c.post<ApiRecord>('/elements', { threat_model_id: modelId, type: 'data_store', name: 'B' })).body;
  });

  afterAll(async () => {
    await server.close();
  });

  const body = (overrides: Record<string, unknown> = {}) => ({
    threat_model_id: modelId,
    category: 'Tampering',
    title: 'Abuse of the order flow',
    likelihood: 'Medium',
    impact: 'High',
    origin: 'manual',
    ...overrides,
  });

  it('creates a manual threat for an element of its own threat model', async () => {
    const res = await c.post('/threats', body({ element_id: a.id }));
    expect(res.status).toBe(201);
    expect(ThreatRecord.parse(res.body)).toMatchObject({ element_id: a.id, origin: 'manual' });
  });

  it('moves a manual threat to another element, and to none', async () => {
    const threat = (await c.post<ApiRecord>('/threats', body({ element_id: a.id }))).body;
    const moved = await c.patch(`/threats/${threat.id}`, { element_id: b.id });
    expect(ThreatRecord.parse(moved.body).element_id).toBe(b.id);
    const unlinked = await c.patch(`/threats/${threat.id}`, { element_id: null });
    expect(ThreatRecord.parse(unlinked.body).element_id).toBeNull();
  });

  it('refuses an element of another threat model, on create and on move', async () => {
    const project = (await c.post<ApiRecord>('/projects', { name: uniqueName('Elsewhere') })).body;
    const other = (await c.post<ApiRecord>('/threat-models', { project_id: project.id, name: 'Other' })).body;
    const foreign = (await c.post<ApiRecord>('/elements', { threat_model_id: other.id, type: 'process', name: 'Foreign' })).body;

    expect(await c.post('/threats', body({ element_id: foreign.id }))).toEqual({ status: 400, body: { error: SAME_MODEL } });
    const threat = (await c.post<ApiRecord>('/threats', body({ element_id: a.id }))).body;
    expect(await c.patch(`/threats/${threat.id}`, { element_id: foreign.id })).toEqual({ status: 400, body: { error: SAME_MODEL } });
    expect(ThreatRecord.parse((await c.get(`/threats/${threat.id}`)).body).element_id).toBe(a.id);
  });

  it('keeps a rule-generated threat\'s element fixed', async () => {
    await c.post(`/threat-models/${modelId}/threats/generate`, {});
    const generated = ThreatRecord.array().parse((await c.get(`/threat-models/${modelId}/threats`)).body).find((t) => t.origin === 'rule');
    expect(generated).toBeDefined();
    // Moved to an element it is not on: writing the value it already has is not a change, and is allowed.
    const elsewhere = generated?.element_id === b.id ? a.id : b.id;
    const res = await c.patch(`/threats/${generated?.id}`, { element_id: elsewhere });
    expect(res).toEqual({ status: 400, body: { error: 'A rule-generated threat stays linked to its element and rule' } });
  });

  it('refuses to delete an element that has a manual threat linked, naming the rule', async () => {
    const lonely = (await c.post<ApiRecord>('/elements', { threat_model_id: modelId, type: 'process', name: 'Lonely' })).body;
    await c.post('/threats', body({ element_id: lonely.id }));
    const res = await c.del(`/elements/${lonely.id}`);
    expect(res.status).toBe(409);
    expect((res.body as unknown as { error: string }).error).toContain('still has threats');
    expect((await c.get(`/elements/${lonely.id}`)).status).toBe(200);
  });
});
