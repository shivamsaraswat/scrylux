---

description: "Task list for the Review UI (Phase 3 / Milestone 5)"
---

# Tasks: Review UI

**Input**: Design documents from `/specs/phase-3/milestone-5-review-ui/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/http-api.md, contracts/file-format.md,
contracts/ui.md, quickstart.md

**Tests**: Required. Constitution Principle II requires a failing test before each new behaviour, and Success Criteria
SC-001 to SC-010 are checked by tests (quickstart §1). In every phase the test tasks come first and **MUST be run and
seen failing** before the implementation tasks that follow them. Guard tests are exempt, because they check behaviour
that earlier test-first tasks already built, across several modules, and must pass when written: T071 (the canary), T072
(the scale test) and T073 (the browser flow). One behaviour gets one failing test at its module's public boundary, not one
per internal helper (Principle II, III).

**Organization**: by user story, in the spec's order: US1 → US2 → US3 → US4 → US5 (P1), then US6 → US7 (P2). Pulled into
Foundational because every story needs them: migration 019 with its types, the asset and assumption schemas and the
fixed error messages. Notes on how the stories lean on each other:

- US2 needs US1's `compare.ts`; US3 and US4 extend US2's route and `decide.ts`; US6's reading, notice and flag rule extend
  the provenance that US2 already writes (a created record without provenance would break Principle VI, so the write
  is part of US2).
- US5 carries FR-019 to FR-024's records, their file and report, and the version 2 move of the two committed Scrylux files (`docs/threat-model/` and `docs/demo/`).
- The schemas of the decision route grow story by story (`accept` in US2, `edits` in US3, `reject` and `undecide` in US4),
  so no branch of a route or a schema exists before its behaviour.

**Scope guard** (plan.md, Constitution Check III; research #15):

- No new dependency, no new setting, no new worker job, no change to a prompt, a provider adapter or the extraction
  (FR-029).
- No task adds: threat generation (Milestone 6), fuzzy matching, memory of rejections across drafts, roles, assets in OTM,
  an undo of an accept, a bulk "accept everything" beyond selecting items, a provenance column on any record, or a helper
  exported only for a test.
- No new file beyond those listed in research #15. A symbol is exported only if other source code uses it.
- No task writes a `threats` or `mitigations` row, changes `ElementRecord`, or puts a draft's text, a quote or a rationale
  in a log line, an error answer, a file or a report.
- If a task seems to need one, stop and ask.

**Git**: no task commits, pushes, tags or opens a pull request. The maintainer does that. Undo a test's temporary change to
a tracked file with `git restore --source=HEAD -- <file>`, never `git checkout --`.

**Paths**: relative to the repository root. `API` means `apps/api`, `WEB` means `apps/web`, `DB` means `packages/db`,
`CORE` means `packages/core`, `SPEC` means `specs/phase-3/milestone-5-review-ui`.

**SQL**: every statement is parameterized (Kysely or `sql` templates), never string-built (Principle I). No identifier is
built into SQL. "Same name" is `lower(btrim(…))` in SQL on both sides (research #3).

**Lock order**, everywhere a decision writes (research #4): `lockModel` (the threat model row, `FOR NO KEY UPDATE`), then the
draft row `FOR UPDATE`, then the requested items `FOR UPDATE` in position order.

**Messages**: every error is fixed text in the `{ error }` form. Counts are numbers from the request or the database. No
name, statement, quote or rationale ever appears in one (SC-006).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story the task belongs to (US1–US7)

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Baseline: `pnpm run test` is green on `feat/phase-3` before any other change. Record any flaky suite in
  `SPEC/pr-description.md`'s notes rather than fixing it here.
- [X] T002 In `API/vitest.config.ts`, add `'test/review/concurrency.test.ts'` to `JOBS` and extend its comment: that file
  runs a draft's commit (which reads a job row) beside two decisions, so it must not run beside a file that truncates
  `jobs` or `drafts`. The other review tests seed their own rows and stay in the `api` group.
- [X] T003 [P] Add `API/test/fixtures/review/seed.ts`: `seedReviewDraft(accountId, threatModelId)` returns the ids of a
  draft with: one trust boundary `Internal network`; three nodes (process `API` and data store `Database`, both in the
  boundary, and external entity `Browser`); two data flows (`Browser` → `API`, `API` → `Database`); an asset `Session
  tokens` held by `API`; and an assumption `The database is not exposed`. Every item has a rationale and one citation over
  a seeded chunk (reuse `seedReadySource` of `API/test/fixtures/extract-system/seed.ts`), `API` carries two flags
  (`requires_authentication: true`, `internet_facing: false`) with a citation each, and the result has the item ids by name. Also
  `seedElement(threatModelId, { type, name, flags?, parentId? })` and `seedAsset(threatModelId, name, holderIds?)` for the
  model's own records, written directly in SQL. Used by every review test.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the tables, the record schemas and the fixed messages every story needs. No story can be built before this
phase ends.

### Tests (write first, run, see them fail)

- [X] T004 [P] `DB/test/review-schema.test.ts`, against data-model.md: `assets` (a blank name, a name over 200 characters, a
  blank or over-10,000-character description refused; a name that repeats another asset's of the same threat model
  ignoring case and surrounding whitespace refused, the same name in another threat model accepted; the 201st asset
  refused with a `check_violation` named `assets_limit`); `assumptions` likewise (`assumptions_limit`, a repeated
  statement); `asset_holders` (the composite keys refuse an element or an asset of another threat model; a data flow or
  a trust boundary refused as a holder with `asset_holders_node`; deleting a holder element removes the row and leaves
  the asset; deleting the asset removes its rows); `provenance` (exactly one of `element_id`, `asset_id`, `assumption_id`;
  a `flag` only with `element_id`; one row for a record and one per flag, a second row for the same pair refused; deleting
  the record deletes its rows and their citations); `provenance_citations` (the span check `quote_start >= 0 AND quote_end >
  quote_start AND quote_end <= 2000 AND quote_end - quote_start >= 12`; deleting a chunk sets `chunk_id` to NULL and keeps
  the row); `draft_items` decision columns (all of `decision`, `decided_by`, `decided_at` null or all set; a link set only
  when `outcome = 'created'` and only the one that fits the kind; deleting a linked element sets the link NULL and keeps the
  row); cascades from threat model and project. Also extend `DB/test/agreement.test.ts` so `MAX_ASSETS` and `MAX_ASSUMPTIONS`
  of `CORE` equal the numbers in the two triggers, as `elements_limit` is held to `MAX_ELEMENTS`.
- [X] T005 [P] `CORE/test/asset.test.ts`: `AssetRecord`, `AssetInput`, `AssetUpdate`, `AssumptionRecord`, `AssumptionInput`,
  `AssumptionUpdate` are strict (an unknown key, including `provenance`, is refused); a name 1 to 200 characters trimmed; a
  description and a statement non-empty and at most `DESCRIPTION_MAX_LENGTH`; `holder_ids` are UUIDs, at most 1,000, with no
  repeat; `AssetUpdate` and `AssumptionUpdate` refuse an empty object; `MAX_ASSETS` and `MAX_ASSUMPTIONS` are 200.
- [X] T006 [P] `API/test/review/errors.test.ts`: `mapStorageError` answers the new constraints with the fixed messages of
  research #13: `assets_name_key` → 409 `An asset with this name already exists`; `assumptions_statement_key` → 409 `This
  assumption already exists`; `assets_limit` → 400 `A threat model can hold at most 200 assets`; `assumptions_limit` → 400
  `A threat model can hold at most 200 assumptions`; `asset_holders_node` → 400 `A holder must be a process, a data store or
  an external entity`; the composite keys of `asset_holders` → 400 `holder_ids must refer to elements in the same threat model`.
  No message contains the constraint's row values.

### Implementation

- [X] T007 `DB/migrations/019_review.sql`, forward-only, in the order of data-model.md: (1) `assets`, `asset_holders`,
  `assumptions`, the two unique name indexes on `(threat_model_id, lower(btrim(…)))`, `assets_limit`, `assumptions_limit` and
  `asset_holders_check` triggers (the lock-then-count pattern of `013_element_limit.sql`; the node-type check of
  `006_elements.sql`); (2) `provenance` and `provenance_citations`, with the unique index `provenance_key ON
  (coalesce(element_id, asset_id, assumption_id), coalesce(flag, ''))`; (3) the seven `draft_items` columns and their
  checks. Constraint and index names exactly as T004 and T006 use them. Comment the file as 018 does, and say that the draft
  now points at the records an accept created (research #1). Run T004 until it passes.
- [X] T008 `DB/src/schema.ts`: the types of the five tables and the seven columns. Run `DB/test/schema-types.test.ts`.
- [X] T009 `CORE/src/schemas/asset.ts` (new) and its export from `CORE/src/index.ts`: `MAX_ASSETS = 200`, `MAX_ASSUMPTIONS =
  200`, and the six schemas of T005, with the shapes of data-model.md ("The API records"). Run T005 until it passes.
- [X] T010 `API/src/v1/errors.ts`: the constraint messages of T006, in the existing `DUPLICATES`, `BAD_REFERENCES` and
  `BROKEN_RULES` tables. Run T006 until it passes.

**Checkpoint**: the database accepts the new records, and the schemas and messages exist. `pnpm --filter @scrylux/db test`
and `pnpm --filter @scrylux/core test` pass.

---

## Phase 3: User Story 1 - See the draft against the current model (Priority: P1)

**Goal**: every proposed item shows its state, its comparison with the threat model and what it needs, on the Draft tab
and in `GET …/draft`.

**Independent Test**: seed a threat model with two elements the draft also proposes (one with a differing flag), a name two
existing elements share and an asset the draft also proposes; open the Draft tab; check each item's relation, differences
and needs, and that nothing in the threat model changed.

### Tests (write first)

- [X] T011 [P] [US1] `CORE/test/review.test.ts`: `ItemReview` is strict and has the fields of data-model.md ("The API records");
  `DraftRecord` has a `review` map keyed by item id and no other change.
- [X] T012 [P] [US1] `API/test/review/compare.test.ts`, against a seeded draft (T003): `new` and `matched` (with `matched_id`) for
  every kind, and `several` for an element only (an asset or an assumption cannot match two, their names and statements being
  unique), ignoring case and surrounding whitespace, with one non-ASCII name; a process never matches a data
  store of the same name; the differences of a matched element (a proposed flag the element has not assessed, one it has
  with another value, a different boundary, different flow endpoints) and of a matched asset (`holders_missing`); `needs`
  for a flow (`source`, `target`) and a member of a proposed boundary, none for an item whose references resolve; a
  reference **resolves** to an accepted-and-created element and to an element it matches exactly once, and does not
  resolve to a `several` match (research #5); the review of an item decided by seeding the columns of data-model.md: an
  accepted `created` item with a null link reads `undecided`, an accepted `matched` item stays `accepted`, a rejected item
  reads `rejected`; an accepted item has `comparison`, `matched_id`, `differences` and `needs` null; the differences are
  those of data-model.md "What a difference is", case by case: a flag listed only when the element has not assessed it or has
  another value and never when the draft does not propose it, a boundary that does not resolve, one that resolves to another
  element, a draft with no boundary (not a difference), flow endpoints that do not resolve or differ, `holders_missing`
  counting only holders that resolve. Reading writes nothing (row counts of `elements`, `assets`, `assumptions` unchanged).
- [X] T013 [P] [US1] `API/test/contract/v1/review-read.test.ts`: `GET /threat-models/{id}/draft` carries `review` for every
  element, asset and assumption of the draft; the answer parses with `DraftRecord`; a threat model with no draft is still
  `404`; every earlier field is unchanged.
- [X] T014 [P] [US1] `WEB/src/pages/DraftTab.test.tsx` (extended) and `WEB/src/draft/ItemPanel.test.tsx` (extended): each item
  shows its state; an undecided element shows "New", "Already in the model" with its differences, or "Several in the model;
  treated as new"; a flow with an unmet need shows "Needs <name> in the model first" and no enabled Accept (FR-003, the page
  has none yet, so assert the text); states appear in the list and on the diagram; every text is rendered as text. Update every fixture that builds a `DraftRecord`
  (find them with `grep -rln DraftRecord WEB/src API/test`) to carry `review`, so the M4 tests keep passing.

### Implementation

- [X] T015 [US1] `CORE/src/schemas/review.ts` (new): `ItemReview` and its parts, and the `review` field of `DraftRecord` in
  `CORE/src/schemas/draft.ts`. Export from `CORE/src/index.ts`. Run T011.
- [X] T016 [US1] `API/src/review/compare.ts` (new): `readReview(db, draft: DraftRecord)` returns the `review` map. It reads
  the decision columns of the draft's items and compares each item by one query per kind with `lower(btrim(name))` (an
  assumption by its statement) against the threat model's `elements`, `assets` and `assumptions`, then derives the
  differences and `needs` with the resolve rule of research #5 and the state rule of research #2. Export `readReview` and the
  `resolve` function that `decide.ts` will use. Run T012.
- [X] T017 [US1] `API/src/v1/extraction.ts`: `GET …/draft` returns `{ ...draft, review: await readReview(kdb, draft) }`. Run T013.
- [X] T018 [US1] `WEB/src/draft/draft-items.ts`, `DraftList.tsx`, `ItemPanel.tsx`, `DraftDiagram.tsx`, `DraftNodes.tsx` and
  `WEB/src/draft/draft.css`: show each item's state (accepted, with who and when; rejected, dimmed), its comparison and
  differences, and its needs as contracts/ui.md items 1 to 3 say. Link a matched item to its record. No control yet. Run T014 and the M4 draft tests.

**Checkpoint**: US1 is demonstrable: the Draft tab shows state, comparison and needs, and writes nothing.

---

## Phase 4: User Story 2 - Accept items into the threat model (Priority: P1)

**Goal**: a person accepts one or several undecided items; the server creates the records from the stored draft in one
transaction; provenance is written with them; nothing else changes.

**Independent Test**: with a draft of a dozen elements, a few assets and assumptions, accept a subset that has its
dependencies: the model holds exactly those records, valid, with elements unplaced; nothing else changed.

### Tests (write first)

- [X] T019 [P] [US2] `CORE/test/review.test.ts` (extended): `DraftDecision` for `action: 'accept'` (`draft_id` a UUID; `items` 1
  to 70, each `{ id: uuid, seen: 'new' | 'matched' | 'several' }`, strict, no repeated id) and `DecisionResult` (`draft`,
  `created`, `changed`, `unlinked_holders`).
- [X] T020 [P] [US2] `API/test/review/decide.test.ts`: accepting a new element, asset and assumption creates them with the
  stored name, flags, boundary and endpoints (an element has `layout` null) and an asset's holders; boundaries, nodes and
  flows in one request go in whatever the order of the request (a flow with both endpoints, a member with its boundary);
  accepting a flow whose endpoint matches exactly one existing element attaches it to that element with no decision on the
  endpoint; a matched element gets only its unassessed flags (a value already set is never changed, nor its name, boundary or
  endpoints), a matched asset only the holders it lacked, a matched assumption nothing, each recorded with outcome
  `matched`; an asset's holders that are not in the model or the request are not linked and are listed in
  `unlinked_holders`; the accepted items read `accepted`, with the account and time; `created` and `changed` count right;
  0 rows are written to `threats` or `mitigations`, no element, asset or assumption outside the accept changes (SC-001,
  SC-002); an accept still succeeds on a draft whose sources have changed (a source added since) and for an item that has a
  citation whose chunk was deleted, which is copied as "Source deleted" (FR-005).
- [X] T021 [P] [US2] `API/test/review/refusals.test.ts`, each row of the 400/404/409 table of contracts/http-api.md that applies to
  accept: a draft id that is not the current one, or no draft (`This draft was replaced or discarded`); an item id of
  another draft or threat model (404 `Draft item not found`); an item already accepted (`N of the items were already decided`);
  a `seen` that differs from the comparison now, including a match deleted after the page loaded (`N of the items are out of
  date; the threat model changed`); a flow whose endpoint is in neither the model nor the request, and a member whose boundary
  is not (`N items need elements that are not in the threat model`); the limit with "N more fit" for elements (1,000), assets
  and assumptions (200) counted before anything is written; an asset or assumption that would repeat one (409). After
  every refusal the threat model's elements, assets and assumptions are exactly as before, no message holds a name,
  statement or quote (SC-003, SC-006).
- [X] T022 [P] [US2] `API/test/review/concurrency.test.ts`: two connections accepting the same item at once create one record,
  and the second is refused `409`; an accept racing `DELETE …/draft`, and racing a new draft's commit (`draftCommit` of
  `API/src/extract-system/draft.ts` run in a transaction with a seeded job row), either creates its records whole or none,
  never deadlocks, and when the draft was replaced refuses as out of date (SC-003, SC-004).
- [X] T023 [P] [US2] `API/test/review/provenance.test.ts` (the write side): a created element has a `provenance` row with the
  item's rationale, `accepted_by` and `accepted_at`, and its citations copied as the draft keeps them (chunk id and span, never
  text); one more row for each proposed flag the new element keeps with the proposed value, each with that flag's citations
  and the item's rationale; a flag the accept edited, and one it cleared, has none (checked again in T032); a matched
  element has a row for each flag the accept filled in and no record-level row, and is not otherwise marked; a created
  asset and a created assumption have one row; a matched asset or assumption none; a citation whose chunk was deleted before the accept
  is copied with `chunk_id` null; no table of this feature holds any text of a chunk (SC-004).
- [X] T024 [P] [US2] `API/test/contract/v1/review.test.ts` (accept): the body's shapes and every status for accept; `DecisionResult`;
  the answer's `draft.review` shows the items accepted; one log line per request with `event: 'decision'`, the account, the
  action, the threat model and counts, and no text; auth is required; an unknown field is `400`. The test clears every provider variable (`LLM_*`, `EMBEDDING_*`) and starts no
  worker, so that it shows a review needs neither (FR-024, SC-009).
- [X] T025 [P] [US2] `WEB/src/draft/ReviewControls.test.tsx` and `WEB/src/pages/DraftTab.test.tsx` (extended): selecting items by click,
  shift-click and space; Accept is enabled only for undecided or rejected items whose needs are in the selection or
  resolved, with the reason in text when not; one click sends each item's `seen`; the status line says how many records were
  created and changed and names holders left unlinked; a `409` shows its message and reads the draft again; the replacement
  warning of contracts/ui.md item 8 shows when any decision has been made; a draft whose sources changed, or an item with a
  "Source deleted" citation, shows its warning and still has Accept enabled (FR-005).

### Implementation

- [X] T026 [US2] `CORE/src/schemas/review.ts`: `DraftDecision` (accept variant, discriminated on `action`) and `DecisionResult`.
  Run T019.
- [X] T027 [US2] `API/src/review/provenance.ts` (new): `writeProvenance(trx, { threatModelId, accountId, rows })` inserts
  `provenance` rows and copies the draft's `draft_citations` of the item (and of each flag) into `provenance_citations`, in
  batches. Used by `decide.ts` (here) and read by the route of T063, which is why it is its own file.
- [X] T028 [US2] `API/src/review/decide.ts` (new): `accept(db, threatModelId, accountId, body)` in one transaction, in the order
  of research #4 and the lock order above: refusals first (draft, items, `already decided`, `seen`), then the plan: draw
  the ids of what will be created, resolve references (research #5), count the limits (research #6), then write boundaries by
  depth, then nodes, then flows (as `API/src/exchange/import/write.ts` orders them) with `createElementIn`; assets with their
  holders, assumptions; a matched element is filled through `updateElementIn` with `properties.flags` merged so that only absent
  flags are added; then the provenance rows (T027) and the decision columns (`decision`, `decided_by`, `decided_at`,
  `outcome`, and the link of the kind) in one `UPDATE … FROM unnest`. Returns the counts and `unlinked_holders`. A violation
  of a database rule goes through `mapStorageError`. Run T020, T021, T022, T023.
- [X] T029 [US2] `API/src/v1/review.ts` (new): the operation `decideDraft` (`POST /threat-models/:id/draft/decisions`, 200, errors
  400, 404, 409), calling `accept`, then `readDraft` and `readReview` for the answer, then `logDecision`, which you add to `API/src/v1/write-log.ts` beside `logGeneration`: one line `{ event: 'decision',
  account_id, action, threat_model_id, items, created, changed }`, numbers and ids only. Register `reviewOperations` in
  `API/src/v1/operations.ts`. The operation count is now 50: update `API/test/contract/v1/auth.test.ts` and `validation.test.ts`
  (`toHaveLength(49)` → 50), list the operation id in `API/test/contract/v1/openapi.test.ts`, and regenerate `API/openapi.json`
  with `pnpm --filter @scrylux/api openapi`. Run T024.
- [X] T030 [US2] `WEB/src/api/queries.ts`: `useDecideDraft(threatModelId)`, which on settle invalidates `keys.draft`,
  `keys.extraction`, `keys.elements`, `keys.assets`, `keys.assumptions` and `keys.provenance` (add the three keys; their queries come
  in T058 and T065). `WEB/src/draft/ReviewControls.tsx` (new): the selection toolbar with **Accept** and a count.
  `DraftList.tsx` and `DraftDiagram.tsx`: multi-selection (click, shift-click, space) that the toolbar acts on.
  `WEB/src/pages/DraftTab.tsx`: the controls, the status line, the refusal messages, the replacement warning. Run T025.

**Checkpoint**: US2 works end to end for a selection without edits. `pnpm --filter @scrylux/api test` and
`pnpm --filter @scrylux/web test` pass.

---

## Phase 5: User Story 3 - Edit an item while accepting it (Priority: P1)

**Goal**: a person changes name, flags, boundary, endpoints, description, holders or statement in the same step as the accept,
under the rules every record obeys, and the draft keeps the model's values.

**Independent Test**: accept an element with a changed name, a cleared flag, a different boundary and, for a flow, different
endpoints, an asset with another description and an assumption with another statement; the created records have the edits
and the draft items do not; a rule-breaking edit is refused with nothing created.

### Tests (write first)

- [X] T031 [P] [US3] `CORE/test/review.test.ts` (extended): `edits` is strict with the optional fields `name` (1 to 200,
  trimmed), `flags` (`{ flag: boolean | null }`), `boundary` (a reference or null), `source`, `target` (a reference),
  `description`, `statement`, `holders` (references, at most 1,000); a **reference** is `{ item: uuid }` or `{ element: uuid }`
  and nothing else; an unknown key is refused.
- [X] T032 [P] [US3] `API/test/review/edits.test.ts`: each edit applies (name, set, change and clear a flag, boundary to a proposed
  boundary being accepted, to an element of the model, to none; a flow's endpoints to a proposed item and to an element
  of the model; an asset's description and holders; an assumption's statement); the created record has the edit and the
  draft item still shows the model's original values; an edit that clears a boundary lets a member be accepted without its
  boundary (FR-009); a flag the accept edited or cleared has no provenance row while the record's row stays (T023's rule);
  every refusal creates nothing: a field the kind does not take (`statement` on an element, `source` on a process), a flag that
  does not apply to the type, a boundary that would nest in itself, a flow from an element to itself, a flow endpoint that is
  not a process, data store or external entity, a name over 200 characters, a reference to an element of another threat
  model, a holder that is a flow or a boundary, an edit that would repeat an existing asset name; `type`, `rationale` and
  `citations` are not editable (the schema refuses them) (FR-013).
- [X] T033 [P] [US3] `WEB/src/draft/AcceptEditor.test.tsx`: the item's values are filled in; one yes / no / not-assessed control per
  flag the type allows, each proposed value marked; boundary and endpoint choices list the draft's items being accepted and the
  model's elements; rationale, citations and kind are shown and not editable; **Accept** sends only the fields that changed;
  **Cancel** sends nothing; the API's message is shown beside the field it concerns.

### Implementation

- [X] T034 [US3] `CORE/src/schemas/review.ts`: `edits` and the reference schema, added to the accept items. Run T031.
- [X] T035 [US3] `API/src/review/decide.ts`: apply `edits` to the plan before anything is written: reject a field the item's kind
  does not take (400, `This edit does not apply to this kind of item`), resolve references (`{ item }` as research #5, `{ element }`
  as given), merge `flags` (null clears), and write the edited values; the draft item is never updated except for its decision
  columns; a flag whose final value differs from the proposed one, or is cleared, gets no provenance row. The element rules,
  the database's keys and triggers are the judges (research #5). Run T032.
- [X] T036 [US3] `WEB/src/draft/AcceptEditor.tsx` (new): the form of contracts/ui.md item 5, reusing `FlagRadioGroup` of
  `WEB/src/diagram/FlagRadioGroup.tsx`; "Accept…" in `ItemPanel.tsx` opens it; `useDecideDraft` sends the edits. Run T033.

**Checkpoint**: US3 works. A decision with and without edits passes.

---

## Phase 6: User Story 4 - Reject items, and change one's mind (Priority: P1)

**Goal**: reject, return to undecided, and an accepted item whose record is deleted reads undecided again; decisions go with
the draft and records stay.

**Independent Test**: reject some items, return one, accept it; delete an accepted element; replace and discard the draft.

### Tests (write first)

- [X] T037 [P] [US4] `CORE/test/review.test.ts` (extended): `DraftDecision` adds `reject` and `undecide`, whose items are `{ id }`
  only; `seen` and `edits` on them are refused.
- [X] T038 [P] [US4] `API/test/review/states.test.ts`: reject writes only the decision columns (SC-001: rows of `elements`,
  `assets`, `assumptions`, `threats`, `mitigations` unchanged); a rejected item reads `rejected` with who and when and can be
  returned to undecided, then accepted, or accepted straight from rejected; reject and undecide are refused whole when any
  item is not undecided (reject) or not rejected (undecide); a created record deleted elsewhere makes its item read
  `undecided` and a new accept creates a fresh record; a matched accept stays `accepted` after its element is deleted;
  replacing the draft (a new commit) and `DELETE …/draft` drop the decisions and keep the records and their provenance;
  an undecided element that depends on a rejected one still shows its needs (FR-014, FR-016).
- [X] T039 [P] [US4] `API/test/contract/v1/review.test.ts` (extended): reject and undecide statuses and one log line each with
  counts and no text.
- [X] T040 [P] [US4] `WEB/src/draft/ReviewControls.test.tsx` (extended): **Reject** and **Return to undecided**, enabled only where they
  apply; a rejected item is dimmed and still selectable; a refusal reads the draft again.

### Implementation

- [X] T041 [US4] `CORE/src/schemas/review.ts`: the two variants. Run T037.
- [X] T042 [US4] `API/src/review/decide.ts`: `reject` and `undecide` in the same transaction and lock order, writing the decision
  columns only; `API/src/v1/review.ts`: dispatch on `action`; both log through `logDecision`. Run T038, T039.
- [X] T043 [US4] `WEB/src/draft/ReviewControls.tsx`: the two buttons. Run T040.

**Checkpoint**: the decision route is complete: accept, edit, reject, return to undecided.

---

## Phase 7: User Story 5 - Read, create, edit and delete assets and assumptions (Priority: P1)

**Goal**: assets and assumptions are ordinary records of the threat model with a tab, and they travel in the Scrylux file
(version 2) and the reports.

**Independent Test**: accept an asset and an assumption and create one of each by hand; open the Assets tab; edit and delete;
delete a holder element; export a Scrylux file and a report and import the file back.

### Tests (write first)

- [X] T044 [P] [US5] `API/test/contract/v1/assets.test.ts`: the four operations of contracts/http-api.md, every status: list oldest
  first with ties by id; create with and without holders; a name that repeats another's ignoring case and whitespace
  `409 An asset with this name already exists`; a holder that is a flow or a boundary, or of another threat model `400`; the
  201st `400`; `PATCH` changes a field, replaces `holder_ids`, refuses an empty body and an unknown key; delete is `204` and
  removes the holder rows; deleting a holder element leaves the asset and drops that holder; the write log has one line with
  `type: asset` and ids only; auth is required.
- [X] T045 [P] [US5] `API/test/contract/v1/assumptions.test.ts`: the same for the four assumption operations (`409 This assumption
  already exists`, `400` at the 201st, `type: assumption` in the log).
- [X] T046 [P] [US5] `CORE/test/exchange/scrylux-file.test.ts` (extended) and `CORE/test/exchange/import-io.test.ts` (extended):
  version 2 has `assets` (`id`, `name`, `description`, `holder_ids`) and `assumptions` (`id`, `statement`), strict, always present;
  a version 1 file still parses, with no such keys, and a version 1 file that has them is refused; a version other than 1 or 2 is
  refused with `must be 1 or 2; this file is version N`; the OTM mark still requires `1` and keeps its message `must be 1`; `ImportModelSummary` gains `assets` and `assumptions` counts.
- [X] T047 [P] [US5] `API/test/exchange/scrylux-export.test.ts`, `scrylux-import.test.ts`, `check-plan.test.ts` (extended): export
  writes both lists sorted by name and by statement by code point (ties by id), `holder_ids` by the element's position, every
  key present, and the bytes of two exports of an unchanged model differ only in `exported_at`; the file holds no
  provenance, rationale, citation, draft or decision; import creates assets and assumptions with new ids and **no
  provenance**, whatever the file says; `checkPlan` refuses with a place in the file and no value: a holder that is not an
  element of the file or is a flow or a boundary, a name or statement repeated after trimming and ignoring case, more than
  200 of either; a version 1 file imports as before; the OTM export and the Threat Dragon import are unchanged and their plans
  carry empty lists; the import check and the import give the same counts; a file is parsed by its `format_version` (`API/src/exchange/import/parse.ts`), so
  a version 2 file and a version 1 file both parse and any other version is refused. Update the existing tests that the version
  changes, each for what it now says: `API/test/contract/v1/exchange.test.ts` (an export parses with `ScryluxFileV2`; the refusal of
  an unknown version expects the new message, for example version 3, since 2 is now readable), `API/test/exchange/fixtures.ts`
  (its file type allows version 2), and any other test of `grep -rln "format_version" API/test WEB/src WEB/e2e CORE/test` that fails
  because of the version; a fixture that is a valid version 1 file stays as it is, since version 1 is still read.
- [X] T048 [P] [US5] `API/test/report/model.test.ts`, `markdown.test.ts`, `html.test.ts`, `snapshot.test.ts` (extended): the snapshot
  reads assets (with holders) and assumptions in its one repeatable-read transaction; both reports gain **Assets** and
  **Assumptions** after the elements (and none when there are none), parsed with the real CommonMark and HTML parsers: a name,
  description and statement with markup, a link, a heading marker or a script stay text; holders appear with the element's
  reference and name; the contents line is unchanged, so the report of a model with no asset and no assumption is byte for byte what it was before
  (the committed `docs/threat-model/report.md` needs no change); a report holds no provenance; the diagram is unchanged.
- [X] T049 [P] [US5] `API/test/exchange/schema-current.test.ts` (extended), `API/test/dogfood/checks.test.ts` and `threat-model.test.ts`
  (extended): `docs/formats/scrylux-file-v1.schema.json` is unchanged and `scrylux-file-v2.schema.json` equals what
  `scryluxFileSchema(2)` generates; the dogfood check validates against the v2 schema, compares `assets` and `assumptions`
  among the round-tripped parts, and finds the committed model at version 2.
- [X] T050 [P] [US5] `WEB/src/pages/AssetsTab.test.tsx`: both lists with their empty states; add, edit and delete an asset and an
  assumption through the forms, the API's messages beside the fields (a repeated name, a full section); holders shown by name
  and linking to the diagram with that element selected; every text rendered as text.

### Implementation

- [X] T051 [US5] `API/src/v1/assets.ts` and `API/src/v1/assumptions.ts` (new, one file per resource): the eight operations
  (`listAssets`, `createAsset`, `updateAsset`, `deleteAsset`, and the four of assumptions), with `recordType: 'asset'` and
  `'assumption'` (add both to `RecordType` in `API/src/v1/write-log.ts`) so the router's write log covers them; holders written
  through `asset_holders` in the request's transaction under `lockModel`; register both in `API/src/v1/operations.ts`. The
  operation count is now 58: update the two counts and `openapi.test.ts`, and regenerate `API/openapi.json` as in T029. Run T044,
  T045.
- [X] T052 [US5] `CORE/src/exchange/formats.ts` and `scrylux-file.ts`: `SCRYLUX_FILE_VERSION = 2` and the readable versions;
  `ScryluxFileV2` (v1's strict schema plus the two lists), `ScryluxFileV1` kept; `SCRYLUX_FORMAT_VERSION` stays 1 for the OTM mark;
  `formatVersionMessage` takes the list of versions to name (the file: 1 and 2; the OTM mark: 1); `CORE/src/exchange/import-io.ts`:
  the two counts. Run T046.
- [X] T053 [US5] `API/src/snapshot.ts`: read assets with holder ids and assumptions, ordered by name and statement. In
  `API/src/exchange/scrylux-export.ts`, write version 2. In `API/src/exchange/import/scrylux.ts`, `plan.ts` and `write.ts`:
  plan, check (as T047) and insert them after the elements in the same transaction, in chunks, with no provenance; `otm.ts` and
  `threat-dragon.ts` plans carry empty lists. In `API/src/exchange/import/parse.ts`, parse a Scrylux file by its `format_version`
  (1 with `ScryluxFileV1`, 2 with `ScryluxFileV2`, anything else refused with the version message) and give `planScrylux` both
  shapes, version 1 planned with empty lists. In `API/src/v1/exchange.ts`, the export operation's description names
  `scrylux-file-v2.schema.json` as the current schema and says that version 1 files are still read. Run T047.
- [X] T054 [US5] `API/src/report/model.ts`, `markdown.ts`, `html.ts`: the two sections, through the existing escapers only. Run T048.
- [X] T055 [US5] `API/src/exchange/schema.ts`: `scryluxFileSchema(version)` writes both `docs/formats/scrylux-file-v1.schema.json`
  (unchanged bytes) and `scrylux-file-v2.schema.json` (`$id` and title for version 2); run `pnpm --filter @scrylux/api formats`.
  `API/test/dogfood/checks.ts`: the published schema validator reads the v2 file; the compared parts gain `assets` and
  `assumptions`. Run T049 up to the committed model.
- [X] T056 [US5] Move the committed `docs/threat-model/threat-model.scrylux.json` to version 2: import it into a local Scrylux built
  from this branch and download it again (the documented way, `docs/threat-model/README.md` "Updating the model"), so that
  the file is exactly what Scrylux writes, with empty `assets` and `assumptions`; regenerate `report.md` the same way (it should come out byte for byte the same: the contents line is unchanged and a model with
  no asset or assumption adds no section). Change nothing else of the model here. This needs a running Scrylux (`docker compose`),
  which the agent's sandbox cannot start: the maintainer runs it, or it is run outside the sandbox, and the result is committed
  unchanged. Run T049 to the end.
- [X] T057 [US5] Move `docs/demo/notes-app.scrylux.json` to version 2 the same way as T056 (import it into the local build and download it
  again; add empty `assets` and `assumptions`; nothing else changes), and bring `API/test/demo/checks.ts`, `checks.test.ts` (its
  `valid()` fixture is typed `ExportedFile` and has `format_version: 1`) and `docs/demo/README.md` (the link to the published
  schema) to version 2, so that the demo checks validate against `scrylux-file-v2.schema.json` and round-trip the file as the
  dogfood checks do. `scripts/release/smoke.ts` only imports the demo file, which version 1 and version 2 both satisfy, so it and its
  test need no change. Same running-Scrylux requirement as T056. Run `API/test/demo`.
- [X] T058 [US5] `WEB/src/pages/AssetsTab.tsx` (new), the route in `WEB/src/App.tsx`, the tab "Assets and assumptions" after Diagram in
  `WEB/src/pages/ThreatModelPage.tsx`, and in `WEB/src/api/queries.ts` the queries and mutations (`useAssets`, `useCreateAsset`,
  `useUpdateAsset`, `useDeleteAsset` and the four of assumptions) behind `keys.assets` and `keys.assumptions`. Delete uses the
  app's `ConfirmDialog`. The import preview in `WEB/src/components/ImportNotes.tsx` or the component that shows its counts
  gains the two numbers (find it with `grep -rn "mitigations" WEB/src/components/Import*`). Run T050.

**Checkpoint**: assets and assumptions are manageable, exportable and importable. A report and a file carry them.

---

## Phase 8: User Story 6 - Know later where an accepted item came from (Priority: P2)

**Goal**: any reader sees which records came from AI and why, after the draft is gone; a person's edit of a flag removes that
flag's mark.

**Independent Test**: accept an element and an asset, discard the draft; both still show the AI mark, rationale and
citations (or "Source deleted").

### Tests (write first)

- [X] T059 [P] [US6] `CORE/test/review.test.ts` (extended): `ProvenanceRecord` as data-model.md says (`target`, `flag`, `rationale`,
  `accepted_by`, `accepted_at`, `citations`), strict.
- [X] T060 [P] [US6] `API/test/review/provenance-read.test.ts`: after an accept and a discard of the draft, `GET …/provenance` lists the
  rows, oldest first with ties by id, each with the citations as the draft's `CitationRecord` (source name, location, the quote
  read from the chunk by its span); deleting a source gives `chunk: null` for its citations ("Source deleted") and keeps the
  row, and no text of a source is stored; a hand-made and an imported record have no row; a client cannot set provenance on any
  record route (a strict body refuses the key); **a person's later change or removal of a flag drops only that flag's row**, through
  `PATCH /elements/{id}` and through `POST …/elements/batch`; a flag written again with the same value keeps its row; deleting the
  element deletes its rows; a threat model that does not exist is `404`; auth is required.
- [X] T061 [P] [US6] `WEB/src/components/ProvenanceNotice.test.tsx` and `WEB/src/diagram/PropertiesPanel.test.tsx` (extended): the notice for a
  record, a flag set by an accept, and a deleted source ("Source deleted"); an element only some of whose flags came from AI is
  not shown as AI's; a hand-drawn element shows nothing; every text rendered as text; the notice is on the Assets tab too.

### Implementation

- [X] T062 [US6] `CORE/src/schemas/review.ts`: `ProvenanceRecord`. Run T059.
- [X] T063 [US6] `API/src/review/provenance.ts`: `readProvenance(db, threatModelId)` with the citations read from the chunks by span,
  as `readDraft` reads the draft's. `API/src/v1/review.ts`: `getProvenance` (`GET /threat-models/:id/provenance`, 200, errors 400,
  404). The operation count is now 59: update the two counts to 59 and `openapi.test.ts`, and regenerate `API/openapi.json` as in T029.
  Run the read parts of T060.
- [X] T064 [US6] `API/src/v1/element-writes.ts`: in `updateElementIn`, after the update, delete the `provenance` rows of the element
  whose `flag` is no longer present in the new `properties.flags` or whose value changed, in the same transaction (research #8).
  Run T060.
- [X] T065 [US6] `WEB/src/api/queries.ts`: `useProvenance(threatModelId)` behind `keys.provenance`. `WEB/src/components/ProvenanceNotice.tsx`
  (new): "Proposed by AI, accepted by <name> on <date>", the rationale and the citations with `CitationView` of `WEB/src/draft/`, "Open in
  source", "Source deleted"; used by `WEB/src/diagram/PropertiesPanel.tsx` (the element, and a mark with detail on each flag an accept
  set) and by `AssetsTab.tsx`. Run T061.

**Checkpoint**: provenance is readable and removable by a person's edit.

---

## Phase 9: User Story 7 - Scrylux's own threat model stays in step (Priority: P2)

**Goal**: the Threat Model section and `docs/threat-model/` describe what this milestone adds (FR-027), in the same change.

**Independent Test**: read the section and the model; the threat model's checks pass.

- [X] T066 [US7] `.specify/memory/constitution.md` 1.19.0, a MINOR, with its Sync Impact Report (keep the report's style: version change,
  rationale, modified sections, previous change line for 1.17.0 → 1.18.0): the Threat Model section's assets (accepted records,
  the new records and provenance as AI text derived from confidential documents, kept until the record goes, and that the draft's
  tables now point at what an accept created); trust boundaries (ten operations as entry points: `POST …/draft/decisions`, `GET
  …/provenance`, the eight record operations); the Tampering "AI-proposed edits" item as mitigated now (the human accept, the server
  building records from the stored draft, one transaction under the model's lock, a mark no client can set); the Spoofing item that says
  a reviewer reads a draft "in Milestone 5" as in place; Information Disclosure for the file and the reports now carrying AI-derived
  text as ordinary records and for provenance's spans; Elevation of Privilege's justified widening (FR-026) and what is not widened;
  the remaining risks (a reviewer accepting without reading; a model proposing what the documents do not say, which the reviewer
  sees as a quote). Also move "the accepted parts of a draft" from the planned assets to the current ones, and update Principle VI's
  sentence about the Draft tab only if it is now wrong.
- [X] T067 [US7] `docs/threat-model/`: rebuild in a running Scrylux (Updating the model, steps 1 and onward): the draft's decisions and the
  records are in the existing `Drafts` store and the database; add the two data flows (decisions, provenance reads), the threats the
  rules derive for them, each decided by the README's table with the evidence named in its mitigation, and the model-wide threats
  of research #14; save the two files unchanged as Scrylux writes them (version 2). This needs a running Scrylux, as in T056: the maintainer runs it
  or it is run outside the sandbox. **Do not write an approval.** In
  `docs/threat-model/README.md` update the description of what it covers, and leave the approval sentence for the maintainer to
  extend after they read the additions; say so in the pull request description. Run `API/test/dogfood`.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [X] T068 [P] Check that the operation count is 59 in `API/test/contract/v1/auth.test.ts` and `validation.test.ts`, that
  `API/test/contract/v1/openapi.test.ts` lists all ten new operation ids, and that `pnpm --filter @scrylux/api openapi` leaves
  `API/openapi.json` unchanged (each of T029, T051 and T063 has already updated them).
- [X] T069 [P] `API.md`: the new operations, the decision route's body and refusals, the file's version 2 and that version 1 is still read
  (FR-028); `docs/formats/scrylux-file.md`: the version 2 section and the table of versions; `docs/formats/otm.md` and
  `docs/formats/threat-dragon.md`: assets and assumptions are not carried; `CHANGELOG.md`: the milestone under Unreleased.
- [X] T070 [P] `plan.md` and `docs/roadmap.md`: Phase 3 Milestone 5 as built (✅), as Milestone 4's entry is written: what was decided
  (assets and assumptions as records, the file's version 2, provenance, no eval gate because no prompt changed).
- [X] T071 `API/test/review/canary.test.ts` (guard): a recognizable fake name, statement, rationale and quote seeded in a draft, run through
  accept, accept with edits, reject, undecide, every refusal, asset and assumption create, edit and delete, and the provenance read,
  appears in 0 log lines and 0 error answers, and in no Scrylux file, OTM file or report (SC-006); the existing
  `API/test/worker/canary.test.ts` still passes.
- [X] T072 `API/test/review/scale.test.ts` (guard): a whole draft (40 elements, 15 assets, 15 assumptions; build it in SQL) accepted into a
  threat model of 960 elements in under 2 s; reading a draft with its review for a threat model of 1,000 elements in under 300 ms
  (SC-005). If it is slower, find the cost with `EXPLAIN ANALYZE` and fix the statement, not the number.
- [X] T073 `WEB/e2e/review.spec.ts` (guard) and `WEB/playwright.config.ts`: with a seeded draft (through the e2e fixtures' way of reaching
  the database, as `draft.spec.ts` does; if it cannot, run an extraction against the stand-in provider as `draft.spec.ts` does and
  put the spec in the `draft` project: extend `WORKER_SPECS` and the project's `testMatch`), open the Draft tab, accept a subset with a
  flow and its endpoints together, edit and accept one element and one asset, reject one item, see the diagram editor show exactly
  the accepted elements with the provenance notice, see the Assets tab, download a Scrylux file and a Markdown report and find the
  records in them and nothing of the draft, import the file back (SC-007, SC-008).
- [X] T074 Run the whole suite: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e` (outside the agent's sandbox where
  the sandbox blocks pnpm, as Milestone 4 recorded), `docker build --pull .`, and `scripts/check-db-upgrade.sh`. Everything of v0.1 and
  Milestones 2 to 4 passes with no worker and no provider (SC-009). Record anything not run, and why, in `SPEC/pr-description.md`.
- [X] T075 `SPEC/pr-description.md`: the PR description, as Milestone 4's: what changed; the security implications (Development Workflow:
  ten routes, a new kind of AI-derived record, provenance, a new file version); the broadening of FR-026; that the draft's tables now
  reference the records an accept created; the file's version 2 and the committed threat model's move to version 2; that
  `docs/threat-model/`'s approval is the maintainer's; the planning clarifications; the constitution amendment; and what was measured, including the line counts that justify `ReviewControls.tsx` and `AcceptEditor.tsx` as files of their own
  (Principle III: `DraftTab.tsx` was 208 lines before this change).
- [X] T076 Walk quickstart §2 by hand against a real draft and record the result under "Verification" in `SPEC/pr-description.md`.
  **Done by the maintainer, not the agent**; `pr-description.md` records what they reported.

---

## Dependencies and execution order

- **Phase 1** → **Phase 2** → the stories. T001 first. T002, T003 are independent.
- **Phase 2**: T004, T005, T006 in parallel and first (see them fail); T007 → T008; T009 and T010 independent of the migration.
- **US1** (T011–T018) needs Phase 2 and T003. T011–T014 in parallel; T015 → T016 → T017; T018 after T015.
- **US2** (T019–T030) needs US1's T016 (`compare.ts`). Tests T019–T025 in parallel; T026 → T027 → T028 → T029 → T030.
- **US3** (T031–T036) extends US2's schema, `decide.ts` and `ReviewControls`; **US4** (T037–T043) does the same. US3 and US4 touch the
  same three files, so run them one after the other (US3, then US4), not at once.
- **US5** (T044–T058) needs Phase 2 and US2's route (T029), because its operation-count updates build on T029's, and can then run beside US3 and US4: its files are different (`v1/assets.ts`, `v1/assumptions.ts`, the
  exchange, the report, `AssetsTab`). T051 and T052 are independent; T053 needs T052 and T051's tables only; T055 needs T052; T056 and
  T057 need T053 and T055 (both need a running Scrylux).
- **US6** (T059–T065) needs US2 (the writes) and US5's `AssetsTab` (T058) for the notice's second place.
- **US7** (T066–T067) needs everything the section describes to be built (read last), and T056.
- **Polish** after the stories; T074 last but T075 and T076.

### Parallel examples

```text
After Phase 2:        T011 T012 T013 T014   (US1 tests)       T044 T045 T046 T047 T048 T049 T050   (US5 tests)
Within US2:           T019 T020 T021 T022 T023 T024 T025       (all tests, before T026)
Operation counts:     T029 → 50, T051 → 58, T063 → 59 (in that order, so every checkpoint's suite is green)
US3/US4 with US5:     one engineer on T031–T043 (decide.ts and ReviewControls), another on T051–T058 (records and files)
Polish:               T068 T069 T070
```

## Implementation strategy

- **MVP**: US1 + US2 (T001–T030): a reviewer sees the draft against the model and accepts a selection into the threat model, with
  provenance written. That is the milestone's reason to exist, and it can be demonstrated and merged to `feat/phase-3` alone.
  Without US5 an accepted asset or assumption is created but cannot be read or edited, so **ship US2 and US5 together**.
- **Increment 2**: US3 and US4 (edit and reject), then US5.
- **Increment 3**: US6 and US7, then the polish phase.
- After every story: its tests green, `pnpm typecheck && pnpm lint` clean, and nothing of an earlier milestone broken.

## Phase 11: Convergence

- [X] T077 Link an item that matched a record to that record on the Draft tab: `WEB/src/draft/ItemPanel.tsx` (and `draft-items.ts` if the label needs it) use `review.matched_id`, which the API already returns and the web app never reads; an element links to `/threat-models/{id}/diagram?element={matched_id}` (as the Assets tab links a holder), an asset or an assumption to the Assets tab; add the test first in `ItemPanel`'s or `DraftTab`'s test, and check that a `several` or `new` item shows no link per contracts/ui.md item 2 and T018 ("Link a matched item to its record") (partial)
- [X] T078 Add a test that holds keyboard operation of the review per FR-025 and contracts/ui.md item 4: in `WEB/src/pages/DraftTab.test.tsx`, with `userEvent.keyboard`/`tab` only, choose two items by their checkboxes, accept them, then open **Accept…** on another and reject one, with no pointer events; fix whatever the test shows is not reachable by keyboard (a diagram node chosen without a click, if it is not) (partial)
