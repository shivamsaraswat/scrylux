import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, createProject, createThreatModel, createUser, escapeIdentifier, expectPgError, pool } from './helpers.js';

// sources and chunks (017), and the changes 017 makes to jobs: the checks here are what the API and the worker rely on, so
// they are tested directly rather than through either (Phase 3 Milestone 3, data-model.md). Each rule is quoted from the
// data model in the name of its test.

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

const COLUMNS = {
  sources: [
    'added_at',
    'added_by',
    'chunk_count',
    'digest',
    'embedding_dimension',
    'embedding_model',
    'id',
    'name',
    'original_key',
    'pages_without_text',
    'ready_at',
    'size_bytes',
    'stored_bytes',
    'text_chars',
    'threat_model_id',
    'type',
  ],
  chunks: [
    'embedding',
    'end_offset',
    'heading',
    'id',
    'line_first',
    'line_last',
    'page_first',
    'page_last',
    'position',
    'source_id',
    'start_offset',
    'text',
  ],
};

let userId: number;
let threatModelId: string;

beforeAll(async () => {
  userId = (await createUser()).id;
  threatModelId = (await createThreatModel((await createProject(userId)).id)).id;
});
afterAll(closePool);

// Column names come from this file's own fixed values, checked and escaped like an identifier in production code
// (Principle I). The values are always parameters.
async function insertInto(table: 'sources' | 'chunks' | 'jobs' | 'job_usage', row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const columns = Object.keys(row);
  if (!columns.every((column) => IDENTIFIER_PATTERN.test(column))) throw new Error('insert(): bad column name');
  const { rows } = await pool().query<Record<string, unknown>>(
    `INSERT INTO ${escapeIdentifier(table)} (${columns.map(escapeIdentifier).join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(row),
  );
  const created = rows[0];
  if (!created) throw new Error('insert returned no row');
  return created;
}

const newThreatModel = async (): Promise<string> => (await createThreatModel((await createProject(userId)).id)).id;

/** A source that is waiting for its ingestion: its original is stored and it is not ready. */
const waiting = (values: Record<string, unknown> = {}) => ({
  threat_model_id: threatModelId,
  name: 'design.md',
  type: 'md',
  size_bytes: 100,
  digest: randomBytes(32),
  added_by: userId,
  original_key: `sources/${randomUUID()}`,
  stored_bytes: 100,
  ...values,
});

/** The same source once ready: no original, and the facts of its ingestion. */
const ready = (values: Record<string, unknown> = {}) =>
  waiting({
    original_key: null,
    ready_at: new Date(),
    text_chars: 10,
    chunk_count: 1,
    embedding_model: 'nomic-embed-text',
    embedding_dimension: 3,
    stored_bytes: 22,
    ...values,
  });

const insertSource = (values: Record<string, unknown> = {}) => insertInto('sources', waiting(values));
const insertReady = (values: Record<string, unknown> = {}) => insertInto('sources', ready(values));

const chunk = (sourceId: string, values: Record<string, unknown> = {}) => ({
  source_id: sourceId,
  position: 0,
  start_offset: 0,
  end_offset: 5,
  text: 'hello',
  embedding: '[1,2,3]',
  ...values,
});
const insertChunk = (sourceId: string, values: Record<string, unknown> = {}) => insertInto('chunks', chunk(sourceId, values));

const insertJob = (values: Record<string, unknown> = {}) =>
  insertInto('jobs', {
    kind: 'provider_check',
    created_by: userId,
    max_runs: 3,
    time_limit_ms: 3_600_000,
    token_cap: 500_000,
    cost_cap_usd: 5,
    ...values,
  });

const ingestionJob = (sourceId: string | null, values: Record<string, unknown> = {}) =>
  insertJob({ kind: 'ingest_source', threat_model_id: threatModelId, source_id: sourceId, input: JSON.stringify({ source_id: sourceId }), ...values });

async function columnsOf(table: string): Promise<string[]> {
  const { rows } = await pool().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return rows.map((r) => r.column_name).sort();
}

async function exists(table: 'sources' | 'chunks' | 'jobs', id: string): Promise<boolean> {
  const { rows } = await pool().query(`SELECT 1 FROM ${escapeIdentifier(table)} WHERE id = $1`, [id]);
  return rows.length === 1;
}

describe('the tables', () => {
  it.each(Object.entries(COLUMNS))('%s has exactly the documented columns', async (table, expected) => {
    expect(await columnsOf(table)).toEqual(expected);
  });

  it('adds threat_model_id and source_id to jobs', async () => {
    const columns = await columnsOf('jobs');
    expect(columns).toContain('threat_model_id');
    expect(columns).toContain('source_id');
  });

  it('has the vector extension', async () => {
    const { rows } = await pool().query<{ extname: string }>(`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
    expect(rows).toHaveLength(1);
  });
});

describe('sources defaults', () => {
  it('adds a waiting source with the documented defaults', async () => {
    const source = await insertSource();
    expect(source).toMatchObject({
      ready_at: null,
      text_chars: null,
      chunk_count: null,
      pages_without_text: null,
      embedding_model: null,
      embedding_dimension: null,
    });
    expect(source.added_at).toBeInstanceOf(Date);
    expect(source.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('sources checks', () => {
  it.each([
    ['an empty name', { name: '' }, 'sources_name_check'],
    ['a name of only spaces', { name: '   ' }, 'sources_name_check'],
    ['a name of 256 characters (the rule is 1–255 characters after trimming)', { name: 'a'.repeat(256) }, 'sources_name_check'],
    ['a type outside md, txt, pdf, docx, text', { type: 'doc' }, 'sources_type_check'],
    ['a size_bytes of 0 (the rule is > 0)', { size_bytes: 0 }, 'sources_size_check'],
    ['a digest that is not 32 bytes (SHA-256)', { digest: randomBytes(16) }, 'sources_digest_check'],
    ['a stored_bytes of 0 (the rule is > 0)', { stored_bytes: 0 }, 'sources_stored_bytes_check'],
    ['an original_key that is not generated by Scrylux', { original_key: '../etc/passwd' }, 'sources_original_key_check'],
    ['an original_key built from a name', { original_key: 'sources/design.md' }, 'sources_original_key_check'],
  ])('rejects %s', async (_label, values, constraint) => {
    await expectPgError(insertSource(values), { code: '23514', constraint });
  });

  it('accepts a name of 1 and of 255 characters', async () => {
    await insertSource({ name: 'a' });
    await insertSource({ name: 'é'.repeat(255) });
  });

  it('accepts each of the five types', async () => {
    for (const type of ['md', 'txt', 'pdf', 'docx', 'text']) await insertSource({ type });
  });

  it.each([
    ['ready_at set without the facts of the ingestion', () => waiting({ original_key: null, ready_at: new Date() }), 'sources_ready_check'],
    ['the facts of the ingestion without ready_at', () => waiting({ text_chars: 10, chunk_count: 1, embedding_model: 'm', embedding_dimension: 3 }), 'sources_ready_check'],
    ['a ready source with a missing embedding_model', () => ready({ embedding_model: null }), 'sources_ready_check'],
    ['a ready source with a missing embedding_dimension', () => ready({ embedding_dimension: null }), 'sources_ready_check'],
    ['a ready source that still has its original (ready_at IS NOT NULL ⇒ original_key IS NULL)', () => ready({ original_key: `sources/${randomUUID()}` }), 'sources_original_presence_check'],
    ['a source that is not ready and has no original (ready_at IS NULL ⇒ original_key IS NOT NULL)', () => waiting({ original_key: null }), 'sources_original_presence_check'],
    ['a text_chars of 0', () => ready({ text_chars: 0 }), 'sources_text_chars_check'],
    ['a chunk_count of 0', () => ready({ chunk_count: 0 }), 'sources_chunk_count_check'],
    ['an embedding_dimension of 0 (the rule is 1–16,000)', () => ready({ embedding_dimension: 0 }), 'sources_dimension_check'],
    ['an embedding_dimension of 16,001', () => ready({ embedding_dimension: 16_001 }), 'sources_dimension_check'],
    ['a blank embedding_model', () => ready({ embedding_model: '  ' }), 'sources_embedding_model_check'],
  ])('rejects %s', async (_label, row, constraint) => {
    await expectPgError(insertInto('sources', row()), { code: '23514', constraint });
  });

  it('accepts the edges of embedding_dimension, 1 and 16,000', async () => {
    await insertReady({ embedding_dimension: 1 });
    await insertReady({ embedding_dimension: 16_000 });
  });

  it('allows pages_without_text only on a ready pdf (pages_without_text IS NOT NULL ⇒ type = pdf AND ready_at IS NOT NULL)', async () => {
    await expectPgError(insertSource({ type: 'pdf', pages_without_text: 1 }), { code: '23514', constraint: 'sources_pages_without_text_check' });
    await expectPgError(insertReady({ type: 'docx', pages_without_text: 1 }), { code: '23514', constraint: 'sources_pages_without_text_check' });
    await expectPgError(insertReady({ type: 'pdf', pages_without_text: -1 }), { code: '23514', constraint: 'sources_pages_without_text_check' });
    await insertReady({ type: 'pdf', pages_without_text: 0 });
    await insertReady({ type: 'pdf', pages_without_text: 4 });
  });

  it('refuses the same content twice on one threat model (UNIQUE (threat_model_id, digest)), and allows it on another', async () => {
    const digest = randomBytes(32);
    await insertSource({ digest });
    await expectPgError(insertSource({ digest }), { code: '23505', constraint: 'sources_digest_key' });
    await insertSource({ digest, threat_model_id: await newThreatModel() });
  });

  it('gives every stored original its own key', async () => {
    const original_key = `sources/${randomUUID()}`;
    await insertSource({ original_key });
    await expectPgError(insertSource({ original_key }), { code: '23505', constraint: 'sources_original_key_key' });
  });

  it('refuses a source for a threat model or an account that does not exist', async () => {
    await expectPgError(insertSource({ threat_model_id: randomUUID() }), { code: '23503', constraint: 'sources_threat_model_id_fkey' });
    await expectPgError(insertSource({ added_by: 2_000_000_000 }), { code: '23503', constraint: 'sources_added_by_fkey' });
  });

  it('does not let an account that added a source be deleted from under it (RESTRICT)', async () => {
    const adder = await createUser();
    await insertSource({ added_by: adder.id });
    await expectPgError(pool().query('DELETE FROM users WHERE id = $1', [adder.id]), { code: '23503', constraint: 'sources_added_by_fkey' });
  });
});

describe('chunks checks', () => {
  let sourceId: string;
  beforeAll(async () => {
    sourceId = (await insertReady()).id as string;
  });

  it.each([
    ['a negative position', { position: -1 }, 'chunks_position_check'],
    ['a start_offset below 0 (the rule is 0 ≤ start < end)', { start_offset: -1, end_offset: 4, text: 'hello' }, 'chunks_offsets_check'],
    ['an end_offset equal to start_offset', { start_offset: 5, end_offset: 5, text: '' }, 'chunks_offsets_check'],
    ['an end_offset before start_offset', { start_offset: 6, end_offset: 5, text: '' }, 'chunks_offsets_check'],
    ['a chunk of 2,001 characters (end − start ≤ 2000)', { start_offset: 0, end_offset: 2001, text: 'a'.repeat(2001) }, 'chunks_offsets_check'],
    ['a text whose length is not end_offset − start_offset', { text: 'hell' }, 'chunks_text_check'],
    ['a page_first without a page_last (both or neither)', { page_first: 1 }, 'chunks_pages_check'],
    ['a page_last without a page_first', { page_last: 1 }, 'chunks_pages_check'],
    ['a page_first of 0 (1 ≤ first ≤ last)', { page_first: 0, page_last: 1 }, 'chunks_pages_check'],
    ['a page_last before page_first', { page_first: 3, page_last: 2 }, 'chunks_pages_check'],
    ['a line_first without a line_last (both or neither)', { line_first: 1 }, 'chunks_lines_check'],
    ['a line_first of 0 (1 ≤ first ≤ last)', { line_first: 0, line_last: 1 }, 'chunks_lines_check'],
    ['a line_last before line_first', { line_first: 3, line_last: 2 }, 'chunks_lines_check'],
    ['a heading of 201 characters (the rule is ≤ 200)', { heading: 'h'.repeat(201) }, 'chunks_heading_check'],
  ])('rejects %s', async (_label, values, constraint) => {
    await expectPgError(insertChunk(sourceId, values), { code: '23514', constraint });
  });

  it('accepts a chunk of exactly 2,000 characters, and counts an astral character as one', async () => {
    await insertChunk(sourceId, { position: 1, start_offset: 5, end_offset: 2005, text: 'a'.repeat(2000) });
    // U+1F600 is one code point and two UTF-16 units: the offsets count code points (research #6).
    await insertChunk(sourceId, { position: 2, start_offset: 2005, end_offset: 2008, text: 'a\u{1F600}b' });
  });

  it('accepts pages, lines and a heading of 200 characters', async () => {
    await insertChunk(sourceId, { position: 3, page_first: 1, page_last: 2, line_first: 4, line_last: 4, heading: 'h'.repeat(200) });
  });

  it('refuses a position used twice in one source (UNIQUE (source_id, position))', async () => {
    await insertChunk(sourceId, { position: 10 });
    await expectPgError(insertChunk(sourceId, { position: 10 }), { code: '23505', constraint: 'chunks_position_key' });
  });

  it('requires an embedding', async () => {
    await expectPgError(insertChunk(sourceId, { position: 11, embedding: null }), { code: '23502', column: 'embedding' });
  });

  it('keeps vectors of different dimensions in one table (no fixed dimension)', async () => {
    const wide = `[${Array.from({ length: 3072 }, (_, i) => (i % 7) / 7).join(',')}]`;
    await insertChunk(sourceId, { position: 12, embedding: wide });
    await insertChunk(sourceId, { position: 13, embedding: '[0.5,0.25]' });
    const { rows } = await pool().query<{ dims: number }>('SELECT vector_dims(embedding) AS dims FROM chunks WHERE source_id = $1 AND position IN (12, 13) ORDER BY position', [sourceId]);
    expect(rows.map((r) => r.dims)).toEqual([3072, 2]);
  });

  it('refuses a chunk for a source that does not exist', async () => {
    await expectPgError(insertChunk(randomUUID()), { code: '23503', constraint: 'chunks_source_id_fkey' });
  });
});

describe('jobs after 017', () => {
  it('accepts the two ingestion kinds with a threat model and a source', async () => {
    const sourceId = (await insertSource()).id as string;
    await ingestionJob(sourceId);
    await ingestionJob(sourceId, { kind: 'refresh_embeddings' });
  });

  it('still rejects a kind that is not one of the three', async () => {
    await expectPgError(insertJob({ kind: 'extraction' }), { code: '23514', constraint: 'jobs_kind_check' });
  });

  it('keeps the provider check outside every threat model (kind = provider_check ⇔ threat_model_id IS NULL)', async () => {
    await insertJob();
    await expectPgError(insertJob({ threat_model_id: threatModelId }), { code: '23514', constraint: 'jobs_scope_check' });
    await expectPgError(ingestionJob(null, { threat_model_id: null }), { code: '23514', constraint: 'jobs_scope_check' });
  });

  it.each([
    'unsupported_type',
    'encrypted',
    'damaged',
    'no_text_found',
    'too_large',
    'too_large_unpacked',
    'unreadable',
    'storage_unavailable',
    'document_space_full',
  ])('accepts the failure category %s', async (category) => {
    const sourceId = (await insertSource()).id as string;
    await ingestionJob(sourceId, {
      state: 'failed',
      run: 1,
      claim: 1,
      started_at: new Date(),
      deadline_at: new Date(Date.now() + 3_600_000),
      finished_at: new Date(),
      failure_category: category,
    });
  });

  it('allows a detail only with its category: time and memory with unreadable, pages and chars with too_large', async () => {
    const failed = (category: string, detail: string | null) => ({
      state: 'failed',
      run: 1,
      claim: 1,
      started_at: new Date(),
      deadline_at: new Date(Date.now() + 3_600_000),
      finished_at: new Date(),
      failure_category: category,
      failure_detail: detail,
    });
    const sourceId = (await insertSource()).id as string;
    for (const [category, detail] of [
      ['unreadable', 'time'],
      ['unreadable', 'memory'],
      ['too_large', 'pages'],
      ['too_large', 'chars'],
      ['cap_reached', 'cap_below_one_request'],
    ] as const) {
      await ingestionJob(sourceId, failed(category, detail));
    }
    for (const [category, detail] of [
      ['unreadable', 'pages'],
      ['too_large', 'time'],
      ['encrypted', 'memory'],
      ['unreadable', 'cap_below_one_request'],
    ] as const) {
      await expectPgError(ingestionJob(sourceId, failed(category, detail)), { code: '23514', constraint: 'jobs_failure_detail_check' });
    }
  });
});

describe('what a deletion takes with it', () => {
  it('deletes a threat model with its sources, their chunks, its jobs and their usage records', async () => {
    const tm = await newThreatModel();
    const source = await insertSource({ threat_model_id: tm });
    const sourceId = source.id as string;
    const readySource = await insertReady({ threat_model_id: tm });
    const chunkRow = await insertChunk(readySource.id as string);
    const job = await ingestionJob(sourceId, { threat_model_id: tm });
    await insertInto('job_usage', {
      job_id: job.id,
      run: 1,
      operation: 'embed',
      provider: 'openai-compatible',
      model: 'nomic-embed-text',
      outcome: 'ok',
      attempts: 1,
      input_tokens: 10,
      output_tokens: 0,
      tokens_estimated: true,
      cost_usd: null,
      cost_estimated: false,
      price_source: 'none',
      temperature_applied: null,
      duration_ms: 5,
    });

    await pool().query('DELETE FROM threat_models WHERE id = $1', [tm]);

    expect(await exists('sources', sourceId)).toBe(false);
    expect(await exists('sources', readySource.id as string)).toBe(false);
    expect(await exists('chunks', chunkRow.id as string)).toBe(false);
    expect(await exists('jobs', job.id as string)).toBe(false);
    const { rows } = await pool().query('SELECT 1 FROM job_usage WHERE job_id = $1', [job.id]);
    expect(rows).toHaveLength(0);
  });

  it('deletes a project down to the sources of its threat models', async () => {
    const project = await createProject(userId);
    const tm = (await createThreatModel(project.id)).id;
    const source = await insertSource({ threat_model_id: tm });
    await pool().query('DELETE FROM projects WHERE id = $1', [project.id]);
    expect(await exists('sources', source.id as string)).toBe(false);
  });

  it('deletes a source with its chunks and leaves its jobs, with no source (ON DELETE SET NULL)', async () => {
    const source = await insertReady();
    const chunkRow = await insertChunk(source.id as string);
    const queued = await ingestionJob(source.id as string);
    await pool().query('DELETE FROM sources WHERE id = $1', [source.id]);
    expect(await exists('chunks', chunkRow.id as string)).toBe(false);
    const { rows } = await pool().query<{ source_id: string | null; threat_model_id: string }>('SELECT source_id, threat_model_id FROM jobs WHERE id = $1', [queued.id]);
    expect(rows[0]).toEqual({ source_id: null, threat_model_id: threatModelId });
  });

  it('lets a source be deleted although a job of it has ended, and changes nothing else on that job', async () => {
    // jobs_final_is_final forbids any change to a job that has ended (FR-012); 017 allows exactly this one: the link to a
    // source that was deleted.
    const source = await insertSource();
    const ended = await ingestionJob(source.id as string, {
      state: 'failed',
      run: 1,
      claim: 1,
      started_at: new Date(),
      deadline_at: new Date(Date.now() + 3_600_000),
      finished_at: new Date(),
      failure_category: 'damaged',
    });
    await pool().query('DELETE FROM sources WHERE id = $1', [source.id]);
    const { rows } = await pool().query<{ source_id: string | null; state: string; failure_category: string }>('SELECT source_id, state, failure_category FROM jobs WHERE id = $1', [ended.id]);
    expect(rows[0]).toEqual({ source_id: null, state: 'failed', failure_category: 'damaged' });
  });

  it('still refuses every other change to a job that has ended', async () => {
    const source = await insertSource();
    const ended = await ingestionJob(source.id as string, {
      state: 'failed',
      run: 1,
      claim: 1,
      started_at: new Date(),
      deadline_at: new Date(Date.now() + 3_600_000),
      finished_at: new Date(),
      failure_category: 'damaged',
    });
    await expectPgError(pool().query(`UPDATE jobs SET failure_category = 'encrypted' WHERE id = $1`, [ended.id]), { code: '23514', constraint: 'jobs_final_is_final' });
    await expectPgError(pool().query('UPDATE jobs SET source_id = NULL, run = 2 WHERE id = $1', [ended.id]), { code: '23514', constraint: 'jobs_final_is_final' });
    await expectPgError(pool().query('UPDATE jobs SET source_id = $2 WHERE id = $1', [ended.id, (await insertSource()).id]), { code: '23514', constraint: 'jobs_final_is_final' });
  });
});
