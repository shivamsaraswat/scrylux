# Quickstart: validating the review UI

How to prove the milestone works. §1 runs in CI with no provider and no secret (FR-029); a review reads a draft that is already stored, so
the tests seed one in SQL and need no worker. §2 is by hand. There is no pre-release model run: no prompt, adapter or extraction changes
(FR-029).

## Prerequisites

- The dev database on the pgvector image: `docker compose up -d db`.
- `pnpm install`. No new dependency (research #15).

## 1. Automated suites

`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`. What each part proves:

| Area | Test location | Proves |
|---|---|---|
| Migration 019 | `packages/db/test/review-schema.test.ts` | the tables and checks of [data-model.md](./data-model.md); a name unique ignoring case and whitespace, per threat model; the 201st asset and assumption refused (and `MAX_*` equal to the triggers); a data flow or a boundary refused as a holder; an element's delete removes its holder rows and provenance and nulls an item's link; a deleted chunk nulls a citation's `chunk_id`; exactly one target per provenance row; cascades from threat model and project (FR-006, FR-014, FR-017, FR-021) |
| Schemas | `packages/core/test/review.test.ts`, `asset.test.ts` | `DraftDecision` and every input are strict; `edits` refuses an unknown key; the discriminated actions; limits of text (FR-007, FR-013, FR-021) |
| Comparison | `apps/api/test/review/compare.test.ts` | `new`, `matched`, `several` per kind, ignoring case and whitespace, with a non-ASCII name; the differences (flags, boundary, endpoints, holders); `needs` for a flow and a member; a matched endpoint resolves with no decision; an accepted item resolves to its created element (FR-002, FR-003, FR-009) |
| Accept | `apps/api/test/review/decide.test.ts` | a new element, asset and assumption are created with the stored values and no position; edits applied; a matched element gets only its unassessed flags, a matched asset only its missing holders, a matched assumption nothing; boundaries, nodes and flows created in one request in dependency order; 0 threats, mitigations or other elements changed; nothing created by reject, undecide or reading (FR-007 to FR-015, SC-001, SC-002) |
| Refusals | `apps/api/test/review/refusals.test.ts` | each row of the 409 and 400 table of [contracts/http-api.md](./contracts/http-api.md): a missing dependency, a stale `seen`, an already decided item, a limit with "N more fit", a rule-breaking edit, an edit that does not fit the kind, a reference to another threat model's element; every refusal leaves the threat model unchanged (FR-009 to FR-013, SC-003) |
| Concurrency | `apps/api/test/review/concurrency.test.ts` | two connections accepting the same item at once create one record and the second is refused; an accept racing a discard, and racing a new draft's commit, creates nothing or is whole, and never deadlocks; an element deleted after the comparison makes a `matched` accept `409` (FR-011, SC-003, SC-004) |
| Undo | `apps/api/test/review/states.test.ts` | reject, return to undecided, accept after reject; a created record deleted elsewhere reads as undecided and can be accepted again; a matched accept stays accepted; replacing and discarding the draft drops decisions and keeps records and provenance (FR-014, FR-016) |
| Provenance | `apps/api/test/review/provenance.test.ts` | a created record has its row and one per proposed flag it keeps; a flag edited at accept has none; a matched element has rows for the flags filled in and is not marked as a whole; a person's later change or removal of a flag drops that flag's row only (single and batch writes), an unchanged flag keeps it; a deleted source reads "Source deleted"; no text of a source is stored; provenance survives the draft; a client cannot set it; a hand-made and an imported record have none (FR-017, FR-018, SC-004) |
| Assets and assumptions | `apps/api/test/contract/v1/assets*.test.ts`, `assumptions*.test.ts` | every status of the contract for the four operations each: duplicates, the limit, a holder that is a flow or a boundary or of another model, a PATCH that replaces holders, strict bodies, the write-log line with ids only (FR-021, FR-022) |
| Decision routes | `apps/api/test/contract/v1/review*.test.ts` | the body's shapes and every status; `DecisionResult`; `GET …/draft` carries `review`; `GET …/provenance`; one log line per decision with counts and no text; the OpenAPI document lists the ten operations; operation counts 49 → 59 (FR-019, FR-022) |
| Export and import | `apps/api/test/exchange/*.test.ts` (extended) | a Scrylux file v2 has both lists, sorted, with every key; exporting an unchanged model twice gives the same bytes apart from `exported_at`; the file imports back to an equal model with no provenance; a v1 file still imports; a holder that is not in the file, a flow as a holder, a repeated name and an excess count are refused with a place and no value; the summary counts both; the OTM export and the Threat Dragon import are unchanged (FR-023, SC-008) |
| Reports | `apps/api/test/report/*.test.ts` (extended) | both sections in the Markdown and the HTML, parsed by the real CommonMark and HTML parsers: a hostile name and description stay text; the contents line is unchanged and a report of a model with neither record is byte for byte as before; a report holds no provenance (FR-023, SC-006) |
| Dogfood | `apps/api/test/dogfood/*.test.ts` (extended) | the committed threat model is version 2 and round-trips, with `assets` and `assumptions` among the compared parts |
| Canary | `apps/api/test/worker/canary.test.ts` and `review/canary.test.ts` | a fake name, statement and quote run through every decision, create, edit and delete appear in 0 log lines and 0 error answers, and in no file or report (SC-006) |
| Scale | `apps/api/test/review/scale.test.ts` | a whole draft (40 elements, 15 assets, 15 assumptions) accepted into a threat model of 960 elements in under 2 s; reading a draft with its review for 1,000 elements under 300 ms (SC-005) |
| Web | `apps/web/src/pages/DraftTab.test.tsx`, `AssetsTab.test.tsx`, `draft/*.test.tsx`, `components/ProvenanceNotice.test.tsx` | states and comparisons shown; Accept disabled with its reason until the needs are selected; multi-select by keyboard; the editor sends only the edits; each refusal's message and a reload; the replacement warning with decisions; the assets and assumptions forms and their errors; the provenance notice for a record, a flag and a deleted source; every text rendered as text (FR-001 to FR-005, FR-019, FR-021, FR-025) |
| Browser | `apps/web/e2e/review.spec.ts` | with a seeded draft: open the Draft tab, accept a subset with a flow and its endpoints together, edit and accept one element and one asset, reject one, see the diagram editor show exactly the accepted elements with the provenance notice, see the Assets tab, export a Scrylux file and a report and find the records in them and none of the draft, import the file back (SC-007, SC-008) |
| Earlier suites | the whole of `pnpm test` and `pnpm test:e2e` | v0.1 and Milestones 2 to 4 pass with no worker and no provider (SC-009) |

## 2. By hand: reviewing a real draft

1. Start the stack with a hosted generation provider and an embedding provider (`docs/ai-providers.md`), and do Milestone 4's §2 to get
   a draft of `evals/samples/scrylux/design.md`.
2. On the Draft tab, check each item shows its state and comparison. Draw one of the proposed processes by hand on the Diagram tab with
   the same name and one flag set, then reload the Draft tab: check it reads "Already in the model" with the differing flags listed.
3. Select a flow only: check Accept is disabled and says what it needs. Select it with its endpoints and Accept: check three elements
   appear on the Diagram tab, placed on the grid, and the flow joins them.
4. Open Accept… on an element, change its name and clear a flag, accept: check the created element has the edits and the draft item still
   shows the model's values.
5. Reject an item and return it to undecided. Delete an accepted element on the Diagram tab and check its draft item is undecided again.
6. Accept an asset and an assumption: open the Assets tab, check the provenance notice, then add one of each by hand and check they have
   none. Edit a flag the accept set on an element in the diagram and check its AI mark goes while the element's other marks stay.
7. Discard the draft: check the accepted records and their provenance stay, and the notice still shows its citations or "Source deleted".
8. Download the Scrylux file and the Markdown report and check the assets and assumptions are in them, and no rationale or citation is.
   Import the file into a new threat model and check the records come in with no provenance.
9. Start a new extraction on a threat model with decisions: check the warning says decisions are lost and accepted records stay.
