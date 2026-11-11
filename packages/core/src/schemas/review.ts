import { z } from 'zod';
import { DESCRIPTION_MAX_LENGTH, NAME_MAX_LENGTH, requiredText, timestamp, uuid } from '../fields.js';
import { CitationRecord, DraftRecord, ItemComparison } from './draft.js';
import { JobUser } from './job.js';

// What a person sends to decide the items of a draft, and what comes back (Phase 3 Milestone 5, contracts/http-api.md). The request carries the
// draft the reviewer saw and, for each item, its id and the comparison the page showed, and nothing else: the server builds every record from
// the draft it stores, so no client can put content or provenance of its own into a record (FR-007).

/** The most items a draft holds: 40 elements, 15 assets and 15 assumptions fit in 70 (research #9 of Milestone 4). */
const MAX_DECISION_ITEMS = 70;

const distinct = (items: readonly { id: string }[]): boolean => new Set(items.map((item) => item.id)).size === items.length;

/** An element a record names: an item of the draft (by what it will be, or already is, in the threat model), or an element of the threat model itself. */
const Ref = z.union([z.strictObject({ item: uuid }), z.strictObject({ element: uuid })]);
export type EditRef = z.infer<typeof Ref>;

/**
 * What a person may change in the step in which they accept an item (FR-013): a name, flags, a boundary, a flow's ends, an asset's description and holders, an
 * assumption's statement. Never the item's kind, its rationale or its citations. Which of these an item takes depends on its kind, and the server refuses the
 * rest. The draft item keeps what the model proposed; the edits are of the record that is created.
 */
export const ItemEdits = z.strictObject({
  name: requiredText(NAME_MAX_LENGTH).optional(),
  flags: z.record(z.string(), z.boolean().nullable()).optional().meta({ description: 'true or false sets a flag, null clears it (not assessed).' }),
  boundary: Ref.nullable().optional().meta({ description: 'A trust boundary, or null for none.' }),
  source: Ref.optional(),
  target: Ref.optional(),
  description: requiredText(DESCRIPTION_MAX_LENGTH).optional(),
  statement: requiredText(DESCRIPTION_MAX_LENGTH).optional(),
  holders: Ref.array().max(1000, 'must have at most 1000 items').optional().meta({ description: 'Replaces the asset’s holders.' }),
});
export type ItemEdits = z.infer<typeof ItemEdits>;

const AcceptItem = z.strictObject({
  id: uuid.meta({ description: "The draft item's id." }),
  seen: ItemComparison.meta({ description: 'How the page showed the item to compare with the threat model. A different comparison now refuses the request as out of date.' }),
  edits: ItemEdits.optional(),
});

const ItemId = z.strictObject({ id: uuid.meta({ description: "The draft item's id." }) });

const draftId = uuid.meta({ description: 'The draft the reviewer saw. If it was discarded or replaced, the request is refused as out of date.' });
const someItems = <T extends { id: string }>(items: z.ZodType<T>) =>
  items
    .array()
    .min(1, `must have 1 to ${MAX_DECISION_ITEMS} items`)
    .max(MAX_DECISION_ITEMS, `must have 1 to ${MAX_DECISION_ITEMS} items`)
    .refine(distinct, { message: 'must not name an item twice' });

export const DraftDecision = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('accept'),
    draft_id: uuid.meta({ description: 'The draft the reviewer saw. If it was discarded or replaced, the request is refused as out of date.' }),
    items: AcceptItem.array()
      .min(1, `must have 1 to ${MAX_DECISION_ITEMS} items`)
      .max(MAX_DECISION_ITEMS, `must have 1 to ${MAX_DECISION_ITEMS} items`)
      .refine(distinct, { message: 'must not name an item twice' }),
  }),
  // A rejection writes nothing to the threat model, and a rejected item can come back to undecided (FR-014). Neither carries more than the items' ids.
  z.strictObject({ action: z.literal('reject'), draft_id: draftId, items: someItems(ItemId) }),
  z.strictObject({ action: z.literal('undecide'), draft_id: draftId, items: someItems(ItemId) }),
]);
export type DraftDecision = z.infer<typeof DraftDecision>;

const count = z.number().int().min(0);

export const DecisionResult = z.strictObject({
  /** The draft as it now stands, with each item's review. */
  draft: DraftRecord,
  /** Records an accept created. */
  created: count,
  /** Records an accept matched and changed (a matched element's flags, a matched asset's holders). */
  changed: count,
  /** Holders of an accepted asset that were left unlinked because they are not elements of the threat model that can hold it (FR-009). */
  unlinked_holders: z.strictObject({ asset_item_id: uuid, element_item_id: uuid }).array(),
});
export type DecisionResult = z.infer<typeof DecisionResult>;

/**
 * Where a record, or one flag of an element, came from (FR-017, FR-018, research #8): written when an accept created the record or set the flag, and kept after
 * the draft is gone. The citations are shown as the draft's are: a deleted source leaves `chunk` and `quote` null, and no text of a source is stored.
 */
export const ProvenanceRecord = z.strictObject({
  id: uuid,
  target: z.strictObject({ kind: z.enum(['element', 'asset', 'assumption']), id: uuid }),
  /** The flag it is about, or null for the record itself. */
  flag: z.string().nullable(),
  rationale: z.string(),
  accepted_by: JobUser,
  accepted_at: timestamp,
  citations: CitationRecord.array(),
});
export type ProvenanceRecord = z.infer<typeof ProvenanceRecord>;
