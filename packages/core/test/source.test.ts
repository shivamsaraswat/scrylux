import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ChunkPage,
  ChunkPageQuery,
  ChunkRecord,
  JOB_FAILURE_CATEGORIES,
  JOB_KINDS,
  JobCreateInput,
  JobProgress,
  JobRecord,
  SourceFileName,
  SourceList,
  SourceRecord,
  SourceTextInput,
} from '../src/index.js';

// The records of the source routes (Phase 3 Milestone 3, data-model.md and contracts/http-api.md). The API parses every
// success body with them, and the web app parses what it receives, so a stray column is a server bug and not a leak.

const AT = '2026-11-01T10:00:00.000Z';
const user = { id: 1, username: 'ada' };
const progress = { step: 'embed', done: 3, total: 10 };
const failure = { category: 'damaged', message: 'The file is damaged.', hint: 'Upload it again.', retryable: false };

const base = () => ({
  id: randomUUID(),
  threat_model_id: randomUUID(),
  name: 'design.md',
  type: 'md',
  size_bytes: 1200,
  added_by: user,
  added_at: AT,
  progress: null,
  failure: null,
  ready: null,
  refresh: null,
  refresh_failure: null,
  refreshable: false,
});

const waiting = (over: Record<string, unknown> = {}) => ({ ...base(), status: 'waiting', ...over });
const processing = (over: Record<string, unknown> = {}) => ({ ...base(), status: 'processing', progress, ...over });
const failed = (over: Record<string, unknown> = {}) => ({ ...base(), status: 'failed', failure, ...over });
const readySource = (over: Record<string, unknown> = {}) => ({
  ...base(),
  status: 'ready',
  ready: { at: AT, text_chars: 4000, chunk_count: 3, pages_without_text: null, embedding: { model: 'nomic-embed-text', dimension: 768, state: 'current' } },
  ...over,
});

describe('SourceFileName', () => {
  it.each(['a.md', 'notes.TXT', 'Design Doc.PdF', 'résumé.docx', `${'a'.repeat(252)}.md`, '  padded.md  '])('accepts %j', (name) => {
    expect(SourceFileName.safeParse(name).success).toBe(true);
  });

  it('trims the name, and counts 255 characters after trimming', () => {
    expect(SourceFileName.parse('  padded.md  ')).toBe('padded.md');
    expect(SourceFileName.safeParse(`${'a'.repeat(252)}.md`).success).toBe(true);
    expect(SourceFileName.safeParse(`${'a'.repeat(253)}.md`).success).toBe(false);
  });

  it('counts code points, as the database does: an emoji is one character, not two', () => {
    // 252 emoji and ".md" are 255 code points, and 510 UTF-16 units.
    expect(SourceFileName.safeParse(`${'\u{1F600}'.repeat(252)}.md`).success).toBe(true);
    expect(SourceFileName.safeParse(`${'\u{1F600}'.repeat(253)}.md`).success).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['no extension', 'notes'],
    ['the older Word format', 'notes.doc'],
    ['a macro-enabled Word file', 'notes.docm'],
    ['another type', 'notes.exe'],
    ['an extension in the middle', 'notes.pdf.exe'],
    ['a control character', 'no\u0007tes.md'],
    ['a new line', 'no\ntes.md'],
    ['a NUL', 'no\u0000tes.md'],
    ['256 characters', `${'a'.repeat(253)}.md`],
  ])('refuses %s', (_label, name) => {
    expect(SourceFileName.safeParse(name).success).toBe(false);
  });

  it('never repeats the name in its message', () => {
    const secret = 'confidential-merger-plan.exe';
    const result = SourceFileName.safeParse(secret);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain('confidential');
    const control = SourceFileName.safeParse('confidential\u0007.md');
    expect(JSON.stringify(control.error?.issues)).not.toContain('confidential');
  });
});

describe('SourceTextInput', () => {
  it('accepts a title and a text, and trims the title', () => {
    expect(SourceTextInput.parse({ title: '  Architecture notes ', text: 'The API talks to the database.' })).toEqual({
      title: 'Architecture notes',
      text: 'The API talks to the database.',
    });
  });

  it('keeps the text as pasted, spaces and all', () => {
    expect(SourceTextInput.parse({ title: 't', text: '  indented\n\n  text  ' }).text).toBe('  indented\n\n  text  ');
  });

  it('counts a title of 1 to 200 characters', () => {
    expect(SourceTextInput.safeParse({ title: 'a', text: 'x' }).success).toBe(true);
    expect(SourceTextInput.safeParse({ title: 'a'.repeat(200), text: 'x' }).success).toBe(true);
    expect(SourceTextInput.safeParse({ title: 'a'.repeat(201), text: 'x' }).success).toBe(false);
    expect(SourceTextInput.safeParse({ title: '   ', text: 'x' }).success).toBe(false);
    expect(SourceTextInput.safeParse({ title: '', text: 'x' }).success).toBe(false);
  });

  it('needs at least one character that is not a space in the text', () => {
    expect(SourceTextInput.safeParse({ title: 't', text: '' }).success).toBe(false);
    expect(SourceTextInput.safeParse({ title: 't', text: ' \n\t ' }).success).toBe(false);
    expect(SourceTextInput.safeParse({ title: 't', text: ' . ' }).success).toBe(true);
  });

  it('refuses a field it does not name, and a missing one', () => {
    expect(SourceTextInput.safeParse({ title: 't', text: 'x', type: 'pdf' }).success).toBe(false);
    expect(SourceTextInput.safeParse({ title: 't' }).success).toBe(false);
    expect(SourceTextInput.safeParse({ text: 'x' }).success).toBe(false);
  });
});

describe('SourceRecord', () => {
  it('accepts a source in each of the four statuses', () => {
    for (const source of [waiting(), processing(), failed(), readySource()]) expect(SourceRecord.parse(source)).toEqual(source);
  });

  it('accepts a ready source being refreshed, with the last refresh that failed', () => {
    const source = readySource({ refresh: { state: 'running', progress }, refresh_failure: { ...failure, category: 'cap_reached', retryable: true }, refreshable: true });
    expect(SourceRecord.parse(source)).toEqual(source);
  });

  it('accepts the failure category cancelled, which a source shows when its ingestion was cancelled', () => {
    const source = failed({ failure: { category: 'cancelled', message: 'Processing was cancelled.', hint: 'Retry to process it again.', retryable: true } });
    expect(SourceRecord.parse(source)).toEqual(source);
  });

  it('accepts each of the three embedding states', () => {
    for (const state of ['current', 'out_of_date', 'no_provider']) {
      const source = readySource();
      source.ready.embedding.state = state;
      expect(SourceRecord.safeParse(source).success, state).toBe(true);
    }
    const unknown = readySource();
    unknown.ready.embedding.state = 'missing';
    expect(SourceRecord.safeParse(unknown).success).toBe(false);
  });

  it.each([
    ['a ready source with no ready facts', readySource({ ready: null })],
    ['ready facts on a source that is not ready', waiting({ ready: readySource().ready })],
    ['a failed source with no failure', failed({ failure: null })],
    ['a failure on a source that has not failed', waiting({ failure: failure })],
    ['a refresh on a source that is not ready', waiting({ refresh: { state: 'queued', progress: null } })],
    ['progress on a waiting source', waiting({ progress })],
    ['a size of 0', waiting({ size_bytes: 0 })],
    ['a type outside the five', waiting({ type: 'doc' })],
    ['a status outside the four', { ...base(), status: 'paused' }],
    ['a field the record does not name', waiting({ original_key: 'sources/x' })],
    ['an id that is not a UUID', waiting({ id: 'abc' })],
  ])('refuses %s', (_label, source) => {
    expect(SourceRecord.safeParse(source).success).toBe(false);
  });

  it('shows the pages without text only as a number or null', () => {
    const source = readySource();
    source.ready.pages_without_text = 4 as never;
    expect(SourceRecord.safeParse(source).success).toBe(true);
    source.ready.pages_without_text = -1 as never;
    expect(SourceRecord.safeParse(source).success).toBe(false);
  });

  it('has no place for a key, a path, a bucket or a stored original', () => {
    const keys = Object.keys(SourceRecord.shape);
    expect(keys.filter((key) => /key|path|bucket|original|digest/.test(key))).toEqual([]);
  });
});

describe('SourceList', () => {
  const limits = { max_bytes: 10_485_760, per_threat_model: 20, used_bytes: 4096, document_space_bytes: 2_147_483_648 };

  it('holds the sources, oldest first as the API sends them, and the limits the add form shows', () => {
    const list = { sources: [waiting(), readySource()], limits };
    expect(SourceList.parse(list)).toEqual(list);
  });

  it('accepts an empty list', () => {
    expect(SourceList.safeParse({ sources: [], limits }).success).toBe(true);
  });

  it.each([
    ['a missing limit', { sources: [], limits: { max_bytes: 1, per_threat_model: 20, used_bytes: 0 } }],
    ['a negative used_bytes', { sources: [], limits: { ...limits, used_bytes: -1 } }],
    ['an extra limit', { sources: [], limits: { ...limits, secret: 1 } }],
    ['an extra field', { sources: [], limits, next: 'x' }],
  ])('refuses %s', (_label, list) => {
    expect(SourceList.safeParse(list).success).toBe(false);
  });
});

describe('ChunkRecord and ChunkPage', () => {
  const chunk = (over: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    position: 0,
    start_offset: 0,
    end_offset: 120,
    text: 'The gateway forwards each request to the service.',
    pages: null,
    lines: { first: 1, last: 3 },
    heading: 'Architecture',
    ...over,
  });

  it('accepts a chunk with lines and a heading, and one with pages and neither', () => {
    expect(ChunkRecord.safeParse(chunk()).success).toBe(true);
    expect(ChunkRecord.safeParse(chunk({ pages: { first: 2, last: 3 }, lines: null, heading: null })).success).toBe(true);
  });

  it.each([
    ['a negative position', { position: -1 }],
    ['an end before the start', { start_offset: 10, end_offset: 5 }],
    ['a chunk of 2,001 characters', { start_offset: 0, end_offset: 2001 }],
    ['a first page of 0', { pages: { first: 0, last: 1 } }],
    ['a last page before the first', { pages: { first: 3, last: 2 } }],
    ['a first line of 0', { lines: { first: 0, last: 1 } }],
    ['a last line before the first', { lines: { first: 3, last: 2 } }],
    ['a heading of 201 characters', { heading: 'h'.repeat(201) }],
    ['an embedding, which the API does not send', { embedding: [0.1, 0.2] }],
  ])('refuses %s', (_label, over) => {
    expect(ChunkRecord.safeParse(chunk(over)).success).toBe(false);
  });

  it('holds a page of chunks and whether there are more', () => {
    expect(ChunkPage.safeParse({ chunks: [chunk(), chunk({ position: 1, start_offset: 120, end_offset: 240 })], has_more: true }).success).toBe(true);
    expect(ChunkPage.safeParse({ chunks: [], has_more: false }).success).toBe(true);
    expect(ChunkPage.safeParse({ chunks: [] }).success).toBe(false);
  });
});

describe('ChunkPageQuery', () => {
  it('defaults to the first 50', () => {
    expect(ChunkPageQuery.parse({})).toEqual({ offset: 0, limit: 50 });
  });

  it('reads numbers from the query string', () => {
    expect(ChunkPageQuery.parse({ offset: '100', limit: '25' })).toEqual({ offset: 100, limit: 25 });
  });

  it('accepts a limit of 1 to 100 and an offset of 0 or more', () => {
    expect(ChunkPageQuery.safeParse({ limit: '1' }).success).toBe(true);
    expect(ChunkPageQuery.safeParse({ limit: '100' }).success).toBe(true);
    expect(ChunkPageQuery.safeParse({ offset: '0' }).success).toBe(true);
  });

  it.each([{ limit: '0' }, { limit: '101' }, { limit: '1.5' }, { limit: 'many' }, { offset: '-1' }, { offset: 'x' }, { page: '2' }])('refuses %j', (query) => {
    expect(ChunkPageQuery.safeParse(query).success).toBe(false);
  });
});

describe('the changes to the job schemas', () => {
  it('has the two ingestion kinds beside the provider check', () => {
    expect(JOB_KINDS).toEqual(['provider_check', 'ingest_source', 'refresh_embeddings']);
  });

  it('has the failure categories of ingestion beside Milestone 2’s', () => {
    for (const category of ['unsupported_type', 'encrypted', 'damaged', 'no_text_found', 'too_large', 'too_large_unpacked', 'unreadable', 'storage_unavailable', 'document_space_full']) {
      expect(JOB_FAILURE_CATEGORIES, category).toContain(category);
    }
    for (const category of ['cap_reached', 'timed_out', 'worker_lost', 'job_error']) expect(JOB_FAILURE_CATEGORIES).toContain(category);
  });

  it('has the steps of ingestion beside the provider check’s', () => {
    for (const step of ['generation', 'embeddings', 'extract', 'chunk', 'embed']) expect(JobProgress.safeParse({ step }).success, step).toBe(true);
    expect(JobProgress.safeParse({ step: 'upload' }).success).toBe(false);
  });

  it('links a job to its threat model and its source, which are null for a provider check', () => {
    const shape = JobRecord.shape;
    expect(Object.keys(shape)).toContain('threat_model_id');
    expect(Object.keys(shape)).toContain('source_id');
    expect(shape.threat_model_id.safeParse(null).success).toBe(true);
    expect(shape.source_id.safeParse(randomUUID()).success).toBe(true);
    expect(shape.source_id.safeParse('x').success).toBe(false);
  });

  it('still lets a person start only a provider check (FR-045a)', () => {
    expect(JobCreateInput.safeParse({ kind: 'provider_check' }).success).toBe(true);
    expect(JobCreateInput.safeParse({ kind: 'ingest_source' }).success).toBe(false);
    expect(JobCreateInput.safeParse({ kind: 'refresh_embeddings' }).success).toBe(false);
    expect(JobCreateInput.safeParse({ kind: 'ingest_source', source_id: randomUUID() }).success).toBe(false);
  });
});
