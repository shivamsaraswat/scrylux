import type { JobFailureCategory, JobFailureDetail } from '@scrylux/core';
import type { Database } from '@scrylux/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { RunCommit } from '../jobs/store.js';
import type { ChunkDraft } from './chunk.js';
import { lockSpace } from './store.js';

// What a successful ingestion or refresh writes, in the one transaction that ends its job (Phase 3 Milestone 3, FR-024, FR-057,
// research #2, #8, #12). The chunks of a source, with their embeddings, appear all at once or not at all. The lock order is
// the source, then the install's document space, then the job (which finishRun takes).

type Db = Kysely<Database>;
type Trx = Transaction<Database>;

const BATCH = 500;
/** An embedding takes 4 bytes a dimension (research #12). */
const BYTES_PER_DIMENSION = 4;

/** pgvector's text form of a vector. It is always bound as a parameter, never written into a statement. */
export const vectorText = (vector: readonly number[]): string => `[${vector.join(',')}]`;

/** What the worker needs to know about a source before it works on it. */
export interface WorkSource {
  id: string;
  threatModelId: string;
  type: 'md' | 'txt' | 'pdf' | 'docx' | 'text';
  originalKey: string | null;
  readyAt: Date | null;
  storedBytes: number;
  chunkCount: number | null;
  embeddingDimension: number | null;
}

export async function loadWorkSource(db: Db, id: string): Promise<WorkSource | undefined> {
  const row = await db
    .selectFrom('sources')
    .select(['id', 'threat_model_id', 'type', 'original_key', 'ready_at', 'stored_bytes', 'chunk_count', 'embedding_dimension'])
    .where('id', '=', id)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : {
        id: row.id,
        threatModelId: row.threat_model_id,
        type: row.type,
        originalKey: row.original_key,
        readyAt: row.ready_at,
        storedBytes: Number(row.stored_bytes),
        chunkCount: row.chunk_count,
        embeddingDimension: row.embedding_dimension,
      };
}

/** Takes the source's lock, then the document space's. False when the source is gone: the job then ends as cancelled. */
async function lockForWrite(trx: Trx, sourceId: string): Promise<boolean> {
  const { rows } = await sql`SELECT 1 FROM sources WHERE id = ${sourceId} FOR UPDATE`.execute(trx);
  if (rows.length === 0) return false;
  await lockSpace(trx);
  return true;
}

/** Whether the ready sources, with this one at its new size, would pass the install's document space (FR-009). */
async function spaceCheck(trx: Trx, sourceId: string, newBytes: number, capBytes: number): Promise<{ category: JobFailureCategory; detail?: JobFailureDetail } | undefined> {
  const { rows } = await sql<{ others: string }>`SELECT coalesce(sum(stored_bytes), 0)::text AS others FROM sources WHERE id <> ${sourceId}`.execute(trx);
  return Number(rows[0]?.others ?? 0) + newBytes > capBytes ? { category: 'document_space_full' } : undefined;
}

export interface IngestResult {
  chunks: ChunkDraft[];
  /** One embedding per chunk, in order. */
  vectors: number[][];
  model: string;
  dimension: number;
  textBytes: number;
  textChars: number;
  pagesWithoutText: number | null;
}

/**
 * Ingestion: insert every chunk with its embedding, and make the source ready, its original forgotten. Chunks are inserted in
 * batches under Postgres's limit on bound parameters (research #9).
 */
export function ingestCommit(sourceId: string, result: IngestResult, documentSpaceBytes: number): RunCommit {
  const stored = result.textBytes + result.chunks.length * result.dimension * BYTES_PER_DIMENSION;
  return {
    lock: (trx) => lockForWrite(trx, sourceId),
    check: (trx) => spaceCheck(trx, sourceId, stored, documentSpaceBytes),
    async write(trx) {
      for (let at = 0; at < result.chunks.length; at += BATCH) {
        const rows = result.chunks.slice(at, at + BATCH).map((chunk, i) => ({
          source_id: sourceId,
          position: chunk.position,
          start_offset: chunk.startOffset,
          end_offset: chunk.endOffset,
          text: chunk.text,
          page_first: chunk.pageFirst,
          page_last: chunk.pageLast,
          line_first: chunk.lineFirst,
          line_last: chunk.lineLast,
          heading: chunk.heading,
          embedding: vectorText(result.vectors[at + i] as number[]),
        }));
        await trx.insertInto('chunks').values(rows).execute();
      }
      await trx
        .updateTable('sources')
        .set({
          ready_at: sql<Date>`now()`,
          text_chars: result.textChars,
          chunk_count: result.chunks.length,
          pages_without_text: result.pagesWithoutText,
          embedding_model: result.model,
          embedding_dimension: result.dimension,
          stored_bytes: stored,
          original_key: null,
        })
        .where('id', '=', sourceId)
        .execute();
    },
  };
}

export interface RefreshResult {
  /** The chunks' ids, in position order. */
  chunkIds: string[];
  vectors: number[][];
  model: string;
  dimension: number;
}

/** Refresh: replace every chunk's embedding and the source's model and dimension, changing no id and no text (FR-034). */
export function refreshCommit(sourceId: string, result: RefreshResult, documentSpaceBytes: number): RunCommit {
  return {
    lock: (trx) => lockForWrite(trx, sourceId),
    async check(trx) {
      const { rows } = await sql<{ text_bytes: string }>`SELECT coalesce(sum(octet_length(text)), 0)::text AS text_bytes FROM chunks WHERE source_id = ${sourceId}`.execute(trx);
      return spaceCheck(trx, sourceId, Number(rows[0]?.text_bytes ?? 0) + result.chunkIds.length * result.dimension * BYTES_PER_DIMENSION, documentSpaceBytes);
    },
    async write(trx) {
      for (let at = 0; at < result.chunkIds.length; at += BATCH) {
        const values = result.chunkIds.slice(at, at + BATCH).map((id, i) => sql`(${id}::uuid, ${vectorText(result.vectors[at + i] as number[])})`);
        await sql`UPDATE chunks AS c SET embedding = v.embedding::vector FROM (VALUES ${sql.join(values)}) AS v(id, embedding) WHERE c.id = v.id`.execute(trx);
      }
      const { rows } = await sql<{ text_bytes: string }>`SELECT coalesce(sum(octet_length(text)), 0)::text AS text_bytes FROM chunks WHERE source_id = ${sourceId}`.execute(trx);
      await trx
        .updateTable('sources')
        .set({
          embedding_model: result.model,
          embedding_dimension: result.dimension,
          stored_bytes: Number(rows[0]?.text_bytes ?? 0) + result.chunkIds.length * result.dimension * BYTES_PER_DIMENSION,
        })
        .where('id', '=', sourceId)
        .execute();
    },
  };
}

/** Chunks with their ids and text, in order, for a refresh. */
export async function loadChunkTexts(db: Db, sourceId: string): Promise<{ id: string; text: string }[]> {
  return db.selectFrom('chunks').select(['id', 'text']).where('source_id', '=', sourceId).orderBy('position').execute();
}
