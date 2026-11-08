# Data Model: System Extraction

Phase 1 of [plan.md](./plan.md). One forward-only migration, `packages/db/migrations/018_drafts.sql`, adds six tables
and changes `jobs`. Kysely types in `packages/db/src/schema.ts`. The model's answer and the API records are in
`packages/core/src/schemas/draft.ts`. No migration adds a vector index (research #6).

A draft is kept apart from the threat model: no column of `elements`, `threats` or `mitigations` changes, and nothing
here references them (FR-050).

## Migration 018, in order

1. `drafts`, `draft_sources`, `draft_read_chunks`, `draft_items`, `draft_asset_holders`, `draft_citations`.
2. The changes to `jobs`.

## `drafts`: at most one per threat model

| Column | Type | Rules |
|---|---|---|
| `id` | `UUID` PK | `gen_random_uuid()` |
| `threat_model_id` | `UUID` NOT NULL | FK `threat_models(id)` `ON DELETE CASCADE` (FR-056); `UNIQUE` (FR-052) |
| `job_id` | `UUID` | FK `jobs(id)` `ON DELETE SET NULL`: the extraction that made it |
| `started_by` | `INTEGER` NOT NULL | FK `users(id)` `ON DELETE RESTRICT`, as for jobs and sources |
| `made_at` | `TIMESTAMPTZ` NOT NULL | `now()`, the commit's time; shown, and never compared to decide whether sources changed (research #13) |
| `generation_model` | `TEXT` NOT NULL | the worker's configured model; non-empty |
| `prompt_version` | `TEXT` NOT NULL | `^extract-system/[0-9a-f]{12}$` (research #12) |
| `path` | `TEXT` NOT NULL | `whole` or `retrieval` (FR-014) |
| `chunks_read` | `INTEGER` NOT NULL | 1–1,000 |
| `chunks_available` | `INTEGER` NOT NULL | ≥ `chunks_read`; equal when `path = 'whole'` |
| `sources_total` | `INTEGER` NOT NULL | ≥ 1: the sources the extraction considered, read or left out |
| `nothing_found` | `TEXT` | 1–300 characters; set exactly when the draft has no item (FR-024), checked by the writer |

## `draft_sources`: what the extraction read and left out (FR-004, FR-053)

| Column | Type | Rules |
|---|---|---|
| `draft_id` | `UUID` NOT NULL | FK `drafts(id)` `ON DELETE CASCADE` |
| `source_id` | `UUID` NOT NULL | FK `sources(id)` `ON DELETE CASCADE`: a deleted source leaves fewer rows than `sources_total` |
| `read` | `BOOLEAN` NOT NULL | false for a source left out because it was waiting, processing or failed |

PK `(draft_id, source_id)`. Index `(source_id)` for the cascade.

## `draft_read_chunks`: which chunks were sent (FR-014)

| Column | Type | Rules |
|---|---|---|
| `draft_id` | `UUID` NOT NULL | FK `drafts(id)` `ON DELETE CASCADE` |
| `chunk_id` | `UUID` NOT NULL | FK `chunks(id)` `ON DELETE CASCADE` |
| `label` | `SMALLINT` NOT NULL | 1–1,000: the `cN` it was sent as; `UNIQUE (draft_id, label)` |

PK `(draft_id, chunk_id)`. Index `(chunk_id)`.

## `draft_items`: proposed elements, assets and assumptions (FR-021 to FR-023)

| Column | Type | Rules |
|---|---|---|
| `id` | `UUID` PK | `gen_random_uuid()`; the model's `ref` is not stored |
| `draft_id` | `UUID` NOT NULL | FK `drafts(id)` `ON DELETE CASCADE` |
| `position` | `SMALLINT` NOT NULL | 0–69, the order of the answer; `UNIQUE (draft_id, position)` |
| `kind` | `TEXT` NOT NULL | `process`, `data_store`, `external_entity`, `data_flow`, `trust_boundary`, `asset`, `assumption` |
| `name` | `TEXT` | 1–200 characters; NULL exactly for an assumption |
| `body` | `TEXT` | an asset's description or an assumption's statement, 1–300 characters; NULL for elements |
| `rationale` | `TEXT` NOT NULL | 1–300 characters |
| `boundary_id` | `UUID` | FK `draft_items(id)` `ON DELETE CASCADE`; elements other than flows only |
| `source_item_id`, `target_item_id` | `UUID` | FK `draft_items(id)` `ON DELETE CASCADE`; set exactly for `data_flow`; different |
| `flags` | `JSONB` NOT NULL | `{}` or `{ "<flag>": true|false }`; for elements only; each flag allowed for `kind` (`ELEMENT_FLAGS`) |

Per-kind presence is a `CHECK` (name, body, endpoints, flags `{}` for assets and assumptions). That the referenced item
is of the right kind, that boundaries nest without a cycle, and that names are unique per kind are checked in the
answer before writing (research #2), and the draft never changes after it is written, so no trigger repeats them.

## `draft_asset_holders`

`(asset_id, element_id)`, both FK `draft_items(id)` `ON DELETE CASCADE`, PK of both: the elements that store or carry an
asset (FR-023).

## `draft_citations`

| Column | Type | Rules |
|---|---|---|
| `id` | `UUID` PK | |
| `item_id` | `UUID` NOT NULL | FK `draft_items(id)` `ON DELETE CASCADE` |
| `flag` | `TEXT` | NULL for a citation of the item; a flag name for a citation of that flag (FR-022) |
| `position` | `SMALLINT` NOT NULL | the order within the item or the flag |
| `chunk_id` | `UUID` | FK `chunks(id)` `ON DELETE SET NULL`: NULL means "source deleted" (FR-054) |
| `quote_start`, `quote_end` | `INTEGER` NOT NULL | code points within the chunk's text, `0 ≤ start < end ≤ 2000`, `end - start` ≥ 12 (research #4) |

No column holds the quote's text: it is read from the chunk, so a deleted source leaves none of its text here.
`UNIQUE (item_id, flag, position)` with `NULLS NOT DISTINCT`. Index `(chunk_id)`.

## Changes to `jobs`

- `jobs_kind_check`: adds `extract_system`. `jobs_scope_check` already requires a threat model for every kind but the
  provider check; `source_id` stays NULL for an extraction.
- `jobs_failure_category_check`: adds `no_ready_source`, `embeddings_out_of_date` and `sources_changed` (FR-044).
  `sources_changed` joins `JOB_TRANSIENT_CATEGORIES` in `packages/core`.
- `CREATE UNIQUE INDEX jobs_one_extraction_idx ON jobs (threat_model_id) WHERE kind = 'extract_system' AND state IN
  ('queued', 'running')` (FR-042, research #11).
- The steps `select`, `generate`, `store` join the kind's list in `JOB_STEPS`.

## The model's answer: `DraftAnswer` (sent as JSON Schema; research #2)

```text
DraftAnswer {
  elements:    Element[]   ≤ 40
  assets:      Asset[]     ≤ 15
  assumptions: Assumption[] ≤ 15
  nothing_found: string(1–300) | null
}
Element    { ref, type: process|data_store|external_entity|data_flow|trust_boundary, name(1–200),
             boundary: ref|null, source: ref|null, target: ref|null,
             flags: { flag: <any ELEMENT_FLAGS name>, value: boolean, citations: Citation[1–2] }[] ≤ 4,
             rationale(1–300), citations: Citation[1–5] }
Asset      { ref, name(1–200), description(1–300), held_by: ref[] ≤ 10, rationale(1–300), citations: Citation[1–5] }
Assumption { ref, statement(1–300), rationale(1–300), citations: Citation[1–5] }
Citation   { chunk: ^c[1-9][0-9]{0,3}$, quote: string(12–200) }
ref        ^[a-z][a-z0-9_]{0,23}$
```

Every object is strict, and every field is required, with `null` where it may be absent, as strict structured output
needs. The request's refinement adds the checks of research #2.

## API records (`packages/core/src/schemas/draft.ts`)

- **`ExtractionStatus`** (`GET /threat-models/{id}/extraction`): `latest` (the threat model's latest `extract_system`
  job as Milestone 2's `JobRecord`, or null), `start` (`{ offered: true, path, replaces_draft }` or `{ offered: false,
  reason, message }`, the reasons being those of the start route's refusals), and the numbers the page shows
  (`chunks_available`, `budget_chars`).
- **`DraftRecord`** (`GET /threat-models/{id}/draft`): `id`, `threat_model_id`, `made_at`, `started_by` (`JobUser`),
  `job_id`, `generation_model`, `prompt_version`, `path`, `chunks_read`, `chunks_available`, `sources` (`{ id, name,
  read }[]`, the remaining rows), `sources_deleted` (`sources_total` minus the remaining rows), `sources_changed`
  (research #13), `nothing_found`, `elements`, `assets`, `assumptions` (each with `id`, its fields, references as item
  ids, and `citations`), and `read_chunks` (`{ source_id, position }[]`).
- **`CitationRecord`**: `{ chunk: { id, source_id, source_name, position, page_first, page_last, line_first, line_last,
  heading } | null, quote: string | null }`, the quote read from the chunk at `quote_start`–`quote_end`. Both null for a
  deleted source.

## Transitions

```text
no draft ──(extraction succeeds)──▶ draft
draft ──(extraction succeeds)──▶ new draft (the old one deleted in the same commit)
draft ──(extraction fails or is cancelled)──▶ same draft
draft ──(discard)──▶ no draft
draft ──(a source added or deleted, a left-out source ready)──▶ same draft, sources_changed
any ──(threat model or project deleted)──▶ gone
```
