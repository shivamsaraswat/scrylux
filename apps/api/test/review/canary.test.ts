import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/app.js';
import db from '../../src/db.js';
import { login, startTestServer, type TestServer } from '../contract/helpers.js';
import { accountIdOf, client, type ApiRecord, type V1Client } from '../contract/v1/helpers.js';
import { seedReviewDraft, type ReviewDraft } from '../fixtures/review/seed.js';

// A recognizable text (not the word Milestone 4's canary test scans the whole database for, since the records this test leaves are real rows), run through every way the review can end (Phase 3 Milestone 5, SC-006): the names and statements that a draft proposes appear in no log
// line and no error answer, and the rationale and the quoted text of a source appear in no log line, no error answer, no Scrylux file, no OTM file and no
// report. (A name or a statement that was accepted is an ordinary record, so it is in the files and reports, by design: FR-023.)

const NAME = 'TRACER-NAME-4f1c9a';
const STATEMENT = 'TRACER-STATEMENT-7b2e0d';
const RATIONALE = 'TRACER-RATIONALE-91ad3c';
const QUOTE = 'TRACER-QUOTE-5e77f2 is what the document says here';

describe('the review leaks no text of a draft', () => {
  let server: TestServer;
  let c: V1Client;
  let account: number;
  let threatModel: string;
  let draft: ReviewDraft;
  let printed: string[];
  let answers: string[];

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
    await db.query(`UPDATE draft_items SET rationale = $2 || ' ' || coalesce(name, ''), name = CASE WHEN name IS NULL THEN NULL ELSE name || ' ' || $3 END WHERE draft_id = $1`, [draft.draftId, RATIONALE, NAME]);
    await db.query(`UPDATE draft_items SET body = $2 WHERE draft_id = $1 AND kind = 'assumption'`, [draft.draftId, STATEMENT]);
    // The chunk keeps its length, which its offsets say.
    await db.query(`UPDATE chunks SET text = left($2 || repeat('x', 400), char_length(text)) WHERE id = $1`, [draft.chunkId, `${QUOTE}. `]);
    printed = [];
    answers = [];
    for (const method of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  const call = async (method: 'get' | 'post' | 'patch' | 'del', path: string, body?: unknown) => {
    const res = await (method === 'del' ? c.del(path) : method === 'get' ? c.get(path) : c[method](path, body));
    if (res.status >= 400) answers.push(JSON.stringify(res.body));
    return res;
  };
  const decide = (body: unknown) => call('post', `/threat-models/${threatModel}/draft/decisions`, body);

  it('through accept, edits, every refusal, reject, undecide, the records and the provenance', async () => {
    const accept = (ids: readonly string[], seen = 'new', edits?: Record<string, unknown>) => ({
      action: 'accept',
      draft_id: draft.draftId,
      items: ids.map((id) => ({ id, seen, ...(edits?.[id] === undefined ? {} : { edits: edits[id] }) })),
    });
    // Refusals first: the page was out of date, an item that needs another, a body that is wrong.
    await decide({ ...accept([draft.id.api]), draft_id: randomUUID() });
    await decide(accept([draft.id.flowIn]));
    await decide(accept([draft.id.api], 'matched'));
    await decide({ ...accept([draft.id.api]), name: NAME });
    await decide(accept([draft.id.browser], 'new', { [draft.id.browser]: { statement: NAME } }));
    // Then what succeeds.
    await decide(accept([draft.id.boundary, draft.id.api, draft.id.browser, draft.id.flowIn, draft.id.asset, draft.id.assumption], 'new', { [draft.id.browser]: { name: `${NAME} edited` } }));
    await decide(accept([draft.id.browser]));
    await decide({ action: 'reject', draft_id: draft.draftId, items: [{ id: draft.id.database }] });
    await decide({ action: 'reject', draft_id: draft.draftId, items: [{ id: draft.id.database }] });
    await decide({ action: 'undecide', draft_id: draft.draftId, items: [{ id: draft.id.database }] });
    // The records a person handles, and where an accept's records came from.
    const asset = (await call('post', `/threat-models/${threatModel}/assets`, { name: `By hand ${NAME}`, description: STATEMENT })).body as ApiRecord;
    await call('post', `/threat-models/${threatModel}/assets`, { name: `By hand ${NAME}`, description: STATEMENT });
    await call('patch', `/assets/${asset.id}`, { name: 'Renamed' });
    await call('post', `/threat-models/${threatModel}/assumptions`, { statement: STATEMENT });
    await call('post', `/threat-models/${threatModel}/assumptions`, { statement: STATEMENT });
    await call('del', `/assets/${asset.id}`);
    expect((await call('get', `/threat-models/${threatModel}/provenance`)).status).toBe(200);
    await db.query('DELETE FROM chunks WHERE id = $1', [draft.chunkId]);
    expect((await call('get', `/threat-models/${threatModel}/provenance`)).status).toBe(200);

    const everything = [...printed, ...answers].join('\n');
    for (const text of [NAME, STATEMENT, RATIONALE, QUOTE]) expect(everything, text).not.toContain(text);
    expect(answers.length).toBeGreaterThan(6);
  });

  it('in no Scrylux file, no OTM file and no report: neither the rationale nor the text of a source, and no provenance', async () => {
    await decide({ action: 'accept', draft_id: draft.draftId, items: [draft.id.boundary, draft.id.api, draft.id.asset, draft.id.assumption].map((id) => ({ id, seen: 'new' })) });
    const exportOf = async (format: string) => (await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/export?format=${format}`, { headers: { Authorization: `Bearer ${await login(server.baseUrl)}` } })).text();
    const reportOf = async (format: string) => (await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/report?format=${format}`, { headers: { Authorization: `Bearer ${await login(server.baseUrl)}` } })).text();
    const documents = [await exportOf('scrylux'), await exportOf('otm'), await reportOf('markdown'), await reportOf('html')];
    for (const document of documents) {
      expect(document.length).toBeGreaterThan(100);
      for (const text of [RATIONALE, QUOTE, 'provenance', 'accepted_by', 'rationale']) expect(document, text).not.toContain(text);
    }
    // The accepted records themselves, which are ordinary records, are in the file: that is what an export carries.
    expect(documents[0]).toContain(STATEMENT);
    expect(documents[0]).toContain(NAME);
  });
});
