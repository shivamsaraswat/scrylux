import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DraftRecord, ItemReview } from '@scrylux/core';
import db, { kdb } from '../../src/db.js';
import { readDraft } from '../../src/extract-system/draft.js';
import { readReview } from '../../src/review/compare.js';
import { seedAccount, seedThreatModel } from '../fixtures/extract-system/seed.js';
import { seedAsset, seedElement, seedReviewDraft, type ReviewDraft } from '../fixtures/review/seed.js';

// What a draft item is against the threat model now (Phase 3 Milestone 5, FR-001 to FR-003, research #2, #3, #5, data-model.md "What a
// difference is"): new, matched or several, with its differences and its needs, and its state read from the decision columns. Reading
// writes nothing.

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

async function review(): Promise<Record<string, ItemReview>> {
  const record = (await readDraft(kdb, threatModelId)) as DraftRecord;
  return readReview(kdb, record);
}
const of = async (item: string): Promise<ItemReview> => (await review())[item] as ItemReview;

async function decide(item: string, values: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(values);
  await db.query(`UPDATE draft_items SET ${columns.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [item, ...Object.values(values)]);
}

describe('comparison', () => {
  it('says every item is new when the threat model holds nothing', async () => {
    const all = await review();
    expect(Object.keys(all)).toHaveLength(8);
    for (const item of Object.values(all)) {
      expect(item.state).toBe('undecided');
      expect(item.comparison).toBe('new');
      expect(item.matched_id).toBeNull();
      expect(item.differences).toBeNull();
    }
  });

  it('matches an element of the same type and name, ignoring case and surrounding whitespace, and gives its id', async () => {
    const existing = await seedElement(threatModelId, { type: 'process', name: '  api ' });
    const api = await of(draft.id.api);
    expect(api.comparison).toBe('matched');
    expect(api.matched_id).toBe(existing);
    expect((await of(draft.id.database)).comparison).toBe('new');
  });

  it('compares a non-ASCII name as the database does', async () => {
    await db.query(`UPDATE draft_items SET name = 'Café service' WHERE id = $1`, [draft.id.api]);
    const existing = await seedElement(threatModelId, { type: 'process', name: 'Café service' });
    expect((await of(draft.id.api)).matched_id).toBe(existing);
  });

  it('never matches a process with a data store of the same name', async () => {
    await seedElement(threatModelId, { type: 'data_store', name: 'API' });
    expect((await of(draft.id.api)).comparison).toBe('new');
  });

  it('says several when more than one element has the type and name, and chooses none', async () => {
    await seedElement(threatModelId, { type: 'process', name: 'API' });
    await seedElement(threatModelId, { type: 'process', name: 'api' });
    const api = await of(draft.id.api);
    expect(api.comparison).toBe('several');
    expect(api.matched_id).toBeNull();
    expect(api.differences).toBeNull();
  });

  it('matches an asset by its name and an assumption by its statement, never to several', async () => {
    const asset = await seedAsset(threatModelId, ' session TOKENS ');
    await db.query('INSERT INTO assumptions (threat_model_id, statement) VALUES ($1, $2)', [threatModelId, '  THE database is not EXPOSED. ']);
    const { rows } = await db.query<{ id: string }>('SELECT id FROM assumptions WHERE threat_model_id = $1', [threatModelId]);
    expect(await of(draft.id.asset)).toMatchObject({ comparison: 'matched', matched_id: asset });
    expect(await of(draft.id.assumption)).toMatchObject({ comparison: 'matched', matched_id: rows[0]?.id });
  });
});

describe('differences of a matched element', () => {
  it('lists the proposed flags the element has not assessed or has with another value, and never a flag the draft does not propose', async () => {
    await seedElement(threatModelId, { type: 'process', name: 'API', flags: { internet_facing: true, runs_privileged: true } });
    const flags = (await of(draft.id.api)).differences?.flags;
    expect(flags).toEqual([
      { flag: 'internet_facing', proposed: false, current: true },
      { flag: 'requires_authentication', proposed: true, current: null },
    ]);
  });

  it('lists no flag the element already has with the proposed value', async () => {
    await seedElement(threatModelId, { type: 'process', name: 'API', flags: { requires_authentication: true, internet_facing: false } });
    expect((await of(draft.id.api)).differences?.flags).toEqual([]);
  });

  it('says the boundary differs when the draft names one that is not in the model, or another than the element is in', async () => {
    const api = await seedElement(threatModelId, { type: 'process', name: 'API' });
    expect((await of(draft.id.api)).differences?.boundary).toBe(true);

    const boundary = await seedElement(threatModelId, { type: 'trust_boundary', name: 'Internal network' });
    expect((await of(draft.id.api)).differences?.boundary).toBe(true);

    await db.query('UPDATE elements SET parent_boundary_id = $1 WHERE id = $2', [boundary, api]);
    expect((await of(draft.id.api)).differences?.boundary).toBe(false);

    const other = await seedElement(threatModelId, { type: 'trust_boundary', name: 'DMZ' });
    await db.query('UPDATE elements SET parent_boundary_id = $1 WHERE id = $2', [other, api]);
    expect((await of(draft.id.api)).differences?.boundary).toBe(true);
  });

  it('does not call a boundary a difference when the draft names none', async () => {
    await seedElement(threatModelId, { type: 'external_entity', name: 'Browser' });
    expect((await of(draft.id.browser)).differences?.boundary).toBe(false);
  });

  it('says the endpoints differ when an endpoint does not resolve or resolves to another element', async () => {
    const browser = await seedElement(threatModelId, { type: 'external_entity', name: 'Browser' });
    const api = await seedElement(threatModelId, { type: 'process', name: 'API' });
    const other = await seedElement(threatModelId, { type: 'process', name: 'Worker' });
    const flow = async (source: string, target: string) => {
      await db.query('DELETE FROM elements WHERE type = $1 AND threat_model_id = $2', ['data_flow', threatModelId]);
      await db.query(`INSERT INTO elements (threat_model_id, type, name, source_element_id, target_element_id) VALUES ($1, 'data_flow', 'Browser to API', $2, $3)`, [threatModelId, source, target]);
      return (await of(draft.id.flowIn)).differences?.endpoints;
    };
    expect(await flow(browser, api)).toBe(false);
    expect(await flow(browser, other)).toBe(true);
    await db.query('DELETE FROM elements WHERE id = $1', [browser]);
    await db.query('DELETE FROM elements WHERE type = $1 AND threat_model_id = $2', ['data_flow', threatModelId]);
    const flowOnly = await seedElement(threatModelId, { type: 'external_entity', name: 'Someone else' });
    await db.query(`INSERT INTO elements (threat_model_id, type, name, source_element_id, target_element_id) VALUES ($1, 'data_flow', 'Browser to API', $2, $3)`, [threatModelId, flowOnly, api]);
    expect((await of(draft.id.flowIn)).differences?.endpoints).toBe(true);
  });
});

describe('differences of a matched asset', () => {
  it('counts the draft holders that resolve to an element which does not hold it, and not those that do not resolve', async () => {
    await seedAsset(threatModelId, 'Session tokens');
    expect((await of(draft.id.asset)).differences?.holders_missing).toBe(0);
    const api = await seedElement(threatModelId, { type: 'process', name: 'API' });
    expect((await of(draft.id.asset)).differences?.holders_missing).toBe(1);
    await db.query('INSERT INTO asset_holders (threat_model_id, asset_id, element_id) SELECT $1, id, $2 FROM assets WHERE threat_model_id = $1', [threatModelId, api]);
    expect((await of(draft.id.asset)).differences?.holders_missing).toBe(0);
  });
});

describe('needs', () => {
  it('names the references of an element that do not resolve: a flow its endpoints, a member its boundary', async () => {
    const all = await review();
    expect(all[draft.id.flowIn]?.needs).toEqual([
      { need: 'source', item_id: draft.id.browser },
      { need: 'target', item_id: draft.id.api },
    ]);
    expect(all[draft.id.api]?.needs).toEqual([{ need: 'boundary', item_id: draft.id.boundary }]);
    expect(all[draft.id.browser]?.needs).toEqual([]);
    expect(all[draft.id.boundary]?.needs).toEqual([]);
  });

  it('counts a reference as resolved when it matches exactly one existing element, with no decision on it', async () => {
    await seedElement(threatModelId, { type: 'external_entity', name: 'Browser' });
    expect((await of(draft.id.flowIn)).needs).toEqual([{ need: 'target', item_id: draft.id.api }]);
  });

  it('does not count a reference that matches several elements', async () => {
    await seedElement(threatModelId, { type: 'external_entity', name: 'Browser' });
    await seedElement(threatModelId, { type: 'external_entity', name: 'browser' });
    expect((await of(draft.id.flowIn)).needs).toEqual([
      { need: 'source', item_id: draft.id.browser },
      { need: 'target', item_id: draft.id.api },
    ]);
  });

  it('counts a reference as resolved when its item was accepted and created an element that still exists', async () => {
    const created = await seedElement(threatModelId, { type: 'process', name: 'Whatever the reviewer called it' });
    await decide(draft.id.api, { decision: 'accepted', decided_by: account, decided_at: new Date(), outcome: 'created', element_id: created });
    expect((await of(draft.id.flowIn)).needs).toEqual([{ need: 'source', item_id: draft.id.browser }]);
  });

  it('has none for an asset or an assumption', async () => {
    expect((await of(draft.id.asset)).needs).toBeNull();
    expect((await of(draft.id.assumption)).needs).toBeNull();
  });
});

describe('state', () => {
  const when = new Date('2026-11-10T00:00:00.000Z');

  it('reads a rejected item as rejected, with who and when', async () => {
    await decide(draft.id.browser, { decision: 'rejected', decided_by: account, decided_at: when });
    const browser = await of(draft.id.browser);
    expect(browser.state).toBe('rejected');
    expect(browser.decided_at).toBe(when.toISOString());
    expect(browser.decided_by?.id).toBe(account);
    expect(browser.comparison).toBe('new');
  });

  it('reads an accepted item whose created record exists as accepted, with nothing compared', async () => {
    const created = await seedElement(threatModelId, { type: 'external_entity', name: 'Browser' });
    await decide(draft.id.browser, { decision: 'accepted', decided_by: account, decided_at: when, outcome: 'created', element_id: created });
    expect(await of(draft.id.browser)).toMatchObject({ state: 'accepted', outcome: 'created', comparison: null, matched_id: null, differences: null, needs: null });
  });

  it('reads an accepted, created item whose record was deleted as undecided', async () => {
    const created = await seedElement(threatModelId, { type: 'external_entity', name: 'Browser' });
    await decide(draft.id.browser, { decision: 'accepted', decided_by: account, decided_at: when, outcome: 'created', element_id: created });
    await db.query('DELETE FROM elements WHERE id = $1', [created]);
    const browser = await of(draft.id.browser);
    expect(browser).toMatchObject({ state: 'undecided', decided_by: null, decided_at: null, outcome: null, comparison: 'new' });
  });

  it('keeps an item accepted as a match accepted, however the model changes', async () => {
    await decide(draft.id.browser, { decision: 'accepted', decided_by: account, decided_at: when, outcome: 'matched' });
    expect((await of(draft.id.browser)).state).toBe('accepted');
  });
});

describe('reading', () => {
  it('writes nothing to elements, assets, assumptions, threats, mitigations or the draft', async () => {
    await seedElement(threatModelId, { type: 'process', name: 'API' });
    const count = async (): Promise<string> => {
      // The test database is shared, so only this threat model's rows are counted.
      const { rows } = await db.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM elements WHERE threat_model_id = $1) || ',' || (SELECT count(*) FROM assets WHERE threat_model_id = $1) || ',' ||
                (SELECT count(*) FROM assumptions WHERE threat_model_id = $1) || ',' || (SELECT count(*) FROM threats WHERE threat_model_id = $1) || ',' ||
                (SELECT count(*) FROM draft_items i JOIN drafts d ON d.id = i.draft_id WHERE d.threat_model_id = $1 AND i.decision IS NOT NULL) || ',' ||
                (SELECT count(*) FROM provenance WHERE threat_model_id = $1) AS n`,
        [threatModelId],
      );
      return rows[0]?.n ?? '';
    };
    const before = await count();
    await review();
    await review();
    expect(await count()).toBe(before);
  });
});
