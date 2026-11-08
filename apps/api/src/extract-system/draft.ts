import type {
  CitationRecord,
  DraftAssetRecord,
  DraftAssumptionRecord,
  DraftElementRecord,
  DraftPath,
  DraftRecord,
} from '@scrylux/core';
import type { Database } from '@scrylux/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { RunCommit } from '../jobs/store.js';
import type { LabelledChunk } from './content.js';
import type { MappedDraft } from './map.js';

// Writing and reading a threat model's draft (Phase 3 Milestone 4, data-model.md, research #10, #13). A draft is written whole, in the one
// transaction that ends its extraction, replacing the one before it; a failed or cancelled extraction writes nothing. Nothing here touches
// `elements`, `threats` or `mitigations` (FR-050).
//
// Lock order, as everywhere (research #10): the sources the draft read, by id, then the job row, which finishRun takes. FOR KEY SHARE
// holds a source's deletion off until the commit ends, so a chunk the draft cites cannot vanish between the check and the write.

type Db = Kysely<Database>;
type Trx = Transaction<Database>;

export interface DraftWrite {
  threatModelId: string;
  jobId: string;
  model: string;
  promptVersion: string;
  path: DraftPath;
  /** Every chunk of the ready sources, whether or not it was sent. */
  chunksAvailable: number;
  /** Every source the extraction considered: read, or left out because it was not ready (FR-004). */
  sources: ReadonlyArray<{ id: string; read: boolean }>;
  /** The chunks that were sent, under the labels they were sent with, in order. */
  sent: readonly LabelledChunk[];
  mapped: MappedDraft;
  /** Why there is no item (FR-024). */
  nothingFound: string | null;
}

const BATCH = 500;

export function draftCommit(write: DraftWrite): RunCommit {
  const readIds = write.sources.filter((source) => source.read).map((source) => source.id);
  const chunkIds = write.sent.map((chunk) => chunk.chunkId);
  return {
    async lock(trx) {
      await sql`SELECT id FROM sources WHERE id = ANY(${[...readIds].sort()}::uuid[]) ORDER BY id FOR KEY SHARE`.execute(trx);
      return true;
    },
    async check(trx) {
      // A source or a chunk the draft read is gone: running again reads what is there now (FR-044, FR-051).
      const sources = await sql<{ n: number }>`SELECT count(*)::int AS n FROM sources WHERE id = ANY(${readIds}::uuid[])`.execute(trx);
      if ((sources.rows[0]?.n ?? 0) !== readIds.length) return { category: 'sources_changed' };
      const chunks = await sql<{ n: number }>`SELECT count(*)::int AS n FROM chunks WHERE id = ANY(${chunkIds}::uuid[])`.execute(trx);
      if ((chunks.rows[0]?.n ?? 0) !== chunkIds.length) return { category: 'sources_changed' };
      return undefined;
    },
    async write(trx) {
      await sql`DELETE FROM drafts WHERE threat_model_id = ${write.threatModelId}::uuid`.execute(trx);
      const draftId = await insertDraft(trx, write);
      await sql`
        INSERT INTO draft_sources (draft_id, source_id, read)
        SELECT ${draftId}::uuid, s.id, t.read
        FROM unnest(${write.sources.map((source) => source.id)}::uuid[], ${write.sources.map((source) => source.read)}::boolean[]) AS t(id, read)
        JOIN sources s ON s.id = t.id`.execute(trx);
      await trx.insertInto('draft_read_chunks').values(write.sent.map((chunk, index) => ({ draft_id: draftId, chunk_id: chunk.chunkId, label: index + 1 }))).execute();

      const { items, holders, citations } = write.mapped;
      for (let at = 0; at < items.length; at += BATCH) {
        await trx
          .insertInto('draft_items')
          .values(
            items.slice(at, at + BATCH).map((item) => ({
              id: item.id,
              draft_id: draftId,
              position: item.position,
              kind: item.kind,
              name: item.name,
              body: item.body,
              rationale: item.rationale,
              boundary_id: item.boundaryId,
              source_item_id: item.sourceItemId,
              target_item_id: item.targetItemId,
              flags: item.flags,
            })),
          )
          .execute();
      }
      if (holders.length > 0) {
        await trx.insertInto('draft_asset_holders').values(holders.map((holder) => ({ asset_id: holder.assetId, element_id: holder.elementId }))).execute();
      }
      for (let at = 0; at < citations.length; at += BATCH) {
        await trx
          .insertInto('draft_citations')
          .values(
            citations.slice(at, at + BATCH).map((citation) => ({
              item_id: citation.itemId,
              flag: citation.flag,
              position: citation.position,
              chunk_id: citation.chunkId,
              quote_start: citation.quoteStart,
              quote_end: citation.quoteEnd,
            })),
          )
          .execute();
      }
    },
  };
}

async function insertDraft(trx: Trx, write: DraftWrite): Promise<string> {
  // The account that started it is the job's: read here, in the transaction, so that the commit needs nothing but the job's id.
  const { rows } = await sql<{ id: string }>`
    INSERT INTO drafts (threat_model_id, job_id, started_by, generation_model, prompt_version, path, chunks_read, chunks_available, sources_total, nothing_found)
    SELECT ${write.threatModelId}::uuid, j.id, j.created_by, ${write.model}, ${write.promptVersion}, ${write.path}, ${write.sent.length}, ${write.chunksAvailable},
           ${write.sources.length}, ${write.nothingFound}
    FROM jobs j WHERE j.id = ${write.jobId}::uuid
    RETURNING id`.execute(trx);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the job that made the draft is gone');
  return id;
}

// ---- Reading ------------------------------------------------------------------------------------------------------------

interface DraftRow {
  id: string;
  threat_model_id: string;
  job_id: string | null;
  started_by: number;
  username: string;
  made_at: Date;
  generation_model: string;
  prompt_version: string;
  path: DraftPath;
  chunks_read: number;
  chunks_available: number;
  sources_total: number;
  nothing_found: string | null;
}

interface ItemRow {
  id: string;
  kind: 'process' | 'data_store' | 'external_entity' | 'data_flow' | 'trust_boundary' | 'asset' | 'assumption';
  name: string | null;
  body: string | null;
  rationale: string;
  boundary_id: string | null;
  source_item_id: string | null;
  target_item_id: string | null;
  flags: Record<string, boolean>;
}

interface CitationRow {
  item_id: string;
  flag: string | null;
  chunk_id: string | null;
  chunk_position: number | null;
  page_first: number | null;
  page_last: number | null;
  line_first: number | null;
  line_last: number | null;
  heading: string | null;
  source_id: string | null;
  source_name: string | null;
  quote: string | null;
}

const citationOf = (row: CitationRow): CitationRecord =>
  row.chunk_id === null || row.source_id === null || row.source_name === null || row.chunk_position === null || row.quote === null
    ? { chunk: null, quote: null }
    : {
        chunk: {
          id: row.chunk_id,
          source_id: row.source_id,
          source_name: row.source_name,
          position: row.chunk_position,
          page_first: row.page_first,
          page_last: row.page_last,
          line_first: row.line_first,
          line_last: row.line_last,
          heading: row.heading,
        },
        quote: row.quote,
      };

/**
 * The draft of a threat model, or undefined when it has none. Quotes are read from their chunks by the span the draft kept, so a
 * deleted source leaves no text: its citations are shown as such, never dropped (FR-054, research #4). Whether the sources have changed
 * is derived from what is there now, not from times (research #13).
 */
export async function readDraft(db: Db, threatModelId: string): Promise<DraftRecord | undefined> {
  const { rows: found } = await sql<DraftRow>`
    SELECT d.id, d.threat_model_id, d.job_id, d.started_by, u.username, d.made_at, d.generation_model, d.prompt_version, d.path,
           d.chunks_read, d.chunks_available, d.sources_total, d.nothing_found
    FROM drafts d JOIN users u ON u.id = d.started_by WHERE d.threat_model_id = ${threatModelId}::uuid`.execute(db);
  const draft = found[0];
  if (draft === undefined) return undefined;

  const sources = await sql<{ id: string; name: string; read: boolean }>`
    SELECT s.id, s.name, ds.read FROM draft_sources ds JOIN sources s ON s.id = ds.source_id
    WHERE ds.draft_id = ${draft.id}::uuid ORDER BY s.added_at, s.id`.execute(db);

  const changed = await sql<{ changed: boolean }>`
    SELECT (
      (SELECT count(*) FROM draft_sources WHERE draft_id = ${draft.id}::uuid) < ${draft.sources_total}
      OR EXISTS (SELECT 1 FROM sources s WHERE s.threat_model_id = ${threatModelId}::uuid
                 AND NOT EXISTS (SELECT 1 FROM draft_sources ds WHERE ds.draft_id = ${draft.id}::uuid AND ds.source_id = s.id))
      OR EXISTS (SELECT 1 FROM draft_sources ds JOIN sources s ON s.id = ds.source_id
                 WHERE ds.draft_id = ${draft.id}::uuid AND NOT ds.read AND s.ready_at IS NOT NULL)
    ) AS changed`.execute(db);

  const items = await sql<ItemRow>`
    SELECT id, kind, name, body, rationale, boundary_id, source_item_id, target_item_id, flags
    FROM draft_items WHERE draft_id = ${draft.id}::uuid ORDER BY "position"`.execute(db);

  const holders = await sql<{ asset_id: string; element_id: string }>`
    SELECT h.asset_id, h.element_id FROM draft_asset_holders h JOIN draft_items i ON i.id = h.asset_id
    WHERE i.draft_id = ${draft.id}::uuid ORDER BY h.asset_id, h.element_id`.execute(db);

  const cited = await sql<CitationRow>`
    SELECT ci.item_id, ci.flag, ci.chunk_id, c."position" AS chunk_position, c.page_first, c.page_last, c.line_first, c.line_last, c.heading,
           c.source_id, s.name AS source_name, substr(c.text, ci.quote_start + 1, ci.quote_end - ci.quote_start) AS quote
    FROM draft_citations ci
    JOIN draft_items i ON i.id = ci.item_id
    LEFT JOIN chunks c ON c.id = ci.chunk_id
    LEFT JOIN sources s ON s.id = c.source_id
    WHERE i.draft_id = ${draft.id}::uuid
    ORDER BY ci.item_id, ci.flag NULLS FIRST, ci."position"`.execute(db);

  const read = await sql<{ source_id: string; position: number }>`
    SELECT c.source_id, c."position" FROM draft_read_chunks r JOIN chunks c ON c.id = r.chunk_id JOIN sources s ON s.id = c.source_id
    WHERE r.draft_id = ${draft.id}::uuid ORDER BY s.added_at, s.id, c."position"`.execute(db);

  const citationsOf = (itemId: string, flag: string | null): CitationRecord[] =>
    cited.rows.filter((row) => row.item_id === itemId && row.flag === flag).map(citationOf);

  const elements: DraftElementRecord[] = [];
  const assets: DraftAssetRecord[] = [];
  const assumptions: DraftAssumptionRecord[] = [];
  for (const item of items.rows) {
    if (item.kind === 'asset') {
      assets.push({
        id: item.id,
        name: item.name as string,
        description: item.body as string,
        held_by: holders.rows.filter((holder) => holder.asset_id === item.id).map((holder) => holder.element_id),
        rationale: item.rationale,
        citations: citationsOf(item.id, null),
      });
    } else if (item.kind === 'assumption') {
      assumptions.push({ id: item.id, statement: item.body as string, rationale: item.rationale, citations: citationsOf(item.id, null) });
    } else {
      elements.push({
        id: item.id,
        type: item.kind,
        name: item.name as string,
        boundary_id: item.boundary_id,
        source_id: item.source_item_id,
        target_id: item.target_item_id,
        flags: Object.keys(item.flags)
          .sort()
          .map((flag) => ({ flag, value: item.flags[flag] as boolean, citations: citationsOf(item.id, flag) })),
        rationale: item.rationale,
        citations: citationsOf(item.id, null),
      });
    }
  }

  return {
    id: draft.id,
    threat_model_id: draft.threat_model_id,
    made_at: draft.made_at.toISOString(),
    started_by: { id: draft.started_by, username: draft.username },
    job_id: draft.job_id,
    generation_model: draft.generation_model,
    prompt_version: draft.prompt_version,
    path: draft.path,
    chunks_read: draft.chunks_read,
    chunks_available: draft.chunks_available,
    sources: sources.rows,
    sources_deleted: Math.max(0, draft.sources_total - sources.rows.length),
    sources_changed: changed.rows[0]?.changed === true,
    nothing_found: draft.nothing_found,
    elements,
    assets,
    assumptions,
    read_chunks: read.rows,
  };
}

/** Discards a threat model's draft (FR-055). Whether there was one. */
export async function discardDraft(db: Db, threatModelId: string): Promise<boolean> {
  const { rows } = await sql<{ id: string }>`DELETE FROM drafts WHERE threat_model_id = ${threatModelId}::uuid RETURNING id`.execute(db);
  return rows.length > 0;
}
