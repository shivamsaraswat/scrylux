# Phase 3 Milestone 5: review the draft

A person can now decide on each item of a draft: **accept** it, **edit and accept** it, **reject** it, or return it to undecided, one at a time or in a batch. Nothing a model proposed enters the threat model until a person accepts it, and only one route can put it there. To give an accept somewhere to put assets and assumptions, they become **records of a threat model** too, with a new **Assets and assumptions** tab, routes, tables, file version and report sections.

## Security implications (Development Workflow: ten routes, a new kind of AI-derived record, provenance, a new file version)

- **This is the human accept that Principle VI asks for.** `POST /threat-models/{id}/draft/decisions` carries ids, the draft the reviewer saw (`draft_id`), what the reviewer saw of each item (`seen`) and, for an edit, the edited fields. It carries no other content: the server builds every record from the draft it stores, so a client cannot put text, a name or provenance of its own into a record.
- **One transaction, one lock order.** A decision locks the threat model, then the draft row, then its items (`FOR UPDATE`), and writes everything or nothing. A draft or a threat model that changed since the reviewer looked, an item that is already decided, a count over a limit (1,000 items; 200 assets; 200 assumptions) and an item whose dependency is not in the model are each refused with `409` or `400` and a fixed message, and nothing is written. `apps/api/test/review/refusals.test.ts` and `concurrency.test.ts` hold each; the concurrency test runs two decisions and a commit at once.
- **"Same name" is decided in the database**, with `lower(btrim())`, the expression of the unique indexes, so the comparison shown to a reviewer and the uniqueness a write is held to cannot disagree.
- **Provenance a client cannot set.** A record an accept creates carries a mark, and a stored copy of its rationale and citations as spans of chunks, as Milestone 4 keeps them: a citation whose source was deleted says so and no text of a source outlives it. A match that fills the flags nobody had assessed carries provenance for each of those flags, and the element is not marked as AI-created as a whole. A person's later change of a flag removes that flag's mark, since the value is then theirs. Every body of a record route is strict, so a mark cannot be sent (`packages/core/test/asset.test.ts`).
- **Ten new operations**, defined with `defineOperation` so the router and `apps/api/openapi.json` agree (59 resource operations now; `openapi.json` is unchanged by `pnpm --filter @scrylux/api openapi`): `listAssets`, `createAsset`, `updateAsset`, `deleteAsset`, `listAssumptions`, `createAssumption`, `updateAssumption`, `deleteAssumption`, `decideDraft`, `listProvenance`. The draft read gains a `review` for each item.
- **Broadening (FR-026):** any signed-in account can review any threat model's draft and create, edit and delete its assets and assumptions. There are no roles before Phase 6, as for every other record. The constitution records it; each decision names the account and the time.
- **Nothing of a draft in a log, an error or a refusal.** The decision route logs one line: the account, the action, the threat model and counts. Each constraint of migration 019 answers with a fixed message and never repeats a row value (`apps/api/test/review/errors.test.ts`). A canary test runs distinctive text through the whole path and finds it only in the tables that should hold it (`apps/api/test/review/canary.test.ts`).
- **AI-derived text is ordinary text once accepted.** A name, a statement and a description an accept created are stored as data and rendered escaped in the page; the report and the file carry them as they carry any record, under the escaping the report's existing hostile-text tests hold.
- **No prompt, no provider call and no worker code changed.** Reviewing reads the stored draft and writes records; it sends nothing to a model. No eval gate applies (Principle II) because no prompt changed.

## The constitution amendment (1.19.0)

The Threat Model section gains assets, the new entry points (ten routes) and the new risks, and resolves the items that waited for this milestone. It adds no principle and removes none. The rationale is in the amendment's own header.

## What changes for every install

- **Migration `019_review.sql`** adds the tables `assets`, `asset_holders`, `assumptions`, `provenance` and `provenance_citations`, and the columns of `draft_items` that hold a decision and the record it created. The first process to start applies it; it is forward-only, as every migration is.
- **The Scrylux file is written as version 2** (assets, assumptions). Version 1 files still import. A file written by this release is not read by an earlier one, which does not know version 2. An OTM export and a Threat Dragon import are unchanged: neither has a place for assets or assumptions, and an import still lists an OTM file's own assets as not carried over.
- **Reports gain Assets and Assumptions sections.** The contents line is unchanged.
- **The committed threat model of Scrylux itself** (`docs/threat-model/threat-model.scrylux.json`) is now written as version 2 by the serializer, not by a running Scrylux, with its report; the new entry points and risks are recorded in it. **Its approval is the maintainer's**: I wrote none for this milestone, and `docs/threat-model/README.md` still shows what it showed.
- Nothing is required of an install: with no worker and no provider, everything of v0.1 and Milestones 2 to 4 works as before (SC-009).

## Decisions to review

- **Assets and assumptions become new records on accept** (clarification Q1), and can also be created by hand (Q4); only an accepted one carries provenance.
- **A match fills only the flags nobody has assessed** (Q2). Nothing else on an existing element changes, and an asset gains only the holders it lacks.
- **Provenance is a mark and a stored copy of the rationale and citations as spans** (Q3), and a flag has no rationale of its own (Milestone 4 gave a flag citations only), so a flag's provenance keeps its item's rationale.
- **A match counts as "in the model" for dependencies**: a flow whose endpoint matches exactly one element attaches to it with no decision on that endpoint. A comparison that finds several matches asks the reviewer to choose.
- **A request that includes an item already decided is refused as a whole**, so a double click gets a `409` and creates nothing.
- **An accepted item whose record is deleted reads undecided again**, and cannot be undone from the review: its record is deleted where it lives.
- **The tab is named "Assets and assumptions"**, and the tab bar now wraps (`apps/web/src/diagram/diagram.css`): five tabs did not fit a narrow screen, which `e2e/diagram-large.spec.ts` caught.
- **`test/storage/sweep.test.ts` moved into the serial `jobs` group** (`apps/api/vitest.config.ts`). It truncates `jobs` and `sources`, and with them every draft, so beside the review tests (which seed sources and drafts) it deadlocked with them and deleted their sources. It belongs in the group by the config's own rule.
- **File sizes (Principle III).** `DraftTab.tsx` was 208 lines before this change and is 247 now. `ReviewControls.tsx` (101 lines) holds the controls of one item and is used by every kind of item the tab shows; `AcceptEditor.tsx` (187) holds the edit form for an element, an asset and an assumption, which the tab and the Assets tab both open. Each is used from more than one place. `AssetsTab.tsx` is 306 lines for the one tab. In the API, `review/compare.ts` is 175, `decide.ts` 249, `provenance.ts` 96 and the route file 55.

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | passes |
| `pnpm lint` (eslint of every package and `scripts`, then the license check) | passes; three `no-unnecessary-type-assertion` errors in `packages/db/test/review-schema.test.ts` were fixed |
| `packages/core` / `llm` / `threat-library` / `db` / `web` tests | 563 / 645 / 314 / 441 / 935, all pass |
| `apps/api` tests | 2,612 of 2,612 pass outside the agent's sandbox, with the shell's `LLM_*` and `EMBEDDING_*` variables unset. Inside the sandbox 49 fail, in the 10 files that failed before this change (`extract/read`, `extract/failures`, `sources/ingest`, `worker/canary`, `contract/v1/{sources,sources-retry,sources-refresh,jobs,jobs-off,extraction}`), all of which need a child process, a worker or a socket the sandbox blocks |
| `scripts` tests | 288 pass outside the sandbox (3 `release/notes` tests spawn the `tsx` CLI, which the sandbox blocks) |
| `pnpm build` | passes |
| `pnpm test:e2e` | 65 pass outside the sandbox, with the provider variables unset, including the new review flow in `e2e/draft.spec.ts` (accept a selection with a flow and its ends together, edit one element and one asset, reject one, see the provenance notice and the Assets tab, download a file and a report and find the records and nothing of the draft in them) |
| `docker build --pull .` | passes |
| `scripts/check-db-upgrade.sh` | passes |
| `openapi.json` | unchanged by `pnpm --filter @scrylux/api openapi` |

**Two problems found while running the whole suite, and fixed:** a test of Milestone 4 that scans the whole database for its canary word found it in the rows of the new review canary test (the review test now uses a different recognizable string), and the deadlock above. Run with a real provider's variables in the shell, the e2e app inherits them and the Jobs page expects "Embeddings: not configured", so unset them first.

**Added by `/speckit-converge`:** a matched draft item now links to the record it matched (`ItemPanel.tsx`; the API already returned `matched_id`), and three keyboard-only tests hold FR-025 in `DraftTab.test.tsx`. Web tests: 941 pass; e2e: 65 pass.

**Running e2e locally:** `.env.test` points e2e at the `threats` database, which a running `docker compose` stack also uses. Its worker, with a real provider, then takes the e2e jobs and fails `jobs.spec.ts` (and, when it fails, skips the projects that depend on it, including `draft.spec.ts`). Run e2e with `DB_NAME=scrylux_db_test` (or with the compose worker stopped) and with the provider variables unset.

**Quickstart §2, the walk by hand against a real draft (T076):** done by the maintainer, not by an agent, who reported it complete. Per-step results were not given to the agent, so none are recorded here; the maintainer may add them. One thing came up: the first extraction attempt on the sample document stopped with "The answer was cut off at the output limit" at the default `EXTRACTION_MAX_OUTPUT_TOKENS` of 12,000 (a Milestone 4 behavior, not a review one), and went through once the setting was raised for the app and the worker. Whether the default is too small for the sample document is worth a look before release.

No live run of an extraction with a local model was made, and none was needed for this milestone, which sends nothing to a model; Milestone 4's recorded manual run and its waived local run stand as they were.
