import { MitigationRecord, ThreatRecord, lifecycleGap } from '@scrylux/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { client, uniqueName, type ApiRecord, type V1Client } from './helpers.js';

// FR-003 and SC-001: a threat never becomes mitigated without an implemented or verified mitigation, even when
// that mitigation is changed at the same moment. A timing-based test cannot prove "at the same moment", so each
// order is made to happen on purpose with a second connection holding a transaction open (research #3).

const MITIGATED_REFUSED =
  'A threat can be set to mitigated only when at least one of its mitigations is implemented or verified';
const WAIT_MS = 300;

// 'pending' if the promise has not settled WAIT_MS after this was called; otherwise what it settled with.
async function settledOrPending<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), WAIT_MS))]);
}

describe('mitigated, and a mitigation that changes at the same moment (FR-003, SC-001)', () => {
  let server: TestServer;
  let c: V1Client;
  let modelId: string;

  beforeAll(async () => {
    server = await startTestServer(app);
    c = client(server.baseUrl, await login(server.baseUrl));
    const project = (await c.post<ApiRecord>('/projects', { name: uniqueName('Race') })).body;
    modelId = (await c.post<ApiRecord>('/threat-models', { project_id: project.id, name: 'Model' })).body.id;
  });

  afterAll(async () => {
    await server.close();
  });

  // An open threat with exactly one mitigation, implemented.
  async function threatWithImplementedMitigation(): Promise<{ threatId: string; mitigationId: string }> {
    const threat = (
      await c.post<ApiRecord>('/threats', {
        threat_model_id: modelId,
        category: 'Tampering',
        title: 'Race',
        likelihood: 'Medium',
        impact: 'High',
        origin: 'manual',
      })
    ).body;
    const mitigation = (
      await c.post<ApiRecord>('/mitigations', { threat_id: threat.id, description: 'The only control', status: 'implemented' })
    ).body;
    return { threatId: threat.id, mitigationId: mitigation.id };
  }

  const storedThreat = async (id: string) => ThreatRecord.parse((await c.get(`/threats/${id}`)).body);

  // Runs `work` on a second connection from the app's own pool, inside a transaction that is rolled back
  // if the test does not commit it.
  async function withSecondConnection(work: (query: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<void>) {
    const connection = await db.connect();
    try {
      await work((sql, params) => connection.query(sql, params));
    } finally {
      await connection.query('ROLLBACK').catch(() => undefined);
      connection.release();
    }
  }

  it('(a) refuses the change when the only implemented mitigation is downgraded first, even though the downgrade has not committed yet', async () => {
    const { threatId, mitigationId } = await threatWithImplementedMitigation();
    await withSecondConnection(async (query) => {
      await query('BEGIN');
      await query(`UPDATE mitigations SET status = 'proposed' WHERE id = $1`, [mitigationId]);

      const patch = c.patch(`/threats/${threatId}`, { status: 'mitigated' });
      // The request is waiting for the downgrade to finish, not answering from what it saw before it.
      expect(await settledOrPending(patch)).toBe('pending');

      await query('COMMIT');
      expect(await patch).toEqual({ status: 409, body: { error: MITIGATED_REFUSED } });
    });
    expect(await storedThreat(threatId)).toMatchObject({ status: 'open' });
  });

  it('(b) lets the status change go first, and the downgrade that follows leaves the flagged state of FR-006', async () => {
    const { threatId, mitigationId } = await threatWithImplementedMitigation();
    const res = await c.patch(`/threats/${threatId}`, { status: 'mitigated' });
    expect(res.status).toBe(200);

    await withSecondConnection(async (query) => {
      await query('BEGIN');
      await query(`UPDATE mitigations SET status = 'proposed' WHERE id = $1`, [mitigationId]);
      await query('COMMIT');
    });

    const threat = await storedThreat(threatId);
    expect(threat.status).toBe('mitigated');
    const mitigations = MitigationRecord.array().parse((await c.get(`/threats/${threatId}/mitigations`)).body);
    expect(lifecycleGap(threat, mitigations)).toBe('no_implemented_mitigation');
  });

  it('(c) refuses the change when the only implemented mitigation is being deleted', async () => {
    const { threatId, mitigationId } = await threatWithImplementedMitigation();
    await withSecondConnection(async (query) => {
      await query('BEGIN');
      await query('DELETE FROM mitigations WHERE id = $1', [mitigationId]);

      const patch = c.patch(`/threats/${threatId}`, { status: 'mitigated' });
      expect(await settledOrPending(patch)).toBe('pending');

      await query('COMMIT');
      expect(await patch).toEqual({ status: 409, body: { error: MITIGATED_REFUSED } });
    });
    expect(await storedThreat(threatId)).toMatchObject({ status: 'open' });
  });

  // The lock the status change takes is the one that makes (a) and (c) wait. This shows it from the other side:
  // a mitigation change waits behind a holder of that lock, so it cannot slip in between the check and the write.
  it('(d) makes a mitigation change wait while the lock the status change relies on is held', async () => {
    const { mitigationId } = await threatWithImplementedMitigation();
    await withSecondConnection(async (query) => {
      await query('BEGIN');
      await query('SELECT 1 FROM mitigations WHERE id = $1 FOR SHARE', [mitigationId]);

      const downgrade = c.patch(`/mitigations/${mitigationId}`, { status: 'proposed' });
      expect(await settledOrPending(downgrade)).toBe('pending');

      await query('COMMIT');
      expect((await downgrade).status).toBe(200);
    });
  });
});
