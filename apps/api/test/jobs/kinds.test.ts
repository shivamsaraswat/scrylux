import { JOB_KINDS } from '@scrylux/core';
import { describe, expect, it } from 'vitest';
import { NEEDS, isOffered } from '../../src/jobs/kinds.js';

// Which provider a job kind needs, so the API can refuse to queue one while that provider is not configured (Phase 3 Milestone 2
// FR-063; Milestone 3 FR-030 and FR-047 for ingestion; Milestone 4 FR-002 and FR-047 for extraction).

const none = { generation: null, embedding: null };
const generation = { generation: { provider: 'anthropic' }, embedding: null };
const embedding = { generation: null, embedding: { provider: 'openai-compatible' } };
const both = { generation: { provider: 'anthropic' }, embedding: { provider: 'openai-compatible' } };

describe('NEEDS', () => {
  it('names a need for every job kind, and nothing else', () => {
    expect(Object.keys(NEEDS).sort()).toEqual([...JOB_KINDS].sort());
  });

  it('says that an extraction needs a generation provider', () => {
    expect(NEEDS.extract_system).toBe('generation');
  });

  it('keeps the needs of the other kinds', () => {
    expect(NEEDS.provider_check).toBe('any');
    expect(NEEDS.ingest_source).toBe('embedding');
    expect(NEEDS.refresh_embeddings).toBe('embedding');
  });
});

describe('isOffered', () => {
  it('offers a kind that needs generation only when generation is configured, whether or not embeddings are', () => {
    expect(isOffered('generation', none)).toBe(false);
    expect(isOffered('generation', embedding)).toBe(false);
    expect(isOffered('generation', generation)).toBe(true);
    expect(isOffered('generation', both)).toBe(true);
  });

  it('offers a kind that needs embeddings only when embeddings are configured, as in Milestone 3', () => {
    expect(isOffered('embedding', none)).toBe(false);
    expect(isOffered('embedding', generation)).toBe(false);
    expect(isOffered('embedding', embedding)).toBe(true);
  });

  it('offers a kind that needs any provider when either is configured', () => {
    expect(isOffered('any', none)).toBe(false);
    expect(isOffered('any', generation)).toBe(true);
    expect(isOffered('any', embedding)).toBe(true);
  });
});
