import type { Database } from '@scrylux/db';
import { sql, type Kysely } from 'kysely';
import type { ChunkForPrompt } from './content.js';
import type { ReadySourceFacts } from './path.js';

// What an extraction reads from the database about a threat model's sources and chunks (Phase 3 Milestone 4, FR-004, FR-011, FR-012).
// Reads only. Every statement is parameterized.

type Db = Kysely<Database>;

export type SourceStatus = 'waiting' | 'processing' | 'ready' | 'failed';

/** One source of a threat model, with the status it is shown with (Milestone 3, research #1): read from its latest ingestion job. */
export interface SourceFact {
  id: string;
  name: string;
  status: SourceStatus;
  /** Set exactly when the source is ready. */
  textChars: number | null;
  chunkCount: number | null;
  embeddingModel: string | null;
  embeddingDimension: number | null;
}

interface SourceRow {
  id: string;
  name: string;
  ready_at: Date | null;
  text_chars: number | null;
  chunk_count: number | null;
  embedding_model: string | null;
  embedding_dimension: number | null;
  ingest_state: string | null;
}

/** The threat model's sources, oldest first, as the order in which an extraction reads them (FR-011). */
export async function loadSourceFacts(db: Db, threatModelId: string): Promise<SourceFact[]> {
  const { rows } = await sql<SourceRow>`
    SELECT s.id, s.name, s.ready_at, s.text_chars, s.chunk_count, s.embedding_model, s.embedding_dimension,
           (SELECT j.state FROM jobs j WHERE j.source_id = s.id AND j.kind = 'ingest_source' ORDER BY j.queued_at DESC, j.id DESC LIMIT 1) AS ingest_state
    FROM sources s WHERE s.threat_model_id = ${threatModelId} ORDER BY s.added_at, s.id`.execute(db);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.ready_at !== null ? 'ready' : row.ingest_state === 'queued' ? 'waiting' : row.ingest_state === 'running' ? 'processing' : 'failed',
    textChars: row.text_chars,
    chunkCount: row.chunk_count,
    embeddingModel: row.embedding_model,
    embeddingDimension: row.embedding_dimension,
  }));
}

/** The ready sources, in the shape that choosing a path and checking embeddings need. */
export function readyFacts(facts: readonly SourceFact[]): ReadySourceFacts[] {
  return facts
    .filter((fact) => fact.status === 'ready')
    .map((fact) => ({
      id: fact.id,
      textChars: fact.textChars as number,
      chunkCount: fact.chunkCount as number,
      embeddingModel: fact.embeddingModel as string,
      embeddingDimension: fact.embeddingDimension as number,
    }));
}

/** A chunk as the extraction holds it: what the content builder needs, and where it sits among the sources. */
export interface LoadedChunk extends ChunkForPrompt {
  /** The place of its source among the ready sources, oldest first. */
  sourceOrder: number;
  /** Its text, in characters (code points). */
  chars: number;
  /** Its place in its source. */
  position: number;
}

/**
 * Chunks of ready sources, in source order and then position. `sourceIds` are the ready sources in the order they are read, and
 * `only`, when given, narrows the result to those chunks. The text is the chunk's, verbatim.
 */
export async function loadChunks(db: Db, sourceIds: readonly string[], only?: readonly string[]): Promise<LoadedChunk[]> {
  if (sourceIds.length === 0 || (only !== undefined && only.length === 0)) return [];
  let query = db
    .selectFrom('chunks as c')
    .innerJoin('sources as s', 's.id', 'c.source_id')
    .select(['c.id', 'c.source_id', 's.name', 'c.position', 'c.page_first', 'c.page_last', 'c.line_first', 'c.line_last', 'c.heading', 'c.text'])
    .where('c.source_id', 'in', [...sourceIds]);
  if (only !== undefined) query = query.where('c.id', 'in', [...only]);
  const rows = await query.execute();
  const order = new Map(sourceIds.map((id, index) => [id, index]));
  return rows
    .map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      sourceName: row.name,
      pageFirst: row.page_first,
      pageLast: row.page_last,
      lineFirst: row.line_first,
      lineLast: row.line_last,
      heading: row.heading,
      text: row.text,
      sourceOrder: order.get(row.source_id) as number,
      chars: [...row.text].length,
      position: row.position,
    }))
    .sort((a, b) => a.sourceOrder - b.sourceOrder || a.position - b.position);
}

/** The first chunk of each source, in source order: the seeds of the retrieval path (research #6). */
export async function loadFirstChunks(db: Db, sourceIds: readonly string[]): Promise<Array<{ id: string; sourceOrder: number; position: number; chars: number }>> {
  if (sourceIds.length === 0) return [];
  const { rows } = await sql<{ id: string; source_id: string; position: number; chars: number }>`
    SELECT id, source_id, "position", char_length(text)::int AS chars FROM chunks WHERE source_id = ANY(${[...sourceIds]}::uuid[]) AND "position" = 0`.execute(db);
  const order = new Map(sourceIds.map((id, index) => [id, index]));
  return rows.map((row) => ({ id: row.id, sourceOrder: order.get(row.source_id) as number, position: row.position, chars: row.chars })).sort((a, b) => a.sourceOrder - b.sourceOrder);
}
