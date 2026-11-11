import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, createProject, createThreatModel, createUser, escapeIdentifier, expectPgError, pool } from './helpers.js';

// The draft tables (018) and the changes 018 makes to jobs: the checks here are what the API and the worker rely on, so they are tested
// directly rather than through either (Phase 3 Milestone 4, data-model.md). Each rule is quoted from the data model in the name of its test.

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;
const TABLES = ['drafts', 'draft_sources', 'draft_read_chunks', 'draft_items', 'draft_asset_holders', 'draft_citations', 'sources', 'chunks', 'jobs'] as const;

const COLUMNS = {
  drafts: ['chunks_available', 'chunks_read', 'generation_model', 'id', 'job_id', 'made_at', 'nothing_found', 'path', 'prompt_version', 'sources_total', 'started_by', 'threat_model_id'],
  draft_sources: ['draft_id', 'read', 'source_id'],
  draft_read_chunks: ['chunk_id', 'draft_id', 'label'],
  // 018's columns and the seven decision columns that 019 adds (Phase 3 Milestone 5).
  draft_items: [
    'asset_id',
    'assumption_id',
    'body',
    'boundary_id',
    'decided_at',
    'decided_by',
    'decision',
    'draft_id',
    'element_id',
    'flags',
    'id',
    'kind',
    'name',
    'outcome',
    'position',
    'rationale',
    'source_item_id',
    'target_item_id',
  ],
  draft_asset_holders: ['asset_id', 'element_id'],
  draft_citations: ['chunk_id', 'flag', 'id', 'item_id', 'position', 'quote_end', 'quote_start'],
};

let userId: number;

beforeAll(async () => {
  userId = (await createUser()).id;
});
afterAll(closePool);

// Table and column names come from this file's own fixed values, checked and escaped like an identifier in production code
// (Principle I). The values are always parameters.
async function insertInto(table: (typeof TABLES)[number], row: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!TABLES.includes(table)) throw new Error('insertInto(): bad table');
  const columns = Object.keys(row);
  if (!columns.every((column) => IDENTIFIER_PATTERN.test(column))) throw new Error('insertInto(): bad column name');
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

/** A ready source with one chunk, as a finished ingestion leaves them. */
async function readySource(threatModelId: string): Promise<{ sourceId: string; chunkId: string }> {
  const source = await insertInto('sources', {
    threat_model_id: threatModelId,
    name: 'design.md',
    type: 'md',
    size_bytes: 100,
    digest: randomBytes(32),
    added_by: userId,
    original_key: null,
    stored_bytes: 22,
    ready_at: new Date(),
    text_chars: 10,
    chunk_count: 1,
    embedding_model: 'nomic-embed-text',
    embedding_dimension: 3,
  });
  const chunk = await insertInto('chunks', { source_id: source.id, position: 0, start_offset: 0, end_offset: 5, text: 'hello', embedding: '[1,2,3]' });
  return { sourceId: source.id as string, chunkId: chunk.id as string };
}

const insertDraft = (threatModelId: string, values: Record<string, unknown> = {}) =>
  insertInto('drafts', {
    threat_model_id: threatModelId,
    started_by: userId,
    generation_model: 'claude-test',
    prompt_version: 'extract-system/0123456789ab',
    path: 'whole',
    chunks_read: 3,
    chunks_available: 3,
    sources_total: 1,
    ...values,
  });

const item = (draftId: string, position: number, values: Record<string, unknown> = {}) => ({
  draft_id: draftId,
  position,
  kind: 'process',
  name: `Item ${position}`,
  rationale: 'Because the document says so.',
  ...values,
});
const insertItem = (draftId: string, position: number, values: Record<string, unknown> = {}) => insertInto('draft_items', item(draftId, position, values));

async function newDraft(): Promise<{ threatModelId: string; draftId: string; sourceId: string; chunkId: string }> {
  const threatModelId = await newThreatModel();
  const { sourceId, chunkId } = await readySource(threatModelId);
  const draft = await insertDraft(threatModelId);
  return { threatModelId, draftId: draft.id as string, sourceId, chunkId };
}

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
const extraction = (threatModelId: string, values: Record<string, unknown> = {}) =>
  insertJob({ kind: 'extract_system', threat_model_id: threatModelId, input: JSON.stringify({}), ...values });

async function exists(table: string, column: string, value: string): Promise<boolean> {
  if (!IDENTIFIER_PATTERN.test(table) || !IDENTIFIER_PATTERN.test(column)) throw new Error('exists(): bad name');
  const { rows } = await pool().query(`SELECT 1 FROM ${escapeIdentifier(table)} WHERE ${escapeIdentifier(column)} = $1`, [value]);
  return rows.length > 0;
}

describe('the tables', () => {
  for (const [table, expected] of Object.entries(COLUMNS)) {
    it(`gives ${table} exactly the columns of the data model`, async () => {
      const { rows } = await pool().query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      expect(rows.map((r) => r.column_name).sort()).toEqual(expected);
    });
  }
});

describe('drafts', () => {
  it('holds at most one draft for a threat model (FR-052)', async () => {
    const threatModelId = await newThreatModel();
    await readySource(threatModelId);
    await insertDraft(threatModelId);
    await expectPgError(insertDraft(threatModelId), { code: '23505', constraint: 'drafts_threat_model_key' });
  });

  it('takes a prompt version of "extract-system/" and twelve hex digits, and nothing else', async () => {
    const threatModelId = await newThreatModel();
    for (const bad of ['v1', 'extract-system/0123456789a', 'extract-system/0123456789abc', 'extract-system/0123456789AB', 'other/0123456789ab', '']) {
      await expectPgError(insertDraft(threatModelId, { prompt_version: bad }), { code: '23514', constraint: 'drafts_prompt_version_check' });
    }
    await insertDraft(threatModelId, { prompt_version: 'extract-system/abcdef012345' });
  });

  it('takes the path "whole" or "retrieval"', async () => {
    const threatModelId = await newThreatModel();
    await expectPgError(insertDraft(threatModelId, { path: 'partial' }), { code: '23514', constraint: 'drafts_path_check' });
    await insertDraft(threatModelId, { path: 'retrieval', chunks_available: 400 });
  });

  it('reads 1 to 1,000 chunks, at most as many as are available, and all of them on the whole path', async () => {
    const threatModelId = await newThreatModel();
    await expectPgError(insertDraft(threatModelId, { chunks_read: 0, chunks_available: 0 }), { code: '23514', constraint: 'drafts_chunks_read_check' });
    await expectPgError(insertDraft(threatModelId, { chunks_read: 1001, chunks_available: 1001 }), { code: '23514', constraint: 'drafts_chunks_read_check' });
    await expectPgError(insertDraft(threatModelId, { chunks_read: 5, chunks_available: 4, path: 'retrieval' }), { code: '23514', constraint: 'drafts_chunks_available_check' });
    // Reading all of them means as many as there are.
    await expectPgError(insertDraft(threatModelId, { chunks_read: 5, chunks_available: 9, path: 'whole' }), { code: '23514', constraint: 'drafts_chunks_available_check' });
    await insertDraft(threatModelId, { chunks_read: 1000, chunks_available: 5000, path: 'retrieval' });
  });

  it('considers at least one source', async () => {
    const threatModelId = await newThreatModel();
    await expectPgError(insertDraft(threatModelId, { sources_total: 0 }), { code: '23514', constraint: 'drafts_sources_total_check' });
  });

  it('gives a reason for an empty draft of 1 to 300 characters', async () => {
    const threatModelId = await newThreatModel();
    for (const bad of ['', '   ', 'x'.repeat(301)]) {
      await expectPgError(insertDraft(threatModelId, { nothing_found: bad }), { code: '23514', constraint: 'drafts_nothing_found_check' });
    }
    await insertDraft(threatModelId, { nothing_found: 'x'.repeat(300) });
  });

  it('is deleted with its threat model, with every row under it (FR-056)', async () => {
    const { threatModelId, draftId, sourceId, chunkId } = await newDraft();
    await insertInto('draft_sources', { draft_id: draftId, source_id: sourceId, read: true });
    await insertInto('draft_read_chunks', { draft_id: draftId, chunk_id: chunkId, label: 1 });
    const a = await insertItem(draftId, 0);
    await insertInto('draft_citations', { item_id: a.id, position: 0, chunk_id: chunkId, quote_start: 0, quote_end: 12 });
    await pool().query('DELETE FROM threat_models WHERE id = $1', [threatModelId]);
    expect(await exists('drafts', 'id', draftId)).toBe(false);
    expect(await exists('draft_sources', 'draft_id', draftId)).toBe(false);
    expect(await exists('draft_read_chunks', 'draft_id', draftId)).toBe(false);
    expect(await exists('draft_items', 'draft_id', draftId)).toBe(false);
    expect(await exists('draft_citations', 'item_id', a.id as string)).toBe(false);
  });

  it('is deleted with the project of its threat model', async () => {
    const project = await createProject(userId);
    const threatModelId = (await createThreatModel(project.id)).id;
    await readySource(threatModelId);
    const draft = await insertDraft(threatModelId);
    await pool().query('DELETE FROM projects WHERE id = $1', [project.id]);
    expect(await exists('drafts', 'id', draft.id as string)).toBe(false);
  });

  it('keeps itself when the job that made it is removed on its own, with the link cleared', async () => {
    const threatModelId = await newThreatModel();
    await readySource(threatModelId);
    const job = await extraction(threatModelId);
    const draft = await insertDraft(threatModelId, { job_id: job.id });
    await pool().query('DELETE FROM jobs WHERE id = $1', [job.id]);
    const { rows } = await pool().query<{ job_id: string | null }>('SELECT job_id FROM drafts WHERE id = $1', [draft.id]);
    expect(rows[0]?.job_id).toBeNull();
  });

  it('does not let the account that started it be deleted from under it', async () => {
    const other = await createUser();
    const threatModelId = await newThreatModel();
    await readySource(threatModelId);
    await insertDraft(threatModelId, { started_by: other.id });
    await expectPgError(pool().query('DELETE FROM users WHERE id = $1', [other.id]), { code: '23503' });
  });
});

describe('draft_sources and draft_read_chunks', () => {
  it('lose their rows with a deleted source or chunk, and the draft stays (FR-053, FR-054)', async () => {
    const { draftId, sourceId, chunkId } = await newDraft();
    await insertInto('draft_sources', { draft_id: draftId, source_id: sourceId, read: false });
    await insertInto('draft_read_chunks', { draft_id: draftId, chunk_id: chunkId, label: 1 });
    await pool().query('DELETE FROM sources WHERE id = $1', [sourceId]);
    expect(await exists('draft_sources', 'draft_id', draftId)).toBe(false);
    expect(await exists('draft_read_chunks', 'draft_id', draftId)).toBe(false);
    expect(await exists('drafts', 'id', draftId)).toBe(true);
  });

  it('names a chunk once, and a label once, within a draft: "label 1 to 1,000"', async () => {
    const { threatModelId, draftId, chunkId } = await newDraft();
    await insertInto('draft_read_chunks', { draft_id: draftId, chunk_id: chunkId, label: 1 });
    await expectPgError(insertInto('draft_read_chunks', { draft_id: draftId, chunk_id: chunkId, label: 2 }), { code: '23505', constraint: 'draft_read_chunks_pkey' });
    const second = await insertInto('chunks', {
      source_id: (await pool().query<{ id: string }>('SELECT id FROM sources WHERE threat_model_id = $1', [threatModelId])).rows[0]?.id,
      position: 1,
      start_offset: 5,
      end_offset: 10,
      text: 'world',
      embedding: '[1,2,3]',
    });
    await expectPgError(insertInto('draft_read_chunks', { draft_id: draftId, chunk_id: second.id, label: 1 }), { code: '23505', constraint: 'draft_read_chunks_label_key' });
    for (const bad of [0, 1001]) {
      await expectPgError(insertInto('draft_read_chunks', { draft_id: draftId, chunk_id: second.id, label: bad }), { code: '23514', constraint: 'draft_read_chunks_label_check' });
    }
    await insertInto('draft_read_chunks', { draft_id: draftId, chunk_id: second.id, label: 1000 });
  });
});

describe('draft_items', () => {
  it('takes the seven kinds', async () => {
    const { draftId } = await newDraft();
    await expectPgError(insertItem(draftId, 0, { kind: 'threat' }), { code: '23514', constraint: 'draft_items_kind_check' });
    const kinds = ['process', 'data_store', 'external_entity', 'trust_boundary'];
    for (const [i, kind] of kinds.entries()) await insertItem(draftId, i, { kind });
    await insertItem(draftId, 10, { kind: 'asset', body: 'The threats it stores.' });
    await insertItem(draftId, 11, { kind: 'assumption', name: null, body: 'The network is private.' });
  });

  it('gives an element and an asset a name of 1 to 200 characters, and an assumption none', async () => {
    const { draftId } = await newDraft();
    for (const bad of ['', '   ', 'x'.repeat(201)]) {
      await expectPgError(insertItem(draftId, 0, { name: bad }), { code: '23514', constraint: 'draft_items_name_check' });
    }
    await expectPgError(insertItem(draftId, 0, { name: null }), { code: '23514', constraint: 'draft_items_name_check' });
    await expectPgError(insertItem(draftId, 0, { kind: 'assumption', body: 'A statement.' }), { code: '23514', constraint: 'draft_items_name_check' });
    await insertItem(draftId, 1, { name: 'x'.repeat(200) });
  });

  it('gives an asset and an assumption a body of 1 to 300 characters, and an element none', async () => {
    const { draftId } = await newDraft();
    await expectPgError(insertItem(draftId, 0, { body: 'An element has no body.' }), { code: '23514', constraint: 'draft_items_body_check' });
    await expectPgError(insertItem(draftId, 0, { kind: 'asset' }), { code: '23514', constraint: 'draft_items_body_check' });
    for (const bad of ['', '  ', 'x'.repeat(301)]) {
      await expectPgError(insertItem(draftId, 0, { kind: 'asset', body: bad }), { code: '23514', constraint: 'draft_items_body_check' });
    }
    await insertItem(draftId, 1, { kind: 'asset', body: 'x'.repeat(300) });
  });

  it('gives every item a rationale of 1 to 300 characters', async () => {
    const { draftId } = await newDraft();
    for (const bad of ['', '   ', 'x'.repeat(301)]) {
      await expectPgError(insertItem(draftId, 0, { rationale: bad }), { code: '23514', constraint: 'draft_items_rationale_check' });
    }
    await insertItem(draftId, 1, { rationale: 'x'.repeat(300) });
  });

  it('numbers its items 0 to 69, once each, in a draft', async () => {
    const { draftId } = await newDraft();
    await expectPgError(insertItem(draftId, -1), { code: '23514', constraint: 'draft_items_position_check' });
    await expectPgError(insertItem(draftId, 70), { code: '23514', constraint: 'draft_items_position_check' });
    await insertItem(draftId, 69);
    await expectPgError(insertItem(draftId, 69), { code: '23505', constraint: 'draft_items_position_key' });
  });

  it('sets the endpoints of a data flow, and only of a data flow, and not the same one twice', async () => {
    const { draftId } = await newDraft();
    const a = await insertItem(draftId, 0);
    const b = await insertItem(draftId, 1, { kind: 'data_store' });
    await expectPgError(insertItem(draftId, 2, { kind: 'data_flow' }), { code: '23514', constraint: 'draft_items_endpoints_check' });
    await expectPgError(insertItem(draftId, 2, { kind: 'data_flow', source_item_id: a.id }), { code: '23514', constraint: 'draft_items_endpoints_check' });
    await expectPgError(insertItem(draftId, 2, { source_item_id: a.id, target_item_id: b.id }), { code: '23514', constraint: 'draft_items_endpoints_check' });
    await expectPgError(insertItem(draftId, 2, { kind: 'data_flow', source_item_id: a.id, target_item_id: a.id }), { code: '23514', constraint: 'draft_items_flow_not_self_loop' });
    await insertItem(draftId, 2, { kind: 'data_flow', source_item_id: a.id, target_item_id: b.id });
  });

  it('puts an element in a boundary, but not a data flow, an asset or an assumption, and not a boundary in itself', async () => {
    const { draftId } = await newDraft();
    const zone = await insertItem(draftId, 0, { kind: 'trust_boundary' });
    const a = await insertItem(draftId, 1);
    await insertItem(draftId, 2, { boundary_id: zone.id });
    await insertItem(draftId, 3, { kind: 'trust_boundary', boundary_id: zone.id });
    await expectPgError(insertItem(draftId, 4, { kind: 'data_flow', source_item_id: a.id, target_item_id: zone.id, boundary_id: zone.id }), { code: '23514', constraint: 'draft_items_boundary_check' });
    await expectPgError(insertItem(draftId, 4, { kind: 'asset', body: 'b', boundary_id: zone.id }), { code: '23514', constraint: 'draft_items_boundary_check' });
    const id = randomUUID();
    await expectPgError(insertItem(draftId, 5, { id, kind: 'trust_boundary', boundary_id: id }), { code: '23514', constraint: 'draft_items_boundary_check' });
  });

  it('keeps flags to an object, and to the elements that have flags', async () => {
    const { draftId } = await newDraft();
    await insertItem(draftId, 0, { flags: JSON.stringify({ internet_facing: true }) });
    await expectPgError(insertItem(draftId, 1, { flags: JSON.stringify([true]) }), { code: '23514', constraint: 'draft_items_flags_check' });
    await expectPgError(insertItem(draftId, 1, { kind: 'trust_boundary', flags: JSON.stringify({ internet_facing: true }) }), { code: '23514', constraint: 'draft_items_flags_check' });
    await expectPgError(insertItem(draftId, 1, { kind: 'asset', body: 'b', flags: JSON.stringify({ internet_facing: true }) }), { code: '23514', constraint: 'draft_items_flags_check' });
    await insertItem(draftId, 2, { kind: 'trust_boundary' });
  });

  it('points only at an item of its own draft', async () => {
    const one = await newDraft();
    const two = await newDraft();
    const foreign = await insertItem(two.draftId, 0, { kind: 'trust_boundary' });
    await expectPgError(insertItem(one.draftId, 0, { boundary_id: foreign.id }), { code: '23503', constraint: 'draft_items_boundary_fkey' });
    const a = await insertItem(one.draftId, 1);
    await expectPgError(insertItem(one.draftId, 2, { kind: 'data_flow', source_item_id: a.id, target_item_id: foreign.id }), { code: '23503', constraint: 'draft_items_target_fkey' });
  });

  it('lets a draft be written in any order: a member before its boundary, in one transaction', async () => {
    const { draftId } = await newDraft();
    const zone = randomUUID();
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO draft_items (draft_id, "position", kind, name, rationale, boundary_id) VALUES ($1, 0, 'process', 'Inside', 'r', $2)`,
        [draftId, zone],
      );
      await client.query(`INSERT INTO draft_items (id, draft_id, "position", kind, name, rationale) VALUES ($1, $2, 1, 'trust_boundary', 'Zone', 'r')`, [zone, draftId]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await exists('draft_items', 'id', zone)).toBe(true);
  });
});

describe('draft_asset_holders', () => {
  it('names an element once for an asset, and goes with either', async () => {
    const { draftId } = await newDraft();
    const asset = await insertItem(draftId, 0, { kind: 'asset', body: 'b' });
    const store = await insertItem(draftId, 1, { kind: 'data_store' });
    await insertInto('draft_asset_holders', { asset_id: asset.id, element_id: store.id });
    await expectPgError(insertInto('draft_asset_holders', { asset_id: asset.id, element_id: store.id }), { code: '23505', constraint: 'draft_asset_holders_pkey' });
    await pool().query('DELETE FROM draft_items WHERE id = $1', [store.id]);
    expect(await exists('draft_asset_holders', 'asset_id', asset.id as string)).toBe(false);
  });
});

describe('draft_citations', () => {
  it('keeps the span of a quote in its chunk, 12 to 2,000 code points, and never its text', async () => {
    const { draftId, chunkId } = await newDraft();
    const a = await insertItem(draftId, 0);
    const cite = (values: Record<string, unknown>) => insertInto('draft_citations', { item_id: a.id, position: 0, chunk_id: chunkId, quote_start: 0, quote_end: 12, ...values });
    for (const bad of [
      { quote_start: -1, quote_end: 20 },
      { quote_start: 5, quote_end: 5 },
      { quote_start: 10, quote_end: 5 },
      { quote_start: 0, quote_end: 11 },
      { quote_start: 1990, quote_end: 2001 },
    ]) {
      await expectPgError(cite(bad), { code: '23514', constraint: 'draft_citations_span_check' });
    }
    await cite({ quote_start: 1988, quote_end: 2000 });
    expect(await columnNames('draft_citations')).not.toContain('quote');
  });

  it('numbers the citations of an item 0 to 4, once each, and the citations of each flag apart from the item’s own', async () => {
    const { draftId, chunkId } = await newDraft();
    const a = await insertItem(draftId, 0);
    const cite = (values: Record<string, unknown>) => insertInto('draft_citations', { item_id: a.id, position: 0, chunk_id: chunkId, quote_start: 0, quote_end: 12, ...values });
    await expectPgError(cite({ position: 5 }), { code: '23514', constraint: 'draft_citations_position_check' });
    await cite({});
    await expectPgError(cite({}), { code: '23505', constraint: 'draft_citations_position_key' });
    await cite({ flag: 'internet_facing' });
    await expectPgError(cite({ flag: 'internet_facing' }), { code: '23505', constraint: 'draft_citations_position_key' });
    await cite({ flag: 'requires_authentication' });
    await cite({ position: 1 });
  });

  it('refuses an empty flag name, which would be taken for the item itself', async () => {
    const { draftId, chunkId } = await newDraft();
    const a = await insertItem(draftId, 0);
    await expectPgError(
      insertInto('draft_citations', { item_id: a.id, position: 0, chunk_id: chunkId, quote_start: 0, quote_end: 12, flag: '' }),
      { code: '23514', constraint: 'draft_citations_flag_check' },
    );
  });

  it('survives its chunk’s deletion with the chunk cleared, and the draft and the item stay (FR-054)', async () => {
    const { draftId, sourceId, chunkId } = await newDraft();
    const a = await insertItem(draftId, 0);
    const cited = await insertInto('draft_citations', { item_id: a.id, position: 0, chunk_id: chunkId, quote_start: 0, quote_end: 12 });
    await pool().query('DELETE FROM sources WHERE id = $1', [sourceId]);
    const { rows } = await pool().query<{ chunk_id: string | null; quote_start: number; quote_end: number }>(
      'SELECT chunk_id, quote_start, quote_end FROM draft_citations WHERE id = $1',
      [cited.id],
    );
    expect(rows[0]).toEqual({ chunk_id: null, quote_start: 0, quote_end: 12 });
    expect(await exists('draft_items', 'id', a.id as string)).toBe(true);
    expect(await exists('drafts', 'id', draftId)).toBe(true);
  });

  it('goes with its item', async () => {
    const { draftId, chunkId } = await newDraft();
    const a = await insertItem(draftId, 0);
    const cited = await insertInto('draft_citations', { item_id: a.id, position: 0, chunk_id: chunkId, quote_start: 0, quote_end: 12 });
    await pool().query('DELETE FROM draft_items WHERE id = $1', [a.id]);
    expect(await exists('draft_citations', 'id', cited.id as string)).toBe(false);
  });
});

async function columnNames(table: string): Promise<string[]> {
  const { rows } = await pool().query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]);
  return rows.map((r) => r.column_name);
}

describe('jobs (FR-042, FR-044)', () => {
  const failed = (category: string) => ({
    state: 'failed',
    run: 1,
    claim: 1,
    started_at: new Date(),
    deadline_at: new Date(Date.now() + 3_600_000),
    finished_at: new Date(),
    failure_category: category,
  });

  it('accepts the extract_system kind with a threat model and no source', async () => {
    const threatModelId = await newThreatModel();
    const job = await extraction(threatModelId);
    expect(job).toMatchObject({ kind: 'extract_system', threat_model_id: threatModelId, source_id: null, state: 'queued' });
  });

  it('refuses an extraction that belongs to no threat model', async () => {
    await expectPgError(insertJob({ kind: 'extract_system', input: JSON.stringify({}) }), { code: '23514', constraint: 'jobs_scope_check' });
  });

  it('keeps refusing a kind it does not know', async () => {
    await expectPgError(insertJob({ kind: 'extraction' }), { code: '23514', constraint: 'jobs_kind_check' });
  });

  it.each(['no_ready_source', 'embeddings_out_of_date', 'sources_changed'])('accepts the failure category %s', async (category) => {
    const threatModelId = await newThreatModel();
    await extraction(threatModelId, failed(category));
  });

  it('keeps refusing a failure category it does not know, and still accepts the earlier ones', async () => {
    const threatModelId = await newThreatModel();
    await expectPgError(extraction(threatModelId, failed('sources_changed_by_someone')), { code: '23514', constraint: 'jobs_failure_category_check' });
    for (const category of ['invalid_output', 'input_too_large', 'output_limit_reached', 'cap_reached', 'document_space_full']) {
      await extraction(threatModelId, failed(category));
    }
  });

  it('allows one queued or running extraction of a threat model at a time', async () => {
    const threatModelId = await newThreatModel();
    await extraction(threatModelId);
    await expectPgError(extraction(threatModelId), { code: '23505', constraint: 'jobs_one_extraction_idx' });
    const running = {
      state: 'running',
      run: 1,
      claim: 1,
      started_at: new Date(),
      deadline_at: new Date(Date.now() + 3_600_000),
      // A running job has a worker and a lease (jobs_running_check).
      worker_id: randomUUID(),
      lease_expires_at: new Date(Date.now() + 60_000),
    };
    const other = await newThreatModel();
    const job = await extraction(other, running);
    await expectPgError(extraction(other), { code: '23505', constraint: 'jobs_one_extraction_idx' });
    expect(job.state).toBe('running');
  });

  it('allows another once the first has ended, and one for another threat model at the same time', async () => {
    const threatModelId = await newThreatModel();
    await extraction(threatModelId, failed('invalid_output'));
    await extraction(threatModelId);
    await extraction(await newThreatModel());
  });

  it('does not limit the other kinds: a provider check, or two ingestions of one threat model', async () => {
    await insertJob();
    await insertJob();
  });
});
