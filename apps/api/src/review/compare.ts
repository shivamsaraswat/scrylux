import type { ItemReview } from '@scrylux/core';
import type { Database } from '@scrylux/db';
import { sql, type Kysely } from 'kysely';
import type { StoredDraft } from '../extract-system/draft.js';

// What each item of a draft is against the threat model now, and where it stands in the review (Phase 3 Milestone 5, FR-001 to FR-003,
// research #2, #3, #5). It is derived every time and never stored: a match is by the type and name an element has (an asset's name, an
// assumption's statement), compared in SQL with `lower(btrim(…))`, the expression of the unique indexes of migration 019, so that the page
// and the database can never disagree on "the same name". Reading writes nothing.

type Db = Kysely<Database>;

type Match = { kind: 'new' } | { kind: 'matched'; id: string } | { kind: 'several' };

interface DecisionRow {
  id: string;
  decision: 'accepted' | 'rejected' | null;
  decided_by: number | null;
  username: string | null;
  decided_at: Date | null;
  outcome: 'created' | 'matched' | null;
  element_id: string | null;
  asset_id: string | null;
  assumption_id: string | null;
}

/** The item ids that have each current record, by the name or statement they share with it: one query per kind. */
async function matchesOf(db: Db, draftId: string, threatModelId: string): Promise<Map<string, Match>> {
  const rows = await sql<{ item_id: string; ids: string[] }>`
    SELECT i.id AS item_id, array_agg(e.id ORDER BY e.created_at, e.id) AS ids
    FROM draft_items i
    JOIN elements e ON e.threat_model_id = ${threatModelId}::uuid AND e.type = i.kind AND lower(btrim(e.name)) = lower(btrim(i.name))
    WHERE i.draft_id = ${draftId}::uuid
    GROUP BY i.id
    UNION ALL
    SELECT i.id, array_agg(a.id ORDER BY a.created_at, a.id)
    FROM draft_items i
    JOIN assets a ON a.threat_model_id = ${threatModelId}::uuid AND i.kind = 'asset' AND lower(btrim(a.name)) = lower(btrim(i.name))
    WHERE i.draft_id = ${draftId}::uuid
    GROUP BY i.id
    UNION ALL
    SELECT i.id, array_agg(m.id ORDER BY m.created_at, m.id)
    FROM draft_items i
    JOIN assumptions m ON m.threat_model_id = ${threatModelId}::uuid AND i.kind = 'assumption' AND lower(btrim(m.statement)) = lower(btrim(i.body))
    WHERE i.draft_id = ${draftId}::uuid
    GROUP BY i.id`.execute(db);
  const found = new Map<string, Match>();
  for (const row of rows.rows) found.set(row.item_id, row.ids.length === 1 ? { kind: 'matched', id: row.ids[0] as string } : { kind: 'several' });
  return found;
}

/** The review of every item of the draft, by the item's id. */
export async function readReview(db: Db, draft: StoredDraft): Promise<Record<string, ItemReview>> {
  return (await loadReview(db, draft)).review;
}

/** The same, with the function that says which element of the threat model an item stands for now: what a decision builds its references from (research #5). */
export async function loadReview(db: Db, draft: StoredDraft): Promise<{ review: Record<string, ItemReview>; resolve: (itemId: string | null) => string | null }> {
  const threatModelId = draft.threat_model_id;
  const decisions = new Map<string, DecisionRow>(
    (
      await sql<DecisionRow>`
        SELECT i.id, i.decision, i.decided_by, u.username, i.decided_at, i.outcome, i.element_id, i.asset_id, i.assumption_id
        FROM draft_items i LEFT JOIN users u ON u.id = i.decided_by WHERE i.draft_id = ${draft.id}::uuid`.execute(db)
    ).rows.map((row) => [row.id, row]),
  );
  const matches = await matchesOf(db, draft.id, threatModelId);
  const elements = new Map(
    (
      await db
        .selectFrom('elements')
        .select(['id', 'properties', 'parent_boundary_id', 'source_element_id', 'target_element_id'])
        .where('threat_model_id', '=', threatModelId)
        .execute()
    ).map((row) => [row.id, row]),
  );
  const holders = new Map<string, Set<string>>();
  for (const row of await db.selectFrom('asset_holders').select(['asset_id', 'element_id']).where('threat_model_id', '=', threatModelId).execute()) {
    holders.set(row.asset_id, (holders.get(row.asset_id) ?? new Set()).add(row.element_id));
  }

  // An item is accepted when its accept matched a record, or created one that is still there; an accepted item whose record was deleted is
  // undecided again (research #2).
  const stateOf = (id: string): 'undecided' | 'accepted' | 'rejected' => {
    const row = decisions.get(id);
    if (row?.decision === 'rejected') return 'rejected';
    if (row?.decision !== 'accepted') return 'undecided';
    return row.outcome === 'matched' || row.element_id !== null || row.asset_id !== null || row.assumption_id !== null ? 'accepted' : 'undecided';
  };

  // An item resolves to an element when it was accepted and created one that exists, or when exactly one element matches it (research #5).
  const resolve = (id: string | null): string | null => {
    if (id === null) return null;
    const row = decisions.get(id);
    if (stateOf(id) === 'accepted' && row?.outcome === 'created' && row.element_id !== null) return row.element_id;
    const match = matches.get(id);
    return match?.kind === 'matched' ? match.id : null;
  };

  const review: Record<string, ItemReview> = {};
  const base = (id: string): Pick<ItemReview, 'state' | 'decided_by' | 'decided_at' | 'outcome'> => {
    const state = stateOf(id);
    const row = decisions.get(id);
    return state === 'undecided' || row === undefined
      ? { state, decided_by: null, decided_at: null, outcome: null }
      : {
          state,
          decided_by: row.decided_by === null ? null : { id: row.decided_by, username: row.username ?? '' },
          decided_at: row.decided_at === null ? null : row.decided_at.toISOString(),
          outcome: state === 'accepted' ? row.outcome : null,
        };
  };
  const accepted = { comparison: null, matched_id: null, differences: null, needs: null } as const;
  const compared = (id: string): { comparison: 'new' | 'matched' | 'several'; matched_id: string | null } => {
    const match = matches.get(id) ?? { kind: 'new' as const };
    return { comparison: match.kind, matched_id: match.kind === 'matched' ? match.id : null };
  };
  const noDifference = { flags: [], boundary: false, endpoints: false, holders_missing: 0 };

  for (const element of draft.elements) {
    if (stateOf(element.id) === 'accepted') {
      review[element.id] = { ...base(element.id), ...accepted };
      continue;
    }
    const { comparison, matched_id } = compared(element.id);
    const current = matched_id === null ? undefined : elements.get(matched_id);
    let differences: ItemReview['differences'] = null;
    if (current !== undefined) {
      const stored = (current.properties as { flags?: Record<string, boolean> }).flags ?? {};
      const resolvedBoundary = resolve(element.boundary_id);
      differences = {
        flags: element.flags
          .filter((flag) => stored[flag.flag] === undefined || stored[flag.flag] !== flag.value)
          .map((flag) => ({ flag: flag.flag, proposed: flag.value, current: stored[flag.flag] ?? null })),
        boundary: element.boundary_id !== null && (resolvedBoundary === null || resolvedBoundary !== current.parent_boundary_id),
        endpoints:
          element.type === 'data_flow' &&
          (resolve(element.source_id) === null || resolve(element.source_id) !== current.source_element_id || resolve(element.target_id) === null || resolve(element.target_id) !== current.target_element_id),
        holders_missing: 0,
      };
    }
    const needs: NonNullable<ItemReview['needs']> = [];
    if (element.type === 'data_flow') {
      if (resolve(element.source_id) === null && element.source_id !== null) needs.push({ need: 'source', item_id: element.source_id });
      if (resolve(element.target_id) === null && element.target_id !== null) needs.push({ need: 'target', item_id: element.target_id });
    } else if (element.boundary_id !== null && resolve(element.boundary_id) === null) {
      needs.push({ need: 'boundary', item_id: element.boundary_id });
    }
    review[element.id] = { ...base(element.id), comparison, matched_id, differences, needs };
  }

  for (const asset of draft.assets) {
    if (stateOf(asset.id) === 'accepted') {
      review[asset.id] = { ...base(asset.id), ...accepted };
      continue;
    }
    const { comparison, matched_id } = compared(asset.id);
    const holding = matched_id === null ? undefined : (holders.get(matched_id) ?? new Set<string>());
    const missing = holding === undefined ? 0 : asset.held_by.filter((item) => {
      const element = resolve(item);
      return element !== null && !holding.has(element);
    }).length;
    review[asset.id] = { ...base(asset.id), comparison, matched_id, differences: matched_id === null ? null : { ...noDifference, holders_missing: missing }, needs: null };
  }

  for (const assumption of draft.assumptions) {
    if (stateOf(assumption.id) === 'accepted') {
      review[assumption.id] = { ...base(assumption.id), ...accepted };
      continue;
    }
    const { comparison, matched_id } = compared(assumption.id);
    review[assumption.id] = { ...base(assumption.id), comparison, matched_id, differences: matched_id === null ? null : noDifference, needs: null };
  }
  return { review, resolve };
}
