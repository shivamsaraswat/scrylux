import { randomUUID } from 'node:crypto';
import type { ProvenanceRecord } from '@scrylux/core';
import type { Database } from '@scrylux/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { citationOf, type CitationRow } from '../extract-system/draft.js';

// Provenance (Phase 3 Milestone 5, FR-017, FR-018, research #8): where a record, or one flag of an element, came from. An accept writes it in the
// transaction that creates the record, copying the draft item's rationale and its citations as the draft keeps them: the chunk and the span of the
// quote, never the quote's text. A flag has no rationale of its own (Milestone 4 gave a flag citations only), so its row repeats its item's.

type Trx = Transaction<Database>;

export interface ProvenanceMark {
  /** The record it is about: exactly one of these. */
  elementId?: string;
  assetId?: string;
  assumptionId?: string;
  /** The flag it is about, or null for the record itself. */
  flag: string | null;
  rationale: string;
  /** The draft item whose citations (or whose flag's citations) are copied. */
  itemId: string;
}

const BATCH = 500;

/** Writes the marks and their citations. Run by the accept, under the threat model's lock. */
export async function writeProvenance(trx: Trx, threatModelId: string, accountId: number, marks: readonly ProvenanceMark[]): Promise<void> {
  for (let at = 0; at < marks.length; at += BATCH) {
    const batch = marks.slice(at, at + BATCH).map((mark) => ({ ...mark, id: randomUUID() }));
    await trx
      .insertInto('provenance')
      .values(
        batch.map((mark) => ({
          id: mark.id,
          threat_model_id: threatModelId,
          element_id: mark.elementId ?? null,
          asset_id: mark.assetId ?? null,
          assumption_id: mark.assumptionId ?? null,
          flag: mark.flag,
          rationale: mark.rationale,
          accepted_by: accountId,
        })),
      )
      .execute();
    // '' stands for "the item itself", as in the draft's own unique index on its citations.
    await sql`
      INSERT INTO provenance_citations (provenance_id, "position", chunk_id, quote_start, quote_end)
      SELECT m.pid, c."position", c.chunk_id, c.quote_start, c.quote_end
      FROM unnest(${batch.map((mark) => mark.id)}::uuid[], ${batch.map((mark) => mark.itemId)}::uuid[], ${batch.map((mark) => mark.flag ?? '')}::text[]) AS m(pid, item_id, flag)
      JOIN draft_citations c ON c.item_id = m.item_id AND coalesce(c.flag, '') = m.flag`.execute(trx);
  }
}

interface ProvenanceRow {
  id: string;
  element_id: string | null;
  asset_id: string | null;
  assumption_id: string | null;
  flag: string | null;
  rationale: string;
  accepted_by: number;
  username: string;
  accepted_at: Date;
}

/**
 * Everything a threat model's accepted records came from, oldest first (FR-017). Quotes are read from their chunks by the span that was kept, as a draft's are, so a
 * deleted source leaves no text: its citations are shown as such, never dropped.
 */
export async function readProvenance(db: Kysely<Database>, threatModelId: string): Promise<ProvenanceRecord[]> {
  const rows = await sql<ProvenanceRow>`
    SELECT p.id, p.element_id, p.asset_id, p.assumption_id, p.flag, p.rationale, p.accepted_by, u.username, p.accepted_at
    FROM provenance p JOIN users u ON u.id = p.accepted_by
    WHERE p.threat_model_id = ${threatModelId}::uuid ORDER BY p.accepted_at, p.id`.execute(db);
  const cited = await sql<CitationRow & { provenance_id: string }>`
    SELECT pc.provenance_id AS item_id, pc.provenance_id, NULL::text AS flag, pc.chunk_id, c."position" AS chunk_position, c.page_first, c.page_last, c.line_first, c.line_last, c.heading,
           c.source_id, s.name AS source_name, substr(c.text, pc.quote_start + 1, pc.quote_end - pc.quote_start) AS quote
    FROM provenance_citations pc
    JOIN provenance p ON p.id = pc.provenance_id
    LEFT JOIN chunks c ON c.id = pc.chunk_id
    LEFT JOIN sources s ON s.id = c.source_id
    WHERE p.threat_model_id = ${threatModelId}::uuid
    ORDER BY pc.provenance_id, pc."position"`.execute(db);
  return rows.rows.map((row) => ({
    id: row.id,
    target:
      row.element_id !== null ? { kind: 'element' as const, id: row.element_id } : row.asset_id !== null ? { kind: 'asset' as const, id: row.asset_id } : { kind: 'assumption' as const, id: row.assumption_id as string },
    flag: row.flag,
    rationale: row.rationale,
    accepted_by: { id: row.accepted_by, username: row.username },
    accepted_at: row.accepted_at.toISOString(),
    citations: cited.rows.filter((citation) => citation.provenance_id === row.id).map(citationOf),
  }));
}

