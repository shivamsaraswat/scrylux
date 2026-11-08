import { MAX_CHUNKS_PER_REQUEST } from './content.js';

// Filling the budget on the retrieval path (Phase 3 Milestone 4, research #6, FR-012). The ranking statement gives, for each retrieval
// query, the chunks of the threat model nearest to it. This chooses which of them to send:
//
//  1. Seeds: the first chunk of each ready source, in source order, which usually names the system and its parts. They take at most a
//     quarter of the budget, so that a threat model of many sources is not read mostly from its first chunks.
//  2. Ranked: the queries' results interleaved by rank, the best of every query, then the second of every query, and so on.
//
// A chunk that would pass the budget is skipped and filling goes on with the next, until no candidate fits. The chosen chunks are then
// sorted into source order and position, so that the model reads them as they appear in the documents.

/** The share of the budget that the seeds may take. */
export const SEED_SHARE = 0.25;

export interface Candidate {
  id: string;
  /** The place of the chunk's source among the ready sources, in the order they were added. */
  sourceOrder: number;
  position: number;
  /** The characters of the chunk's text. */
  chars: number;
}

export interface FillInput {
  /** The first chunk of each ready source, in source order. */
  seeds: readonly Candidate[];
  /** For each query, its nearest chunks, best first. */
  ranked: readonly (readonly Candidate[])[];
  budgetChars: number;
}

export function fillBudget({ seeds, ranked, budgetChars }: FillInput): Candidate[] {
  const chosen = new Map<string, Candidate>();
  let used = 0;

  const take = (candidate: Candidate, limit: number): void => {
    if (chosen.has(candidate.id) || chosen.size >= MAX_CHUNKS_PER_REQUEST) return;
    if (used + candidate.chars > limit) return;
    chosen.set(candidate.id, candidate);
    used += candidate.chars;
  };

  const seedLimit = Math.floor(budgetChars * SEED_SHARE);
  for (const seed of seeds) take(seed, seedLimit);

  const depth = Math.max(0, ...ranked.map((list) => list.length));
  for (let rank = 0; rank < depth; rank++) {
    for (const list of ranked) {
      const candidate = list[rank];
      if (candidate !== undefined) take(candidate, budgetChars);
    }
  }

  return [...chosen.values()].sort((a, b) => a.sourceOrder - b.sourceOrder || a.position - b.position);
}
