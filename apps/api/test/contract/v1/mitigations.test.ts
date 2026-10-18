import { MitigationRecord } from '@scrylux/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { client, seedChain, type ApiRecord, type Chain, type V1Client } from './helpers.js';

describe('/api/v1/mitigations (FR-001, FR-010a)', () => {
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

  async function createMitigation(): Promise<ApiRecord> {
    const res = await c.post<ApiRecord>('/mitigations', { threat_id: chain.threat.id, description: 'Validate input' });
    expect(res.status).toBe(201);
    return res.body;
  }

  it('creates a mitigation that is proposed and has no external reference by default', async () => {
    expect(MitigationRecord.parse(await createMitigation())).toMatchObject({
      description: 'Validate input',
      status: 'proposed',
      external_ref: null,
      threat_id: chain.threat.id,
    });
  });

  it('moves between statuses in any direction (FR-010a)', async () => {
    const mitigation = await createMitigation();
    for (const status of ['verified', 'proposed', 'implemented', 'proposed']) {
      const res = await c.patch(`/mitigations/${mitigation.id}`, { status });
      expect(res.status).toBe(200);
      expect(MitigationRecord.parse(res.body).status).toBe(status);
    }
  });

  it('sets and clears the external reference', async () => {
    const mitigation = await createMitigation();
    const set = await c.patch(`/mitigations/${mitigation.id}`, { external_ref: 'https://example.com/T-1' });
    expect(MitigationRecord.parse(set.body).external_ref).toBe('https://example.com/T-1');
    const cleared = await c.patch(`/mitigations/${mitigation.id}`, { external_ref: null });
    expect(cleared.status).toBe(200);
    expect(MitigationRecord.parse(cleared.body).external_ref).toBeNull();
  });

  it('reads and deletes a mitigation', async () => {
    const mitigation = await createMitigation();
    const read = await c.get(`/mitigations/${mitigation.id}`);
    expect(read.status).toBe(200);
    expect(MitigationRecord.parse(read.body).id).toBe(mitigation.id);

    expect(await c.del(`/mitigations/${mitigation.id}`)).toEqual({ status: 204, body: null });
    expect(await c.get(`/mitigations/${mitigation.id}`)).toEqual({
      status: 404,
      body: { error: 'Mitigation not found' },
    });
  });
});
