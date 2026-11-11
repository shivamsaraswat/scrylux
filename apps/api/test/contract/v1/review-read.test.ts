import { randomUUID } from 'node:crypto';
import { DraftRecord } from '@scrylux/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import { seedReviewDraft, seedElement, type ReviewDraft } from '../../fixtures/review/seed.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { accountIdOf, client, type V1Client } from './helpers.js';

// Reading a draft with its review (Phase 3 Milestone 5, US1, FR-001 to FR-004): GET …/draft carries each item's state and comparison, and
// everything it said before is unchanged.

describe('GET /api/v1/threat-models/{id}/draft, with its review', () => {
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
    const project = (await c.post<{ id: string }>('/projects', { name: `p-${randomUUID()}` })).body;
    threatModel = (await c.post<{ id: string }>('/threat-models', { project_id: project.id, name: 'model' })).body.id;
    draft = await seedReviewDraft(account, threatModel);
  });

  const read = () => c.get<unknown>(`/threat-models/${threatModel}/draft`);

  it('carries a review for every element, asset and assumption of the draft, and parses as a DraftRecord', async () => {
    const res = await read();
    expect(res.status).toBe(200);
    const record = DraftRecord.parse(res.body);
    const items = [...record.elements.map((e) => e.id), ...record.assets.map((a) => a.id), ...record.assumptions.map((a) => a.id)];
    expect(items).toHaveLength(8);
    expect(Object.keys(record.review).sort()).toEqual([...items].sort());
    for (const id of items) expect(record.review[id]).toMatchObject({ state: 'undecided', comparison: 'new' });
  });

  it('shows what the threat model holds: a matched element with its differences', async () => {
    const existing = await seedElement(threatModel, { type: 'process', name: 'API', flags: { internet_facing: true } });
    const record = DraftRecord.parse((await read()).body);
    expect(record.review[draft.id.api]).toMatchObject({ comparison: 'matched', matched_id: existing });
    expect(record.review[draft.id.api]?.differences?.flags).toEqual([
      { flag: 'internet_facing', proposed: false, current: true },
      { flag: 'requires_authentication', proposed: true, current: null },
    ]);
  });

  it('leaves every earlier field as it was', async () => {
    const record = DraftRecord.parse((await read()).body);
    expect(record).toMatchObject({
      id: draft.draftId,
      threat_model_id: threatModel,
      generation_model: 'seeded-model',
      path: 'whole',
      sources_changed: false,
      nothing_found: null,
    });
    expect(record.elements.find((e) => e.id === draft.id.api)).toMatchObject({ name: 'API', boundary_id: draft.id.boundary });
  });

  it('is still 404 for a threat model with no draft, 400 for a bad id and 401 without a sign-in', async () => {
    const project = (await c.post<{ id: string }>('/projects', { name: `p-${randomUUID()}` })).body;
    const empty = (await c.post<{ id: string }>('/threat-models', { project_id: project.id, name: 'empty' })).body.id;
    expect((await c.get(`/threat-models/${empty}/draft`)).status).toBe(404);
    expect((await c.get('/threat-models/not-a-uuid/draft')).status).toBe(400);
    expect((await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/draft`)).status).toBe(401);
  });
});
