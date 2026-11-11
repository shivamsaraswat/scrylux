# Implementation Plan: Review UI

**Branch**: not yet created (spec directory `phase-3/milestone-5-review-ui`; work is on `feat/phase-3`; the setup script could not
run in the agent's sandbox, so this plan was written by hand from the template) | **Date**: 2026-11-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/phase-3/milestone-5-review-ui/spec.md`

## Summary

Phase 3 / Milestone 5 turns the read-only draft of Milestone 4 into something a person decides on. The Draft tab compares every
proposed item with the threat model as it stands and lets a signed-in person accept, edit-and-accept, reject, or return an item to
undecided. One new route, `POST /threat-models/{id}/draft/decisions`, does all three. An accept names item ids and optional edits and
nothing else: the server builds each record from the draft it holds, in one transaction under the threat model's lock, so an element,
asset or assumption can only enter the model through a human decision, and no client can set provenance (Principle VI).

Because the spec accepts assets and assumptions, they become records of the threat model: three tables (`assets`, `asset_holders`,
`assumptions`), eight operations to read, create, edit and delete them, a tab to manage them, and a place in the Scrylux file (version 2,
version 1 still read) and in the reports. Provenance is a separate pair of tables (`provenance`, `provenance_citations`) that copies a
draft item's rationale and citation spans, one row for a created record and one for each flag an accept set, and cascades away with the
record. One read route, `GET /threat-models/{id}/provenance`, serves it. No existing record shape (`ElementRecord`, the threat model's
other records) changes.

At planning the plan settled these things and recorded them in the spec (Clarifications, session 2026-11-10, during planning):

- **A match counts as "in the model" for dependencies**: a flow whose endpoint matches exactly one existing element attaches to it with no
  decision on that endpoint (FR-009; research #5).
- **A decision request is all or nothing, and an item already decided refuses it** (a double click gets a 409, not a second element)
  (FR-010, FR-011; research #4).
- **The comparison is checked at decision time through a `seen` value** the page sends per item (FR-011; research #4).
- **Comparison is done in SQL** with the same expression as the unique indexes, so the page and the database agree on "same name"
  (FR-002, FR-021; research #3).
- **A flag has no rationale of its own** (Milestone 4 gave a flag citations only), so a flag's provenance keeps its item's rationale
  (FR-017; research #8).
- **The Scrylux file moves to version 2** and still reads version 1; the OTM export's own mark stays at 1, because the OTM export does not
  change (FR-023; research #10).
- **Assets and assumptions have their own tab**, not a panel of the diagram (FR-019; research #12).

**1. Database** (`packages/db/migrations/019_review.sql`): `assets`, `asset_holders`, `assumptions`, `provenance`,
`provenance_citations`, and the decision columns of `draft_items` ([data-model.md](./data-model.md)).

**2. Shared schemas** (`packages/core`): `DraftDecision`, `DecisionResult`, `ItemReview` (a `review` map on `DraftRecord`),
`AssetRecord`/`AssetInput`/`AssetUpdate`, the assumption equivalents, `ProvenanceRecord`; `MAX_ASSETS`, `MAX_ASSUMPTIONS`; the Scrylux
file's version 2 (`schemas/review.ts`, `schemas/asset.ts`, changes to `schemas/draft.ts` and `exchange/`).

**3. Review module** (`apps/api/src/review/`): `compare.ts` (what a draft item is against the model now, and what it needs),
`decide.ts` (accept, reject, undecide), `provenance.ts` (write and read) ([contracts/http-api.md](./contracts/http-api.md); research #1–#9).

**4. The API**: ten operations in three route files (`v1/review.ts`, `v1/assets.ts`, `v1/assumptions.ts`); `updateElementIn` drops the
provenance of a flag a person changes; `GET …/draft` attaches each item's decision and comparison (`compare.ts` reads the decision
columns itself, so `readDraft` is unchanged).

**5. Exchange and reports**: the snapshot reads assets and assumptions; the Scrylux file v2 and its import; two report sections
([contracts/file-format.md](./contracts/file-format.md); research #10, #11).

**6. The web app**: the review on the Draft tab, an accept form, the Assets tab, a provenance notice shown on elements and records, the
warning before a new extraction ([contracts/ui.md](./contracts/ui.md); research #12).

**7. Docs, governance and the threat model**: `API.md`, `docs/formats/`, `CHANGELOG.md`, plan.md and `docs/roadmap.md` (M5 as built),
constitution 1.19.0 (the Threat Model section), `docs/threat-model/` rebuilt (research #14).

## Technical Context

**Language/Version**: TypeScript 6.0.x, strict, on Node 22.13 or later. SQL for the migration.

**Primary Dependencies**: none added (research #15). zod 4.6, Kysely, React 19 with React Router and TanStack Query, React Flow 12, the
existing `@scrylux/core` and `@scrylux/db`.

**Storage**: PostgreSQL 16 with pgvector. One migration: five tables, three triggers (two limits and the holder check), seven columns. Per threat
model: at most 200 assets and 200 assumptions (constants), each asset with at most a few holders.

**Testing**:

- **Vitest** with the Postgres service container: `packages/db/test/review-schema.test.ts`, `packages/core/test/`,
  `apps/api/test/review/` (compare, decide, dependencies, concurrency, limits, provenance), `apps/api/test/contract/v1/` (decisions,
  assets, assumptions, provenance), the exchange and report tests extended, the canary extended, and web unit tests.
- **Concurrency tests** use two connections that decide the same item at once (SC-003), and a decision racing a discard or a new draft
  (SC-004).
- **One Playwright spec** (`apps/web/e2e/review.spec.ts`) in the existing `draft` project, which already starts a worker and a stand-in
  provider. The rest of the browser suite is unchanged (SC-009).
- **No secret, no provider network** (FR-029). A review reads a draft that is already stored, so the tests seed a draft in SQL and need
  no worker. §3 of [quickstart.md](./quickstart.md) is by hand.

**Target Platform**: the published image on Node 22, the same two processes. No new entry point. The worker does not change.

**Project Type**: the existing web service (`apps/api`, `apps/web`) and its packages.

**Performance Goals**:

- A decision request for a whole draft (40 elements, 15 assets, 15 assumptions) under 2 s on the CI host, at any threat model size up to
  its limits (SC-005): a handful of statements, batched, and one lock.
- Reading a draft with its review under 300 ms for a threat model of 1,000 elements: the comparison is three joined queries.

**Constraints**:

- Every write to elements takes the threat model's lock first, then the draft's (research #4). The worker's draft commit never takes the
  model lock, so the two cannot deadlock.
- A request carries ids and edits only; the server reads every value from the stored draft (FR-007).
- Provenance is written only inside the accept transaction and is never settable by a client (FR-017, FR-021).
- No draft text in a log line or an error answer (SC-006). Error messages are fixed text; counts are numbers.
- Every v0.1 and Milestone 2 to 4 flow works with no worker and no provider (SC-009, FR-024).

**Scale/Scope**:

- About 6 new source files in `apps/api/src`: `review/compare.ts`, `review/decide.ts`, `review/provenance.ts`, `v1/review.ts`,
  `v1/assets.ts`, `v1/assumptions.ts`. About 8 changed: `v1/extraction.ts`, `v1/element-writes.ts`, `v1/errors.ts`,
  `v1/write-log.ts`, `v1/operations.ts`, `v1/openapi.ts` (registration only), `snapshot.ts`, `exchange/scrylux-export.ts`,
  `exchange/import/{scrylux,plan,write}.ts`, `report/{model,markdown,html}.ts`.
- One migration and its types. In `packages/core`: `schemas/review.ts`, `schemas/asset.ts` (both record kinds), changes to
  `schemas/draft.ts`, `exchange/scrylux-file.ts`, `exchange/formats.ts`.
- In `apps/web`: `pages/AssetsTab.tsx`, `draft/ReviewControls.tsx`, `draft/AcceptEditor.tsx`, `components/ProvenanceNotice.tsx`, with
  changes to `DraftTab.tsx`, `DraftList.tsx`, `ItemPanel.tsx`, `DraftDiagram.tsx`, `PropertiesPanel.tsx`, `ThreatModelPage.tsx`,
  `App.tsx` and `api/queries.ts`.
- About 14 test files, the docs, the constitution and the threat model. Principle III's count of files is in research #15.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|---|---|---|
| **I. Secure coding** | Parameterized SQL only; input validated; secrets never logged; consistent errors; auth on every route. | ✅ All writes go through Kysely or parameterized `sql` templates; the comparison joins on a normalised name expression, never built from input. The decision body is a strict zod schema with ids as UUIDs; edits are checked by the element and record schemas and the database rules. Every error is fixed `{ error }` text; no draft text in one. The ten operations sit behind the existing `/api/v1` authentication. No new secret. |
| **II. Test-first** | A failing test before each behavior; suite green; eval gate. | ✅ Every FR maps to a test in [quickstart §1](./quickstart.md#1-automated-suites), written first. No prompt, provider adapter or extraction pipeline changes (FR-029), so the eval gate of Milestone 7 does not apply. One failing test per behavior at the module's public boundary; no helper exported only to be tested. |
| **III. Simplicity / YAGNI** | Least code; no new file without a reason; no export for a test; nothing the spec does not ask for. | ✅ with a note. The milestone is large because the spec adds two record kinds. **Not added**: threat generation (Milestone 6), a vector or fuzzy match, rejection memory across drafts, roles, OTM assets, an undo for an accept, a bulk "accept everything" shortcut beyond multi-select, any setting. **Files**: each new source file has a reason in [research #15](./research.md#15-principle-iii-the-files-and-what-is-not-built). **Dependencies**: none. |
| **IV. Maintainability** | Env-only config; stdout logs without payloads; forward-only migrations; stateless; data files. | ✅ No new variable: the limits are constants kept equal to the triggers by a test, as 013 does. One forward-only migration. Log lines hold ids and counts. Both processes stay stateless. No prompt changes, so no data file. |
| **V. Least privilege / threat-aware** | Threat Model updated in the same change; broader grants called out. | ✅ **The section changes (FR-027)**: accepted draft content and the new records as assets; ten operations as entry points; the Tampering "AI-proposed edits" item made current; the Spoofing item that names Milestone 5; the report and file as carriers of AI-derived text; research #14. Constitution 1.19.0 (MINOR). `docs/threat-model/` rebuilt, **and the maintainer's approval of its additions is theirs to give**: the plan does not mark them approved. **Called out as broadening (FR-026)**: any signed-in account can accept AI-proposed content into any threat model and manage its assets and assumptions, which it could already do for elements. |
| **VI. AI output is a draft** | Provenance; human accept; draft and accepted distinguishable; validated; escaped. | ✅ This milestone is the human accept. Only the decision route creates AI-proposed records, from the stored draft, with a provenance row that outlives the draft. Edits are validated by the same schemas as any write and cannot change kind, rationale or citations. Every text, including provenance and the new records, is rendered as text. |

**Post-design re-check (after Phase 1)**: still passing.

- The design adds ten operations, five tables and seven columns. Each is in the threat model update (research #14).
- The contracts return no draft text outside `DraftRecord`, `ProvenanceRecord` and the two record kinds. A quote's text is never stored.
- The PR must call out:
  - the broadening of FR-026;
  - that the draft's tables now reference the records an accept created, where Milestone 4 kept them wholly apart (research #1);
  - the Scrylux file's version 2 and that version 1 is still read (research #10);
  - that exports and reports now carry AI-derived text as ordinary records, with no provenance (research #11);
  - the planning clarifications above.

## Project Structure

### Documentation (this feature)

```text
specs/phase-3/milestone-5-review-ui/
├── plan.md              # This file
├── research.md          # Phase 0: decisions 1–16
├── data-model.md        # Phase 1: migration 019, the records, transitions
├── quickstart.md        # Phase 1: automated suites, by-hand run
├── contracts/
│   ├── http-api.md      # the ten operations and the change to GET /draft
│   ├── file-format.md   # the Scrylux file version 2, the import, the two report sections
│   └── ui.md            # the Draft tab's review, the Assets tab, the provenance notice
├── checklists/
│   └── requirements.md  # spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
packages/db/
├── migrations/019_review.sql         # new: five tables, the draft_items decision columns, limit and holder triggers
└── src/schema.ts                     # + the new tables' types and the new draft_items columns

packages/core/src/
├── schemas/review.ts                 # new: DraftDecision, DecisionResult, ItemReview, ProvenanceRecord
├── schemas/asset.ts                  # new: AssetRecord/Input/Update, AssumptionRecord/Input/Update, MAX_ASSETS, MAX_ASSUMPTIONS
├── schemas/draft.ts                  # DraftRecord + review
├── exchange/scrylux-file.ts          # version 2 (assets, assumptions); version 1 still parsed
├── exchange/import-io.ts             # the import summary's counts gain assets and assumptions
└── exchange/formats.ts               # SCRYLUX_FILE_VERSION, the readable versions

apps/api/src/
├── review/
│   ├── compare.ts                    # comparison, differences, needs: used by reading a draft and by deciding
│   ├── decide.ts                     # accept, reject, undecide: one transaction each
│   └── provenance.ts                 # write copies in the accept transaction; read for the route
├── v1/review.ts                      # POST …/draft/decisions, GET …/provenance
├── v1/assets.ts, v1/assumptions.ts   # list, create, patch, delete (one file per resource)
├── v1/element-writes.ts              # updateElementIn drops the provenance of a flag whose value changed
├── v1/errors.ts, v1/write-log.ts     # new constraint messages; RecordType + logDecision
├── v1/operations.ts, v1/openapi.ts   # registration
├── v1/extraction.ts                  # GET …/draft attaches the review
├── snapshot.ts                       # + assets (with holders) and assumptions
├── exchange/scrylux-export.ts        # version 2
├── exchange/import/{scrylux,plan,write}.ts   # assets and assumptions in the plan, the checks and the inserts
└── report/{model,markdown,html}.ts   # the Assets and Assumptions sections

apps/api/test/
├── review/                           # compare, decide, dependencies, concurrency, limits, provenance, injection-free canary
├── contract/v1/                      # review, assets, assumptions, provenance; auth/validation counts 49 → 59
├── exchange/, report/                # extended
├── dogfood/, demo/                   # the committed model and the demo file are version 2; assets and assumptions among the compared parts
└── (also parse.ts of the import: a file is parsed by its format_version)

apps/web/src/
├── App.tsx, pages/ThreatModelPage.tsx   # + /threat-models/:id/assets and its tab
├── pages/AssetsTab.tsx                  # new, with tests
├── pages/DraftTab.tsx                   # review controls, the replacement warning
├── draft/ReviewControls.tsx             # new: selection, accept, reject, undecide
├── draft/AcceptEditor.tsx               # new: the edits of one item
├── draft/{DraftList,ItemPanel,DraftDiagram,draft-items}.ts(x)   # states, comparison, needs
├── components/ProvenanceNotice.tsx      # new: used by the diagram's properties panel and the Assets tab
├── diagram/PropertiesPanel.tsx          # the notice and per-flag marks
└── api/queries.ts                       # decisions, assets, assumptions, provenance
apps/web/e2e/review.spec.ts              # new

docs/formats/scrylux-file.md, scrylux-file-v2.schema.json, docs/formats/otm.md (assets not carried), API.md, CHANGELOG.md
plan.md, docs/roadmap.md                 # M5 as built
.specify/memory/constitution.md          # 1.19.0
docs/threat-model/                       # rebuilt, for the maintainer to approve
```

**Structure Decision**: the existing monorepo. Review is a module of `apps/api` used by the API only (the worker is not involved, so
the existing import-graph test needs no change). `compare.ts` is its own file because two callers use it: reading a draft and deciding.
Route files stay one per resource.

## Complexity Tracking

| Departure | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| The draft's items now reference the records an accept created (Milestone 4 kept the draft wholly apart) | A decision has to say which record an item became, so that a deleted record makes the item undecided again (FR-014, FR-018) | Storing no link: the page could not tell "accepted" from "accepted and since deleted", and a second accept would duplicate |
| Two new record kinds, with a tab, eight operations, a file version and two report sections | The spec's Q1 decision (2026-11-10): assets and assumptions are acceptable | Leaving them in the draft: decided against by the maintainer |
| A `provenance` table separate from the records | Provenance must survive the draft, apply to three record kinds and to single flags, and never be settable or exported | A column on each record: three migrations of existing tables and a change to every record shape and to the file |
| One provenance row per proposed flag | A flag an accept fills in on a hand-drawn element is the only AI content on it (FR-017), and a person's later edit removes exactly that flag's mark | One row per record: it would mark the whole element or lose which flags are AI's |
| Scrylux file version 2 | Assets and assumptions must travel with the model for "export it" to hold (FR-023) | Leaving them out of the file: an export would silently lose records a person accepted |
