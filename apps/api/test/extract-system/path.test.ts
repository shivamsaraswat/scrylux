import { describe, expect, it } from 'vitest';
import { choosePath, staleEmbeddings, type ReadySourceFacts } from '../../src/extract-system/path.js';

// Which path an extraction takes, and whether its embeddings are current (Phase 3 Milestone 4, research #6, #7; FR-011, FR-012,
// FR-015). The API calls these at a start and the worker again at a run, so they must never disagree: one function decides.

const source = (over: Partial<ReadySourceFacts> = {}): ReadySourceFacts => ({
  id: crypto.randomUUID(),
  textChars: 1000,
  chunkCount: 1,
  embeddingModel: 'embed-1',
  embeddingDimension: 768,
  ...over,
});

describe('choosePath', () => {
  it('is whole when the ready sources’ text fits the budget', () => {
    expect(choosePath([source({ textChars: 10_000 }), source({ textChars: 20_000 })], 36_000)).toBe('whole');
  });

  it('is whole at exactly the budget and retrieval one character over it', () => {
    expect(choosePath([source({ textChars: 36_000 })], 36_000)).toBe('whole');
    expect(choosePath([source({ textChars: 36_001 })], 36_000)).toBe('retrieval');
    expect(choosePath([source({ textChars: 18_000 }), source({ textChars: 18_001 })], 36_000)).toBe('retrieval');
  });

  it('is retrieval when the text fits but there are more than 1,000 chunks, which one request cannot label', () => {
    expect(choosePath([source({ textChars: 5000, chunkCount: 1000 })], 36_000)).toBe('whole');
    expect(choosePath([source({ textChars: 5000, chunkCount: 1001 })], 36_000)).toBe('retrieval');
    expect(choosePath([source({ textChars: 100, chunkCount: 600 }), source({ textChars: 100, chunkCount: 401 })], 36_000)).toBe('retrieval');
  });

  it('is whole for no source: there is nothing to choose among', () => {
    expect(choosePath([], 36_000)).toBe('whole');
  });
});

describe('staleEmbeddings', () => {
  const configured = { model: 'embed-1', dimension: 768 };

  it('names no source when every embedding is from the configured model and dimension', () => {
    expect(staleEmbeddings([source(), source()], configured)).toEqual([]);
  });

  it('names a source from another model, and one of another dimension', () => {
    const otherModel = source({ embeddingModel: 'embed-0' });
    const otherSize = source({ embeddingDimension: 1024 });
    const current = source();
    expect(staleEmbeddings([otherModel, current, otherSize], configured)).toEqual([otherModel.id, otherSize.id]);
  });

  it('names every source when the model has the same name but another dimension', () => {
    const a = source({ embeddingDimension: 384 });
    expect(staleEmbeddings([a], configured)).toEqual([a.id]);
  });

  // The size of a model's vectors is known only once it has made one, so a check before any request compares the model alone, as
  // Milestone 3 does when it says an embedding is out of date. The size is checked after the queries are embedded (FR-015).
  it('compares the model alone when the size is not known yet', () => {
    const sameModelOtherSize = source({ embeddingDimension: 1024 });
    const otherModel = source({ embeddingModel: 'embed-0' });
    expect(staleEmbeddings([sameModelOtherSize, otherModel], { model: 'embed-1' })).toEqual([otherModel.id]);
  });
});
