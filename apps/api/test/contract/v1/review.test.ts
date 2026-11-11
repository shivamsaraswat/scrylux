import { randomUUID } from 'node:crypto';
import { DecisionResult, DraftRecord } from '@scrylux/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../src/app.js';
import { seedReviewDraft, type ReviewDraft } from '../../fixtures/review/seed.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { accountIdOf, client, type V1Client } from './helpers.js';

// The decision route (Phase 3 Milestone 5, US2, FR-007, FR-019, FR-022, FR-024): the body's shapes and every status of contracts/http-api.md, one
// log line per request with counts and no text, and a review that needs no provider and no worker.

describe('POST /api/v1/threat-models/{id}/draft/decisions', () => {
  let server: TestServer;
  let c: V1Client;
  let account: number;
  let threatModel: string;
  let draft: ReviewDraft;
  let lines: string[];

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
    // A review reads a draft that is stored: it needs no generation provider, no embedding provider and no worker (FR-024).
    for (const name of Object.keys(process.env).filter((key) => key.startsWith('LLM_') || key.startsWith('EMBEDDING_'))) vi.stubEnv(name, '');
    const project = (await c.post<{ id: string }>('/projects', { name: `p-${randomUUID()}` })).body;
    threatModel = (await c.post<{ id: string }>('/threat-models', { project_id: project.id, name: 'model' })).body.id;
    draft = await seedReviewDraft(account, threatModel);
    lines = [];
    const original = console.log;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(' ');
      lines.push(line);
      if (!line.startsWith('{"event":"')) original(...args);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const decide = (body: unknown) => c.post<unknown>(`/threat-models/${threatModel}/draft/decisions`, body);
  const accept = (ids: readonly string[], seen = 'new') => ({ action: 'accept', draft_id: draft.draftId, items: ids.map((id) => ({ id, seen })) });
  const decisionLines = () => lines.filter((line) => line.startsWith('{"event":"decision"')).map((line) => JSON.parse(line) as Record<string, unknown>);

  it('answers 200 with the counts and the draft as it now stands, the items accepted', async () => {
    const res = await decide(accept([draft.id.boundary, draft.id.api]));
    expect(res.status).toBe(200);
    const result = DecisionResult.parse(res.body);
    expect(result).toMatchObject({ created: 2, changed: 0, unlinked_holders: [] });
    expect(DraftRecord.parse(result.draft).review[draft.id.api]).toMatchObject({ state: 'accepted', outcome: 'created' });
    const elements = (await c.get<Array<{ name: string }>>(`/threat-models/${threatModel}/elements`)).body.map((element) => element.name).sort();
    expect(elements).toEqual(['API', 'Internal network']);
  });

  it('logs one line per request: the account, the action, the threat model and counts, and no text', async () => {
    await decide(accept([draft.id.browser]));
    const logged = decisionLines();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toEqual({ event: 'decision', account_id: account, action: 'accept', threat_model_id: threatModel, items: 1, created: 1, changed: 0 });
    expect(lines.join('\n')).not.toContain('Browser');
  });

  it('refuses a body that does not match: no draft id, no items, an unknown field, an action it does not know', async () => {
    expect((await decide({})).status).toBe(400);
    expect((await decide({ action: 'accept', draft_id: draft.draftId, items: [] })).status).toBe(400);
    expect((await decide({ ...accept([draft.id.browser]), name: 'x' })).status).toBe(400);
    expect((await decide({ ...accept([draft.id.browser]), action: 'delete' })).status).toBe(400);
    expect((await decide({ action: 'accept', draft_id: draft.draftId, items: [{ id: draft.id.browser }] })).status).toBe(400);
    expect(decisionLines()).toHaveLength(0);
  });

  it('answers 404 for an unknown threat model and 400 for an id that is not one, and 401 without a sign-in', async () => {
    expect((await c.post(`/threat-models/${randomUUID()}/draft/decisions`, accept([draft.id.browser]))).status).toBe(404);
    expect((await c.post('/threat-models/not-a-uuid/draft/decisions', accept([draft.id.browser]))).status).toBe(400);
    const anonymous = await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/draft/decisions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(accept([draft.id.browser])) });
    expect(anonymous.status).toBe(401);
  });

  it('answers 409 with a fixed message for an out-of-date draft, a decided item and a missing dependency', async () => {
    const stale = await decide({ ...accept([draft.id.browser]), draft_id: randomUUID() });
    expect(stale).toEqual({ status: 409, body: { error: 'This draft was replaced or discarded' } });
    expect((await decide(accept([draft.id.flowIn]))).body).toEqual({ error: '1 items need elements that are not in the threat model' });
    await decide(accept([draft.id.browser]));
    expect((await decide(accept([draft.id.browser]))).body).toEqual({ error: '1 of the items were already decided' });
    expect((await decide(accept([randomUUID()]))).status).toBe(404);
  });

  it('rejects items and returns them to undecided, answering the draft with their states and logging counts', async () => {
    const rejected = await decide({ action: 'reject', draft_id: draft.draftId, items: [{ id: draft.id.browser }, { id: draft.id.asset }] });
    expect(rejected.status).toBe(200);
    expect(DecisionResult.parse(rejected.body)).toMatchObject({ created: 0, changed: 0, unlinked_holders: [] });
    expect(DraftRecord.parse((rejected.body as { draft: unknown }).draft).review[draft.id.browser]).toMatchObject({ state: 'rejected', decided_by: { id: account } });
    expect(await c.get<unknown[]>(`/threat-models/${threatModel}/elements`)).toEqual({ status: 200, body: [] });

    const back = await decide({ action: 'undecide', draft_id: draft.draftId, items: [{ id: draft.id.browser }] });
    expect(back.status).toBe(200);
    expect(DraftRecord.parse((back.body as { draft: unknown }).draft).review[draft.id.browser]).toMatchObject({ state: 'undecided', decided_by: null });

    expect(decisionLines()).toEqual([
      { event: 'decision', account_id: account, action: 'reject', threat_model_id: threatModel, items: 2, created: 0, changed: 0 },
      { event: 'decision', account_id: account, action: 'undecide', threat_model_id: threatModel, items: 1, created: 0, changed: 0 },
    ]);
    expect(lines.join('\n')).not.toContain('Browser');
  });

  it('refuses a reject or an undecide of items in the wrong state, a draft that is not the current one, and a body with seen or edits', async () => {
    await decide({ action: 'reject', draft_id: draft.draftId, items: [{ id: draft.id.browser }] });
    expect((await decide({ action: 'reject', draft_id: draft.draftId, items: [{ id: draft.id.browser }] })).body).toEqual({ error: '1 of the items were already decided' });
    expect((await decide({ action: 'undecide', draft_id: draft.draftId, items: [{ id: draft.id.api }] })).body).toEqual({ error: '1 of the items were already decided' });
    expect((await decide({ action: 'reject', draft_id: randomUUID(), items: [{ id: draft.id.api }] })).body).toEqual({ error: 'This draft was replaced or discarded' });
    expect((await decide({ action: 'reject', draft_id: draft.draftId, items: [{ id: draft.id.api, seen: 'new' }] })).status).toBe(400);
    expect((await decide({ action: 'undecide', draft_id: draft.draftId, items: [{ id: draft.id.api, edits: {} }] })).status).toBe(400);
  });
});
