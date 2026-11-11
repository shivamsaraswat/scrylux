import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecisionResult, DraftDecision, DraftRecord, ItemReview, ProvenanceRecord } from '../src/index.js';

// What the review adds to a draft (Phase 3 Milestone 5, data-model.md "The API records" and "What a difference is"): each item's state, its
// comparison with the threat model, its differences and what it needs. The schemas are strict, so a stray field is a server bug, not a leak.

const now = '2026-11-10T00:00:00.000Z';

const undecided = (over: Record<string, unknown> = {}) => ({
  state: 'undecided',
  decided_by: null,
  decided_at: null,
  outcome: null,
  comparison: 'new',
  matched_id: null,
  differences: null,
  needs: [],
  ...over,
});

describe('ItemReview', () => {
  it('describes an undecided item: its comparison, and what it needs', () => {
    expect(ItemReview.safeParse(undecided()).success).toBe(true);
    expect(ItemReview.safeParse(undecided({ needs: [{ need: 'source', item_id: randomUUID() }, { need: 'boundary', item_id: randomUUID() }] })).success).toBe(true);
  });

  it('describes a matched item with its differences', () => {
    const matched = undecided({
      comparison: 'matched',
      matched_id: randomUUID(),
      differences: { flags: [{ flag: 'internet_facing', proposed: true, current: null }, { flag: 'runs_privileged', proposed: false, current: true }], boundary: true, endpoints: false, holders_missing: 0 },
    });
    expect(ItemReview.safeParse(matched).success).toBe(true);
    expect(ItemReview.safeParse({ ...matched, comparison: 'several' }).success).toBe(true);
  });

  it('describes a decided item: who and when, and the outcome of an accept', () => {
    const decided = { state: 'accepted', decided_by: { id: 1, username: 'admin' }, decided_at: now, outcome: 'created', comparison: null, matched_id: null, differences: null, needs: null };
    expect(ItemReview.safeParse(decided).success).toBe(true);
    expect(ItemReview.safeParse({ ...decided, outcome: 'matched' }).success).toBe(true);
    expect(ItemReview.safeParse({ ...decided, state: 'rejected', outcome: null }).success).toBe(true);
  });

  it('knows three states, three comparisons and three needs, and nothing else', () => {
    expect(ItemReview.safeParse(undecided({ state: 'pending' })).success).toBe(false);
    expect(ItemReview.safeParse(undecided({ comparison: 'maybe' })).success).toBe(false);
    expect(ItemReview.safeParse(undecided({ needs: [{ need: 'holder', item_id: randomUUID() }] })).success).toBe(false);
    expect(ItemReview.safeParse(undecided({ outcome: 'deleted' })).success).toBe(false);
  });

  it('is strict, and takes UUIDs for the ids', () => {
    expect(ItemReview.safeParse({ ...undecided(), extra: 1 }).success).toBe(false);
    expect(ItemReview.safeParse(undecided({ matched_id: 'x' })).success).toBe(false);
    expect(ItemReview.safeParse(undecided({ differences: { flags: [], boundary: false, endpoints: false, holders_missing: -1 } })).success).toBe(false);
    expect(ItemReview.safeParse(undecided({ differences: { flags: [], boundary: false, endpoints: false, holders_missing: 0, extra: 1 } })).success).toBe(false);
  });
});

describe('DraftRecord.review', () => {
  it('is a map from an item id to its review, and every item of the draft has one', () => {
    const id = randomUUID();
    const shape = DraftRecord.shape.review;
    expect(shape.safeParse({ [id]: undecided() }).success).toBe(true);
    expect(shape.safeParse({}).success).toBe(true);
    expect(shape.safeParse({ 'not-a-uuid': undecided() }).success).toBe(false);
    expect(shape.safeParse({ [id]: { state: 'undecided' } }).success).toBe(false);
  });
});

describe('DraftDecision, accept (FR-007)', () => {
  const accept = (items: unknown[], over: Record<string, unknown> = {}) => ({ action: 'accept', draft_id: randomUUID(), items, ...over });
  const one = (over: Record<string, unknown> = {}) => ({ id: randomUUID(), seen: 'new', ...over });

  it('names the draft the reviewer saw and, for each item, its id and the comparison the page showed', () => {
    expect(DraftDecision.safeParse(accept([one(), one({ seen: 'matched' }), one({ seen: 'several' })])).success).toBe(true);
  });

  it('takes 1 to 70 items, each once, with ids that are UUIDs', () => {
    const id = randomUUID();
    expect(DraftDecision.safeParse(accept([])).success).toBe(false);
    expect(DraftDecision.safeParse(accept(Array.from({ length: 70 }, () => one()))).success).toBe(true);
    expect(DraftDecision.safeParse(accept(Array.from({ length: 71 }, () => one()))).success).toBe(false);
    expect(DraftDecision.safeParse(accept([one({ id }), one({ id })])).success).toBe(false);
    expect(DraftDecision.safeParse(accept([one({ id: 'x' })])).success).toBe(false);
    expect(DraftDecision.safeParse(accept([one()], { draft_id: 'x' })).success).toBe(false);
  });

  it('is strict: an unknown key, a content field and a provenance field are refused, and `seen` is one of the three comparisons', () => {
    expect(DraftDecision.safeParse(accept([one()], { provenance: {} })).success).toBe(false);
    expect(DraftDecision.safeParse(accept([one({ name: 'x' })])).success).toBe(false);
    expect(DraftDecision.safeParse(accept([one({ seen: 'maybe' })])).success).toBe(false);
    expect(DraftDecision.safeParse(accept([{ id: randomUUID() }])).success).toBe(false);
    expect(DraftDecision.safeParse({ action: 'delete', draft_id: randomUUID(), items: [one()] }).success).toBe(false);
  });
});

describe('DecisionResult', () => {
  it('carries the updated draft, the counts and the holders left unlinked', () => {
    const shape = DecisionResult.shape;
    expect(Object.keys(shape).sort()).toEqual(['changed', 'created', 'draft', 'unlinked_holders']);
    expect(shape.unlinked_holders.safeParse([{ asset_item_id: randomUUID(), element_item_id: randomUUID() }]).success).toBe(true);
    expect(shape.unlinked_holders.safeParse([{ asset_item_id: randomUUID() }]).success).toBe(false);
    expect(shape.created.safeParse(-1).success).toBe(false);
  });
});

describe('edits while accepting (FR-013)', () => {
  const withEdits = (edits: unknown) => ({ action: 'accept', draft_id: randomUUID(), items: [{ id: randomUUID(), seen: 'new', edits }] });
  const ok = (edits: unknown) => DraftDecision.safeParse(withEdits(edits)).success;
  const ref = () => ({ item: randomUUID() });

  it('takes any of the fields an item can have changed, each optional', () => {
    expect(ok({})).toBe(true);
    expect(ok({ name: '  Renamed ' })).toBe(true);
    expect(ok({ flags: { internet_facing: true, runs_privileged: false, encrypted_at_rest: null } })).toBe(true);
    expect(ok({ boundary: ref() })).toBe(true);
    expect(ok({ boundary: { element: randomUUID() } })).toBe(true);
    expect(ok({ boundary: null })).toBe(true);
    expect(ok({ source: ref(), target: { element: randomUUID() } })).toBe(true);
    expect(ok({ description: 'A new description.' })).toBe(true);
    expect(ok({ statement: 'A new statement.' })).toBe(true);
    expect(ok({ holders: [ref(), { element: randomUUID() }] })).toBe(true);
    expect(ok({ holders: [] })).toBe(true);
  });

  it('is strict: a field that is not editable, such as the kind, the rationale and the citations, is refused', () => {
    for (const field of ['type', 'kind', 'rationale', 'citations', 'id', 'provenance', 'layout', 'properties']) expect(ok({ [field]: 'x' }), field).toBe(false);
  });

  it('takes a name of 1 to 200 characters, trimmed, and a description and a statement of 1 to 10,000', () => {
    expect(ok({ name: ' ' })).toBe(false);
    expect(ok({ name: 'n'.repeat(201) })).toBe(false);
    expect(ok({ name: 'n'.repeat(200) })).toBe(true);
    expect(ok({ description: ' ' })).toBe(false);
    expect(ok({ statement: 's'.repeat(10_001) })).toBe(false);
  });

  it('takes a reference as an item or an element, a UUID, and nothing else', () => {
    expect(ok({ boundary: { item: 'x' } })).toBe(false);
    expect(ok({ boundary: { element: 'x' } })).toBe(false);
    expect(ok({ boundary: { item: randomUUID(), element: randomUUID() } })).toBe(false);
    expect(ok({ boundary: { other: randomUUID() } })).toBe(false);
    expect(ok({ source: null })).toBe(false);
    expect(ok({ holders: Array.from({ length: 1001 }, () => ref()) })).toBe(false);
  });

  it('takes a flag value that is true, false or null (to clear it), and nothing else', () => {
    expect(ok({ flags: { internet_facing: 'yes' } })).toBe(false);
    expect(ok({ flags: { internet_facing: 1 } })).toBe(false);
  });
});

describe('DraftDecision, reject and return to undecided (FR-014)', () => {
  const body = (action: string, items: unknown[], over: Record<string, unknown> = {}) => ({ action, draft_id: randomUUID(), items, ...over });
  const ids = (n: number) => Array.from({ length: n }, () => ({ id: randomUUID() }));

  it('takes the draft the reviewer saw and the items’ ids, and nothing else', () => {
    for (const action of ['reject', 'undecide']) {
      expect(DraftDecision.safeParse(body(action, ids(2))).success, action).toBe(true);
      expect(DraftDecision.safeParse(body(action, [{ id: randomUUID(), seen: 'new' }])).success, `${action} seen`).toBe(false);
      expect(DraftDecision.safeParse(body(action, [{ id: randomUUID(), edits: { name: 'x' } }])).success, `${action} edits`).toBe(false);
      expect(DraftDecision.safeParse(body(action, ids(1), { provenance: {} })).success, `${action} extra`).toBe(false);
    }
  });

  it('takes 1 to 70 items, each once', () => {
    const id = randomUUID();
    for (const action of ['reject', 'undecide']) {
      expect(DraftDecision.safeParse(body(action, [])).success).toBe(false);
      expect(DraftDecision.safeParse(body(action, ids(70))).success).toBe(true);
      expect(DraftDecision.safeParse(body(action, ids(71))).success).toBe(false);
      expect(DraftDecision.safeParse(body(action, [{ id }, { id }])).success).toBe(false);
    }
  });
});

describe('ProvenanceRecord (FR-017, FR-018)', () => {
  const record = (over: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    target: { kind: 'element', id: randomUUID() },
    flag: null,
    rationale: 'The document says so.',
    accepted_by: { id: 7, username: 'ada' },
    accepted_at: now,
    citations: [],
    ...over,
  });
  const cited = { chunk: { id: randomUUID(), source_id: randomUUID(), source_name: 'design.md', position: 2, page_first: null, page_last: null, line_first: 4, line_last: 9, heading: null }, quote: 'a passage of the chunk' };

  it('says what record, or what flag of an element, it is about, why, who accepted it and when, with its citations as a draft shows them', () => {
    expect(ProvenanceRecord.safeParse(record()).success).toBe(true);
    expect(ProvenanceRecord.safeParse(record({ flag: 'internet_facing', citations: [cited, { chunk: null, quote: null }] })).success).toBe(true);
    for (const kind of ['element', 'asset', 'assumption']) expect(ProvenanceRecord.safeParse(record({ target: { kind, id: randomUUID() } })).success, kind).toBe(true);
  });

  it('refuses a kind it does not know, an id that is not a UUID, an incomplete citation and a key it has not got', () => {
    expect(ProvenanceRecord.safeParse(record({ target: { kind: 'threat', id: randomUUID() } })).success).toBe(false);
    expect(ProvenanceRecord.safeParse(record({ target: { kind: 'asset', id: 'x' } })).success).toBe(false);
    expect(ProvenanceRecord.safeParse(record({ citations: [{ chunk: null, quote: 'text' }] })).success).toBe(false);
    expect(ProvenanceRecord.safeParse({ ...record(), origin: 'ai' }).success).toBe(false);
    expect(ProvenanceRecord.safeParse(record({ accepted_by: null })).success).toBe(false);
  });
});
