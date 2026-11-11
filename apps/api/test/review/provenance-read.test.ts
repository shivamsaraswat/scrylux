import { randomUUID } from 'node:crypto';
import { ProvenanceRecord } from '@scrylux/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../../src/app.js';
import db from '../../src/db.js';
import { login, startTestServer, type TestServer } from '../contract/helpers.js';
import { accountIdOf, client, type ApiRecord, type V1Client } from '../contract/v1/helpers.js';
import { REVIEW_CHUNK_TEXT, seedReviewDraft, type ReviewDraft } from '../fixtures/review/seed.js';

// Reading where accepted records came from, and what removes it (Phase 3 Milestone 5, US6; FR-017, FR-018, SC-004): the provenance outlives the draft, shows
// its citations as a draft does, and a person's later change to a flag removes that flag's mark and nothing else.

describe('GET /api/v1/threat-models/{id}/provenance', () => {
  let server: TestServer;
  let c: V1Client;
  let account: number;
  let threatModel: string;
  let draft: ReviewDraft;

  beforeAll(async () => {
    server = await startTestServer(app);
    const token = await login(server.baseUrl);
    account = accountIdOf(token);
    c = client(server.baseUrl, token);
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    const project = (await c.post<ApiRecord>('/projects', { name: `p-${randomUUID()}` })).body;
    threatModel = (await c.post<ApiRecord>('/threat-models', { project_id: project.id, name: 'model' })).body.id;
    draft = await seedReviewDraft(account, threatModel);
  });

  const accept = (ids: readonly string[], edits: Record<string, unknown> = {}) =>
    c.post(`/threat-models/${threatModel}/draft/decisions`, { action: 'accept', draft_id: draft.draftId, items: ids.map((id) => ({ id, seen: 'new', ...(edits[id] === undefined ? {} : { edits: edits[id] }) })) });
  const read = async () => ProvenanceRecord.array().parse((await c.get<unknown[]>(`/threat-models/${threatModel}/provenance`)).body);
  const elementNamed = async (name: string) => (await c.get<Array<{ id: string; name: string; properties: { flags?: Record<string, boolean> } }>>(`/threat-models/${threatModel}/elements`)).body.find((e) => e.name === name);

  it('lists what an accept wrote, with the citations read from their chunks, after the draft is discarded', async () => {
    expect((await accept([draft.id.boundary, draft.id.api, draft.id.asset, draft.id.assumption])).status).toBe(200);
    expect((await c.del(`/threat-models/${threatModel}/draft`)).status).toBe(204);
    const found = await read();
    const api = await elementNamed('API');
    const record = found.find((row) => row.target.id === api?.id && row.flag === null);
    expect(record).toMatchObject({ target: { kind: 'element' }, rationale: 'Why API is proposed.', accepted_by: { id: account } });
    expect(record?.citations).toEqual([{ chunk: expect.objectContaining({ source_name: expect.stringMatching(/\.md$/) as unknown, position: 0 }) as unknown, quote: REVIEW_CHUNK_TEXT.slice(0, 20) }]);
    expect(found.filter((row) => row.target.id === api?.id).map((row) => row.flag).sort((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual([null, 'internet_facing', 'requires_authentication']);
    expect(found.map((row) => row.target.kind).sort()).toEqual(['asset', 'assumption', 'element', 'element', 'element', 'element']);
    const flag = found.find((row) => row.flag === 'requires_authentication');
    expect(flag?.citations[0]?.quote).toBe(REVIEW_CHUNK_TEXT.slice(4, 30));
  });

  it('lists the oldest first, ties by id', async () => {
    await accept([draft.id.boundary, draft.id.api, draft.id.browser]);
    const found = await read();
    const keys = found.map((row) => [row.accepted_at, row.id]);
    expect(keys).toEqual([...keys].sort((a, b) => (a[0] as string).localeCompare(b[0] as string) || (a[1] as string).localeCompare(b[1] as string)));
  });

  it('keeps a citation whose source was deleted, saying so, and stores none of its text', async () => {
    await accept([draft.id.browser]);
    await db.query('DELETE FROM chunks WHERE id = $1', [draft.chunkId]);
    const [record] = await read();
    expect(record?.citations).toEqual([{ chunk: null, quote: null }]);
    expect(JSON.stringify(record)).not.toContain('The API serves');
  });

  it('has no row for a record a person created, and none can be set by a request', async () => {
    const created = await c.post<ApiRecord>(`/threat-models/${threatModel}/assets`, { name: 'By hand', description: 'd' });
    expect(created.status).toBe(201);
    await c.post<ApiRecord>('/elements', { threat_model_id: threatModel, type: 'process', name: 'By hand too' });
    expect(await read()).toEqual([]);
    expect((await c.post('/elements', { threat_model_id: threatModel, type: 'process', name: 'x', provenance: { rationale: 'r' } })).status).toBe(400);
    expect((await c.post(`/threat-models/${threatModel}/assets`, { name: 'y', description: 'd', provenance: {} })).status).toBe(400);
    expect(await read()).toEqual([]);
  });

  describe('a person’s later change of a flag', () => {
    const flagsOf = async (elementId: string) => (await read()).filter((row) => row.target.id === elementId).map((row) => row.flag).sort((a, b) => (a ?? '').localeCompare(b ?? ''));

    it('removes the mark of the flag that was changed, and only that', async () => {
      await accept([draft.id.boundary, draft.id.api]);
      const api = (await elementNamed('API')) as { id: string; properties: { flags: Record<string, boolean> } };
      const res = await c.patch(`/elements/${api.id}`, { properties: { flags: { requires_authentication: true, internet_facing: true } } });
      expect(res.status).toBe(200);
      expect(await flagsOf(api.id)).toEqual([null, 'requires_authentication']);
    });

    it('removes the mark of a flag that was removed, and keeps those of the flags that were not touched', async () => {
      await accept([draft.id.boundary, draft.id.api]);
      const api = (await elementNamed('API')) as { id: string };
      await c.patch(`/elements/${api.id}`, { properties: { flags: { requires_authentication: true } } });
      expect(await flagsOf(api.id)).toEqual([null, 'requires_authentication']);
    });

    it('keeps the mark of a flag written again with the value it had, and of an element renamed', async () => {
      await accept([draft.id.boundary, draft.id.api]);
      const api = (await elementNamed('API')) as { id: string };
      await c.patch(`/elements/${api.id}`, { properties: { flags: { requires_authentication: true, internet_facing: false } } });
      await c.patch(`/elements/${api.id}`, { name: 'Renamed API' });
      expect(await flagsOf(api.id)).toEqual([null, 'internet_facing', 'requires_authentication']);
    });

    it('does the same through the batch endpoint, in the same transaction', async () => {
      await accept([draft.id.boundary, draft.id.api]);
      const api = (await elementNamed('API')) as { id: string };
      const res = await c.post(`/threat-models/${threatModel}/elements/batch`, { operations: [{ op: 'update', id: api.id, changes: { properties: { flags: { requires_authentication: false, internet_facing: false } } } }] });
      expect(res.status).toBe(200);
      expect(await flagsOf(api.id)).toEqual([null, 'internet_facing']);
    });

    it('leaves the whole element’s mark until the element itself is deleted, and then removes every row of it', async () => {
      await accept([draft.id.boundary, draft.id.api]);
      const api = (await elementNamed('API')) as { id: string };
      await c.patch(`/elements/${api.id}`, { properties: {} });
      expect(await flagsOf(api.id)).toEqual([null]);
      expect((await c.del(`/elements/${api.id}`)).status).toBe(204);
      expect(await flagsOf(api.id)).toEqual([]);
    });
  });

  it('answers 404 for an unknown threat model, 400 for an id that is not one, and 401 without a sign-in; an empty list when nothing was accepted', async () => {
    expect((await c.get(`/threat-models/${randomUUID()}/provenance`)).status).toBe(404);
    expect((await c.get('/threat-models/not-a-uuid/provenance')).status).toBe(400);
    expect((await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/provenance`)).status).toBe(401);
    expect(await read()).toEqual([]);
  });
});
