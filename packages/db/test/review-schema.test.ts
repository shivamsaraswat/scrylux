import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MAX_ASSETS, MAX_ASSUMPTIONS } from '@scrylux/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, createElement, createProject, createThreatModel, createUser, deleteProjects, escapeIdentifier, expectPgError, pool } from './helpers.js';

// The records and provenance of Phase 3 Milestone 5 (019, data-model.md): assets, their holders, assumptions, the provenance of what an
// accept created, and the decision columns of the draft's items. The checks here are what the API relies on, so they are tested
// directly rather than through it. Each rule is quoted from the data model in the name of its test.

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;
const TABLES = [
  'assets',
  'asset_holders',
  'assumptions',
  'provenance',
  'provenance_citations',
  'drafts',
  'draft_items',
  'sources',
  'chunks',
] as const;

let userId: number;
const projects: string[] = [];

beforeAll(async () => {
  userId = (await createUser()).id;
});
afterAll(async () => {
  await deleteProjects(projects);
  await closePool();
});

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

async function newThreatModel(): Promise<string> {
  const project = await createProject(userId);
  projects.push(project.id);
  return (await createThreatModel(project.id)).id;
}

const asset = (threatModelId: string, name: string, values: Record<string, unknown> = {}) =>
  insertInto('assets', { threat_model_id: threatModelId, name, description: 'Something worth protecting.', ...values });
const assumption = (threatModelId: string, statement: string) => insertInto('assumptions', { threat_model_id: threatModelId, statement });

async function readyChunk(threatModelId: string): Promise<string> {
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
  return chunk.id as string;
}

async function exists(table: string, column: string, value: string): Promise<boolean> {
  if (!IDENTIFIER_PATTERN.test(table) || !IDENTIFIER_PATTERN.test(column)) throw new Error('exists(): bad name');
  const { rows } = await pool().query(`SELECT 1 FROM ${escapeIdentifier(table)} WHERE ${escapeIdentifier(column)} = $1`, [value]);
  return rows.length > 0;
}

describe('assets', () => {
  it('needs a name of 1 to 200 characters that is not blank, and a description of at most 10,000 that is not blank', async () => {
    const threatModelId = await newThreatModel();
    await expectPgError(asset(threatModelId, '   '), { code: '23514', constraint: 'assets_name_check' });
    await expectPgError(asset(threatModelId, 'a'.repeat(201)), { code: '23514', constraint: 'assets_name_check' });
    await expect(asset(threatModelId, 'a'.repeat(200))).resolves.toBeDefined();
    await expectPgError(asset(threatModelId, 'Blank description', { description: '  ' }), { code: '23514', constraint: 'assets_description_check' });
    await expectPgError(asset(threatModelId, 'Long description', { description: 'd'.repeat(10_001) }), { code: '23514', constraint: 'assets_description_check' });
    await expect(asset(threatModelId, 'Longest description', { description: 'd'.repeat(10_000) })).resolves.toBeDefined();
  });

  it('keeps a name unique within a threat model, ignoring case and surrounding whitespace (FR-021)', async () => {
    const threatModelId = await newThreatModel();
    await asset(threatModelId, 'Session tokens');
    await expectPgError(asset(threatModelId, '  session TOKENS '), { code: '23505', constraint: 'assets_name_key' });
    await expect(asset(await newThreatModel(), 'Session tokens')).resolves.toBeDefined();
  });

  it('holds at most 200 per threat model: the 201st is refused with assets_limit', async () => {
    const threatModelId = await newThreatModel();
    await pool().query(
      `INSERT INTO assets (threat_model_id, name, description) SELECT $1, 'asset ' || n, 'text' FROM generate_series(1, $2::int) AS n`,
      [threatModelId, MAX_ASSETS],
    );
    await expectPgError(asset(threatModelId, 'one too many'), { code: '23514', constraint: 'assets_limit' });
  });

  it('keeps the limit in the migration equal to MAX_ASSETS and MAX_ASSUMPTIONS in @scrylux/core', async () => {
    const sql = await readFile(new URL('../migrations/019_review.sql', import.meta.url), 'utf8');
    const assets = /max_assets\s+CONSTANT\s+integer\s*:=\s*(\d+)/i.exec(sql);
    const assumptions = /max_assumptions\s+CONSTANT\s+integer\s*:=\s*(\d+)/i.exec(sql);
    expect(assets, 'the migration must declare max_assets CONSTANT integer := <n>').not.toBeNull();
    expect(assumptions, 'the migration must declare max_assumptions CONSTANT integer := <n>').not.toBeNull();
    expect(Number(assets?.[1])).toBe(MAX_ASSETS);
    expect(Number(assumptions?.[1])).toBe(MAX_ASSUMPTIONS);
  });
});

describe('assumptions', () => {
  it('needs a statement that is not blank and at most 10,000 characters, unique per threat model ignoring case and whitespace', async () => {
    const threatModelId = await newThreatModel();
    await expectPgError(assumption(threatModelId, ' '), { code: '23514', constraint: 'assumptions_statement_check' });
    await expectPgError(assumption(threatModelId, 's'.repeat(10_001)), { code: '23514', constraint: 'assumptions_statement_check' });
    await assumption(threatModelId, 'The database is not exposed.');
    await expectPgError(assumption(threatModelId, ' THE database is NOT exposed. '), { code: '23505', constraint: 'assumptions_statement_key' });
    await expect(assumption(await newThreatModel(), 'The database is not exposed.')).resolves.toBeDefined();
  });

  it('holds at most 200 per threat model: the 201st is refused with assumptions_limit', async () => {
    const threatModelId = await newThreatModel();
    await pool().query(
      `INSERT INTO assumptions (threat_model_id, statement) SELECT $1, 'statement ' || n FROM generate_series(1, $2::int) AS n`,
      [threatModelId, MAX_ASSUMPTIONS],
    );
    await expectPgError(assumption(threatModelId, 'one too many'), { code: '23514', constraint: 'assumptions_limit' });
  });
});

describe('asset_holders', () => {
  it('holds elements of the same threat model only', async () => {
    const threatModelId = await newThreatModel();
    const other = await newThreatModel();
    const a = await asset(threatModelId, 'Tokens');
    const here = await createElement(threatModelId, 'process');
    const elsewhere = await createElement(other, 'process');
    await expect(insertInto('asset_holders', { threat_model_id: threatModelId, asset_id: a.id, element_id: here.id })).resolves.toBeDefined();
    await expectPgError(insertInto('asset_holders', { threat_model_id: threatModelId, asset_id: a.id, element_id: elsewhere.id }), {
      code: '23503',
      constraint: 'asset_holders_element_fkey',
    });
    await expectPgError(insertInto('asset_holders', { threat_model_id: other, asset_id: a.id, element_id: elsewhere.id }), {
      code: '23503',
      constraint: 'asset_holders_asset_fkey',
    });
  });

  it('refuses a data flow and a trust boundary as a holder, and accepts every node type', async () => {
    const threatModelId = await newThreatModel();
    const a = await asset(threatModelId, 'Tokens');
    const from = await createElement(threatModelId, 'process');
    const to = await createElement(threatModelId, 'data_store');
    const flow = await createElement(threatModelId, 'data_flow', { source_element_id: from.id, target_element_id: to.id });
    const boundary = await createElement(threatModelId, 'trust_boundary');
    for (const refused of [flow, boundary]) {
      await expectPgError(insertInto('asset_holders', { threat_model_id: threatModelId, asset_id: a.id, element_id: refused.id }), {
        code: '23514',
        constraint: 'asset_holders_node',
      });
    }
    for (const accepted of [from, to, await createElement(threatModelId, 'external_entity')]) {
      await expect(insertInto('asset_holders', { threat_model_id: threatModelId, asset_id: a.id, element_id: accepted.id })).resolves.toBeDefined();
    }
  });

  it('loses the row when the holder element is deleted, keeping the asset, and when the asset is deleted', async () => {
    const threatModelId = await newThreatModel();
    const kept = await asset(threatModelId, 'Kept');
    const gone = await asset(threatModelId, 'Gone');
    const element = await createElement(threatModelId, 'process');
    await insertInto('asset_holders', { threat_model_id: threatModelId, asset_id: kept.id, element_id: element.id });
    await insertInto('asset_holders', { threat_model_id: threatModelId, asset_id: gone.id, element_id: element.id });
    await pool().query('DELETE FROM elements WHERE id = $1', [element.id]);
    expect(await exists('assets', 'id', kept.id as string)).toBe(true);
    expect(await exists('asset_holders', 'asset_id', kept.id as string)).toBe(false);
    await pool().query('DELETE FROM assets WHERE id = $1', [gone.id]);
    expect(await exists('asset_holders', 'asset_id', gone.id as string)).toBe(false);
  });
});

describe('provenance', () => {
  const row = (threatModelId: string, values: Record<string, unknown>) =>
    insertInto('provenance', { threat_model_id: threatModelId, rationale: 'The document says so.', accepted_by: userId, ...values });

  it('names exactly one record: an element, an asset or an assumption', async () => {
    const threatModelId = await newThreatModel();
    const element = await createElement(threatModelId, 'process');
    const a = await asset(threatModelId, 'Tokens');
    await expectPgError(row(threatModelId, {}), { code: '23514', constraint: 'provenance_target_check' });
    await expectPgError(row(threatModelId, { element_id: element.id, asset_id: a.id }), { code: '23514', constraint: 'provenance_target_check' });
    await expect(row(threatModelId, { element_id: element.id })).resolves.toBeDefined();
    await expect(row(threatModelId, { asset_id: a.id })).resolves.toBeDefined();
  });

  it('puts a flag only on an element, of 1 to 64 characters, and a rationale of 1 to 300', async () => {
    const threatModelId = await newThreatModel();
    const element = await createElement(threatModelId, 'process');
    const a = await asset(threatModelId, 'Tokens');
    await expectPgError(row(threatModelId, { asset_id: a.id, flag: 'internet_facing' }), { code: '23514', constraint: 'provenance_flag_check' });
    await expectPgError(row(threatModelId, { element_id: element.id, flag: '' }), { code: '23514', constraint: 'provenance_flag_check' });
    await expectPgError(row(threatModelId, { element_id: element.id, flag: 'f'.repeat(65) }), { code: '23514', constraint: 'provenance_flag_check' });
    await expectPgError(row(threatModelId, { element_id: element.id, flag: 'internet_facing', rationale: ' ' }), { code: '23514', constraint: 'provenance_rationale_check' });
    await expectPgError(row(threatModelId, { element_id: element.id, flag: 'internet_facing', rationale: 'r'.repeat(301) }), {
      code: '23514',
      constraint: 'provenance_rationale_check',
    });
    await expect(row(threatModelId, { element_id: element.id, flag: 'internet_facing' })).resolves.toBeDefined();
  });

  it('has one row for a record and one for each of its flags, no more', async () => {
    const threatModelId = await newThreatModel();
    const element = await createElement(threatModelId, 'process');
    await row(threatModelId, { element_id: element.id });
    await expectPgError(row(threatModelId, { element_id: element.id }), { code: '23505', constraint: 'provenance_key' });
    await row(threatModelId, { element_id: element.id, flag: 'internet_facing' });
    await expectPgError(row(threatModelId, { element_id: element.id, flag: 'internet_facing' }), { code: '23505', constraint: 'provenance_key' });
    await expect(row(threatModelId, { element_id: element.id, flag: 'runs_privileged' })).resolves.toBeDefined();
  });

  it('refers to a record of its own threat model, and goes with the record, its citations with it', async () => {
    const threatModelId = await newThreatModel();
    const other = await newThreatModel();
    const element = await createElement(threatModelId, 'process');
    await expectPgError(row(other, { element_id: element.id }), { code: '23503', constraint: 'provenance_element_fkey' });
    const mark = await row(threatModelId, { element_id: element.id });
    await insertInto('provenance_citations', { provenance_id: mark.id, position: 0, chunk_id: await readyChunk(threatModelId), quote_start: 0, quote_end: 12 });
    await pool().query('DELETE FROM elements WHERE id = $1', [element.id]);
    expect(await exists('provenance', 'id', mark.id as string)).toBe(false);
    expect(await exists('provenance_citations', 'provenance_id', mark.id as string)).toBe(false);
  });

  it('keeps the user who accepted it from being deleted from under it (RESTRICT)', async () => {
    const threatModelId = await newThreatModel();
    const element = await createElement(threatModelId, 'process');
    const accepter = await createUser();
    await insertInto('provenance', { threat_model_id: threatModelId, element_id: element.id, rationale: 'x', accepted_by: accepter.id });
    await expectPgError(pool().query('DELETE FROM users WHERE id = $1', [accepter.id]), { code: '23503' });
  });
});

describe('provenance_citations', () => {
  async function mark(): Promise<{ id: string; threatModelId: string }> {
    const threatModelId = await newThreatModel();
    const element = await createElement(threatModelId, 'process');
    const created = await insertInto('provenance', { threat_model_id: threatModelId, element_id: element.id, rationale: 'x', accepted_by: userId });
    return { id: created.id as string, threatModelId };
  }

  it('keeps a span of a chunk: 0 <= start < end <= 2000, at least 12 long (and never the quote)', async () => {
    const { id, threatModelId } = await mark();
    const chunkId = await readyChunk(threatModelId);
    const span = (position: number, start: number, end: number) =>
      insertInto('provenance_citations', { provenance_id: id, position, chunk_id: chunkId, quote_start: start, quote_end: end });
    await expectPgError(span(0, -1, 20), { code: '23514', constraint: 'provenance_citations_span_check' });
    await expectPgError(span(0, 5, 5), { code: '23514', constraint: 'provenance_citations_span_check' });
    await expectPgError(span(0, 5, 16), { code: '23514', constraint: 'provenance_citations_span_check' });
    await expectPgError(span(0, 0, 2001), { code: '23514', constraint: 'provenance_citations_span_check' });
    await expect(span(0, 0, 12)).resolves.toBeDefined();
    await expect(span(1, 1988, 2000)).resolves.toBeDefined();
    const { rows } = await pool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'provenance_citations'`,
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual(['chunk_id', 'position', 'provenance_id', 'quote_end', 'quote_start']);
  });

  it('has positions 0 to 4, each once', async () => {
    const { id, threatModelId } = await mark();
    const chunkId = await readyChunk(threatModelId);
    const at = (position: number) => insertInto('provenance_citations', { provenance_id: id, position, chunk_id: chunkId, quote_start: 0, quote_end: 12 });
    await expectPgError(at(5), { code: '23514', constraint: 'provenance_citations_position_check' });
    await at(0);
    await expectPgError(at(0), { code: '23505', constraint: 'provenance_citations_pkey' });
  });

  it('keeps its row with a null chunk when the chunk is deleted: "Source deleted"', async () => {
    const { id, threatModelId } = await mark();
    const chunkId = await readyChunk(threatModelId);
    await insertInto('provenance_citations', { provenance_id: id, position: 0, chunk_id: chunkId, quote_start: 0, quote_end: 12 });
    await pool().query('DELETE FROM chunks WHERE id = $1', [chunkId]);
    const { rows } = await pool().query<{ chunk_id: string | null }>('SELECT chunk_id FROM provenance_citations WHERE provenance_id = $1', [id]);
    expect(rows).toEqual([{ chunk_id: null }]);
  });
});

describe('draft_items decisions', () => {
  async function draftItem(kind = 'process', values: Record<string, unknown> = {}): Promise<{ threatModelId: string; itemId: string }> {
    const threatModelId = await newThreatModel();
    await readyChunk(threatModelId);
    const draft = await insertInto('drafts', {
      threat_model_id: threatModelId,
      started_by: userId,
      generation_model: 'claude-test',
      prompt_version: 'extract-system/0123456789ab',
      path: 'whole',
      chunks_read: 1,
      chunks_available: 1,
      sources_total: 1,
    });
    const item = await insertInto('draft_items', {
      draft_id: draft.id,
      position: 0,
      kind,
      name: kind === 'assumption' ? null : 'Item',
      body: kind === 'asset' || kind === 'assumption' ? 'Some text.' : null,
      rationale: 'Because.',
      ...values,
    });
    return { threatModelId, itemId: item.id as string };
  }

  const decide = (itemId: string, values: Record<string, unknown>) => {
    const columns = Object.keys(values);
    if (!columns.every((column) => IDENTIFIER_PATTERN.test(column))) throw new Error('decide(): bad column name');
    return pool().query(
      `UPDATE draft_items SET ${columns.map((c, i) => `${escapeIdentifier(c)} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [itemId, ...Object.values(values)],
    );
  };

  it('is undecided with every decision column null by default', async () => {
    const { itemId } = await draftItem();
    const { rows } = await pool().query(
      'SELECT decision, decided_by, decided_at, outcome, element_id, asset_id, assumption_id FROM draft_items WHERE id = $1',
      [itemId],
    );
    expect(rows[0]).toEqual({ decision: null, decided_by: null, decided_at: null, outcome: null, element_id: null, asset_id: null, assumption_id: null });
  });

  it('sets decision, decided_by and decided_at together or not at all, and a decision is accepted or rejected', async () => {
    const { itemId } = await draftItem();
    await expectPgError(decide(itemId, { decision: 'rejected' }), { code: '23514', constraint: 'draft_items_decision_check' });
    await expectPgError(decide(itemId, { decision: 'maybe', decided_by: userId, decided_at: new Date() }), { code: '23514', constraint: 'draft_items_decision_check' });
    await expect(decide(itemId, { decision: 'rejected', decided_by: userId, decided_at: new Date() })).resolves.toBeDefined();
  });

  it('has an outcome, created or matched, exactly when it is accepted', async () => {
    const { itemId } = await draftItem();
    const decided = { decided_by: userId, decided_at: new Date() };
    await expectPgError(decide(itemId, { decision: 'accepted', ...decided }), { code: '23514', constraint: 'draft_items_outcome_check' });
    await expectPgError(decide(itemId, { decision: 'rejected', outcome: 'created', ...decided }), { code: '23514', constraint: 'draft_items_outcome_check' });
    await expectPgError(decide(itemId, { decision: 'accepted', outcome: 'other', ...decided }), { code: '23514', constraint: 'draft_items_outcome_check' });
    await expect(decide(itemId, { decision: 'accepted', outcome: 'matched', ...decided })).resolves.toBeDefined();
  });

  it('links a created record, and only the one that fits the kind, and only when the outcome is created', async () => {
    const element = await draftItem('process');
    const decided = { decision: 'accepted', decided_by: userId, decided_at: new Date() };
    const created = await createElement(element.threatModelId, 'process');
    const a = await asset(element.threatModelId, 'Tokens');
    await expectPgError(decide(element.itemId, { ...decided, outcome: 'matched', element_id: created.id }), { code: '23514', constraint: 'draft_items_link_check' });
    await expectPgError(decide(element.itemId, { ...decided, outcome: 'created', asset_id: a.id }), { code: '23514', constraint: 'draft_items_link_check' });
    await expectPgError(decide(element.itemId, { ...decided, outcome: 'created', element_id: created.id, asset_id: a.id }), {
      code: '23514',
      constraint: 'draft_items_link_check',
    });
    await expect(decide(element.itemId, { ...decided, outcome: 'created', element_id: created.id })).resolves.toBeDefined();

    const assetItem = await draftItem('asset');
    await expectPgError(decide(assetItem.itemId, { ...decided, outcome: 'created', element_id: created.id }), { code: '23514', constraint: 'draft_items_link_check' });
    const made = await asset(assetItem.threatModelId, 'Tokens');
    await expect(decide(assetItem.itemId, { ...decided, outcome: 'created', asset_id: made.id })).resolves.toBeDefined();
  });

  it('clears the link, and keeps the row and the decision, when the record it created is deleted', async () => {
    const { threatModelId, itemId } = await draftItem('process');
    const created = await createElement(threatModelId, 'process');
    await decide(itemId, { decision: 'accepted', decided_by: userId, decided_at: new Date(), outcome: 'created', element_id: created.id });
    await pool().query('DELETE FROM elements WHERE id = $1', [created.id]);
    const { rows } = await pool().query('SELECT decision, outcome, element_id FROM draft_items WHERE id = $1', [itemId]);
    expect(rows[0]).toEqual({ decision: 'accepted', outcome: 'created', element_id: null });
  });

  it('keeps the user who decided it from being deleted from under it (RESTRICT)', async () => {
    const { itemId } = await draftItem();
    const decider = await createUser();
    await decide(itemId, { decision: 'rejected', decided_by: decider.id, decided_at: new Date() });
    await expectPgError(pool().query('DELETE FROM users WHERE id = $1', [decider.id]), { code: '23503' });
  });
});

describe('cascades', () => {
  it('deletes a threat model\'s assets, holders, assumptions and provenance with the threat model', async () => {
    const threatModelId = await newThreatModel();
    const element = await createElement(threatModelId, 'process');
    const a = await asset(threatModelId, 'Tokens');
    await insertInto('asset_holders', { threat_model_id: threatModelId, asset_id: a.id, element_id: element.id });
    await assumption(threatModelId, 'Nothing is exposed.');
    await insertInto('provenance', { threat_model_id: threatModelId, asset_id: a.id, rationale: 'x', accepted_by: userId });
    await pool().query('DELETE FROM threat_models WHERE id = $1', [threatModelId]);
    for (const [table, column] of [
      ['assets', 'threat_model_id'],
      ['assumptions', 'threat_model_id'],
      ['provenance', 'threat_model_id'],
      ['asset_holders', 'threat_model_id'],
    ] as const) {
      expect(await exists(table, column, threatModelId), table).toBe(false);
    }
  });
});
