import { randomUUID } from 'node:crypto';
import { DraftRecord } from '@scrylux/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { CHUNK_TEXTS } from '../../fixtures/extract-system/answers.js';
import { seedDraft, seedReadySource, seedUnreadySource } from '../../fixtures/extract-system/seed.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { accountIdOf, client, type V1Client } from './helpers.js';
import { LOCAL_PROVIDER } from './jobs-helpers.js';

// Reading and discarding a draft (Phase 3 Milestone 4, US2, US7; FR-053 to FR-056, FR-062, FR-066, SC-005): every field of the record, a citation's
// quote read from its chunk, a deleted source's citations shown as such and never dropped, whether the sources have changed derived from what is
// there now, and a discard that touches only the draft.

describe('/api/v1/threat-models/{id}/draft', () => {
  let server: TestServer;
  let c: V1Client;
  let token: string;
  let account: number;
  let threatModel: string;

  beforeAll(async () => {
    server = await startTestServer(app);
    token = await login(server.baseUrl);
    account = accountIdOf(token);
    c = client(server.baseUrl, token);
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    for (const [name, value] of Object.entries({ ...LOCAL_PROVIDER, JOBS_PER_ACCOUNT: '100', PROVIDER_CHECK_COOLDOWN: '0' })) vi.stubEnv(name, value);
    await db.query('TRUNCATE jobs, job_usage, workers, sources CASCADE');
    const project = (await c.post<{ id: string }>('/projects', { name: `p-${randomUUID()}` })).body;
    threatModel = (await c.post<{ id: string }>('/threat-models', { project_id: project.id, name: 'model' })).body.id;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const design = () => seedReadySource(account, threatModel, { name: 'design.md', chunks: [CHUNK_TEXTS.c1, CHUNK_TEXTS.c2, CHUNK_TEXTS.c3] });
  const draftOf = () => c.get<DraftRecord & { error?: string }>(`/threat-models/${threatModel}/draft`);

  describe('GET', () => {
    it('answers 404 with a fixed message when there is no draft, and 400 for an id that is not one, and 401 without a sign-in', async () => {
      const none = await draftOf();
      expect(none.status).toBe(404);
      expect(none.body.error).toBe('This threat model has no draft.');
      expect((await c.get('/threat-models/not-a-uuid/draft')).status).toBe(400);
      expect((await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/draft`)).status).toBe(401);
    });

    it('answers every field of the record (data-model.md)', async () => {
      const source = await design();
      const { draftId } = await seedDraft(account, threatModel, source);
      const res = await draftOf();
      expect(res.status).toBe(200);
      const draft = DraftRecord.parse(res.body);
      expect(draft).toMatchObject({
        id: draftId,
        threat_model_id: threatModel,
        started_by: { id: account },
        job_id: null,
        generation_model: 'seeded-model',
        prompt_version: 'extract-system/0123456789ab',
        path: 'whole',
        chunks_read: 3,
        chunks_available: 3,
        sources: [{ id: source.sourceId, name: 'design.md', read: true }],
        sources_deleted: 0,
        sources_changed: false,
        nothing_found: null,
        assets: [],
        assumptions: [],
        read_chunks: [{ source_id: source.sourceId, position: 0 }],
      });
      expect(draft.elements).toHaveLength(1);
      expect(draft.elements[0]).toMatchObject({ type: 'process', name: 'API', boundary_id: null, source_id: null, target_id: null, flags: [], rationale: 'The API serves the web application.' });
    });

    it('shows a citation’s quote, read from its chunk by the span the draft kept, with where the chunk is (FR-062)', async () => {
      const source = await design();
      await seedDraft(account, threatModel, source);
      const cited = (await draftOf()).body.elements[0]?.citations[0];
      expect(cited?.quote).toBe([...CHUNK_TEXTS.c1].slice(0, 20).join(''));
      expect(cited?.chunk).toMatchObject({ id: source.chunkIds[0], source_id: source.sourceId, source_name: 'design.md', position: 0, line_first: 1, line_last: 3, heading: 'Architecture', page_first: null });
    });

    it('stores no quote: a citation holds a span and nothing else (FR-054)', async () => {
      const { rows } = await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'draft_citations'`);
      expect(rows.map((r) => r.column_name)).not.toContain('quote');
      expect(rows.map((r) => r.column_name).filter((n) => /text|body|passage/.test(n))).toEqual([]);
    });

    it('shows a citation whose source was deleted as one with no chunk and no quote, and keeps the item and the draft (FR-054)', async () => {
      const source = await design();
      await seedDraft(account, threatModel, source);
      await db.query('DELETE FROM sources WHERE id = $1', [source.sourceId]);
      const draft = DraftRecord.parse((await draftOf()).body);
      expect(draft.elements).toHaveLength(1);
      expect(draft.elements[0]?.citations).toEqual([{ chunk: null, quote: null }]);
      expect(draft.sources).toEqual([]);
      expect(draft.sources_deleted).toBe(1);
      expect(draft.sources_changed).toBe(true);
      expect(draft.read_chunks).toEqual([]);
    });

    it('says the sources have not changed while they have not, and when one is added (FR-053)', async () => {
      await seedDraft(account, threatModel, await design());
      expect((await draftOf()).body.sources_changed).toBe(false);
      await seedReadySource(account, threatModel, { name: 'added.md', chunks: ['A document added after the draft was made.'] });
      expect((await draftOf()).body.sources_changed).toBe(true);
    });

    it('says they changed when a source that was left out has become ready, and not before (FR-053)', async () => {
      const source = await design();
      const { draftId } = await seedDraft(account, threatModel, source);
      const later = await seedReadySource(account, threatModel, { name: 'later.md', chunks: ['Ready now.'] });
      // The extraction considered it and left it out because it was not ready then.
      await db.query('INSERT INTO draft_sources (draft_id, source_id, read) VALUES ($1, $2, false)', [draftId, later.sourceId]);
      await db.query('UPDATE drafts SET sources_total = 2 WHERE id = $1', [draftId]);
      expect((await draftOf()).body.sources_changed).toBe(true);
    });

    it('does not say they changed for a source that was left out and is still not ready', async () => {
      const source = await design();
      const { draftId } = await seedDraft(account, threatModel, source);
      const failed = await seedUnreadySource(account, threatModel, 'failed');
      await db.query('INSERT INTO draft_sources (draft_id, source_id, read) VALUES ($1, $2, false)', [draftId, failed]);
      await db.query('UPDATE drafts SET sources_total = 2 WHERE id = $1', [draftId]);
      const draft = (await draftOf()).body;
      expect(draft.sources_changed).toBe(false);
      expect(draft.sources).toHaveLength(2);
      expect(draft.sources.find((s) => s.id === failed)).toMatchObject({ read: false });
      expect(draft.sources.find((s) => s.id === source.sourceId)).toMatchObject({ name: 'design.md', read: true });
    });

    it('does not decide it from times: a source that was added before the draft was made, but not considered, counts (research #13)', async () => {
      const source = await design();
      // Made after the second source was added, which the extraction did not consider: it appeared while the model was answering.
      await seedReadySource(account, threatModel, { name: 'during.md', chunks: ['Added while the model answered.'] });
      await seedDraft(account, threatModel, source);
      expect((await draftOf()).body.sources_changed).toBe(true);
    });
  });

  describe('DELETE', () => {
    it('discards the draft and everything under it, and answers 204 (FR-055)', async () => {
      const source = await design();
      const { draftId } = await seedDraft(account, threatModel, source);
      const res = await c.del(`/threat-models/${threatModel}/draft`);
      expect(res.status).toBe(204);
      expect((await draftOf()).status).toBe(404);
      for (const [table, column] of [['drafts', 'id'], ['draft_sources', 'draft_id'], ['draft_read_chunks', 'draft_id'], ['draft_items', 'draft_id']]) {
        const { rows } = await db.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [draftId]);
        expect(rows, table).toHaveLength(0);
      }
    });

    it('answers 404 when there is no draft, 400 for an id that is not one, and 401 without a sign-in', async () => {
      expect((await c.del(`/threat-models/${threatModel}/draft`)).status).toBe(404);
      expect((await c.del('/threat-models/not-a-uuid/draft')).status).toBe(400);
      expect((await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/draft`, { method: 'DELETE' })).status).toBe(401);
    });

    it('does not stop an extraction that is queued or running, which makes a new draft if it succeeds', async () => {
      await seedDraft(account, threatModel, await design());
      // A draft that exists does not stop a start: the new draft replaces it when it succeeds.
      expect((await c.post(`/threat-models/${threatModel}/extraction`)).status).toBe(201);
      expect((await c.del(`/threat-models/${threatModel}/draft`)).status).toBe(204);
      const { rows } = await db.query<{ state: string }>(`SELECT state FROM jobs WHERE kind = 'extract_system'`);
      expect(rows).toEqual([{ state: 'queued' }]);
    });

    it('changes nothing of the threat model, and the sources stay (FR-050)', async () => {
      const source = await design();
      await db.query(`INSERT INTO elements (threat_model_id, type, name) VALUES ($1, 'process', 'Existing')`, [threatModel]);
      await seedDraft(account, threatModel, source);
      await c.del(`/threat-models/${threatModel}/draft`);
      expect((await db.query('SELECT 1 FROM elements WHERE threat_model_id = $1', [threatModel])).rows).toHaveLength(1);
      expect((await db.query('SELECT 1 FROM sources WHERE id = $1', [source.sourceId])).rows).toHaveLength(1);
    });

    it('writes one line, with who, what and which threat model (FR-065)', async () => {
      await seedDraft(account, threatModel, await design());
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
      await c.del(`/threat-models/${threatModel}/draft`);
      const mine = lines.filter((line) => line.includes('"event":"extraction"'));
      expect(mine.map((line) => JSON.parse(line) as unknown)).toEqual([{ event: 'extraction', action: 'discard', account_id: account, threat_model_id: threatModel }]);
    });
  });

  describe('exports and reports (FR-067)', () => {
    it('hold nothing of the draft: not in the Scrylux file, the OTM file, or the Markdown and HTML reports', async () => {
      await seedDraft(account, threatModel, await design());
      const text = async (path: string) => {
        const res = await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
        expect(res.status, path).toBe(200);
        return res.text();
      };
      for (const path of ['export?format=scrylux', 'export?format=otm', 'report?format=markdown', 'report?format=html']) {
        const body = await text(path);
        expect(body, path).not.toContain('The API serves the web application.');
        expect(body, path).not.toContain('seeded-model');
      }
    });
  });

  describe('deletion of the threat model and the project (FR-056)', () => {
    it('removes the draft with the threat model', async () => {
      const { draftId } = await seedDraft(account, threatModel, await design());
      expect((await c.del(`/threat-models/${threatModel}`)).status).toBe(204);
      expect((await db.query('SELECT 1 FROM drafts WHERE id = $1', [draftId])).rows).toHaveLength(0);
    });
  });
});
