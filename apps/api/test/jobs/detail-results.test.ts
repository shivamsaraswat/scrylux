import { describe, expect, it } from 'vitest';
import { detailResults } from '../../src/jobs/store.js';

// Which part of a job detail a job's stored result goes in (Phase 3 Milestone 4, contracts/worker.md "Result"). A provider check keeps
// each operation's outcome, an ingestion keeps counts, an extraction keeps counts and two settings. The route parses its answer
// with the strict JobDetail, so a result that is not whole, such as the empty one a job keeps when it failed before it had counts,
// must come out as null and not make the job unreadable.

const INGESTION = { chunks: 12, pages_without_text: 2 };
const EXTRACTION = {
  path: 'whole',
  chunks_read: 18,
  chunks_available: 18,
  sources_read: 3,
  sources_left_out: 0,
  items: { elements: 12, assets: 2, assumptions: 1 },
  context_chars: 36_000,
  max_output_tokens: 12_000,
};

describe('detailResults', () => {
  it('puts an ingestion’s counts in `ingestion`, for both kinds of ingestion', () => {
    for (const kind of ['ingest_source', 'refresh_embeddings'] as const) {
      expect(detailResults(kind, INGESTION)).toEqual({ ingestion: INGESTION, extraction: null });
    }
  });

  it('puts an extraction’s counts in `extraction`, and nothing in `ingestion`', () => {
    expect(detailResults('extract_system', EXTRACTION)).toEqual({ ingestion: null, extraction: EXTRACTION });
  });

  it('puts neither for a provider check, whose result is its own', () => {
    expect(detailResults('provider_check', { generation: { status: 'ok' } })).toEqual({ ingestion: null, extraction: null });
  });

  it('puts nothing where a job has no result yet', () => {
    for (const kind of ['ingest_source', 'refresh_embeddings', 'extract_system', 'provider_check'] as const) {
      expect(detailResults(kind, null)).toEqual({ ingestion: null, extraction: null });
    }
  });

  it('gives null for a result that is not whole: the empty one a job keeps when it failed before it had counts', () => {
    expect(detailResults('extract_system', {})).toEqual({ ingestion: null, extraction: null });
    expect(detailResults('ingest_source', {})).toEqual({ ingestion: null, extraction: null });
    expect(detailResults('extract_system', { path: 'whole' })).toEqual({ ingestion: null, extraction: null });
  });

  it('does not put one kind’s result in another’s part', () => {
    expect(detailResults('extract_system', INGESTION)).toEqual({ ingestion: null, extraction: null });
    expect(detailResults('ingest_source', EXTRACTION)).toEqual({ ingestion: null, extraction: null });
  });

  it('gives nothing that could hold text: a result with a field of its own is refused whole', () => {
    expect(detailResults('extract_system', { ...EXTRACTION, name: 'Payment service' })).toEqual({ ingestion: null, extraction: null });
  });
});
