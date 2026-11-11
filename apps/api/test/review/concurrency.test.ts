import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import db, { kdb } from '../../src/db.js';
import { discardDraft } from '../../src/extract-system/draft.js';
import { accept } from '../../src/review/decide.js';
import { HttpError } from '../../src/v1/errors.js';
import { seedAccount, seedThreatModel } from '../fixtures/extract-system/seed.js';
import { acceptBody, recordsOf, seedReviewDraft, type ReviewDraft } from '../fixtures/review/seed.js';

// Two people deciding at once (Phase 3 Milestone 5, FR-011, SC-003, SC-004): every write to a threat model's elements takes the model's lock first,
// then the draft's, so a second request waits and then finds what the first did. Nothing deadlocks, and nothing is created twice.

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

const settled = async (promise: Promise<unknown>): Promise<'done' | HttpError> => {
  try {
    await promise;
    return 'done';
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
};

describe('the same item, twice at once', () => {
  it('creates one record, and refuses the second request', async () => {
    const body = await acceptBody(threatModelId, draft.draftId, [draft.id.browser, draft.id.boundary]);
    const [first, second] = await Promise.all([settled(accept(threatModelId, account, body)), settled(accept(threatModelId, account, body))]);
    const results = [first, second];
    expect(results.filter((r) => r === 'done')).toHaveLength(1);
    const refused = results.find((r) => r !== 'done') as HttpError;
    expect(refused.status).toBe(409);
    expect(refused.message).toMatch(/already decided/);
    const records = await recordsOf(threatModelId);
    expect(records.elements.map((element) => element.name).sort()).toEqual(['Browser', 'Internal network']);
  });
});

describe('a decision racing a discard', () => {
  it('creates its records whole or none, and never deadlocks', async () => {
    const body = await acceptBody(threatModelId, draft.draftId, [draft.id.browser, draft.id.boundary]);
    const [decision] = await Promise.all([settled(accept(threatModelId, account, body)), discardDraft(kdb, threatModelId)]);
    const records = await recordsOf(threatModelId);
    if (decision === 'done') expect(records.elements).toHaveLength(2);
    else {
      expect(decision.status).toBe(409);
      expect(decision.message).toBe('This draft was replaced or discarded');
      expect(records.elements).toHaveLength(0);
    }
  });
});

describe('a decision racing a new draft', () => {
  it('refuses as out of date when the draft it saw was replaced, creating nothing', async () => {
    const body = await acceptBody(threatModelId, draft.draftId, [draft.id.browser]);
    // The worker's commit: the old draft is deleted and a new one written.
    await db.query('DELETE FROM drafts WHERE id = $1', [draft.draftId]);
    await seedReviewDraft(account, threatModelId);
    expect(await settled(accept(threatModelId, account, body))).toMatchObject({ status: 409, message: 'This draft was replaced or discarded' });
    expect((await recordsOf(threatModelId)).elements).toHaveLength(0);
  });

  it('survives a replacement that happens while it waits', async () => {
    const body = await acceptBody(threatModelId, draft.draftId, [draft.id.browser]);
    const replace = (async () => {
      await db.query('DELETE FROM drafts WHERE id = $1', [draft.draftId]);
      await seedReviewDraft(account, threatModelId);
    })();
    const decision = await settled(accept(threatModelId, account, body));
    await replace;
    const records = await recordsOf(threatModelId);
    if (decision === 'done') expect(records.elements).toHaveLength(1);
    else {
      expect(decision.status).toBe(409);
      expect(records.elements).toHaveLength(0);
    }
  });
});
