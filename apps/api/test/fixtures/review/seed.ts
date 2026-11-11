import { randomUUID } from 'node:crypto';
import type { DraftDecision, ItemReview } from '@scrylux/core';
import db, { kdb } from '../../../src/db.js';
import { readDraft, type StoredDraft } from '../../../src/extract-system/draft.js';
import { readReview } from '../../../src/review/compare.js';
import { seedReadySource } from '../extract-system/seed.js';

// Seeding for the review tests (Phase 3 Milestone 5, tasks T003): a draft with every kind of item, written directly as a finished
// extraction leaves it, so that a test needs no worker and no provider, and the model's own records written in SQL.

/** The text of the one chunk every item cites. A citation's span is inside it. */
export const REVIEW_CHUNK_TEXT = 'The API serves the web application and keeps session tokens in the database, behind the internal network.';

export interface ReviewDraft {
  draftId: string;
  sourceId: string;
  chunkId: string;
  threatModelId: string;
  /** The draft's items, by what they are. */
  id: { boundary: string; api: string; database: string; browser: string; flowIn: string; flowOut: string; asset: string; assumption: string };
}

/**
 * A draft with: the trust boundary `Internal network`; the process `API` and the data store `Database`, both in it; the external entity
 * `Browser`; the data flows `Browser to API` and `API to Database`; the asset `Session tokens`, held by `API`; and the assumption
 * `The database is not exposed.` Every item has a rationale and a citation. `API` proposes two flags, each with a citation of its own.
 */
export async function seedReviewDraft(accountId: number, threatModelId: string): Promise<ReviewDraft> {
  const source = await seedReadySource(accountId, threatModelId, { chunks: [REVIEW_CHUNK_TEXT] });
  const chunkId = source.chunkIds[0] as string;
  const id = {
    boundary: randomUUID(),
    api: randomUUID(),
    database: randomUUID(),
    browser: randomUUID(),
    flowIn: randomUUID(),
    flowOut: randomUUID(),
    asset: randomUUID(),
    assumption: randomUUID(),
  };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO drafts (threat_model_id, started_by, generation_model, prompt_version, path, chunks_read, chunks_available, sources_total)
       VALUES ($1, $2, 'seeded-model', 'extract-system/0123456789ab', 'whole', 1, 1, 1) RETURNING id`,
      [threatModelId, accountId],
    );
    const draftId = rows[0]?.id as string;
    await client.query('INSERT INTO draft_sources (draft_id, source_id, read) VALUES ($1, $2, true)', [draftId, source.sourceId]);
    await client.query('INSERT INTO draft_read_chunks (draft_id, chunk_id, label) VALUES ($1, $2, 1)', [draftId, chunkId]);

    const items: Array<{ id: string; kind: string; name: string | null; body: string | null; boundary?: string; source?: string; target?: string; flags?: object }> = [
      { id: id.boundary, kind: 'trust_boundary', name: 'Internal network', body: null },
      { id: id.api, kind: 'process', name: 'API', body: null, boundary: id.boundary, flags: { requires_authentication: true, internet_facing: false } },
      { id: id.database, kind: 'data_store', name: 'Database', body: null, boundary: id.boundary },
      { id: id.browser, kind: 'external_entity', name: 'Browser', body: null },
      { id: id.flowIn, kind: 'data_flow', name: 'Browser to API', body: null, source: id.browser, target: id.api },
      { id: id.flowOut, kind: 'data_flow', name: 'API to Database', body: null, source: id.api, target: id.database },
      { id: id.asset, kind: 'asset', name: 'Session tokens', body: 'Bearer tokens held for signed-in people.' },
      { id: id.assumption, kind: 'assumption', name: null, body: 'The database is not exposed.' },
    ];
    for (const [position, item] of items.entries()) {
      await client.query(
        `INSERT INTO draft_items (id, draft_id, "position", kind, name, body, rationale, boundary_id, source_item_id, target_item_id, flags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [item.id, draftId, position, item.kind, item.name, item.body, `Why ${item.name ?? 'the assumption'} is proposed.`, item.boundary ?? null, item.source ?? null, item.target ?? null, JSON.stringify(item.flags ?? {})],
      );
      await client.query('INSERT INTO draft_citations (item_id, "position", chunk_id, quote_start, quote_end) VALUES ($1, 0, $2, 0, 20)', [item.id, chunkId]);
    }
    await client.query('INSERT INTO draft_asset_holders (asset_id, element_id) VALUES ($1, $2)', [id.asset, id.api]);
    await client.query(`INSERT INTO draft_citations (item_id, flag, "position", chunk_id, quote_start, quote_end) VALUES ($1, 'requires_authentication', 0, $2, 4, 30)`, [id.api, chunkId]);
    await client.query(`INSERT INTO draft_citations (item_id, flag, "position", chunk_id, quote_start, quote_end) VALUES ($1, 'internet_facing', 0, $2, 60, 100)`, [id.api, chunkId]);
    await client.query('COMMIT');
    return { draftId, sourceId: source.sourceId, chunkId, threatModelId, id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** An element of the threat model's own, written directly. */
export async function seedElement(
  threatModelId: string,
  element: { type: 'process' | 'data_store' | 'external_entity' | 'trust_boundary'; name: string; flags?: Record<string, boolean>; parentId?: string },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO elements (threat_model_id, type, name, properties, parent_boundary_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [threatModelId, element.type, element.name, JSON.stringify(element.flags === undefined ? {} : { flags: element.flags }), element.parentId ?? null],
  );
  return rows[0]?.id as string;
}

/** An asset of the threat model's own, written directly, with the elements that hold it. */
export async function seedAsset(threatModelId: string, name: string, holderIds: readonly string[] = []): Promise<string> {
  const { rows } = await db.query<{ id: string }>('INSERT INTO assets (threat_model_id, name, description) VALUES ($1, $2, $3) RETURNING id', [threatModelId, name, `About ${name}.`]);
  const assetId = rows[0]?.id as string;
  for (const holder of holderIds) {
    await db.query('INSERT INTO asset_holders (threat_model_id, asset_id, element_id) VALUES ($1, $2, $3)', [threatModelId, assetId, holder]);
  }
  return assetId;
}

/** The review of the threat model's draft as the page reads it. */
export async function reviewOf(threatModelId: string): Promise<Record<string, ItemReview>> {
  const draft = (await readDraft(kdb, threatModelId)) as StoredDraft;
  return readReview(kdb, draft);
}

/** An accept request for the given items, each with the comparison the page would show now. */
export async function acceptBody(threatModelId: string, draftId: string, ids: readonly string[]): Promise<Extract<DraftDecision, { action: 'accept' }>> {
  const review = await reviewOf(threatModelId);
  return { action: 'accept', draft_id: draftId, items: ids.map((id) => ({ id, seen: (review[id]?.comparison ?? 'new') })) };
}

/** The records of a threat model, by name, for what an accept should have written. */
export async function recordsOf(threatModelId: string) {
  const elements = (await db.query('SELECT id, type, name, properties, layout, parent_boundary_id, source_element_id, target_element_id FROM elements WHERE threat_model_id = $1 ORDER BY name', [threatModelId])).rows as Array<{
    id: string;
    type: string;
    name: string;
    properties: { flags?: Record<string, boolean> };
    layout: unknown;
    parent_boundary_id: string | null;
    source_element_id: string | null;
    target_element_id: string | null;
  }>;
  const assets = (await db.query('SELECT id, name, description FROM assets WHERE threat_model_id = $1 ORDER BY name', [threatModelId])).rows as Array<{ id: string; name: string; description: string }>;
  const holders = (await db.query('SELECT asset_id, element_id FROM asset_holders WHERE threat_model_id = $1', [threatModelId])).rows as Array<{ asset_id: string; element_id: string }>;
  const assumptions = (await db.query('SELECT id, statement FROM assumptions WHERE threat_model_id = $1 ORDER BY statement', [threatModelId])).rows as Array<{ id: string; statement: string }>;
  return { elements, assets, holders, assumptions, byName: (name: string) => elements.find((element) => element.name === name) };
}
