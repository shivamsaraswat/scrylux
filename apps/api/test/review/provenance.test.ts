import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import db from '../../src/db.js';
import { accept } from '../../src/review/decide.js';
import { seedAccount, seedThreatModel } from '../fixtures/extract-system/seed.js';
import { acceptBody, recordsOf, seedAsset, seedElement, seedReviewDraft, type ReviewDraft } from '../fixtures/review/seed.js';

// What an accept writes as provenance (Phase 3 Milestone 5, US2, FR-017, FR-018, SC-004; research #8): a row for a record it created and one for
// each flag it set, with the draft's rationale, who accepted it and when, and the citations as the draft keeps them, never a quote's text.

let account: number;
let threatModelId: string;
let draft: ReviewDraft;

afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  account = await seedAccount();
  threatModelId = (await seedThreatModel(account)).threatModelId;
  draft = await seedReviewDraft(account, threatModelId);
});

const run = async (ids: readonly string[]) => accept(threatModelId, account, await acceptBody(threatModelId, draft.draftId, ids));

interface Mark {
  element_id: string | null;
  asset_id: string | null;
  assumption_id: string | null;
  flag: string | null;
  rationale: string;
  accepted_by: number;
  accepted_at: Date;
  citations: Array<{ position: number; chunk_id: string | null; quote_start: number; quote_end: number }>;
}

async function marks(): Promise<Mark[]> {
  const { rows } = await db.query<Mark>(
    `SELECT p.element_id, p.asset_id, p.assumption_id, p.flag, p.rationale, p.accepted_by, p.accepted_at,
            coalesce((SELECT json_agg(json_build_object('position', c.position, 'chunk_id', c.chunk_id, 'quote_start', c.quote_start, 'quote_end', c.quote_end) ORDER BY c.position)
                      FROM provenance_citations c WHERE c.provenance_id = p.id), '[]'::json) AS citations
     FROM provenance p WHERE p.threat_model_id = $1 ORDER BY p.flag NULLS FIRST, p.id`,
    [threatModelId],
  );
  return rows;
}

describe('a record an accept created', () => {
  it('has a row with the item’s rationale, the account and time, and its citations copied as chunk and span', async () => {
    await run([draft.id.browser]);
    const records = await recordsOf(threatModelId);
    const [mark, ...rest] = await marks();
    expect(rest).toEqual([]);
    expect(mark).toMatchObject({ element_id: records.byName('Browser')?.id, flag: null, rationale: 'Why Browser is proposed.', accepted_by: account });
    expect(mark?.accepted_at).toBeInstanceOf(Date);
    expect(mark?.citations).toEqual([{ position: 0, chunk_id: draft.chunkId, quote_start: 0, quote_end: 20 }]);
  });

  it('has one more row for each proposed flag the new element keeps, with that flag’s citations and the item’s rationale', async () => {
    await run([draft.id.boundary, draft.id.api]);
    const api = (await recordsOf(threatModelId)).byName('API');
    const forApi = (await marks()).filter((mark) => mark.element_id === api?.id);
    expect(forApi.map((mark) => mark.flag).sort((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual([null, 'internet_facing', 'requires_authentication']);
    const flag = forApi.find((mark) => mark.flag === 'requires_authentication');
    expect(flag?.rationale).toBe('Why API is proposed.');
    expect(flag?.citations).toEqual([{ position: 0, chunk_id: draft.chunkId, quote_start: 4, quote_end: 30 }]);
    expect(forApi.find((mark) => mark.flag === 'internet_facing')?.citations).toEqual([{ position: 0, chunk_id: draft.chunkId, quote_start: 60, quote_end: 100 }]);
  });

  it('is marked for an asset and an assumption, one row each', async () => {
    await run([draft.id.asset, draft.id.assumption]);
    const records = await recordsOf(threatModelId);
    const found = await marks();
    expect(found).toHaveLength(2);
    expect(found.find((mark) => mark.asset_id !== null)).toMatchObject({ asset_id: records.assets[0]?.id, flag: null, rationale: 'Why Session tokens is proposed.' });
    expect(found.find((mark) => mark.assumption_id !== null)).toMatchObject({ assumption_id: records.assumptions[0]?.id, flag: null });
  });

  it('copies a citation whose chunk was deleted before the accept, with no chunk', async () => {
    await db.query('DELETE FROM chunks WHERE id = $1', [draft.chunkId]);
    await run([draft.id.browser]);
    expect((await marks())[0]?.citations).toEqual([{ position: 0, chunk_id: null, quote_start: 0, quote_end: 20 }]);
  });
});

describe('an element that was already in the model', () => {
  it('has a row for each flag the accept filled in, and no row for the element as a whole', async () => {
    await seedElement(threatModelId, { type: 'process', name: 'API', flags: { internet_facing: true } });
    await run([draft.id.api]);
    const found = await marks();
    expect(found.map((mark) => mark.flag)).toEqual(['requires_authentication']);
    expect(found[0]?.citations).toEqual([{ position: 0, chunk_id: draft.chunkId, quote_start: 4, quote_end: 30 }]);
  });

  it('has none when no flag was filled in, and none for a matched asset or assumption', async () => {
    await seedElement(threatModelId, { type: 'process', name: 'API', flags: { requires_authentication: true, internet_facing: false } });
    await seedAsset(threatModelId, 'Session tokens');
    await db.query('INSERT INTO assumptions (threat_model_id, statement) VALUES ($1, $2)', [threatModelId, 'The database is not exposed.']);
    await run([draft.id.api, draft.id.asset, draft.id.assumption]);
    expect(await marks()).toEqual([]);
  });
});

describe('no text', () => {
  it('stores no text of a source: no column of the provenance tables holds a quote', async () => {
    await run([draft.id.boundary, draft.id.api]);
    const text = JSON.stringify(await marks());
    expect(text).not.toContain('session tokens');
    expect(text).not.toContain('The API serves');
    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('provenance', 'provenance_citations') AND data_type = 'text'`,
    );
    expect(rows.map((row) => `${row.table_name}.${row.column_name}`).sort()).toEqual(['provenance.flag', 'provenance.rationale']);
  });
});
