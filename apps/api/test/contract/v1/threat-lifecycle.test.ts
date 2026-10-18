import { ThreatRecord } from '@scrylux/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { captureWriteLog, client, uniqueName, type ApiRecord, type V1Client } from './helpers.js';

// contracts/threat-lifecycle-api.md: every row of the createThreat and updateThreat tables, with the status
// code, the exact message and the stored row afterwards (spec FR-002 to FR-009, FR-023).

const REQUIRED = 'status_reason: is required when status is accepted or not_applicable';
const LEFT_OUT = 'status_reason: must be left out unless status is accepted or not_applicable';
const NEW_MITIGATED =
  'status: a new threat cannot be mitigated: it has no mitigations yet; set the status after one is implemented or verified';
const MITIGATED_REFUSED =
  'A threat can be set to mitigated only when at least one of its mitigations is implemented or verified';
const REASON_ALONE = 'status_reason can only be set on a threat that is accepted or not_applicable';

describe('threat lifecycle (/api/v1/threats)', () => {
  let server: TestServer;
  let c: V1Client;
  let modelId: string;
  let processId: string;

  beforeAll(async () => {
    server = await startTestServer(app);
    c = client(server.baseUrl, await login(server.baseUrl));
    const project = (await c.post<ApiRecord>('/projects', { name: uniqueName('Lifecycle') })).body;
    modelId = (await c.post<ApiRecord>('/threat-models', { project_id: project.id, name: 'Model' })).body.id;
    processId = (await c.post<ApiRecord>('/elements', { threat_model_id: modelId, type: 'process', name: 'API' })).body.id;
  });

  afterAll(async () => {
    await server.close();
  });

  const body = (overrides: Record<string, unknown> = {}) => ({
    threat_model_id: modelId,
    category: 'Spoofing',
    title: 'Forged token',
    likelihood: 'High',
    impact: 'High',
    origin: 'manual',
    ...overrides,
  });
  const make = async (overrides: Record<string, unknown> = {}) => (await c.post<ApiRecord>('/threats', body(overrides))).body;
  const read = async (id: string) => ThreatRecord.parse((await c.get(`/threats/${id}`)).body);
  const addMitigation = async (threatId: string, status = 'proposed') =>
    (await c.post<ApiRecord>('/mitigations', { threat_id: threatId, description: 'A control', status })).body;
  const rejected = (error: string, status = 400) => ({ status, body: { error } });

  describe('createThreat', () => {
    it('creates an open threat with no reason, as before', async () => {
      const res = await c.post('/threats', body());
      expect(res.status).toBe(201);
      expect(ThreatRecord.parse(res.body)).toMatchObject({ status: 'open', status_reason: null });
    });

    it.each(['accepted', 'not_applicable'])('creates a %s threat with a reason', async (status) => {
      const res = await c.post('/threats', body({ status, status_reason: 'Covered by the WAF' }));
      expect(res.status).toBe(201);
      expect(ThreatRecord.parse(res.body)).toMatchObject({ status, status_reason: 'Covered by the WAF' });
    });

    it.each(['accepted', 'not_applicable'])('refuses a %s threat without a reason', async (status) => {
      expect(await c.post('/threats', body({ status }))).toEqual(rejected(REQUIRED));
    });

    it.each(['open', 'mitigated'])('refuses a reason with %s', async (status) => {
      const res = await c.post('/threats', body({ status, status_reason: 'why' }));
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toContain(LEFT_OUT);
    });

    it('refuses a new threat that is mitigated', async () => {
      expect(await c.post('/threats', body({ status: 'mitigated' }))).toEqual(rejected(NEW_MITIGATED));
    });

    it('still refuses an element in another threat model', async () => {
      const project = (await c.post<ApiRecord>('/projects', { name: uniqueName('Other') })).body;
      const other = (await c.post<ApiRecord>('/threat-models', { project_id: project.id, name: 'Other' })).body;
      const node = (await c.post<ApiRecord>('/elements', { threat_model_id: other.id, type: 'process', name: 'Elsewhere' })).body;
      expect(await c.post('/threats', body({ element_id: node.id }))).toEqual(
        rejected('element_id must refer to an element in the same threat model'),
      );
    });
  });

  describe('updateThreat: into mitigated (FR-003)', () => {
    it('is refused with no mitigation, and the threat stays open', async () => {
      const threat = await make();
      expect(await c.patch(`/threats/${threat.id}`, { status: 'mitigated' })).toEqual(rejected(MITIGATED_REFUSED, 409));
      expect(await read(threat.id)).toMatchObject({ status: 'open' });
    });

    it('is refused when every mitigation is only proposed', async () => {
      const threat = await make();
      await addMitigation(threat.id, 'proposed');
      expect(await c.patch(`/threats/${threat.id}`, { status: 'mitigated' })).toEqual(rejected(MITIGATED_REFUSED, 409));
    });

    it.each(['implemented', 'verified'])('is allowed once a mitigation is %s', async (status) => {
      const threat = await make();
      await addMitigation(threat.id, 'proposed');
      await addMitigation(threat.id, status);
      const res = await c.patch(`/threats/${threat.id}`, { status: 'mitigated' });
      expect(res.status).toBe(200);
      expect(ThreatRecord.parse(res.body)).toMatchObject({ status: 'mitigated', status_reason: null });
    });

    it('is allowed from accepted, directly, and clears the reason (FR-002, FR-005)', async () => {
      const threat = await make({ status: 'accepted', status_reason: 'For now' });
      await addMitigation(threat.id, 'implemented');
      const res = await c.patch(`/threats/${threat.id}`, { status: 'mitigated' });
      expect(res.status).toBe(200);
      expect(ThreatRecord.parse(res.body)).toMatchObject({ status: 'mitigated', status_reason: null });
    });

    // Repeating the status is not a status change, so a threat that lost its implemented mitigation (the FR-006
    // state) stays editable by a client that sends the status along.
    it('is not checked when the threat is already mitigated', async () => {
      const threat = await make();
      const mitigation = await addMitigation(threat.id, 'implemented');
      expect((await c.patch(`/threats/${threat.id}`, { status: 'mitigated' })).status).toBe(200);
      await c.patch(`/mitigations/${mitigation.id}`, { status: 'proposed' });
      const res = await c.patch(`/threats/${threat.id}`, { status: 'mitigated', title: 'Renamed' });
      expect(res.status).toBe(200);
      expect(ThreatRecord.parse(res.body)).toMatchObject({ status: 'mitigated', title: 'Renamed' });
    });

    it('answers 404 for a threat that does not exist', async () => {
      expect(await c.patch('/threats/00000000-0000-4000-8000-000000000000', { status: 'mitigated' })).toEqual(
        rejected('Threat not found', 404),
      );
    });
  });

  describe('updateThreat: reasons (FR-004, FR-005)', () => {
    it.each(['accepted', 'not_applicable'])('needs a reason to move to %s', async (status) => {
      const threat = await make();
      expect(await c.patch(`/threats/${threat.id}`, { status })).toEqual(rejected(REQUIRED));
      expect(await read(threat.id)).toMatchObject({ status: 'open', status_reason: null });
      const res = await c.patch(`/threats/${threat.id}`, { status, status_reason: 'Dealt with elsewhere' });
      expect(ThreatRecord.parse(res.body)).toMatchObject({ status, status_reason: 'Dealt with elsewhere' });
    });

    // The schema cannot see the stored status, so a same-status request needs its reason too.
    it('needs a reason even when the status does not change', async () => {
      const threat = await make({ status: 'accepted', status_reason: 'First reason' });
      expect(await c.patch(`/threats/${threat.id}`, { status: 'accepted' })).toEqual(rejected(REQUIRED));
      const res = await c.patch(`/threats/${threat.id}`, { status: 'accepted', status_reason: 'Second reason' });
      expect(ThreatRecord.parse(res.body).status_reason).toBe('Second reason');
    });

    it('replaces the reason when a threat moves from accepted to not applicable', async () => {
      const threat = await make({ status: 'accepted', status_reason: 'Accepted for now' });
      const res = await c.patch(`/threats/${threat.id}`, { status: 'not_applicable', status_reason: 'Out of scope' });
      expect(ThreatRecord.parse(res.body)).toMatchObject({ status: 'not_applicable', status_reason: 'Out of scope' });
    });

    it('clears the reason when a threat moves to open', async () => {
      const threat = await make({ status: 'accepted', status_reason: 'For now' });
      const res = await c.patch(`/threats/${threat.id}`, { status: 'open' });
      expect(res.status).toBe(200);
      expect(ThreatRecord.parse(res.body)).toMatchObject({ status: 'open', status_reason: null });
    });

    it.each(['open', 'mitigated'])('refuses a reason sent with %s', async (status) => {
      const threat = await make();
      await addMitigation(threat.id, 'implemented');
      const res = await c.patch(`/threats/${threat.id}`, { status, status_reason: 'why' });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe(LEFT_OUT);
    });

    it.each(['accepted', 'not_applicable'])('lets the reason of a %s threat be edited on its own', async (status) => {
      const threat = await make({ status, status_reason: 'Old reason' });
      const res = await c.patch(`/threats/${threat.id}`, { status_reason: 'New reason' });
      expect(res.status).toBe(200);
      expect(ThreatRecord.parse(res.body)).toMatchObject({ status, status_reason: 'New reason' });
    });

    it.each(['open', 'mitigated'])('refuses a reason on its own for a %s threat, naming the rule', async (status) => {
      const threat = await make();
      if (status === 'mitigated') {
        await addMitigation(threat.id, 'implemented');
        await c.patch(`/threats/${threat.id}`, { status: 'mitigated' });
      }
      expect(await c.patch(`/threats/${threat.id}`, { status_reason: 'x' })).toEqual(rejected(REASON_ALONE));
      expect(await read(threat.id)).toMatchObject({ status, status_reason: null });
    });

    it('refuses a blank reason, and a null one', async () => {
      const threat = await make({ status: 'accepted', status_reason: 'Reason' });
      const blank = await c.patch(`/threats/${threat.id}`, { status_reason: '   ' });
      expect(blank.status).toBe(400);
      expect((blank.body as { error: string }).error).toContain('status_reason: must not be empty');
      const nothing = await c.patch(`/threats/${threat.id}`, { status_reason: null });
      expect(nothing.status).toBe(400);
      expect((nothing.body as { error: string }).error).toContain('status_reason');
      expect((await read(threat.id)).status_reason).toBe('Reason');
    });

    it('leaves status and reason alone when other fields change', async () => {
      const threat = await make({ status: 'accepted', status_reason: 'Keep me' });
      const res = await c.patch(`/threats/${threat.id}`, { title: 'Renamed', likelihood: 'Low' });
      expect(ThreatRecord.parse(res.body)).toMatchObject({ title: 'Renamed', status: 'accepted', status_reason: 'Keep me' });
    });

    it('moves a manual threat between elements and to none, keeping its status and reason', async () => {
      const threat = await make({ status: 'not_applicable', status_reason: 'Not here' });
      const linked = await c.patch(`/threats/${threat.id}`, { element_id: processId });
      expect(ThreatRecord.parse(linked.body)).toMatchObject({ element_id: processId, status: 'not_applicable', status_reason: 'Not here' });
      const unlinked = await c.patch(`/threats/${threat.id}`, { element_id: null });
      expect(ThreatRecord.parse(unlinked.body)).toMatchObject({ element_id: null, status_reason: 'Not here' });
    });
  });

  describe('mitigations after a threat is mitigated (FR-006)', () => {
    it('lets the last implemented mitigation be downgraded and then deleted; the threat stays mitigated', async () => {
      const threat = await make();
      const mitigation = await addMitigation(threat.id, 'implemented');
      await c.patch(`/threats/${threat.id}`, { status: 'mitigated' });

      expect((await c.patch(`/mitigations/${mitigation.id}`, { status: 'proposed' })).status).toBe(200);
      expect(await read(threat.id)).toMatchObject({ status: 'mitigated' });
      expect((await c.del(`/mitigations/${mitigation.id}`)).status).toBe(204);
      expect(await read(threat.id)).toMatchObject({ status: 'mitigated' });
    });
  });

  describe('rule-generated threats (FR-009)', () => {
    it('can be dismissed as not applicable with a reason, and a later run leaves it and creates no copy', async () => {
      await c.post(`/threat-models/${modelId}/threats/generate`, {});
      const generated = ThreatRecord.array().parse((await c.get(`/threat-models/${modelId}/threats`)).body).filter((t) => t.origin === 'rule');
      expect(generated.length).toBeGreaterThan(0);
      const target = generated[0] as ThreatRecord;

      const res = await c.patch(`/threats/${target.id}`, { status: 'not_applicable', status_reason: 'Handled by the platform' });
      expect(res.status).toBe(200);

      await c.post(`/threat-models/${modelId}/threats/generate`, {});
      const after = ThreatRecord.array().parse((await c.get(`/threat-models/${modelId}/threats`)).body);
      expect(after.find((t) => t.id === target.id)).toMatchObject({ status: 'not_applicable', status_reason: 'Handled by the platform' });
      const copies = after.filter((t) => t.origin === 'rule' && t.element_id === target.element_id && t.library_ref === target.library_ref);
      expect(copies).toHaveLength(1);
    });

    it('keeps its element and rule fixed', async () => {
      const generated = ThreatRecord.array().parse((await c.get(`/threat-models/${modelId}/threats`)).body).find((t) => t.origin === 'rule');
      const res = await c.patch(`/threats/${generated?.id}`, { library_ref: 'something-else' });
      expect(res).toEqual(rejected('A rule-generated threat stays linked to its element and rule'));
    });
  });

  describe('the write log (FR-023)', () => {
    it('writes one update line per change, with no status and no reason', async () => {
      const threat = await make();
      const log = captureWriteLog();
      try {
        const res = await c.patch(`/threats/${threat.id}`, { status: 'accepted', status_reason: 'SECRET-REASON-TEXT' });
        expect(res.status).toBe(200);
        expect(log.lines()).toEqual([expect.objectContaining({ action: 'update', type: 'threat', id: threat.id })]);
        const printed = log.raw().join('\n');
        expect(printed).not.toContain('SECRET-REASON-TEXT');
        expect(printed).not.toContain('accepted');
      } finally {
        log.restore();
      }
    });

    it('writes nothing for a refused change', async () => {
      const threat = await make();
      const log = captureWriteLog();
      try {
        expect((await c.patch(`/threats/${threat.id}`, { status: 'mitigated' })).status).toBe(409);
        expect((await c.patch(`/threats/${threat.id}`, { status: 'accepted' })).status).toBe(400);
        expect(log.lines()).toEqual([]);
      } finally {
        log.restore();
      }
    });
  });
});
