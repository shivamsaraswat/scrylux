import type { DraftPath } from '@scrylux/core';
import { MAX_CHUNKS_PER_REQUEST } from './content.js';

// Which path an extraction takes, and whether the embeddings of its sources are current (Phase 3 Milestone 4, research #6, #7;
// FR-011, FR-012, FR-015). The API decides at a start and the worker again when the job runs, and they call these two functions,
// so the API never approves a path the worker would not take.

/** What the two need to know about a ready source. */
export interface ReadySourceFacts {
  id: string;
  /** Its extracted text, in characters: the sum of its chunks' text, because chunks cover every character once (M3 FR-021). */
  textChars: number;
  chunkCount: number;
  embeddingModel: string;
  embeddingDimension: number;
}

/**
 * Whole when every chunk of the ready sources fits the budget and one request can label them all, so the model reads all of it and
 * no embedding is needed ("for small inputs, skip retrieval", FR-011). Retrieval otherwise, which reads part and says so (FR-012).
 * No ready source has nothing to choose among, and is whole.
 */
export function choosePath(ready: readonly Pick<ReadySourceFacts, 'textChars' | 'chunkCount'>[], budgetChars: number): DraftPath {
  const chars = ready.reduce((sum, source) => sum + source.textChars, 0);
  const chunks = ready.reduce((sum, source) => sum + source.chunkCount, 0);
  return chars <= budgetChars && chunks <= MAX_CHUNKS_PER_REQUEST ? 'whole' : 'retrieval';
}

/**
 * The ready sources whose embeddings are not from the configured model and, when it is known, its dimension, in the order given. Embeddings of two models,
 * or of two sizes, are never compared (M3 FR-032), so on the retrieval path every source must be current (FR-015).
 */
export function staleEmbeddings(ready: readonly ReadySourceFacts[], configured: { model: string; dimension?: number }): string[] {
  return ready
    .filter((source) => source.embeddingModel !== configured.model || (configured.dimension !== undefined && source.embeddingDimension !== configured.dimension))
    .map((source) => source.id);
}
