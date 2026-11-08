import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CitationRecord,
  DRAFT_LIMITS,
  DraftAnswer,
  DraftRecord,
  ELEMENT_FLAGS,
  ExtractionStatus,
  JOB_FAILURE_CATEGORIES,
  JOB_KINDS,
  JOB_TRANSIENT_CATEGORIES,
  JobProgress,
} from '../src/index.js';

// The model's answer for a draft, and the records the draft routes send (Phase 3 Milestone 4, data-model.md). The answer's
// JSON Schema is the same for every request: the checks that depend on a request (which labels were sent, what a chunk says)
// are added as a refinement by the worker, and a refinement never reaches the schema a provider is sent (research #2).

const cite = (over: Record<string, unknown> = {}) => ({ chunk: 'c1', quote: 'twelve chars', ...over });

const element = (over: Record<string, unknown> = {}) => ({
  ref: 'api',
  type: 'process',
  name: 'API',
  boundary: null,
  source: null,
  target: null,
  flags: [],
  rationale: 'The design names an API service.',
  citations: [cite()],
  ...over,
});

const answer = (over: Record<string, unknown> = {}) => ({
  elements: [element()],
  assets: [],
  assumptions: [],
  nothing_found: null,
  ...over,
});

// Walks a JSON Schema and collects every value of a keyword.
function collect(node: unknown, keyword: string, found: unknown[] = []): unknown[] {
  if (node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, keyword, found);
    return found;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === keyword) found.push(value);
    collect(value, keyword, found);
  }
  return found;
}

describe('DraftAnswer', () => {
  it('accepts a small valid answer', () => {
    expect(DraftAnswer.safeParse(answer()).success).toBe(true);
  });

  it('accepts an answer that found nothing, with its reason', () => {
    expect(DraftAnswer.safeParse(answer({ elements: [], nothing_found: 'The content describes no system.' })).success).toBe(true);
  });

  it('refuses an unknown field at every level (every object is strict)', () => {
    expect(DraftAnswer.safeParse({ ...answer(), extra: 1 }).success).toBe(false);
    expect(DraftAnswer.safeParse(answer({ elements: [element({ extra: 1 })] })).success).toBe(false);
    expect(DraftAnswer.safeParse(answer({ elements: [element({ citations: [cite({ extra: 1 })] })] })).success).toBe(false);
    expect(DraftAnswer.safeParse(answer({ elements: [element({ flags: [{ flag: 'internet_facing', value: true, citations: [cite()], extra: 1 }] })] })).success).toBe(false);
  });

  it('requires every field: a missing one is invalid, and absence is written as null', () => {
    const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
    expect(DraftAnswer.safeParse(answer({ elements: [without(element(), 'boundary')] })).success).toBe(false);
    expect(DraftAnswer.safeParse(without(answer(), 'nothing_found')).success).toBe(false);
  });

  describe('limits (research #9)', () => {
    it('holds at most 40 elements, 15 assets and 15 assumptions', () => {
      const many = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i));
      const el = (i: number) => element({ ref: `e${i}`, name: `Element ${i}` });
      expect(DraftAnswer.safeParse(answer({ elements: many(40, el) })).success).toBe(true);
      expect(DraftAnswer.safeParse(answer({ elements: many(41, el) })).success).toBe(false);
      const asset = (i: number) => ({ ref: `a${i}`, name: `Asset ${i}`, description: 'd', held_by: [], rationale: 'r', citations: [cite()] });
      expect(DraftAnswer.safeParse(answer({ assets: many(15, asset) })).success).toBe(true);
      expect(DraftAnswer.safeParse(answer({ assets: many(16, asset) })).success).toBe(false);
      const assumption = (i: number) => ({ ref: `s${i}`, statement: `Statement ${i}`, rationale: 'r', citations: [cite()] });
      expect(DraftAnswer.safeParse(answer({ assumptions: many(15, assumption) })).success).toBe(true);
      expect(DraftAnswer.safeParse(answer({ assumptions: many(16, assumption) })).success).toBe(false);
      expect(DRAFT_LIMITS).toMatchObject({ elements: 40, assets: 15, assumptions: 15 });
    });

    it('holds 1 to 5 citations an item and 1 to 2 a flag, at most 4 flags and 10 holders of an asset', () => {
      const cites = (n: number) => Array.from({ length: n }, () => cite());
      expect(DraftAnswer.safeParse(answer({ elements: [element({ citations: [] })] })).success).toBe(false);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ citations: cites(5) })] })).success).toBe(true);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ citations: cites(6) })] })).success).toBe(false);
      const flag = (n: number) => [{ flag: 'internet_facing', value: true, citations: cites(n) }];
      expect(DraftAnswer.safeParse(answer({ elements: [element({ flags: flag(0) })] })).success).toBe(false);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ flags: flag(2) })] })).success).toBe(true);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ flags: flag(3) })] })).success).toBe(false);
      const four = ['internet_facing', 'requires_authentication', 'handles_sensitive_data', 'runs_privileged'].map((f) => ({ flag: f, value: true, citations: cites(1) }));
      expect(DraftAnswer.safeParse(answer({ elements: [element({ flags: four })] })).success).toBe(true);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ flags: [...four, ...flag(1)] })] })).success).toBe(false);
      const holders = (n: number) => ({ ref: 'a1', name: 'A', description: 'd', held_by: Array.from({ length: n }, (_, i) => `h${i}`), rationale: 'r', citations: cites(1) });
      expect(DraftAnswer.safeParse(answer({ assets: [holders(10)] })).success).toBe(true);
      expect(DraftAnswer.safeParse(answer({ assets: [holders(11)] })).success).toBe(false);
    });

    it('holds a quote of 12 to 200 characters, and names and texts within their lengths', () => {
      expect(DraftAnswer.safeParse(answer({ elements: [element({ citations: [cite({ quote: 'x'.repeat(11) })] })] })).success).toBe(false);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ citations: [cite({ quote: 'x'.repeat(12) })] })] })).success).toBe(true);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ citations: [cite({ quote: 'x'.repeat(200) })] })] })).success).toBe(true);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ citations: [cite({ quote: 'x'.repeat(201) })] })] })).success).toBe(false);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ name: 'n'.repeat(200) })] })).success).toBe(true);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ name: 'n'.repeat(201) })] })).success).toBe(false);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ name: '   ' })] })).success).toBe(false);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ rationale: 'r'.repeat(300) })] })).success).toBe(true);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ rationale: 'r'.repeat(301) })] })).success).toBe(false);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ rationale: '' })] })).success).toBe(false);
      expect(DraftAnswer.safeParse(answer({ elements: [], nothing_found: 'r'.repeat(301) })).success).toBe(false);
      expect(DraftAnswer.safeParse(answer({ elements: [], nothing_found: '' })).success).toBe(false);
    });

    it('counts characters as code points, as the database does', () => {
      // 200 astral characters are 400 UTF-16 code units: still a valid name.
      expect(DraftAnswer.safeParse(answer({ elements: [element({ name: '\u{1F600}'.repeat(200) })] })).success).toBe(true);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ name: '\u{1F600}'.repeat(201) })] })).success).toBe(false);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ citations: [cite({ quote: '\u{1F600}'.repeat(12) })] })] })).success).toBe(true);
      expect(DraftAnswer.safeParse(answer({ elements: [element({ citations: [cite({ quote: '\u{1F600}'.repeat(11) })] })] })).success).toBe(false);
    });
  });

  describe('labels, references, types and flags', () => {
    it('takes a chunk label of the form c1 to c9999 and nothing else', () => {
      for (const ok of ['c1', 'c9', 'c10', 'c999', 'c9999']) {
        expect(DraftAnswer.safeParse(answer({ elements: [element({ citations: [cite({ chunk: ok })] })] })).success, ok).toBe(true);
      }
      for (const bad of ['c0', 'c01', 'c10000', 'C1', 'c', 'chunk1', '1', ' c1', 'c1 ', '3f2a6c1e-0000-4000-8000-000000000000']) {
        expect(DraftAnswer.safeParse(answer({ elements: [element({ citations: [cite({ chunk: bad })] })] })).success, bad).toBe(false);
      }
    });

    it('takes an item reference of 1 to 24 lower-case letters, digits and underscores, starting with a letter', () => {
      for (const ok of ['a', 'api', 'api_gateway', 'x1', `a${'b'.repeat(23)}`]) {
        expect(DraftAnswer.safeParse(answer({ elements: [element({ ref: ok })] })).success, ok).toBe(true);
      }
      for (const bad of ['', '1a', '_a', 'A', 'a-b', 'a b', `a${'b'.repeat(24)}`]) {
        expect(DraftAnswer.safeParse(answer({ elements: [element({ ref: bad })] })).success, bad).toBe(false);
      }
    });

    it('takes the five element types and no asset or assumption type', () => {
      for (const type of ['process', 'data_store', 'external_entity', 'data_flow', 'trust_boundary']) {
        expect(DraftAnswer.safeParse(answer({ elements: [element({ type })] })).success, type).toBe(true);
      }
      for (const type of ['asset', 'assumption', 'threat', '']) {
        expect(DraftAnswer.safeParse(answer({ elements: [element({ type })] })).success, type).toBe(false);
      }
    });

    it('takes every flag name of ELEMENT_FLAGS and no other', () => {
      const names = [...new Set(Object.values(ELEMENT_FLAGS).flat())];
      expect(names.length).toBeGreaterThan(0);
      for (const flag of names) {
        const flags = [{ flag, value: false, citations: [cite()] }];
        expect(DraftAnswer.safeParse(answer({ elements: [element({ flags })] })).success, flag).toBe(true);
      }
      const unknown = [{ flag: 'is_awesome', value: true, citations: [cite()] }];
      expect(DraftAnswer.safeParse(answer({ elements: [element({ flags: unknown })] })).success).toBe(false);
    });
  });
});

describe("DraftAnswer's JSON Schema (research #2)", () => {
  const json = z.toJSONSchema(DraftAnswer, { target: 'draft-2020-12' });

  it('is the same with a request refinement added, so a provider is sent one schema for every request', () => {
    const refined = DraftAnswer.superRefine((value, ctx) => {
      if (value.elements.length > 100) ctx.addIssue({ code: 'custom', message: 'never' });
    });
    expect(z.toJSONSchema(refined, { target: 'draft-2020-12' })).toEqual(json);
  });

  it('refuses unknown fields everywhere and lists every field as required', () => {
    const objects = collect(json, 'additionalProperties');
    expect(objects.length).toBeGreaterThan(3);
    expect(objects.every((v) => v === false)).toBe(true);
    const root = json as { required?: string[] };
    expect(root.required).toEqual(expect.arrayContaining(['elements', 'assets', 'assumptions', 'nothing_found']));
  });

  it('states the label and reference patterns and the limits a model is told', () => {
    const text = JSON.stringify(json);
    expect(text).toContain('^c[1-9][0-9]{0,3}$');
    expect(text).toContain('^[a-z][a-z0-9_]{0,23}$');
    expect(collect(json, 'maxItems')).toEqual(expect.arrayContaining([40, 15, 5, 2, 4, 10]));
    expect(collect(json, 'maxLength')).toEqual(expect.arrayContaining([200, 300]));
  });
});

describe('the records of the draft routes (data-model.md)', () => {
  const at = '2026-11-08T10:00:00.000Z';
  const chunk = () => ({
    id: randomUUID(),
    source_id: randomUUID(),
    source_name: 'design.md',
    position: 3,
    page_first: null,
    page_last: null,
    line_first: 10,
    line_last: 24,
    heading: 'Architecture',
  });

  it('CitationRecord: a live citation, and a deleted one with neither chunk nor quote', () => {
    expect(CitationRecord.safeParse({ chunk: chunk(), quote: 'twelve chars' }).success).toBe(true);
    expect(CitationRecord.safeParse({ chunk: null, quote: null }).success).toBe(true);
    expect(CitationRecord.safeParse({ chunk: chunk(), quote: null }).success).toBe(false);
    expect(CitationRecord.safeParse({ chunk: null, quote: 'twelve chars' }).success).toBe(false);
    expect(CitationRecord.safeParse({ chunk: chunk(), quote: 'q', extra: 1 }).success).toBe(false);
  });

  const record = () => ({
    id: randomUUID(),
    threat_model_id: randomUUID(),
    made_at: at,
    started_by: { id: 1, username: 'alice' },
    job_id: randomUUID(),
    generation_model: 'claude-test',
    prompt_version: 'extract-system/0123456789ab',
    path: 'whole',
    chunks_read: 18,
    chunks_available: 18,
    sources: [{ id: randomUUID(), name: 'design.md', read: true }],
    sources_deleted: 0,
    sources_changed: false,
    nothing_found: null,
    elements: [
      {
        id: randomUUID(),
        type: 'process',
        name: 'API',
        boundary_id: null,
        source_id: null,
        target_id: null,
        flags: [{ flag: 'internet_facing', value: true, citations: [{ chunk: chunk(), quote: 'twelve chars' }] }],
        rationale: 'r',
        citations: [{ chunk: null, quote: null }],
      },
    ],
    assets: [{ id: randomUUID(), name: 'Tokens', description: 'd', held_by: [randomUUID()], rationale: 'r', citations: [] }],
    assumptions: [{ id: randomUUID(), statement: 's', rationale: 'r', citations: [] }],
    read_chunks: [{ source_id: randomUUID(), position: 0 }],
  });

  it('DraftRecord parses a full draft and refuses a stray field', () => {
    expect(DraftRecord.safeParse(record()).success).toBe(true);
    expect(DraftRecord.safeParse({ ...record(), extra: 1 }).success).toBe(false);
    expect(DraftRecord.safeParse({ ...record(), prompt_version: 'v1' }).success).toBe(false);
    expect(DraftRecord.safeParse({ ...record(), path: 'sometimes' }).success).toBe(false);
  });

  it('DraftRecord: an item may be left with no citation, which the page says (FR-054)', () => {
    const draft = record();
    expect(DraftRecord.safeParse({ ...draft, elements: [{ ...draft.elements[0], citations: [] }] }).success).toBe(true);
  });

  it('ExtractionStatus: a start that is offered, and one that is not with its reason', () => {
    const base = { latest: null, chunks_available: 18, budget_chars: 36000 };
    expect(ExtractionStatus.safeParse({ ...base, start: { offered: true, path: 'whole', replaces_draft: false } }).success).toBe(true);
    for (const reason of ['no_generation_provider', 'extraction_active', 'sources_processing', 'no_ready_source', 'no_embedding_provider', 'embeddings_out_of_date', 'would_repeat']) {
      const start = { offered: false, reason, message: 'Wait.', source_ids: [] };
      expect(ExtractionStatus.safeParse({ ...base, start }).success, reason).toBe(true);
    }
    expect(ExtractionStatus.safeParse({ ...base, start: { offered: false, reason: 'because', message: 'x', source_ids: [] } }).success).toBe(false);
    expect(ExtractionStatus.safeParse({ ...base, start: { offered: true, path: 'whole' } }).success).toBe(false);
  });
});

describe('the job kind, steps and categories this milestone adds (FR-040, FR-044)', () => {
  it('has the extract_system kind and its three steps', () => {
    expect(JOB_KINDS).toContain('extract_system');
    for (const step of ['select', 'generate', 'store']) expect(JobProgress.safeParse({ step }).success, step).toBe(true);
  });

  it('has the three categories, and only sources_changed is retried', () => {
    for (const category of ['no_ready_source', 'embeddings_out_of_date', 'sources_changed']) expect(JOB_FAILURE_CATEGORIES).toContain(category);
    expect(JOB_TRANSIENT_CATEGORIES).toContain('sources_changed');
    expect(JOB_TRANSIENT_CATEGORIES).not.toContain('no_ready_source');
    expect(JOB_TRANSIENT_CATEGORIES).not.toContain('embeddings_out_of_date');
  });
});
