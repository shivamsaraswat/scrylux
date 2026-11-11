import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import db, { kdb } from '../../src/db.js';
import { discardDraft } from '../../src/extract-system/draft.js';
import { accept, reject, undecide } from '../../src/review/decide.js';
import { HttpError } from '../../src/v1/errors.js';
import { seedAccount, seedThreatModel } from '../fixtures/extract-system/seed.js';
import { acceptBody, recordsOf, reviewOf, seedElement, seedReviewDraft, type ReviewDraft } from '../fixtures/review/seed.js';

// Rejecting, changing one's mind, and what a decision survives (Phase 3 Milestone 5, US4; FR-014 to FR-016, SC-001): a rejection writes only the
// decision columns, a rejected item can come back, a record deleted elsewhere makes its item undecided again, and decisions go with the draft.

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

const items = (ids: readonly string[]) => ids.map((id) => ({ id }));
const doReject = (ids: readonly string[]) => reject(threatModelId, account, { action: 'reject', draft_id: draft.draftId, items: items(ids) });
const doUndecide = (ids: readonly string[]) => undecide(threatModelId, account, { action: 'undecide', draft_id: draft.draftId, items: items(ids) });
const doAccept = async (ids: readonly string[]) => accept(threatModelId, account, await acceptBody(threatModelId, draft.draftId, ids));
const state = async (id: string) => (await reviewOf(threatModelId))[id];
const failure = async (promise: Promise<unknown>): Promise<HttpError> => {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error('expected a refusal');
};

describe('rejecting', () => {
  it('writes only the decision columns: no element, asset, assumption, threat or mitigation changes (SC-001)', async () => {
    const mine = await seedElement(threatModelId, { type: 'process', name: 'Mine' });
    const tables = async () =>
      (
        await db.query<{ n: string }>(
          `SELECT (SELECT count(*) FROM elements WHERE threat_model_id = $1) || ',' || (SELECT count(*) FROM assets WHERE threat_model_id = $1) || ',' ||
                  (SELECT count(*) FROM assumptions WHERE threat_model_id = $1) || ',' || (SELECT count(*) FROM threats WHERE threat_model_id = $1) || ',' ||
                  (SELECT count(*) FROM provenance WHERE threat_model_id = $1) AS n`,
          [threatModelId],
        )
      ).rows[0]?.n;
    const before = await tables();
    expect(await doReject([draft.id.browser, draft.id.asset])).toMatchObject({ created: 0, changed: 0, unlinked_holders: [] });
    expect(await tables()).toBe(before);
    expect((await recordsOf(threatModelId)).byName('Mine')?.id).toBe(mine);
  });

  it('reads as rejected, with who and when, and keeps the comparison', async () => {
    await doReject([draft.id.browser]);
    expect(await state(draft.id.browser)).toMatchObject({ state: 'rejected', decided_by: { id: account }, outcome: null, comparison: 'new' });
  });

  it('is refused as a whole when any item is already decided', async () => {
    await doAccept([draft.id.browser]);
    await doReject([draft.id.boundary]);
    for (const decided of [draft.id.browser, draft.id.boundary]) {
      const refused = await failure(doReject([draft.id.api, decided]));
      expect(refused).toMatchObject({ status: 409, message: '1 of the items were already decided' });
    }
    expect((await state(draft.id.api))?.state).toBe('undecided');
  });

  it('is refused for a draft that was replaced or discarded, an unknown item and an unknown threat model', async () => {
    expect(await failure(reject(threatModelId, account, { action: 'reject', draft_id: randomUUID(), items: items([draft.id.api]) }))).toMatchObject({ status: 409, message: 'This draft was replaced or discarded' });
    expect(await failure(doReject([randomUUID()]))).toMatchObject({ status: 404, message: 'Draft item not found' });
    expect(await failure(reject(randomUUID(), account, { action: 'reject', draft_id: draft.draftId, items: items([draft.id.api]) }))).toMatchObject({ status: 404, message: 'Threat model not found' });
  });
});

describe('changing one’s mind', () => {
  it('returns a rejected item to undecided, and it can be accepted again', async () => {
    await doReject([draft.id.browser]);
    await doUndecide([draft.id.browser]);
    expect(await state(draft.id.browser)).toMatchObject({ state: 'undecided', decided_by: null, decided_at: null });
    await expect(doAccept([draft.id.browser])).resolves.toMatchObject({ created: 1 });
  });

  it('lets a rejected item be accepted straight away', async () => {
    await doReject([draft.id.browser]);
    await expect(doAccept([draft.id.browser])).resolves.toMatchObject({ created: 1 });
    expect((await state(draft.id.browser))?.state).toBe('accepted');
  });

  it('is refused as a whole when any item is not rejected', async () => {
    await doReject([draft.id.browser]);
    const refused = await failure(doUndecide([draft.id.browser, draft.id.api]));
    expect(refused).toMatchObject({ status: 409, message: '1 of the items were already decided' });
    expect((await state(draft.id.browser))?.state).toBe('rejected');
  });

  it('still shows what an undecided element needs when what it needs was rejected', async () => {
    await doReject([draft.id.boundary]);
    expect((await state(draft.id.api))?.needs).toEqual([{ need: 'boundary', item_id: draft.id.boundary }]);
  });
});

describe('what a decision survives', () => {
  it('makes an accepted item undecided again when its created record is deleted, and a new accept creates a fresh record', async () => {
    await doAccept([draft.id.browser]);
    const first = (await recordsOf(threatModelId)).byName('Browser')?.id;
    await db.query('DELETE FROM elements WHERE id = $1', [first]);
    expect(await state(draft.id.browser)).toMatchObject({ state: 'undecided', comparison: 'new' });
    await doAccept([draft.id.browser]);
    const second = (await recordsOf(threatModelId)).byName('Browser')?.id;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect((await state(draft.id.browser))?.state).toBe('accepted');
  });

  it('keeps an item accepted as a match accepted after its element is deleted: it created nothing', async () => {
    const existing = await seedElement(threatModelId, { type: 'external_entity', name: 'Browser' });
    await doAccept([draft.id.browser]);
    await db.query('DELETE FROM elements WHERE id = $1', [existing]);
    expect((await state(draft.id.browser))?.state).toBe('accepted');
  });

  it('is lost with the draft, when a new extraction replaces it or it is discarded, and the records and their provenance stay', async () => {
    await doAccept([draft.id.browser, draft.id.assumption]);
    await doReject([draft.id.api]);
    const kept = async () => ({
      records: (await recordsOf(threatModelId)).elements.length + (await recordsOf(threatModelId)).assumptions.length,
      provenance: Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM provenance WHERE threat_model_id = $1', [threatModelId])).rows[0]?.n),
    });
    const before = await kept();
    expect(before).toEqual({ records: 2, provenance: 2 });
    // A new extraction's commit: the draft is deleted and another written.
    await db.query('DELETE FROM drafts WHERE id = $1', [draft.draftId]);
    const next = await seedReviewDraft(account, threatModelId);
    expect(await kept()).toEqual(before);
    expect(Object.values(await reviewOf(threatModelId)).every((review) => review.state === 'undecided')).toBe(true);
    expect(await discardDraft(kdb, threatModelId)).toBe(true);
    expect(await kept()).toEqual(before);
    void next;
  });
});
