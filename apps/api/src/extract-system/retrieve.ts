import type { Database } from '@scrylux/db';
import { sql, type Kysely } from 'kysely';
import { vectorText } from '../sources/commit.js';
import type { Candidate } from './fill.js';

// Choosing chunks on the retrieval path (Phase 3 Milestone 4, research #6, FR-012, FR-013). One statement compares the embeddings of the
// retrieval queries with every chunk of the threat model's ready sources, exactly, and ranks the chunks for each query. There is no
// approximate index: a query is always filtered to one threat model's chunks, at most 10,000 at the default limits, where an index over
// the whole install is at its weakest, and the embeddings have no fixed dimension to index (research #6). Only embeddings of one model
// and one size are compared (M3 FR-032): the caller has checked that every source has the configured model's.
//
// The query vectors are parsed once, by MATERIALIZED. Without it the planner rescans them for every chunk and parses the text of each again: at 10,000
// chunks of 3,072 dimensions and 8 queries that was 80,000 parses of 30 KB and took 17 seconds, where the distances themselves take well under one
// (measured when the scale test was written, test/extract-system/retrieval-scale.test.ts). A vector stored out of line is read once per distance and
// that is cheap; it is the parse that costs.

type Db = Kysely<Database>;

/** How many chunks of each query are kept (research #6). */
export const PER_QUERY = 50;

interface Row {
  id: string;
  source_id: string;
  position: number;
  chars: number;
  qi: number;
}

/**
 * For each query, its nearest chunks among `sourceIds`, best first, by cosine distance, with ties broken by source and position so that
 * the same data always gives the same ranking. `sourceOrder` maps a source to its place among the ready sources.
 */
export async function rankChunks(
  db: Db,
  sourceIds: readonly string[],
  vectors: readonly (readonly number[])[],
  sourceOrder: ReadonlyMap<string, number>,
  perQuery: number = PER_QUERY,
): Promise<Candidate[][]> {
  if (sourceIds.length === 0 || vectors.length === 0) return vectors.map(() => []);
  const { rows } = await sql<Row>`
    WITH q AS MATERIALIZED (
      SELECT v::vector AS vec, (ord - 1)::int AS qi
      FROM unnest(${vectors.map(vectorText)}::text[]) WITH ORDINALITY AS t(v, ord)
    ),
    d AS (
      SELECT c.id, c.source_id, c."position", char_length(c.text)::int AS chars, q.qi, c.embedding <=> q.vec AS dist
      FROM chunks c CROSS JOIN q
      WHERE c.source_id = ANY(${[...sourceIds]}::uuid[])
    ),
    r AS (
      SELECT d.*, row_number() OVER (PARTITION BY qi ORDER BY dist, source_id, "position") AS rank FROM d
    )
    SELECT id, source_id, "position", chars, qi FROM r WHERE rank <= ${perQuery} ORDER BY qi, rank`.execute(db);

  const lists: Candidate[][] = vectors.map(() => []);
  for (const row of rows) {
    lists[row.qi]?.push({ id: row.id, sourceOrder: sourceOrder.get(row.source_id) as number, position: row.position, chars: row.chars });
  }
  return lists;
}
