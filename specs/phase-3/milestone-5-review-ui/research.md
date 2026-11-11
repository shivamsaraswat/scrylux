# Research: Review UI

Phase 0 of [plan.md](./plan.md). No item of the Technical Context was left unresolved; each decision below settles a choice the spec
left open, against the code as it stands on `feat/phase-3` (commit `33ca627`).

## 1. Where decisions live

**Decision**: As columns of `draft_items` (`decision`, `decided_by`, `decided_at`, `outcome`, and one link to the record an accept
created: `element_id`, `asset_id` or `assumption_id`), not a table of their own.

**Rationale**: A decision is one-to-one with an item and has the item's life: it goes when the draft is replaced or discarded (FR-016),
which is the `ON DELETE CASCADE` the item already has. A separate table would repeat that cascade and add a join to every read. The links
are `ON DELETE SET NULL` foreign keys to the real records, so a record deleted elsewhere clears the link without a trigger (FR-014).

**Alternatives considered**: A `draft_decisions` table (a second table with the same life); storing the decision on the created record
(the record would then know its draft, which is gone by design).

**Consequence**: Milestone 4 kept a draft wholly apart from the threat model ("nothing here references them"). It no longer does. The
references only point from the draft to what it created; nothing in `elements`, `assets` or `assumptions` points at a draft. The
constitution's "draft tables" sentence and migration 018's comment are updated (research #14).

## 2. What "accepted" means when the record is gone

**Decision**: The state is derived. An item is **accepted** when `decision = 'accepted'` and either `outcome = 'matched'` or the link for
its kind is not null. `decision = 'accepted'`, `outcome = 'created'` and a null link (the record was deleted) is shown as **undecided**,
and the next decision overwrites the row. `rejected` is stored as is.

**Rationale**: FR-014 says an accepted item whose record is deleted becomes undecided; deriving it needs no trigger and no write from the
delete path. A matched accept created nothing, so there is no record to lose and it stays accepted (FR-014's last sentence).

**Alternatives considered**: A trigger on each record table resetting the item (three triggers, a second writer of `draft_items`).

## 3. The comparison, in SQL

**Decision**: `review/compare.ts` reads the draft's items and the threat model's elements, assets and assumptions and derives, for each
item, `new`, `matched` (exactly one) or `several`, with the matched record's id. The match is done in SQL with `lower(btrim(name))` on both
sides, the expression of the unique indexes of data-model.md; an assumption is matched on `lower(btrim(statement))`. Elements match on
type and name.

**Rationale**: FR-002 and FR-021 say the same thing twice: what counts as "the same name" for a match must be what counts as the same name
for a unique index. Doing both in PostgreSQL means JavaScript's `toLowerCase` and the database's `lower` can never disagree on a
non-ASCII name. One query per kind, each joining the draft's items to the model's records and grouping.

**Differences** (FR-002): for a matched element, the proposed flags the element has not assessed or has with another value, whether the
draft boundary resolves to a different element than its current parent, and, for a flow, whether its two endpoints resolve to different
elements; for a matched asset, the number of draft holders that resolve to an element that does not hold it. "Resolve" is research #5.

**Alternatives considered**: Matching in the browser (the page and the server could disagree, and the server has to match anyway at
decision time); fuzzy matching (out of scope, spec Assumptions).

## 4. One decision, one transaction

**Decision**: `decide.ts` runs each request in one transaction, in this order, so that the lock order is the same as everywhere:

1. `lockModel` on the threat model (the existing per-model lock, `FOR NO KEY UPDATE`).
2. The draft row `FOR UPDATE`. If the threat model has no draft, or its id is not the request's `draft_id`, the request is refused `409`
   "This draft was replaced or discarded" and nothing is written (FR-011).
3. The requested items `FOR UPDATE`, in position order. An id that is not an item of that draft is a `404`.
4. For `accept` and `reject`, every item must be undecided, or a rejected one for an accept. Any item that is accepted answers the
   whole request `409` "already decided", counting how many (FR-011). `undecide` takes rejected items only.
5. For `accept`: each item's `seen` must equal the comparison derived now (research #3), or the request is refused `409` "out of date"
   (FR-011, "a match that disappeared"). Then the plan (research #5), the limit check (research #6), the writes, the provenance rows
   (research #8), and the decision columns.

**Rationale**: Two requests for the same item both queue on the model lock; the second then finds the item accepted and is refused, so no
second record is created (SC-003). A discard or a new extraction takes the draft row (the worker's commit takes sources, then the job,
then deletes the draft, and never takes the model's lock), so the two orders cannot form a cycle. A record's citations are copied from
`draft_citations` as stored, spans and chunk ids, so an accept never reads a document's text.

**Why refuse an already-accepted item instead of treating it as done**: the request is all or nothing (FR-010). An idempotent "already
done" for part of a request would make the answer say less than the page asked for. The page reloads the draft on a `409`.

**Alternatives considered**: Optimistic concurrency with a version on the draft (a column and a retry loop where one lock already
serialises writers to a threat model); creating the elements through `POST /elements/batch` (the constitution's Tampering section says a
client cannot fake provenance and only a server-side writer records it, and the batch has no draft to read from).

## 5. Dependencies, references and edits

**Decision**: A draft item **resolves** to an existing element when it is accepted and created (its link), or when it is not and exactly
one element matches it (comparison `matched`), whether or not its own decision is made. Otherwise it does not resolve. A flow needs both
endpoints to resolve or to be created by the same request; a member of a boundary needs the boundary to resolve or be created by the
same request, unless an edit clears it (FR-003, FR-009). An asset's holders are never needed: those that resolve or are created are
linked, the others are listed in the answer as `unlinked_holders` and shown by the page (FR-009).

**Edits** (FR-013) name a reference as `{ "item": <draft item id> }` or `{ "element": <element id> }`, or `null` for no boundary. The
edit schema is strict and has the fields of all kinds; the server refuses a field that the item's kind does not take (`400`, fixed text).
The checks that cannot be written as a schema are left to the rules every element obeys: the element schema (`ElementShape`, the flag
vocabulary), the database's composite foreign keys (an element of another model is a `400`), and its triggers (flow endpoint types, no
cycle of boundaries). `mapStorageError` already turns those into fixed messages; the plan adds the new constraint names (research #13).

**Creation order**: ids are drawn in the transaction before anything is written, so a reference can be written before its target exists.
Boundaries go first, by depth, then nodes, then flows, as the import writes them, because the element trigger reads a row's parent and
a flow's ends.

**A matched element is filled through `updateElementIn`**, with `properties.flags` merged so that only flags that were absent are added.
That reuses the shared schema check, and it cannot drop provenance because it changes no existing value.

**Alternatives considered**: Accepting an item's dependencies automatically (the spec's Assumptions say no: a reviewer decides each
element, and several items go in together by selecting them); refusing a flow to a matched endpoint until it is accepted (the match
would then need a decision it does not need).

## 6. The limits

**Decision**: `MAX_ASSETS = 200` and `MAX_ASSUMPTIONS = 200` are constants in `packages/core`, enforced by triggers in the migration
(the pattern of 013: the model's row locked `FOR NO KEY UPDATE`, then a count) and kept equal by a test. An accept counts what it would
create first and refuses the whole request `409` with how many more fit (FR-012): "A threat model can hold 1,000 elements; 3 more fit."
The numbers come from the database and the request's own count, never from a draft. The element trigger remains the backstop and is
mapped as before.

**Rationale**: 200 holds any draft (at most 40, 15 and 15) several times over, and a person would not read 200 assets. No setting: the
spec asks for a documented number, and a setting would be configuration nothing requires (Principle III).

## 7. Assets and assumptions as tables

**Decision**: `assets(id, threat_model_id, name, description)`, `asset_holders(asset_id, element_id)` and
`assumptions(id, threat_model_id, statement)`, with `created_at`/`updated_at` as every record has. A unique index on
`(threat_model_id, lower(btrim(name)))` for assets and on the statement for assumptions, so a draft item matches at most one
(FR-021). A holder's row has the threat model's id in both composite foreign keys, so a holder is an element of the same model, deleted
with either side; a trigger refuses a data flow or a trust boundary as a holder. Text limits: a name at most 200 characters, a
description or statement at most `DESCRIPTION_MAX_LENGTH` (10,000), non-blank.

**Rationale**: The same reasoning as 006: the database enforces what a record must always satisfy, so the API, the import and the accept
cannot disagree. An element's type can only change within its class (`elements_type_class_immutable`), so a node stays a node and the
holder trigger is race-free, as 006's own checks are.

**Alternatives considered**: Holders as a JSON array on the asset (no referential integrity, no cascade on an element's delete);
holders including flows and boundaries (the spec says nodes only, and a flow "holding" data is a different thing from what an asset's
holder is meant to say).

## 8. Provenance

**Decision**: Two tables. `provenance` has one row per record created by an accept (`flag` null) and one per flag an accept set
(`flag` named), each with `rationale`, `accepted_by` and `accepted_at`; exactly one of `element_id`, `asset_id`, `assumption_id` is set,
and all cascade with the record. `provenance_citations` copies the item's, or the flag's, citations as the draft keeps them: a chunk id
(null once its source is deleted) and the span of the quote, never its text. A created element gets the record row and a row for each
proposed flag it still has with the proposed value; a flag the reviewer edited at accept is theirs and gets no row. A matched element gets
a row for each flag the accept filled in, and nothing else. A matched asset or assumption gets none.

**Rationale**: FR-017 asks for four things the draft cannot give once it is gone: a mark, the rationale, the citations, and which flags are
AI's. M4 gave a flag citations and no rationale of its own, so a flag's row repeats the item's rationale, at most four extra rows of 300
characters. Spans keep Milestone 3's promise that no text of a source outlives it, and the page shows "Source deleted" exactly as the
draft's citations do. The mark is not on the record, so it is in no record shape, no export and no client request (FR-017, FR-023).

**A person's later edit** (FR-017): `updateElementIn` already runs for every element write, single or batch. After it, the flags of
the old and the new `properties` are compared in the same transaction, and the `provenance` rows of a flag whose value changed or was
removed are deleted. A flag whose value is unchanged keeps its row. Nothing else removes a mark but the record's own deletion.

**Alternatives considered**: An `origin` column on elements, assets and assumptions (three altered tables, every record shape and the
export change, and it still would not carry rationale or citations); copying the quote text (a deleted document's words would outlive it,
which M3 FR-053 forbids).

## 9. Reading provenance

**Decision**: One route, `GET /threat-models/{id}/provenance`, returns every row of a threat model with its citations as the draft's
`CitationRecord`s (the same source name, location, quote read from the chunk by span, or "source deleted"). The page joins it to
elements, assets and assumptions by id.

**Rationale**: It leaves `ElementRecord` and every existing response unchanged, so no existing contract test, export or OpenAPI schema
moves (FR-023: no file or report carries it), and one query serves the diagram's panel and the Assets tab.

**Alternatives considered**: A `provenance` field on `ElementRecord` (every element response, batch answer and the diagram's cache would
change shape); one route per record kind (three routes for one table).

## 10. The Scrylux file, version 2

**Decision**: `SCRYLUX_FILE_VERSION = 2` for the file; the file's schema gains `assets` (name, description, `holder_ids` as the file's own
element ids) and `assumptions` (statement). A version 1 file is still parsed, by its own strict schema, and planned with empty lists.
`SCRYLUX_FORMAT_VERSION` keeps its value, 1, because the OTM export, which the spec does not change, writes it into its own mark. The
version message names the versions this install reads. Export order is by name (assets) and statement (assumptions), by code point,
like the elements', and every key is always present, so exporting an unchanged model twice gives the same bytes (Phase 2 Milestone 6
FR-005). An import creates assets and assumptions as ordinary records with **no provenance**, whatever the file says (FR-023). The
checks across records (a holder is an element of the file, a node; names unique after normalising; the limits) join `checkPlan`, so a
refusal names a place in the file and never a value.

**Rationale**: A file that loses what a person accepted is not a way to "export it" (the phase's Definition of Done). A strict version 2
keeps the file's rule that no key may be added; reading version 1 keeps every file ever exported working. The committed
`docs/threat-model/threat-model.scrylux.json` is version 1 and stays readable. **But the dogfood check imports it and exports it again
and compares the two, `format_version` included** (`apps/api/test/dogfood/checks.ts`), so a version 1 file would fail that check once the
exporter writes version 2. The committed file therefore moves to version 2 in this change (re-exported by the new build, with empty
`assets` and `assumptions` until the maintainer's rebuild adds any), and the check's list of compared parts gains `assets` and
`assumptions`. The import summary's per-model counts gain the two numbers for the same reason: that check compares each count with the
file. **The demo file `docs/demo/notes-app.scrylux.json` is checked the same way** (`apps/api/test/demo/`), so it moves to version 2
too. The release smoke run only imports it, which either version satisfies, so it needs no change.

**Alternatives considered**: Optional arrays in version 1 (breaks the rule that a file's shape is its version); bumping the OTM mark too
(the OTM export is unchanged); mapping assets to OTM `assets` (a different shape; the spec leaves it out, and the OTM note says so).

## 11. The snapshot and the reports

**Decision**: `readSnapshot` reads assets (with their holder ids) and assumptions in the same repeatable-read transaction, ordered by
name and statement. The report model gains two sections, **Assets** (name, description, holders by their element's reference and name)
and **Assumptions** (statement), after the elements, in the Markdown and the HTML, with the header's contents line unchanged (it counts
elements, threats and mitigations), so a report of a model with no asset or assumption is byte for byte what it was before. Their text goes through the same escapers as every other report text. The diagram (Mermaid, SVG) is unchanged.

**Rationale**: FR-023 asks for the reports to include them as they include elements; the existing escapers and the report tests that use
real parsers are the guard against a name or a description becoming markup (Phase 2 Milestone 5). The OTM export, which reads the same
snapshot, ignores the new fields.

## 12. The web app

**Decision**:

- **The Draft tab** keeps its layout and gains the review: every item shows its state and comparison, the list and the diagram share one
  selection that may hold several items, and `ReviewControls` offers Accept, Reject and Return to undecided for the selection. "Accept…"
  on one item opens `AcceptEditor`, the form of FR-013, with the model's values filled in. Accepting a selection with no edits is one
  click and sends each item's `seen` value.
- **The Assets tab** (`/threat-models/:id/assets`) lists assets and assumptions, with create, edit and delete forms, the holder names as
  links to the diagram, and the provenance notice.
- **`ProvenanceNotice`** shows "Proposed by AI, accepted by <name> on <date>", the rationale and the citations (reusing the draft's
  `CitationView`), and for flags which are AI's. It is used by the diagram's properties panel and by the Assets tab, which is why it is a
  file of its own.
- **Cache**: a decision invalidates the draft, the extraction status, the elements, the assets, the assumptions and the provenance. The
  diagram editor already refetches elements when they are invalidated and replays unsaved changes on top, so an accept never discards one.

**Rationale**: The page changes where the review is; everything else is a reuse. The diagram editor's provider is keyed by the threat
model and survives tab changes, so no editor state is lost when a reviewer moves between the Draft and the Diagram tabs.

**Alternatives considered**: A separate Review tab (plan.md says the Draft tab: "a diff-style view of the draft"); assets in a panel of
the diagram (the spec says a section apart from it).

## 13. Errors, logging and record types

**Decision**: `RecordType` gains `asset` and `assumption`, so the router's one-line write log (`who, action, type, id`) covers their
create, update and delete with no code of their own. Decisions are not a single record write, so `logDecision` (in `write-log.ts`, beside
`logGeneration`) writes one line: account, action, threat model, the number of items and the number of records created or changed. New
fixed messages in `errors.ts`: the duplicate-name constraints (409), the limit triggers (400), the holder trigger (400), and the decision
refusals above. No message holds a name, a statement or any text of a draft.

## 14. The threat model, the constitution and the maintainer

**Decision**: The Threat Model section and `docs/threat-model/` change as FR-027 lists, as constitution 1.19.0 (a MINOR, with its Sync
Impact Report): assets (accepted records and provenance, which holds AI text derived from confidential documents and is kept until the
record goes); entry points (`POST …/draft/decisions`, `GET …/provenance`, and the six record operations); Tampering's "AI-proposed edits"
item as mitigated now (the human accept; the server builds records from the stored draft; one transaction; a mark no client can set);
Spoofing's "a person reviews the draft, in Milestone 5" as in place; Information Disclosure for the files and reports now carrying
AI-derived text as ordinary records, and for provenance's stored citation spans; Elevation of Privilege's justified widening (any
account can accept into any threat model and manage assets, as it could already edit elements). The remaining risks are a reviewer
accepting without reading and a model proposing what the documents do not say, which the reviewer sees as a quote.

**The maintainer's part**: Milestones 3 and 4 recorded "You approved the additions on <date>" in `docs/threat-model/README.md`. The plan
rebuilds the model in a running Scrylux as before, and **does not write an approval**; the README's approval sentence is left for the
maintainer to extend after they read the additions.

## 15. Principle III: the files, and what is not built

Each new source file and why it exists:

| File | Why |
|---|---|
| `review/compare.ts` | Two callers: reading a draft, and deciding. |
| `review/decide.ts` | The accept, reject and undecide transactions; well over 300 lines with the plan and writes, so not folded into a route file. |
| `review/provenance.ts` | Two callers: the accept writes it, the route reads it. |
| `v1/review.ts` | Route file for the decision and provenance operations. |
| `v1/assets.ts`, `v1/assumptions.ts` | One route file per resource (Principle III). |
| `schemas/review.ts`, `schemas/asset.ts` | Shared schemas the API and the web app both import. |
| `pages/AssetsTab.tsx` | A new tab. |
| `draft/ReviewControls.tsx`, `draft/AcceptEditor.tsx` | Used from `DraftTab` and `ItemPanel`; each is a distinct form of the page, and `DraftTab.tsx` is 208 lines, and the review would take it well past 300. |
| `components/ProvenanceNotice.tsx` | Used from two places. |

**Not built**: any setting; a helper exported only for a test; an undo of an accept; a bulk accept beyond selecting items; memory of
rejections; fuzzy matching; assets in OTM; a provenance column on any record; a new worker job; a new package. Existing code is
touched only where a spec requirement reaches it.

## 16. Performance

**Decision**: A whole-draft accept is at most 40 + 15 + 15 inserts of records, at most 70 decision updates, about 200 provenance rows and
about 350 citation rows. Records go in as multi-row inserts per level (boundaries, nodes, flows, assets, assumptions), citations in two
statements, decisions in one `UPDATE … FROM unnest`. SC-005 (2 s) is a test at the largest draft against a threat model at the element
limit, where the cost that grows with the model is the one `count(*)` of the element trigger, which that test measures.
Reading a draft adds three joined queries to the existing ones; it is measured on a threat model of 1,000 elements in the same test.
