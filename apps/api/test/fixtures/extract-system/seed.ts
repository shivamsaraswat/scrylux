import { randomBytes, randomUUID } from 'node:crypto';
import db from '../../../src/db.js';

// Seeding for the extraction tests (Phase 3 Milestone 4, tasks T003): a threat model, and sources and chunks written directly, as a
// finished ingestion leaves them, so that a test needs no ingestion run. The sources are added one second apart, so that "oldest first"
// is the order they were seeded in.

let tick = 0;

export async function seedAccount(): Promise<number> {
  const { rows } = await db.query<{ id: number }>('INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id', [`extract-test-${randomUUID()}`, 'not-a-real-hash']);
  return rows[0]?.id as number;
}

export async function seedThreatModel(accountId: number): Promise<{ projectId: string; threatModelId: string }> {
  const { rows: project } = await db.query<{ id: string }>('INSERT INTO projects (name, created_by) VALUES ($1, $2) RETURNING id', [`p-${randomUUID()}`, accountId]);
  const projectId = project[0]?.id as string;
  const { rows: model } = await db.query<{ id: string }>('INSERT INTO threat_models (project_id, name) VALUES ($1, $2) RETURNING id', [projectId, 'model']);
  return { projectId, threatModelId: model[0]?.id as string };
}

/** pgvector's text form of a vector. */
export const vectorOf = (numbers: readonly number[]): string => `[${numbers.join(',')}]`;

export interface SeededSource {
  sourceId: string;
  chunkIds: string[];
  /** The text of each chunk, in order. */
  texts: string[];
}

export interface ReadySourceOptions {
  name?: string;
  /** The text of each chunk, in order. */
  chunks: readonly string[];
  model?: string;
  dimension?: number;
  /** The vector of the chunk at this position. The default is a direction that depends on the position. */
  vector?: (position: number) => number[];
  pagesOrLines?: 'lines' | 'pages';
}

// Never the zero vector, whose cosine distance is undefined.
const defaultVector = (position: number, dimension: number): number[] => Array.from({ length: dimension }, (_, d) => (((position + 1) * (d + 1)) % 7) + 1);

/** A ready source with the given chunks and an embedding for each, with no original and no job. */
export async function seedReadySource(accountId: number, threatModelId: string, options: ReadySourceOptions): Promise<SeededSource> {
  const model = options.model ?? 'nomic-embed-text';
  const dimension = options.dimension ?? 3;
  const texts = [...options.chunks];
  const textChars = texts.reduce((sum, text) => sum + [...text].length, 0);
  const addedAt = new Date(Date.now() - 1_000_000 + ++tick * 1000);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sources (threat_model_id, name, type, size_bytes, digest, added_by, added_at, original_key, stored_bytes, ready_at, text_chars, chunk_count, embedding_model, embedding_dimension)
     VALUES ($1, $2, 'md', 100, $3, $4, $5, NULL, $6, now(), $7, $8, $9, $10) RETURNING id`,
    [threatModelId, options.name ?? `source-${tick}.md`, randomBytes(32), accountId, addedAt, textChars + texts.length * dimension * 4, textChars, texts.length, model, dimension],
  );
  const sourceId = rows[0]?.id as string;
  const chunkIds: string[] = [];
  let offset = 0;
  let line = 1;
  for (const [position, text] of texts.entries()) {
    const length = [...text].length;
    const lines = text.split('\n').length;
    const vector = (options.vector ?? ((p: number) => defaultVector(p, dimension)))(position);
    const { rows: chunk } = await db.query<{ id: string }>(
      `INSERT INTO chunks (source_id, "position", start_offset, end_offset, text, page_first, page_last, line_first, line_last, heading, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        sourceId,
        position,
        offset,
        offset + length,
        text,
        options.pagesOrLines === 'pages' ? position + 1 : null,
        options.pagesOrLines === 'pages' ? position + 1 : null,
        options.pagesOrLines === 'pages' ? null : line,
        options.pagesOrLines === 'pages' ? null : line + lines - 1,
        position === 0 ? 'Architecture' : null,
        vectorOf(vector),
      ],
    );
    chunkIds.push(chunk[0]?.id as string);
    offset += length;
    line += lines;
  }
  return { sourceId, chunkIds, texts };
}

/** A source that is not ready: its ingestion is waiting, running, or has failed. It has no chunks. */
export async function seedUnreadySource(accountId: number, threatModelId: string, state: 'waiting' | 'processing' | 'failed', name = `unready-${++tick}.md`): Promise<string> {
  const addedAt = new Date(Date.now() - 1_000_000 + ++tick * 1000);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sources (threat_model_id, name, type, size_bytes, digest, added_by, added_at, original_key, stored_bytes)
     VALUES ($1, $2, 'md', 100, $3, $4, $5, $6, 100) RETURNING id`,
    [threatModelId, name, randomBytes(32), accountId, addedAt, `sources/${randomUUID()}`],
  );
  const sourceId = rows[0]?.id as string;
  const base = `kind, input, created_by, max_runs, time_limit_ms, token_cap, cost_cap_usd, threat_model_id, source_id`;
  const values = `'ingest_source', $1, $2, 3, 3600000, 500000, 5, $3, $4`;
  const input = JSON.stringify({ source_id: sourceId });
  if (state === 'waiting') {
    await db.query(`INSERT INTO jobs (${base}) VALUES (${values})`, [input, accountId, threatModelId, sourceId]);
  } else if (state === 'processing') {
    await db.query(
      `INSERT INTO jobs (${base}, state, run, claim, started_at, deadline_at, worker_id, lease_expires_at) VALUES (${values}, 'running', 1, 1, now(), now() + interval '1 hour', $5, now() + interval '1 minute')`,
      [input, accountId, threatModelId, sourceId, randomUUID()],
    );
  } else {
    await db.query(
      `INSERT INTO jobs (${base}, state, run, claim, started_at, deadline_at, finished_at, failure_category) VALUES (${values}, 'failed', 1, 1, now(), now() + interval '1 hour', now(), 'damaged')`,
      [input, accountId, threatModelId, sourceId],
    );
  }
  return sourceId;
}

/** The smallest draft the tables accept: one item with one citation, over the given chunk. For tests of the routes that read or replace a draft. */
export async function seedDraft(accountId: number, threatModelId: string, source: { sourceId: string; chunkIds: string[] }): Promise<{ draftId: string; itemId: string }> {
  const { rows: draft } = await db.query<{ id: string }>(
    `INSERT INTO drafts (threat_model_id, started_by, generation_model, prompt_version, path, chunks_read, chunks_available, sources_total)
     VALUES ($1, $2, 'seeded-model', 'extract-system/0123456789ab', 'whole', $3, $3, 1) RETURNING id`,
    [threatModelId, accountId, source.chunkIds.length],
  );
  const draftId = draft[0]?.id as string;
  await db.query('INSERT INTO draft_sources (draft_id, source_id, read) VALUES ($1, $2, true)', [draftId, source.sourceId]);
  await db.query('INSERT INTO draft_read_chunks (draft_id, chunk_id, label) VALUES ($1, $2, 1)', [draftId, source.chunkIds[0]]);
  const { rows: item } = await db.query<{ id: string }>(
    `INSERT INTO draft_items (draft_id, "position", kind, name, rationale) VALUES ($1, 0, 'process', 'API', 'The API serves the web application.') RETURNING id`,
    [draftId],
  );
  const itemId = item[0]?.id as string;
  await db.query('INSERT INTO draft_citations (item_id, "position", chunk_id, quote_start, quote_end) VALUES ($1, 0, $2, 0, 20)', [itemId, source.chunkIds[0]]);
  return { draftId, itemId };
}
