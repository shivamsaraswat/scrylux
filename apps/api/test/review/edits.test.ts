import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import db from '../../src/db.js';
import { accept } from '../../src/review/decide.js';
import { HttpError, mapStorageError } from '../../src/v1/errors.js';
import { seedAccount, seedThreatModel } from '../fixtures/extract-system/seed.js';
import { acceptBody, recordsOf, reviewOf, seedAsset, seedElement, seedReviewDraft, type ReviewDraft } from '../fixtures/review/seed.js';

// Editing an item while accepting it (Phase 3 Milestone 5, US3, FR-013): the created record has the edited values, the draft keeps the model's, and
// an edit that breaks a rule of the record is refused with nothing created.

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

type Edits = Record<string, unknown>;

/** An accept of the given items, the edits of some of them added to what the page would send. */
async function request(ids: readonly string[], edits: Record<string, Edits> = {}) {
  const body = await acceptBody(threatModelId, draft.draftId, ids);
  return { ...body, items: body.items.map((item) => (edits[item.id] === undefined ? item : { ...item, edits: edits[item.id] })) } as Parameters<typeof accept>[2];
}
const run = async (ids: readonly string[], edits: Record<string, Edits> = {}) => accept(threatModelId, account, await request(ids, edits));

/** What a refused accept answers, however it is refused: by the module or by a rule of the database. */
async function refused(ids: readonly string[], edits: Record<string, Edits>): Promise<{ status: number; message: string }> {
  const before = await state();
  let caught: unknown;
  try {
    await run(ids, edits);
  } catch (err) {
    caught = err;
  }
  const mapped = caught instanceof HttpError ? caught : mapStorageError(caught, 'write');
  expect(mapped, `refused: ${String(caught)}`).not.toBeNull();
  expect(await state(), 'a refused accept leaves nothing behind').toBe(before);
  return { status: (mapped as HttpError).status, message: (mapped as HttpError).message };
}
async function state(): Promise<string> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM elements WHERE threat_model_id = $1) || ',' || (SELECT count(*) FROM assets WHERE threat_model_id = $1) || ',' ||
            (SELECT count(*) FROM assumptions WHERE threat_model_id = $1) || ',' || (SELECT count(*) FROM provenance WHERE threat_model_id = $1) || ',' ||
            (SELECT count(*) FROM draft_items WHERE draft_id = $2 AND decision IS NOT NULL) AS n`,
    [threatModelId, draft.draftId],
  );
  return rows[0]?.n ?? '';
}
const markFlags = async (elementId: string): Promise<Array<string | null>> =>
  (await db.query<{ flag: string | null }>('SELECT flag FROM provenance WHERE element_id = $1 ORDER BY flag NULLS FIRST', [elementId])).rows.map((row) => row.flag);

describe('what an edit changes', () => {
  it('renames an element, and the draft item keeps the model’s name', async () => {
    await run([draft.id.browser], { [draft.id.browser]: { name: 'Web browser' } });
    expect((await recordsOf(threatModelId)).elements.map((element) => element.name)).toEqual(['Web browser']);
    const { rows } = await db.query<{ name: string }>('SELECT name FROM draft_items WHERE id = $1', [draft.id.browser]);
    expect(rows[0]?.name).toBe('Browser');
  });

  it('sets, changes and clears flags, and keeps the provenance of only the flags that stayed as proposed', async () => {
    await run([draft.id.boundary, draft.id.api], {
      [draft.id.api]: { flags: { requires_authentication: null, internet_facing: true, runs_privileged: true } },
    });
    const api = (await recordsOf(threatModelId)).byName('API');
    expect(api?.properties.flags).toEqual({ internet_facing: true, runs_privileged: true });
    // The record's own row stays; a flag the reviewer changed, cleared or added is theirs.
    expect(await markFlags(api?.id as string)).toEqual([null]);
    expect((await reviewOf(threatModelId))[draft.id.api]?.state).toBe('accepted');
  });

  it('keeps the provenance of a flag that was edited to the value it had', async () => {
    await run([draft.id.boundary, draft.id.api], { [draft.id.api]: { flags: { internet_facing: false, runs_privileged: true } } });
    const api = (await recordsOf(threatModelId)).byName('API');
    expect(await markFlags(api?.id as string)).toEqual([null, 'internet_facing', 'requires_authentication']);
  });

  it('moves a member to an element of the model, to a boundary accepted with it, and to none', async () => {
    const dmz = await seedElement(threatModelId, { type: 'trust_boundary', name: 'DMZ' });
    await run([draft.id.api, draft.id.database, draft.id.boundary, draft.id.browser], {
      [draft.id.api]: { boundary: { element: dmz } },
      [draft.id.database]: { boundary: { item: draft.id.boundary } },
      [draft.id.browser]: { boundary: null },
    });
    const records = await recordsOf(threatModelId);
    expect(records.byName('API')?.parent_boundary_id).toBe(dmz);
    expect(records.byName('Database')?.parent_boundary_id).toBe(records.byName('Internal network')?.id);
    expect(records.byName('Browser')?.parent_boundary_id).toBeNull();
  });

  it('lets a member be accepted without the boundary the draft names, by clearing it', async () => {
    await run([draft.id.api], { [draft.id.api]: { boundary: null } });
    expect((await recordsOf(threatModelId)).byName('API')?.parent_boundary_id).toBeNull();
  });

  it('points a flow at another element of the model, and at an element accepted with it', async () => {
    const worker = await seedElement(threatModelId, { type: 'process', name: 'Worker' });
    await run([draft.id.flowIn, draft.id.api, draft.id.boundary], {
      [draft.id.flowIn]: { source: { element: worker }, target: { item: draft.id.api } },
    });
    const records = await recordsOf(threatModelId);
    expect(records.byName('Browser to API')).toMatchObject({ source_element_id: worker, target_element_id: records.byName('API')?.id });
  });

  it('changes an asset’s name, description and holders, and an assumption’s statement', async () => {
    const worker = await seedElement(threatModelId, { type: 'process', name: 'Worker' });
    await run([draft.id.asset, draft.id.assumption], {
      [draft.id.asset]: { name: 'Auth tokens', description: 'Tokens, edited.', holders: [{ element: worker }] },
      [draft.id.assumption]: { statement: 'The database is reachable only from the API.' },
    });
    const records = await recordsOf(threatModelId);
    expect(records.assets.map(({ name, description }) => ({ name, description }))).toEqual([{ name: 'Auth tokens', description: 'Tokens, edited.' }]);
    expect(records.holders.map((row) => row.element_id)).toEqual([worker]);
    expect(records.assumptions.map((row) => row.statement)).toEqual(['The database is reachable only from the API.']);
    const { rows } = await db.query<{ body: string }>('SELECT body FROM draft_items WHERE id = $1', [draft.id.asset]);
    expect(rows[0]?.body).toBe('Bearer tokens held for signed-in people.');
  });

  it('takes an empty list of holders to mean none', async () => {
    await run([draft.id.api, draft.id.boundary, draft.id.asset], { [draft.id.asset]: { holders: [] } });
    expect((await recordsOf(threatModelId)).holders).toEqual([]);
  });
});

describe('what an edit may not do', () => {
  it('refuses a field that the kind of item does not take', async () => {
    const message = 'This edit does not apply to this kind of item';
    expect(await refused([draft.id.browser], { [draft.id.browser]: { statement: 'x' } })).toEqual({ status: 400, message });
    expect(await refused([draft.id.browser], { [draft.id.browser]: { source: { element: randomUUID() } } })).toEqual({ status: 400, message });
    expect(await refused([draft.id.assumption], { [draft.id.assumption]: { name: 'x' } })).toEqual({ status: 400, message });
    expect(await refused([draft.id.asset], { [draft.id.asset]: { flags: { internet_facing: true } } })).toEqual({ status: 400, message });
    expect(await refused([draft.id.flowIn, draft.id.browser, draft.id.api, draft.id.boundary], { [draft.id.flowIn]: { boundary: null } })).toEqual({ status: 400, message });
  });

  it('refuses an edit of an item that is already in the model', async () => {
    await seedElement(threatModelId, { type: 'external_entity', name: 'Browser' });
    expect(await refused([draft.id.browser], { [draft.id.browser]: { name: 'x' } })).toEqual({ status: 400, message: 'An item that is already in the model cannot be edited' });
  });

  it('refuses a flag that does not apply to the type', async () => {
    const answer = await refused([draft.id.boundary, draft.id.api], { [draft.id.api]: { flags: { stores_sensitive_data: true } } });
    expect(answer.status).toBe(400);
    expect(answer.message).toContain('does not apply');
  });

  it('refuses a boundary inside itself, a flow from an element to itself and a flow end that is not a node', async () => {
    expect(await refused([draft.id.boundary], { [draft.id.boundary]: { boundary: { item: draft.id.boundary } } })).toEqual({ status: 400, message: 'An element cannot be its own parent' });
    expect(await refused([draft.id.browser, draft.id.api, draft.id.boundary, draft.id.flowIn], { [draft.id.flowIn]: { target: { item: draft.id.browser } } })).toEqual({
      status: 400,
      message: 'A data flow cannot start and end at the same element',
    });
    const zone = await seedElement(threatModelId, { type: 'trust_boundary', name: 'DMZ' });
    expect(await refused([draft.id.browser, draft.id.api, draft.id.boundary, draft.id.flowIn], { [draft.id.flowIn]: { target: { element: zone } } })).toEqual({
      status: 400,
      message: 'A data flow can only connect external entities, processes and data stores',
    });
  });

  it('refuses a name over 200 characters', async () => {
    expect((await refused([draft.id.browser], { [draft.id.browser]: { name: 'n'.repeat(201) } })).status).toBe(400);
  });

  it('refuses a reference to an element of another threat model', async () => {
    const other = await seedThreatModel(account);
    const foreign = await seedElement(other.threatModelId, { type: 'trust_boundary', name: 'Elsewhere' });
    expect((await refused([draft.id.api], { [draft.id.api]: { boundary: { element: foreign } } })).status).toBe(400);
    const node = await seedElement(other.threatModelId, { type: 'process', name: 'Elsewhere too' });
    expect((await refused([draft.id.asset], { [draft.id.asset]: { holders: [{ element: node }] } })).status).toBe(400);
  });

  it('refuses a holder that is a data flow or a trust boundary', async () => {
    const zone = await seedElement(threatModelId, { type: 'trust_boundary', name: 'DMZ' });
    expect(await refused([draft.id.asset], { [draft.id.asset]: { holders: [{ element: zone }] } })).toEqual({
      status: 400,
      message: 'A holder must be a process, a data store or an external entity',
    });
  });

  it('refuses an edit that would repeat the name of an asset that is there', async () => {
    await seedAsset(threatModelId, 'Auth tokens');
    expect(await refused([draft.id.asset], { [draft.id.asset]: { name: ' auth TOKENS ' } })).toEqual({ status: 409, message: 'An asset with this name already exists' });
  });

  it('refuses a reference to an item that is not an element of the draft', async () => {
    expect(await refused([draft.id.api], { [draft.id.api]: { boundary: { item: randomUUID() } } })).toEqual({ status: 400, message: 'An edit refers to an item that is not an element of the draft' });
    expect(await refused([draft.id.api], { [draft.id.api]: { boundary: { item: draft.id.asset } } })).toEqual({ status: 400, message: 'An edit refers to an item that is not an element of the draft' });
  });

  it('counts a reference that is not in the model or the request as a missing dependency', async () => {
    expect(await refused([draft.id.api], { [draft.id.api]: { boundary: { item: draft.id.boundary } } })).toEqual({ status: 409, message: '1 items need elements that are not in the threat model' });
  });
});
