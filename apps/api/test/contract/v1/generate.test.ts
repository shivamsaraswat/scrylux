import { ThreatGenerationResult, ThreatRecord } from '@scrylux/core';
import { shippedLibrary, type FlowContext } from '@scrylux/threat-library';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { client, uniqueName, type ApiRecord, type V1Client } from './helpers.js';

const GENERATE = (modelId: string) => `/threat-models/${modelId}/threats/generate`;

describe('POST /api/v1/threat-models/{id}/threats/generate (US1)', () => {
  let server: TestServer;
  let c: V1Client;

  beforeAll(async () => {
    server = await startTestServer(app);
    c = client(server.baseUrl, await login(server.baseUrl));
  });

  afterAll(async () => {
    await server.close();
  });

  async function newModel(): Promise<string> {
    const project = (await c.post<ApiRecord>('/projects', { name: uniqueName('Generate') })).body;
    return (await c.post<ApiRecord>('/threat-models', { project_id: project.id, name: 'Model' })).body.id;
  }

  const element = async (modelId: string, fields: Record<string, unknown>) =>
    (await c.post<ApiRecord>('/elements', { threat_model_id: modelId, ...fields })).body;

  // An external entity outside a boundary; a process and a data store inside it; a flow that crosses
  // the boundary and one that does not.
  async function diagram() {
    const modelId = await newModel();
    const boundary = await element(modelId, { type: 'trust_boundary', name: 'Internal' });
    const customer = await element(modelId, { type: 'external_entity', name: 'Customer' });
    const api = await element(modelId, { type: 'process', name: 'Orders API', parent_boundary_id: boundary.id });
    const store = await element(modelId, { type: 'data_store', name: 'Orders DB', parent_boundary_id: boundary.id });
    const places = await element(modelId, {
      type: 'data_flow',
      name: 'Places order',
      source_element_id: customer.id,
      target_element_id: api.id,
    });
    const writes = await element(modelId, {
      type: 'data_flow',
      name: 'Writes order',
      source_element_id: api.id,
      target_element_id: store.id,
    });
    return { modelId, boundary, customer, api, store, places, writes };
  }

  // What the library says for the diagram above, worked out by hand rather than by the engine.
  function expectedCandidates(d: Awaited<ReturnType<typeof diagram>>) {
    const library = shippedLibrary();
    const flowOf = (crosses: boolean, source: FlowContext['source_type'], target: FlowContext['target_type'], s: string, t: string): FlowContext => ({
      crosses_trust_boundary: crosses,
      source_type: source,
      target_type: target,
      source_name: s,
      target_name: t,
    });
    const asked: [ApiRecord, ReturnType<typeof library.candidatesFor>][] = [
      [d.customer, library.candidatesFor({ type: 'external_entity', name: 'Customer', properties: {} })],
      [d.api, library.candidatesFor({ type: 'process', name: 'Orders API', properties: {} })],
      [d.store, library.candidatesFor({ type: 'data_store', name: 'Orders DB', properties: {} })],
      [d.places, library.candidatesFor({ type: 'data_flow', name: 'Places order', properties: {}, flow: flowOf(true, 'external_entity', 'process', 'Customer', 'Orders API') })],
      [d.writes, library.candidatesFor({ type: 'data_flow', name: 'Writes order', properties: {}, flow: flowOf(false, 'process', 'data_store', 'Orders API', 'Orders DB') })],
    ];
    return asked.flatMap(([el, candidates]) => candidates.map((candidate) => ({ element: el, candidate })));
  }

  it('creates exactly the library’s candidates, each linked to its element, with proposed mitigations (SC-001)', async () => {
    const d = await diagram();
    const expected = expectedCandidates(d);
    expect(expected.length).toBeGreaterThan(0);

    const res = await c.post(GENERATE(d.modelId), {});
    expect(res.status).toBe(200);
    const result = ThreatGenerationResult.parse(res.body);
    expect(result).toEqual({ created: expected.length, existing: 0, newly_stale: 0, no_longer_stale: 0, skipped_elements: [] });

    const threats = ThreatRecord.array().parse((await c.get(`/threat-models/${d.modelId}/threats`)).body);
    expect(threats).toHaveLength(expected.length);
    expect(new Set(threats.map((t) => `${t.element_id}|${t.library_ref}`))).toEqual(
      new Set(expected.map(({ element, candidate }) => `${element.id}|${candidate.rule_id}`)),
    );
    for (const threat of threats) {
      const { candidate } = expected.find((e) => e.element.id === threat.element_id && e.candidate.rule_id === threat.library_ref) ?? {};
      expect(threat).toMatchObject({
        origin: 'rule',
        status: 'open',
        stale: null,
        status_reason: null,
        category: candidate?.category,
        title: candidate?.title,
        description: candidate?.description,
        likelihood: candidate?.likelihood,
        impact: candidate?.impact,
      });
    }

    const mitigations = (await c.get<{ threat_id: string; description: string; status: string; external_ref: string | null }[]>(
      `/threat-models/${d.modelId}/mitigations`,
    )).body;
    for (const threat of threats) {
      const { candidate } = expected.find((e) => e.element.id === threat.element_id && e.candidate.rule_id === threat.library_ref) ?? {};
      const own = mitigations.filter((m) => m.threat_id === threat.id);
      expect(own.map((m) => m.description).sort()).toEqual([...(candidate?.mitigations ?? [])].sort());
      expect(own.every((m) => m.status === 'proposed' && m.external_ref === null)).toBe(true);
    }
  });

  it('gives only the flow that crosses the boundary the crossing rules', async () => {
    const d = await diagram();
    await c.post(GENERATE(d.modelId), {});
    const threats = ThreatRecord.array().parse((await c.get(`/threat-models/${d.modelId}/threats`)).body);
    const refs = (id: string) => new Set(threats.filter((t) => t.element_id === id).map((t) => t.library_ref));
    const crossingOnly = [...refs(d.places.id)].filter((ref) => !refs(d.writes.id).has(ref as string));
    expect(crossingOnly.length).toBeGreaterThan(0);
  });

  it('answers all zeros for an empty model and for one with only trust boundaries', async () => {
    const empty = await newModel();
    expect((await c.post(GENERATE(empty), {})).body).toEqual({ created: 0, existing: 0, newly_stale: 0, no_longer_stale: 0, skipped_elements: [] });
    const onlyBoundary = await newModel();
    await element(onlyBoundary, { type: 'trust_boundary', name: 'B' });
    expect((await c.post(GENERATE(onlyBoundary), {})).body).toMatchObject({ created: 0 });
  });

  it('leaves manual threats exactly as they were', async () => {
    const d = await diagram();
    const manual = (
      await c.post<ApiRecord>('/threats', {
        threat_model_id: d.modelId,
        element_id: d.api.id,
        category: 'Tampering',
        title: 'Hand-written',
        likelihood: 'Low',
        impact: 'Low',
        origin: 'manual',
      })
    ).body;
    await c.post(GENERATE(d.modelId), {});
    expect((await c.get(`/threats/${manual.id}`)).body).toEqual(manual);
  });

  it('answers 404 for an unknown model, 400 for a malformed id', async () => {
    const missing = await c.post(GENERATE('9b6b1c3e-0000-4000-8000-000000000000'), {});
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Threat model not found' });
    const malformed = await c.post(GENERATE('not-an-id'), {});
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'Invalid id' });
  });

  it('answers 401 without a token', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1${GENERATE('9b6b1c3e-0000-4000-8000-000000000000')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('refuses a body other than {} and stores nothing', async () => {
    const d = await diagram();
    const extra = await c.post<{ error: string }>(GENERATE(d.modelId), { dry_run: true });
    expect(extra.status).toBe(400);
    expect(extra.body.error).toContain('dry_run');
    const notAnObject = await c.raw(GENERATE(d.modelId), { method: 'POST', body: '[]' });
    expect(notAnObject.status).toBe(400);
    expect((await c.get<unknown[]>(`/threat-models/${d.modelId}/threats`)).body).toEqual([]);
  });

  it('skips an element stored with properties outside the vocabulary, and still generates the rest (FR-002a)', async () => {
    const d = await diagram();
    const old = await element(d.modelId, { type: 'process', name: 'Legacy API' });
    await db.query(`UPDATE elements SET properties = '{"flags":{"legacy_flag":true}}'::jsonb WHERE id = $1`, [old.id]);
    const res = await c.post<{ created: number; skipped_elements: string[] }>(GENERATE(d.modelId), {});
    expect(res.status).toBe(200);
    expect(res.body.skipped_elements).toEqual([old.id]);
    const threats = ThreatRecord.array().parse((await c.get(`/threat-models/${d.modelId}/threats`)).body);
    expect(threats.some((t) => t.element_id === old.id)).toBe(false);
    expect(threats.some((t) => t.element_id === d.api.id)).toBe(true);
  });

  describe('running it again (US2)', () => {
    const threatsOf = async (modelId: string) => ThreatRecord.array().parse((await c.get(`/threat-models/${modelId}/threats`)).body);
    const mitigationsOf = async (modelId: string) =>
      (await c.get<{ id: string; threat_id: string; description: string; updated_at: string }[]>(`/threat-models/${modelId}/mitigations`)).body;

    it('creates and changes nothing on an unchanged diagram (FR-008, SC-002)', async () => {
      const d = await diagram();
      const first = (await c.post<{ created: number }>(GENERATE(d.modelId), {})).body;
      const threatsBefore = await threatsOf(d.modelId);
      const mitigationsBefore = await mitigationsOf(d.modelId);

      const second = await c.post(GENERATE(d.modelId), {});
      expect(second.body).toEqual({ created: 0, existing: first.created, newly_stale: 0, no_longer_stale: 0, skipped_elements: [] });
      // Every record is byte for byte as before, updated_at included.
      expect(await threatsOf(d.modelId)).toEqual(threatsBefore);
      expect(await mitigationsOf(d.modelId)).toEqual(mitigationsBefore);
    });

    it('keeps every edit to a generated threat and its mitigations, and re-adds no mitigation (FR-007, SC-003)', async () => {
      const d = await diagram();
      await c.post(GENERATE(d.modelId), {});
      const [target] = await threatsOf(d.modelId);
      if (!target) throw new Error('no threat generated');
      const own = (await mitigationsOf(d.modelId)).filter((m) => m.threat_id === target.id);
      expect(own.length).toBeGreaterThan(1);
      await c.patch(`/threats/${target.id}`, { title: 'My own title', description: 'My notes', likelihood: 'Low', impact: 'Low', status: 'accepted', status_reason: 'Mine to decide' });
      await c.del(`/mitigations/${own[0]?.id}`);
      await c.post('/mitigations', { threat_id: target.id, description: 'Added by hand' });
      const before = await mitigationsOf(d.modelId);

      const again = await c.post<{ created: number }>(GENERATE(d.modelId), {});
      expect(again.body.created).toBe(0);
      const after = (await c.get<ApiRecord>(`/threats/${target.id}`)).body;
      expect(after).toMatchObject({ title: 'My own title', description: 'My notes', likelihood: 'Low', impact: 'Low', status: 'accepted', status_reason: 'Mine to decide', stale: null });
      expect(await mitigationsOf(d.modelId)).toEqual(before);
    });

    it('creates a generated threat again when the user deleted it (Clarifications Q3)', async () => {
      const d = await diagram();
      await c.post(GENERATE(d.modelId), {});
      const [target] = await threatsOf(d.modelId);
      if (!target) throw new Error('no threat generated');
      await c.del(`/threats/${target.id}`);
      const again = await c.post(GENERATE(d.modelId), {});
      expect(again.body).toMatchObject({ created: 1 });
      const now = await threatsOf(d.modelId);
      expect(now.filter((t) => t.element_id === target.element_id && t.library_ref === target.library_ref)).toHaveLength(1);
    });

    it('keeps a threat dismissed as not applicable, and does not duplicate it', async () => {
      const d = await diagram();
      await c.post(GENERATE(d.modelId), {});
      const [target] = await threatsOf(d.modelId);
      if (!target) throw new Error('no threat generated');
      await c.patch(`/threats/${target.id}`, { status: 'not_applicable', status_reason: 'Handled by the platform team' });
      const again = await c.post(GENERATE(d.modelId), {});
      expect(again.body).toMatchObject({ created: 0 });
      expect((await c.get<ApiRecord>(`/threats/${target.id}`)).body).toMatchObject({
        status: 'not_applicable',
        status_reason: 'Handled by the platform team',
      });
    });

    it('creates only the new element’s threats when an element was added', async () => {
      const d = await diagram();
      const first = (await c.post<{ created: number }>(GENERATE(d.modelId), {})).body;
      const added = await element(d.modelId, { type: 'process', name: 'Added later' });
      const second = await c.post<{ created: number; existing: number }>(GENERATE(d.modelId), {});
      expect(second.body.existing).toBe(first.created);
      const forAdded = (await threatsOf(d.modelId)).filter((t) => t.element_id === added.id);
      expect(forAdded).toHaveLength(second.body.created);
      expect(forAdded.length).toBeGreaterThan(0);
    });

    it('ignores a manual threat that carries a rule’s id, and still creates the rule’s own threat (US4 scenario 4)', async () => {
      const d = await diagram();
      await c.post(GENERATE(d.modelId), {});
      const [target] = await threatsOf(d.modelId);
      if (!target) throw new Error('no threat generated');
      await c.del(`/threats/${target.id}`);
      const manual = (
        await c.post<ApiRecord>('/threats', {
          threat_model_id: d.modelId,
          element_id: target.element_id,
          library_ref: target.library_ref,
          category: target.category,
          title: 'Hand-written look-alike',
          likelihood: 'Low',
          impact: 'Low',
          origin: 'manual',
        })
      ).body;
      const again = await c.post(GENERATE(d.modelId), {});
      expect(again.body).toMatchObject({ created: 1 });
      expect((await c.get(`/threats/${manual.id}`)).body).toEqual(manual);
      const pair = (await threatsOf(d.modelId)).filter((t) => t.element_id === target.element_id && t.library_ref === target.library_ref);
      expect(pair.map((t) => t.origin).sort()).toEqual(['manual', 'rule']);
    });
  });

  describe('threats that no longer fit the diagram (US3)', () => {
    const threatsOf = async (modelId: string) => ThreatRecord.array().parse((await c.get(`/threat-models/${modelId}/threats`)).body);
    const setFlow = (flowId: string, flags: Record<string, boolean>) => c.patch(`/elements/${flowId}`, { properties: { flags } });
    const forElement = async (modelId: string, elementId: string) => (await threatsOf(modelId)).filter((t) => t.element_id === elementId);

    it('flags the threats of a flow stale when it becomes encrypted, names the condition, and keeps the rest; clears them when it is undone (SC-004)', async () => {
      const d = await diagram();
      await c.post(GENERATE(d.modelId), {});
      const before = await forElement(d.modelId, d.writes.id);
      const plaintext = before.filter((t) => t.library_ref?.includes('plaintext'));
      expect(plaintext.length).toBeGreaterThan(0);
      // The user marks one of them accepted: a stale threat keeps its status.
      await c.patch(`/threats/${plaintext[0]?.id}`, { status: 'accepted', status_reason: 'Plaintext is fine on this link' });
      const mitigationsBefore = (await c.get<ApiRecord[]>(`/threat-models/${d.modelId}/mitigations`)).body;

      expect((await setFlow(d.writes.id, { encrypted_in_transit: true })).status).toBe(200);
      const run = await c.post<{ created: number; newly_stale: number }>(GENERATE(d.modelId), {});
      expect(run.body.newly_stale).toBeGreaterThanOrEqual(plaintext.length);

      const after = await forElement(d.modelId, d.writes.id);
      expect(after).toHaveLength(before.length);
      for (const t of plaintext) {
        const now = after.find((a) => a.id === t.id);
        expect(now?.stale).toEqual({
          reason: 'conditions_unmet',
          unmet: [{ fact: 'flag', flag: 'encrypted_in_transit', required: 'no', actual: 'yes' }],
        });
        expect(now?.title).toBe(t.title);
      }
      expect(after.find((a) => a.id === plaintext[0]?.id)?.status).toBe('accepted');
      expect((await c.get<ApiRecord[]>(`/threat-models/${d.modelId}/mitigations`)).body).toEqual(mitigationsBefore);

      // A second run with nothing changed writes nothing (FR-008): same reasons, same timestamps.
      const settled = await threatsOf(d.modelId);
      expect((await c.post(GENERATE(d.modelId), {})).body).toMatchObject({ created: 0, newly_stale: 0, no_longer_stale: 0 });
      expect(await threatsOf(d.modelId)).toEqual(settled);

      // Back to "not assessed": the same threats are current again, and nothing is duplicated.
      expect((await setFlow(d.writes.id, {})).status).toBe(200);
      const undo = await c.post<{ created: number; no_longer_stale: number }>(GENERATE(d.modelId), {});
      expect(undo.body.created).toBe(0);
      expect(undo.body.no_longer_stale).toBeGreaterThanOrEqual(plaintext.length);
      const restored = await forElement(d.modelId, d.writes.id);
      expect(restored).toHaveLength(before.length);
      expect(restored.every((t) => t.stale === null)).toBe(true);
    });

    it('flags the process rules’ threats stale, with the element type, when a node becomes a data store', async () => {
      const d = await diagram();
      await c.post(GENERATE(d.modelId), {});
      const asProcess = await forElement(d.modelId, d.api.id);
      expect(asProcess.length).toBeGreaterThan(0);
      expect((await c.patch(`/elements/${d.api.id}`, { type: 'data_store' })).status).toBe(200);
      const run = await c.post<{ created: number; newly_stale: number }>(GENERATE(d.modelId), {});
      expect(run.body.newly_stale).toBe(asProcess.length);
      expect(run.body.created).toBeGreaterThan(0);
      const now = await forElement(d.modelId, d.api.id);
      for (const t of asProcess) {
        expect(now.find((a) => a.id === t.id)?.stale).toEqual({
          reason: 'conditions_unmet',
          unmet: [{ fact: 'element_type', required: 'process', actual: 'data_store' }],
        });
      }
    });

    it('does not let a client write stale (FR-010)', async () => {
      const d = await diagram();
      await c.post(GENERATE(d.modelId), {});
      const [target] = await threatsOf(d.modelId);
      const patch = await c.patch<{ error: string }>(`/threats/${target?.id}`, { stale: null });
      expect(patch.status).toBe(400);
      expect(patch.body.error).toContain('stale');
      const create = await c.post<{ error: string }>('/threats', {
        threat_model_id: d.modelId,
        category: 'Spoofing',
        title: 'x',
        likelihood: 'Low',
        impact: 'Low',
        origin: 'manual',
        stale: { reason: 'rule_unknown' },
      });
      expect(create.status).toBe(400);
      expect(create.body.error).toContain('stale');
    });

    it('still refuses to delete an element that has generated threats, with the new wording (FR-013)', async () => {
      const d = await diagram();
      await c.post(GENERATE(d.modelId), {});
      const res = await c.raw(`/elements/${d.api.id}`, { method: 'DELETE' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'This element still has threats, or data flows that would be deleted with it have threats; delete those threats first',
      });
    });
  });

  describe('a generated threat’s provenance (US4, FR-009)', () => {
    const REFUSED = { error: 'A rule-generated threat stays linked to its element and rule' };

    async function generated() {
      const d = await diagram();
      await c.post(GENERATE(d.modelId), {});
      const [target] = ThreatRecord.array().parse((await c.get(`/threat-models/${d.modelId}/threats`)).body);
      if (!target) throw new Error('no threat generated');
      return { d, target };
    }

    it('refuses to change its library_ref, and nothing changes', async () => {
      const { target } = await generated();
      const res = await c.patch(`/threats/${target.id}`, { library_ref: 'something-else' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual(REFUSED);
      expect((await c.get(`/threats/${target.id}`)).body).toMatchObject({ library_ref: target.library_ref, element_id: target.element_id });
    });

    it('refuses to move it to another element', async () => {
      const { d, target } = await generated();
      const other = target.element_id === d.api.id ? d.store.id : d.api.id;
      const res = await c.patch(`/threats/${target.id}`, { element_id: other });
      expect(res.status).toBe(400);
      expect(res.body).toEqual(REFUSED);
      expect((await c.get(`/threats/${target.id}`)).body).toMatchObject({ element_id: target.element_id });
    });

    it('refuses to detach it from its element', async () => {
      const { target } = await generated();
      const res = await c.patch(`/threats/${target.id}`, { element_id: null });
      expect(res.status).toBe(400);
      expect(res.body).toEqual(REFUSED);
    });

    it('accepts the values it already has, and every other edit', async () => {
      const { target } = await generated();
      // Mitigated needs an implemented mitigation (spec FR-003); the rule's suggested ones are proposed.
      const [suggested] = (await c.get<ApiRecord[]>(`/threats/${target.id}/mitigations`)).body;
      expect((await c.patch(`/mitigations/${suggested?.id}`, { status: 'implemented' })).status).toBe(200);
      const res = await c.patch(`/threats/${target.id}`, { library_ref: target.library_ref, element_id: target.element_id, title: 'Renamed by hand', status: 'mitigated' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ title: 'Renamed by hand', status: 'mitigated', origin: 'rule' });
    });

    it('still refuses to create a threat with origin rule or ai, and to change origin', async () => {
      const { d, target } = await generated();
      for (const origin of ['rule', 'ai']) {
        const res = await c.post('/threats', { threat_model_id: d.modelId, category: 'Spoofing', title: 'Faked', likelihood: 'Low', impact: 'Low', origin });
        expect(res.status, origin).toBe(400);
      }
      expect((await c.patch(`/threats/${target.id}`, { origin: 'manual' })).status).toBe(400);
    });

    it('lets a manual threat keep changing its library_ref and element, as before', async () => {
      const d = await diagram();
      const manual = (
        await c.post<ApiRecord>('/threats', { threat_model_id: d.modelId, element_id: d.api.id, library_ref: 'a', category: 'Spoofing', title: 'Mine', likelihood: 'Low', impact: 'Low', origin: 'manual' })
      ).body;
      const res = await c.patch(`/threats/${manual.id}`, { library_ref: 'b', element_id: d.store.id });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ library_ref: 'b', element_id: d.store.id });
    });
  });
});
