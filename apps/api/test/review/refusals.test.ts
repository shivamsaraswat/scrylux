import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import db from '../../src/db.js';
import { accept } from '../../src/review/decide.js';
import { HttpError } from '../../src/v1/errors.js';
import { seedAccount, seedThreatModel } from '../fixtures/extract-system/seed.js';
import { acceptBody, seedAsset, seedElement, seedReviewDraft, type ReviewDraft } from '../fixtures/review/seed.js';

// What an accept refuses, and what it leaves behind when it does (Phase 3 Milestone 5, US2; FR-009 to FR-012, SC-003, SC-006): every refusal
// is a fixed message with a count and no text of the draft, and creates nothing.

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

async function state(): Promise<string> {
  const tables = ['elements', 'assets', 'assumptions', 'asset_holders', 'provenance'];
  const counts = await Promise.all(tables.map(async (t) => (await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${t} WHERE ${t === 'asset_holders' || t === 'provenance' ? 'threat_model_id' : 'threat_model_id'} = $1`, [threatModelId])).rows[0]?.n));
  const decided = (await db.query<{ n: string }>('SELECT count(*) AS n FROM draft_items WHERE draft_id = $1 AND decision IS NOT NULL', [draft.draftId])).rows[0]?.n;
  return [...counts, decided].join(',');
}

async function refusal(body: Parameters<typeof accept>[2]): Promise<HttpError> {
  const before = await state();
  let caught: unknown;
  try {
    await accept(threatModelId, account, body);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(HttpError);
  expect(await state(), 'a refused accept leaves nothing behind').toBe(before);
  return caught as HttpError;
}

const ask = (ids: readonly string[]) => acceptBody(threatModelId, draft.draftId, ids);

describe('the draft', () => {
  it('refuses a draft that is not the current one, or a threat model with none, as replaced or discarded', async () => {
    const body = await ask([draft.id.browser]);
    const stale = await refusal({ ...body, draft_id: randomUUID() });
    expect(stale).toMatchObject({ status: 409, message: 'This draft was replaced or discarded' });
    await db.query('DELETE FROM drafts WHERE id = $1', [draft.draftId]);
    expect(await refusal(body)).toMatchObject({ status: 409, message: 'This draft was replaced or discarded' });
  });

  it('refuses an item id that is not an item of its draft, as not found', async () => {
    const body = await ask([draft.id.browser]);
    const other = await seedThreatModel(account);
    await seedReviewDraft(account, other.threatModelId);
    const foreign = (await db.query<{ id: string }>('SELECT i.id FROM draft_items i JOIN drafts d ON d.id = i.draft_id WHERE d.threat_model_id = $1 LIMIT 1', [other.threatModelId])).rows[0]?.id as string;
    expect(await refusal({ ...body, items: [{ id: foreign, seen: 'new' }] })).toMatchObject({ status: 404, message: 'Draft item not found' });
    expect(await refusal({ ...body, items: [{ id: randomUUID(), seen: 'new' }] })).toMatchObject({ status: 404, message: 'Draft item not found' });
  });

  it('refuses an unknown threat model as not found', async () => {
    let caught: unknown;
    try {
      await accept(randomUUID(), account, await ask([draft.id.browser]));
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 404, message: 'Threat model not found' });
  });
});

describe('decided items', () => {
  it('refuses an item that is already accepted, counting them, and creates nothing for the others', async () => {
    await accept(threatModelId, account, await ask([draft.id.browser]));
    const refused = await refusal(await ask([draft.id.browser, draft.id.boundary]));
    expect(refused).toMatchObject({ status: 409, message: '1 of the items were already decided' });
  });
});

describe('what the page saw', () => {
  it('refuses an item whose comparison is not the one the page showed, counting them', async () => {
    const body = await ask([draft.id.api, draft.id.boundary]);
    await seedElement(threatModelId, { type: 'process', name: 'API' });
    expect(await refusal(body)).toMatchObject({ status: 409, message: '1 of the items are out of date; the threat model changed' });
  });

  it('refuses a match that disappeared since the page loaded', async () => {
    const existing = await seedElement(threatModelId, { type: 'external_entity', name: 'Browser' });
    const body = await ask([draft.id.browser]);
    expect(body.items[0]?.seen).toBe('matched');
    await db.query('DELETE FROM elements WHERE id = $1', [existing]);
    expect(await refusal(body)).toMatchObject({ status: 409, message: '1 of the items are out of date; the threat model changed' });
  });

  it('refuses an asset or an assumption that appeared since the page loaded, rather than repeat it', async () => {
    const body = await ask([draft.id.asset, draft.id.assumption]);
    await seedAsset(threatModelId, 'Session tokens');
    expect(await refusal(body)).toMatchObject({ status: 409, message: '1 of the items are out of date; the threat model changed' });
  });
});

describe('dependencies', () => {
  it('refuses a flow whose endpoint is in neither the model nor the request, and a member whose boundary is not, counting the items', async () => {
    expect(await refusal(await ask([draft.id.flowIn]))).toMatchObject({ status: 409, message: '1 items need elements that are not in the threat model' });
    expect(await refusal(await ask([draft.id.api, draft.id.database, draft.id.flowIn]))).toMatchObject({
      status: 409,
      message: '3 items need elements that are not in the threat model',
    });
  });

  it('does not hold an asset back for its holders', async () => {
    await expect(accept(threatModelId, account, await ask([draft.id.asset]))).resolves.toMatchObject({ created: 1 });
  });
});

describe('limits', () => {
  it('refuses the whole request when it would pass 1,000 elements, saying how many more fit', async () => {
    await db.query(`INSERT INTO elements (threat_model_id, type, name) SELECT $1, 'process', 'filler ' || n FROM generate_series(1, 999) AS n`, [threatModelId]);
    expect(await refusal(await ask([draft.id.browser, draft.id.boundary]))).toMatchObject({ status: 409, message: 'A threat model can hold 1,000 elements; 1 more fit' });
    await expect(accept(threatModelId, account, await ask([draft.id.browser]))).resolves.toMatchObject({ created: 1 });
  });

  it('refuses an asset past 200 and an assumption past 200', async () => {
    await db.query(`INSERT INTO assets (threat_model_id, name, description) SELECT $1, 'asset ' || n, 'text' FROM generate_series(1, 200) AS n`, [threatModelId]);
    await db.query(`INSERT INTO assumptions (threat_model_id, statement) SELECT $1, 'statement ' || n FROM generate_series(1, 200) AS n`, [threatModelId]);
    expect(await refusal(await ask([draft.id.asset]))).toMatchObject({ status: 409, message: 'A threat model can hold 200 assets; 0 more fit' });
    expect(await refusal(await ask([draft.id.assumption]))).toMatchObject({ status: 409, message: 'A threat model can hold 200 assumptions; 0 more fit' });
  });
});

describe('messages', () => {
  it('never hold a name, a statement or any text of the draft', async () => {
    const messages: string[] = [];
    for (const body of [await ask([draft.id.flowIn]), { ...(await ask([draft.id.browser])), draft_id: randomUUID() }]) {
      messages.push((await refusal(body)).message);
    }
    for (const message of messages) {
      for (const text of ['Browser', 'API', 'Session tokens', 'Internal network', 'not exposed']) expect(message).not.toContain(text);
    }
  });
});
