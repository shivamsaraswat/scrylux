# Data Model: Review UI

Phase 1 of [plan.md](./plan.md). One forward-only migration, `packages/db/migrations/019_review.sql`, adds five tables and seven
columns. Kysely types are in `packages/db/src/schema.ts`. The API records are in `packages/core/src/schemas/asset.ts` and
`schemas/review.ts`. No column of `elements`, `threats`, `mitigations` or `threat_models` changes, and `ElementRecord` is unchanged.

## Migration 019, in order

1. `assets`, `asset_holders`, `assumptions`, and their limit and holder triggers.
2. `provenance`, `provenance_citations`.
3. The decision columns of `draft_items`.

## `assets` (Phase 3 Milestone 5, FR-006, FR-021)

| Column | Type | Rules |
|---|---|---|
| `id` | `UUID` PK | `gen_random_uuid()` |
| `threat_model_id` | `UUID` NOT NULL | FK `threat_models(id)` `ON DELETE CASCADE` |
| `name` | `TEXT` NOT NULL | non-blank, at most 200 characters |
| `description` | `TEXT` NOT NULL | non-blank, at most 10,000 characters (`DESCRIPTION_MAX_LENGTH`) |
| `created_at`, `updated_at` | `TIMESTAMPTZ` NOT NULL | `now()`, and the shared `set_timestamps` trigger |

`UNIQUE (threat_model_id, id)`, the target of the composite keys below. `UNIQUE INDEX assets_name_key ON (threat_model_id,
lower(btrim(name)))`: a name is unique within the threat model, ignoring case and surrounding whitespace, and is also what the
comparison matches on (research #3). Trigger `assets_limit`: before an insert, lock the threat model row `FOR NO KEY UPDATE` and refuse a
201st asset with `check_violation` named `assets_limit` (pattern of 013).

## `asset_holders`: the elements that store or carry an asset

| Column | Type | Rules |
|---|---|---|
| `threat_model_id` | `UUID` NOT NULL | |
| `asset_id` | `UUID` NOT NULL | composite FK `(threat_model_id, asset_id)` → `assets(threat_model_id, id)` `ON DELETE CASCADE` |
| `element_id` | `UUID` NOT NULL | composite FK `(threat_model_id, element_id)` → `elements(threat_model_id, id)` `ON DELETE CASCADE` |

PK `(asset_id, element_id)`. Index `(element_id)` for the cascade. Trigger `asset_holders_check`: the element's type is a node
(`process`, `data_store`, `external_entity`); a data flow or a trust boundary raises `check_violation` named `asset_holders_node`. It is
race-free because an element's type class never changes (`elements_type_class_immutable`). Deleting a holder element removes the row and
leaves the asset (FR-021).

## `assumptions` (FR-006, FR-021)

| Column | Type | Rules |
|---|---|---|
| `id` | `UUID` PK | `gen_random_uuid()` |
| `threat_model_id` | `UUID` NOT NULL | FK `threat_models(id)` `ON DELETE CASCADE` |
| `statement` | `TEXT` NOT NULL | non-blank, at most 10,000 characters |
| `created_at`, `updated_at` | `TIMESTAMPTZ` NOT NULL | as `assets` |

`UNIQUE (threat_model_id, id)`. `UNIQUE INDEX assumptions_statement_key ON (threat_model_id, lower(btrim(statement)))`. Trigger
`assumptions_limit`: a 201st raises `assumptions_limit`.

## `provenance`: where a record, or one flag of it, came from (FR-017, FR-018)

| Column | Type | Rules |
|---|---|---|
| `id` | `UUID` PK | `gen_random_uuid()` |
| `threat_model_id` | `UUID` NOT NULL | |
| `element_id`, `asset_id`, `assumption_id` | `UUID` | exactly one is set (`CHECK num_nonnulls(…) = 1`); composite FK on `(threat_model_id, …)` to the record, `ON DELETE CASCADE` |
| `flag` | `TEXT` | NULL for the record itself; a flag name for one flag of an element (only with `element_id`), 1–64 characters |
| `rationale` | `TEXT` NOT NULL | 1–300 characters: the draft item's. A flag's row repeats its item's (research #8) |
| `accepted_by` | `INTEGER` NOT NULL | FK `users(id)` `ON DELETE RESTRICT`, as for drafts and sources |
| `accepted_at` | `TIMESTAMPTZ` NOT NULL | `now()`, the accept's time |

`UNIQUE INDEX provenance_key ON (coalesce(element_id, asset_id, assumption_id), coalesce(flag, ''))`: one row for a record and one per
flag. Index `(threat_model_id)` for the read.

## `provenance_citations`

| Column | Type | Rules |
|---|---|---|
| `provenance_id` | `UUID` NOT NULL | FK `provenance(id)` `ON DELETE CASCADE` |
| `position` | `SMALLINT` NOT NULL | 0–4 |
| `chunk_id` | `UUID` | FK `chunks(id)` `ON DELETE SET NULL`: NULL means "source deleted" |
| `quote_start`, `quote_end` | `INTEGER` NOT NULL | the draft's span, `0 ≤ start < end ≤ 2000`, `end - start` ≥ 12 |

PK `(provenance_id, position)`. Index `(chunk_id)` where not null. No column holds the quote's text.

## `draft_items`: the decision (FR-001, FR-014, FR-018)

| Column | Type | Rules |
|---|---|---|
| `decision` | `TEXT` | NULL (undecided), `accepted` or `rejected` |
| `decided_by` | `INTEGER` | FK `users(id)` `ON DELETE RESTRICT` |
| `decided_at` | `TIMESTAMPTZ` | |
| `outcome` | `TEXT` | `created` or `matched`; set exactly when `decision = 'accepted'` |
| `element_id` | `UUID` | FK `elements(id)` `ON DELETE SET NULL`: the element an accept created, for an element kind only |
| `asset_id` | `UUID` | FK `assets(id)` `ON DELETE SET NULL`, for kind `asset` only |
| `assumption_id` | `UUID` | FK `assumptions(id)` `ON DELETE SET NULL`, for kind `assumption` only |

Checks: `decision`, `decided_by` and `decided_at` are all null or all set; a link is set only when `outcome = 'created'`, and only the
one that fits the item's kind. A `created` item whose link is null is a record that was deleted: it reads as undecided (research #2).
Nothing else about a draft item changes: a decision never edits what the model proposed.

## The API records

- **`AssetRecord`**: `id`, `threat_model_id`, `name`, `description`, `holder_ids` (element ids, in creation order), `created_at`,
  `updated_at`. **`AssetInput`** (create): `name`, `description`, `holder_ids` (default `[]`). **`AssetUpdate`**: any of the three, strict;
  `holder_ids` replaces the set.
- **`AssumptionRecord`**: `id`, `threat_model_id`, `statement`, `created_at`, `updated_at`. **`AssumptionInput`**/**`AssumptionUpdate`**:
  `statement`.
- **`ItemReview`** (in `DraftRecord.review`, keyed by draft item id): `state` (`undecided`, `accepted`, `rejected`), `decided_by`
  (`JobUser` or null), `decided_at`, `outcome`, `comparison` (`new`, `matched`, `several`, or null), `matched_id` (the existing
  record's id when `matched`, else null), `differences` and `needs` (below). For an item whose state is `accepted`, `comparison`,
  `matched_id`, `differences` and `needs` are null: it has been decided, and what it was compared with is no longer the question.
  `several` occurs only for an element; an asset or an assumption matches at most one record (their names and statements are
  unique).
  - `differences` (a matched item only): `flags` (`{ flag, proposed, current }[]`, `current` null when not assessed), `boundary`
    (boolean), `endpoints` (boolean), `holders_missing` (a count, for an asset).
  - `needs` (an undecided element only): `{ need: 'boundary' | 'source' | 'target', item_id }[]`, the references that do not resolve
    (research #5).
- **`DraftDecision`** (the request): `draft_id`, and one of `{ action: 'accept', items: { id, seen, edits? }[] }`,
  `{ action: 'reject', items: { id }[] }`, `{ action: 'undecide', items: { id }[] }`, 1 to 70 items. `seen` is the comparison the page
  showed. `edits` is the strict object of contracts/http-api.md.
- **`DecisionResult`**: `draft` (the updated `DraftRecord`), `created` and `changed` (counts), and `unlinked_holders`
  (`{ asset_item_id, element_item_id }[]`, the holders an accept left unlinked).
- **`ProvenanceRecord`**: `id`, `target` (`{ kind: 'element' | 'asset' | 'assumption', id }`), `flag` (or null), `rationale`,
  `accepted_by` (`JobUser`), `accepted_at`, `citations` (`CitationRecord[]`, as the draft's).

## What a difference is

A draft item **resolves** to an existing element when it is accepted and created (its link), or when exactly one element matches it
(research #5). A *draft boundary* is the item's `boundary_id`, and a *draft endpoint* is its `source_item_id` or `target_item_id`.
For a matched item:

- **`flags`**: for each flag the draft proposes, `{ flag, proposed, current }` where `current` is the element's value or null. It is
  listed when `current` is null or differs from `proposed`; a flag the draft does not propose is never listed.
- **`boundary`**: true when the draft names a boundary and either it does not resolve to an element or it resolves to an element
  other than the matched element's current parent. False when the draft names none, whatever the element's parent.
- **`endpoints`** (a data flow): true when either draft endpoint does not resolve, or resolves to an element other than the matched
  flow's source or target respectively.
- **`holders_missing`** (an asset): the number of the draft asset's holders that resolve to an element which does not hold the
  matched asset. A holder that does not resolve is not counted.

## Transitions of an item

```text
undecided ──accept (new)──────▶ accepted/created ──(record deleted elsewhere)──▶ undecided
undecided ──accept (match)────▶ accepted/matched   (stays accepted; nothing was created)
undecided ──reject────────────▶ rejected ──undecide──▶ undecided
rejected  ──accept────────────▶ accepted/created or accepted/matched
any ──(draft replaced, discarded, threat model deleted)──▶ gone with the draft
```

## What a delete does

| Delete | Effect |
|---|---|
| An element | its holder rows, its provenance (record and flags), the draft item's link (set null); the asset stays |
| An asset or an assumption | its provenance, the draft item's link (set null) |
| A flag's value changed or removed by a person | that flag's `provenance` row (`updateElementIn`) |
| A chunk's source | the provenance citations' `chunk_id` (set null): "Source deleted" |
| The draft (discard, replacement) | its decisions; accepted records and their provenance stay |
| A threat model | everything above |
