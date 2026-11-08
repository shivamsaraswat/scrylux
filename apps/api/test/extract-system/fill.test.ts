import { describe, expect, it } from 'vitest';
import { SEED_SHARE, fillBudget, type Candidate } from '../../src/extract-system/fill.js';

// Filling the budget on the retrieval path (Phase 3 Milestone 4, research #6, FR-012): the first chunk of each source as a seed, up
// to a quarter of the budget, then the queries’ results interleaved by rank, skipping what does not fit, and the chosen chunks
// sent in source order and then position.

let n = 0;
const chunk = (sourceOrder: number, position: number, chars = 100): Candidate => ({ id: `chunk-${++n}`, sourceOrder, position, chars });
const ids = (chosen: Candidate[]): string[] => chosen.map((c) => c.id);

describe('the seeds', () => {
  it('takes the first chunk of each source, in source order', () => {
    const a = chunk(0, 0);
    const b = chunk(1, 0);
    const c = chunk(2, 0);
    expect(ids(fillBudget({ seeds: [a, b, c], ranked: [], budgetChars: 10_000 }))).toEqual([a.id, b.id, c.id]);
  });

  it('stops at a quarter of the budget, so the ranked chunks have room', () => {
    expect(SEED_SHARE).toBe(0.25);
    const seeds = Array.from({ length: 10 }, (_, i) => chunk(i, 0, 100));
    const chosen = fillBudget({ seeds, ranked: [], budgetChars: 1000 });
    expect(chosen).toHaveLength(2);
    expect(chosen.reduce((sum, c) => sum + c.chars, 0)).toBeLessThanOrEqual(250);
  });

  it('skips a seed that does not fit its share and goes on with a smaller one', () => {
    const big = chunk(0, 0, 900);
    const small = chunk(1, 0, 100);
    expect(ids(fillBudget({ seeds: [big, small], ranked: [], budgetChars: 1000 }))).toEqual([small.id]);
  });
});

describe('the ranked chunks', () => {
  it('interleaves the queries by rank: every query’s best, then every query’s second', () => {
    const a1 = chunk(0, 1);
    const a2 = chunk(0, 2);
    const b1 = chunk(0, 3);
    const b2 = chunk(0, 4);
    // Budget for exactly three: the first of each query, then the second of the first query only.
    const chosen = fillBudget({ seeds: [], ranked: [[a1, a2], [b1, b2]], budgetChars: 300 });
    expect(chosen.map((c) => c.id).sort()).toEqual([a1.id, a2.id, b1.id].sort());
  });

  it('takes a chunk once, however many queries rank it', () => {
    const shared = chunk(0, 5);
    const other = chunk(0, 6);
    const chosen = fillBudget({ seeds: [], ranked: [[shared, other], [shared]], budgetChars: 10_000 });
    expect(ids(chosen).filter((id) => id === shared.id)).toHaveLength(1);
    expect(chosen).toHaveLength(2);
  });

  it('does not take a seed again as a ranked chunk', () => {
    const seed = chunk(0, 0);
    const chosen = fillBudget({ seeds: [seed], ranked: [[seed, chunk(0, 1)]], budgetChars: 10_000 });
    expect(ids(chosen).filter((id) => id === seed.id)).toHaveLength(1);
  });

  it('skips a chunk that would pass the budget and takes a smaller one after it', () => {
    const fits = chunk(0, 1, 400);
    const tooBig = chunk(0, 2, 800);
    const small = chunk(0, 3, 100);
    const chosen = fillBudget({ seeds: [], ranked: [[fits, tooBig, small]], budgetChars: 600 });
    expect(chosen.map((c) => c.id).sort()).toEqual([fits.id, small.id].sort());
  });

  it('never passes the budget', () => {
    const ranked = [Array.from({ length: 50 }, (_, i) => chunk(0, i, 137)), Array.from({ length: 50 }, (_, i) => chunk(1, i, 211))];
    for (const budget of [500, 2000, 5000, 9999]) {
      const chosen = fillBudget({ seeds: [], ranked, budgetChars: budget });
      expect(chosen.reduce((sum, c) => sum + c.chars, 0)).toBeLessThanOrEqual(budget);
    }
  });

  it('never takes more than 1,000 chunks, whatever the budget', () => {
    const ranked = [Array.from({ length: 1200 }, (_, i) => chunk(0, i, 1))];
    expect(fillBudget({ seeds: [], ranked, budgetChars: 1_000_000 })).toHaveLength(1000);
  });
});

describe('the order sent', () => {
  it('is source order and then position, however the chunks were ranked', () => {
    const late = chunk(1, 0);
    const early = chunk(0, 7);
    const earlier = chunk(0, 2);
    const chosen = fillBudget({ seeds: [], ranked: [[late, early], [earlier]], budgetChars: 10_000 });
    expect(ids(chosen)).toEqual([earlier.id, early.id, late.id]);
  });

  it('is the same for the same input', () => {
    const input = { seeds: [chunk(0, 0)], ranked: [[chunk(0, 1), chunk(1, 4)], [chunk(1, 2)]], budgetChars: 5000 };
    expect(ids(fillBudget(input))).toEqual(ids(fillBudget(input)));
  });

  it('is empty for no candidate', () => {
    expect(fillBudget({ seeds: [], ranked: [], budgetChars: 1000 })).toEqual([]);
  });
});
