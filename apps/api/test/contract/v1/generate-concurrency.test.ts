import { ThreatRecord } from '@scrylux/core';
import { shippedLibrary } from '@scrylux/threat-library';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { client, uniqueName, type ApiRecord, type V1Client } from './helpers.js';

// FR-005, SC-005: runs on one threat model queue on its lock, and the diagram cannot change under a run.
describe('generating threats while something else writes (FR-005, SC-005)', () => {
  let server: TestServer;
  let c: V1Client;

  beforeAll(async () => {
    server = await startTestServer(app);
    c = client(server.baseUrl, await login(server.baseUrl));
  });

  afterAll(async () => {
    await server.close();
  });

  async function modelWith(count: number): Promise<string> {
    const project = (await c.post<ApiRecord>('/projects', { name: uniqueName('Concurrent') })).body;
    const model = (await c.post<ApiRecord>('/threat-models', { project_id: project.id, name: 'Model' })).body;
    const operations = Array.from({ length: count }, (_, i) => ({
      op: 'create',
      element: { type: i % 3 === 0 ? 'external_entity' : i % 3 === 1 ? 'process' : 'data_store', name: `Element ${i}` },
    }));
    const res = await c.post(`/threat-models/${model.id}/elements/batch`, { operations });
    expect(res.status).toBe(200);
    return model.id;
  }

  const threatsOf = async (modelId: string) => ThreatRecord.array().parse((await c.get(`/threat-models/${modelId}/threats`)).body);

  it('creates each threat once when two runs start at the same moment', async () => {
    const modelId = await modelWith(48);
    const [one, two] = await Promise.all([
      c.post<{ created: number; existing: number }>(`/threat-models/${modelId}/threats/generate`, {}),
      c.post<{ created: number; existing: number }>(`/threat-models/${modelId}/threats/generate`, {}),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);

    const threats = await threatsOf(modelId);
    const keys = threats.map((t) => `${t.element_id}|${t.library_ref}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Whichever ran first created everything, and the other found it all already there.
    expect(one.body.created + two.body.created).toBe(threats.length);
    expect(one.body.created === 0 || two.body.created === 0).toBe(true);
    expect(Math.min(one.body.existing, two.body.existing)).toBe(0);
    expect(Math.max(one.body.existing, two.body.existing)).toBe(threats.length);
  });

  it('ends with exactly the final diagram’s threats when an element is added while a run is going', async () => {
    const modelId = await modelWith(30);
    const [run, batch] = await Promise.all([
      c.post(`/threat-models/${modelId}/threats/generate`, {}),
      c.post<{ elements: ApiRecord[] }>(`/threat-models/${modelId}/elements/batch`, {
        operations: [{ op: 'create', element: { type: 'process', name: 'Added during the run' } }],
      }),
    ]);
    expect([run.status, batch.status]).toEqual([200, 200]);
    const added = batch.body.elements[0];
    if (!added) throw new Error('the batch created nothing');

    // Whichever of the two committed first, one more run settles on the final diagram.
    expect((await c.post(`/threat-models/${modelId}/threats/generate`, {})).status).toBe(200);

    const library = shippedLibrary();
    const elements = (await c.get<{ id: string; type: 'external_entity' | 'process' | 'data_store'; name: string; properties: unknown }[]>(`/threat-models/${modelId}/elements`)).body;
    const expected = elements.flatMap((e) =>
      library.candidatesFor({ type: e.type, name: e.name, properties: e.properties }).map((candidate) => `${e.id}|${candidate.rule_id}`),
    );
    const threats = (await threatsOf(modelId)).map((t) => `${t.element_id}|${t.library_ref}`);
    expect(threats.sort()).toEqual(expected.sort());
    expect(new Set(threats).size).toBe(threats.length);
    expect(threats.some((key) => key.startsWith(`${added.id}|`))).toBe(true);
  });
});
