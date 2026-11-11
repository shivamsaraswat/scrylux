import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import db from '../../src/db.js';
import { accept } from '../../src/review/decide.js';
import { seedAccount, seedThreatModel } from '../fixtures/extract-system/seed.js';
import { acceptBody, recordsOf, reviewOf, seedAsset, seedElement, seedReviewDraft, type ReviewDraft } from '../fixtures/review/seed.js';

// Accepting items into the threat model (Phase 3 Milestone 5, US2; FR-006 to FR-010, FR-015, SC-001, SC-002): the records come from the stored
// draft, in one transaction, whatever order the request names them in, and nothing but what was accepted changes.

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
// The test database is shared, so only this threat model's threats and mitigations are counted.
const counts = async () =>
  (
    await db.query<{ t: string; m: string }>(
      'SELECT (SELECT count(*) FROM threats WHERE threat_model_id = $1) AS t, (SELECT count(*) FROM mitigations m JOIN threats t ON t.id = m.threat_id WHERE t.threat_model_id = $1) AS m',
      [threatModelId],
    )
  ).rows[0];

describe('a new element', () => {
  it('is created with the stored name, flags, boundary and endpoints, and no stored position', async () => {
    const result = await run([draft.id.boundary, draft.id.api]);
    expect(result).toMatchObject({ created: 2, changed: 0, unlinked_holders: [] });
    const records = await recordsOf(threatModelId);
    const boundary = records.byName('Internal network');
    const api = records.byName('API');
    expect(boundary).toMatchObject({ type: 'trust_boundary', layout: null, parent_boundary_id: null });
    expect(api).toMatchObject({ type: 'process', layout: null, parent_boundary_id: boundary?.id });
    expect(api?.properties.flags).toEqual({ requires_authentication: true, internet_facing: false });
    expect(records.elements).toHaveLength(2);
  });

  it('is accepted by the account, at a time, and the item reads accepted with the outcome created', async () => {
    await run([draft.id.browser]);
    const review = (await reviewOf(threatModelId))[draft.id.browser];
    expect(review).toMatchObject({ state: 'accepted', outcome: 'created', decided_by: { id: account }, comparison: null });
    expect(typeof review?.decided_at).toBe('string');
  });
});

describe('dependencies named in the same request', () => {
  it('goes in whatever the order of the request: a flow with both endpoints, a member with its boundary', async () => {
    const result = await run([draft.id.flowOut, draft.id.flowIn, draft.id.database, draft.id.api, draft.id.browser, draft.id.boundary]);
    expect(result.created).toBe(6);
    const records = await recordsOf(threatModelId);
    const boundary = records.byName('Internal network');
    expect(records.byName('API to Database')).toMatchObject({ type: 'data_flow', source_element_id: records.byName('API')?.id, target_element_id: records.byName('Database')?.id, layout: null });
    expect(records.byName('Browser to API')).toMatchObject({ source_element_id: records.byName('Browser')?.id, target_element_id: records.byName('API')?.id });
    expect(records.byName('Database')?.parent_boundary_id).toBe(boundary?.id);
  });

  it('attaches a flow to an existing element that exactly one matches, with no decision on that endpoint', async () => {
    const existing = await seedElement(threatModelId, { type: 'external_entity', name: 'browser' });
    await run([draft.id.api, draft.id.boundary, draft.id.flowIn]);
    const records = await recordsOf(threatModelId);
    expect(records.byName('Browser to API')).toMatchObject({ source_element_id: existing, target_element_id: records.byName('API')?.id });
    expect(records.elements.filter((element) => element.name.toLowerCase() === 'browser')).toHaveLength(1);
  });

  it('attaches to an element an earlier accept created, even one the reviewer renamed since', async () => {
    await run([draft.id.boundary, draft.id.api]);
    await db.query(`UPDATE elements SET name = 'The API, renamed' WHERE threat_model_id = $1 AND type = 'process'`, [threatModelId]);
    await run([draft.id.browser, draft.id.flowIn]);
    const records = await recordsOf(threatModelId);
    expect(records.byName('Browser to API')?.target_element_id).toBe(records.byName('The API, renamed')?.id);
  });
});

describe('an element that is already in the model', () => {
  it('has only its unassessed flags filled in: never a value already set, its name, its boundary or its endpoints', async () => {
    const existing = await seedElement(threatModelId, { type: 'process', name: 'api', flags: { internet_facing: true, runs_privileged: true } });
    const result = await run([draft.id.api]);
    expect(result).toMatchObject({ created: 0, changed: 1 });
    const records = await recordsOf(threatModelId);
    expect(records.elements).toHaveLength(1);
    expect(records.elements[0]).toMatchObject({ id: existing, name: 'api', parent_boundary_id: null });
    expect(records.elements[0]?.properties.flags).toEqual({ internet_facing: true, runs_privileged: true, requires_authentication: true });
    expect((await reviewOf(threatModelId))[draft.id.api]).toMatchObject({ state: 'accepted', outcome: 'matched' });
  });

  it('is accepted as matched, changing nothing, when every flag is already assessed', async () => {
    await seedElement(threatModelId, { type: 'process', name: 'API', flags: { requires_authentication: false, internet_facing: true } });
    const result = await run([draft.id.api]);
    expect(result).toMatchObject({ created: 0, changed: 0 });
    expect((await recordsOf(threatModelId)).elements[0]?.properties.flags).toEqual({ requires_authentication: false, internet_facing: true });
    expect((await reviewOf(threatModelId))[draft.id.api]).toMatchObject({ state: 'accepted', outcome: 'matched' });
  });

  it('is created as a new element when several elements match it', async () => {
    await seedElement(threatModelId, { type: 'external_entity', name: 'Browser' });
    await seedElement(threatModelId, { type: 'external_entity', name: 'browser' });
    const result = await run([draft.id.browser]);
    expect(result.created).toBe(1);
    expect((await recordsOf(threatModelId)).elements).toHaveLength(3);
  });
});

describe('assets and assumptions', () => {
  it('creates an asset with its description and the holders that are in the request or the model, and lists the others', async () => {
    const result = await run([draft.id.api, draft.id.boundary, draft.id.asset]);
    expect(result.created).toBe(3);
    const records = await recordsOf(threatModelId);
    expect(records.assets.map(({ name, description }) => ({ name, description }))).toEqual([{ name: 'Session tokens', description: 'Bearer tokens held for signed-in people.' }]);
    expect(records.holders).toEqual([{ asset_id: records.assets[0]?.id, element_id: records.byName('API')?.id }]);
    expect(result.unlinked_holders).toEqual([]);
  });

  it('lists a holder that is not in the model or the request as unlinked, and creates the asset without it', async () => {
    const result = await run([draft.id.asset]);
    expect(result.unlinked_holders).toEqual([{ asset_item_id: draft.id.asset, element_item_id: draft.id.api }]);
    const records = await recordsOf(threatModelId);
    expect(records.assets).toHaveLength(1);
    expect(records.holders).toEqual([]);
  });

  it('creates an assumption with its statement', async () => {
    await run([draft.id.assumption]);
    expect((await recordsOf(threatModelId)).assumptions.map((row) => row.statement)).toEqual(['The database is not exposed.']);
  });

  it('adds to a matched asset only the holders it lacked, and changes nothing else about it', async () => {
    const api = await seedElement(threatModelId, { type: 'process', name: 'API' });
    const other = await seedElement(threatModelId, { type: 'data_store', name: 'Other' });
    const asset = await seedAsset(threatModelId, 'session tokens', [other]);
    const result = await run([draft.id.asset]);
    expect(result).toMatchObject({ created: 0, changed: 1 });
    const records = await recordsOf(threatModelId);
    expect(records.assets).toEqual([{ id: asset, name: 'session tokens', description: 'About session tokens.' }]);
    expect(records.holders.map((row) => row.element_id).sort()).toEqual([api, other].sort());
  });

  it('accepts a matched assumption changing nothing', async () => {
    await db.query('INSERT INTO assumptions (threat_model_id, statement) VALUES ($1, $2)', [threatModelId, 'the database is not exposed.']);
    const result = await run([draft.id.assumption]);
    expect(result).toMatchObject({ created: 0, changed: 0 });
    expect((await recordsOf(threatModelId)).assumptions).toHaveLength(1);
    expect((await reviewOf(threatModelId))[draft.id.assumption]).toMatchObject({ state: 'accepted', outcome: 'matched' });
  });

  it('does not link a holder that is a data flow or a trust boundary, and lists it as unlinked', async () => {
    await db.query('INSERT INTO draft_asset_holders (asset_id, element_id) VALUES ($1, $2)', [draft.id.asset, draft.id.boundary]);
    const result = await run([draft.id.boundary, draft.id.asset]);
    expect(result.unlinked_holders).toContainEqual({ asset_item_id: draft.id.asset, element_item_id: draft.id.boundary });
    expect((await recordsOf(threatModelId)).holders).toEqual([]);
  });
});

describe('everything else', () => {
  it('writes nothing to threats or mitigations and leaves the rest of the draft and of the model as it was (SC-001)', async () => {
    const mine = await seedElement(threatModelId, { type: 'process', name: 'Mine' });
    const before = await counts();
    await run([draft.id.browser, draft.id.boundary, draft.id.assumption]);
    expect(await counts()).toEqual(before);
    const records = await recordsOf(threatModelId);
    expect(records.byName('Mine')?.id).toBe(mine);
    expect(records.elements.map((element) => element.name).sort()).toEqual(['Browser', 'Internal network', 'Mine']);
    const review = await reviewOf(threatModelId);
    expect(review[draft.id.api]?.state).toBe('undecided');
    expect(review[draft.id.database]?.state).toBe('undecided');
  });

  it('accepts a whole draft in one request', async () => {
    const all = Object.values(draft.id);
    const result = await run(all);
    expect(result.created).toBe(8);
    const records = await recordsOf(threatModelId);
    expect(records.elements).toHaveLength(6);
    expect(records.assets).toHaveLength(1);
    expect(records.assumptions).toHaveLength(1);
    expect(records.holders).toHaveLength(1);
  });

  it('still succeeds when the draft’s sources have changed, and for an item whose citation lost its chunk', async () => {
    await seedReviewDraftSourceAdded();
    await db.query('DELETE FROM chunks WHERE id = $1', [draft.chunkId]);
    await expect(run([draft.id.browser])).resolves.toMatchObject({ created: 1 });
  });

  async function seedReviewDraftSourceAdded(): Promise<void> {
    const { seedReadySource } = await import('../fixtures/extract-system/seed.js');
    await seedReadySource(account, threatModelId, { chunks: ['A source added since the draft was made.'] });
  }
});
