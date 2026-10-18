import { ElementRecord, MitigationRecord, ThreatModelRecord, ThreatRecord } from '@scrylux/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { client, seedChain, uniqueName, type ApiRecord, type V1Client } from './helpers.js';

describe('/api/v1/threat-models (FR-001, FR-002, FR-010a)', () => {
  let server: TestServer;
  let c: V1Client;

  beforeAll(async () => {
    server = await startTestServer(app);
    c = client(server.baseUrl, await login(server.baseUrl));
  });

  afterAll(async () => {
    await server.close();
  });

  async function createModel(): Promise<ApiRecord> {
    const project = (await c.post<ApiRecord>('/projects', { name: uniqueName('Models') })).body;
    const res = await c.post<ApiRecord>('/threat-models', { project_id: project.id, name: 'Checkout' });
    expect(res.status).toBe(201);
    return res.body;
  }

  it('creates a threat model with the STRIDE methodology and draft status by default', async () => {
    const model = ThreatModelRecord.parse(await createModel());
    expect(model).toMatchObject({ name: 'Checkout', methodology: 'STRIDE', status: 'draft' });
  });

  it('reads, renames and deletes a threat model', async () => {
    const model = await createModel();
    const read = await c.get(`/threat-models/${model.id}`);
    expect(read.status).toBe(200);
    expect(ThreatModelRecord.parse(read.body).id).toBe(model.id);

    const renamed = await c.patch(`/threat-models/${model.id}`, { name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(ThreatModelRecord.parse(renamed.body)).toMatchObject({ name: 'Renamed', status: 'draft' });

    expect(await c.del(`/threat-models/${model.id}`)).toEqual({ status: 204, body: null });
    expect(await c.get(`/threat-models/${model.id}`)).toEqual({
      status: 404,
      body: { error: 'Threat model not found' },
    });
  });

  it('accepts any status at any time, in any direction (FR-010a)', async () => {
    const model = await createModel();
    for (const status of ['approved', 'draft', 'in_review', 'draft']) {
      const res = await c.patch(`/threat-models/${model.id}`, { status });
      expect(res.status).toBe(200);
      expect(ThreatModelRecord.parse(res.body).status).toBe(status);
    }
  });

  it('lists the elements, threats and mitigations of a model, oldest first', async () => {
    const chain = await seedChain(c);
    const secondThreat = (
      await c.post<ApiRecord>('/threats', {
        threat_model_id: chain.model.id,
        category: 'Spoofing',
        title: 'Second',
        likelihood: 'Low',
        impact: 'Low',
        origin: 'manual',
      })
    ).body;
    const secondMitigation = (
      await c.post<ApiRecord>('/mitigations', { threat_id: secondThreat.id, description: 'Second fix' })
    ).body;

    const elements = await c.get(`/threat-models/${chain.model.id}/elements`);
    expect(elements.status).toBe(200);
    expect(ElementRecord.array().parse(elements.body).map((e) => e.id)).toEqual([
      chain.nodeA.id,
      chain.nodeB.id,
      chain.flow.id,
    ]);

    const threats = await c.get(`/threat-models/${chain.model.id}/threats`);
    expect(threats.status).toBe(200);
    expect(ThreatRecord.array().parse(threats.body).map((t) => t.id)).toEqual([chain.threat.id, secondThreat.id]);

    // One response holds the mitigations of every threat in the model (spec Story 1, scenario 4).
    const mitigations = await c.get(`/threat-models/${chain.model.id}/mitigations`);
    expect(mitigations.status).toBe(200);
    expect(MitigationRecord.array().parse(mitigations.body).map((m) => m.id)).toEqual([
      chain.mitigation.id,
      secondMitigation.id,
    ]);
  });

  it('lists nothing for a model with nothing in it', async () => {
    const model = await createModel();
    for (const kind of ['elements', 'threats', 'mitigations']) {
      expect(await c.get(`/threat-models/${model.id}/${kind}`)).toEqual({ status: 200, body: [] });
    }
  });
});
