# Research: Dogfood, Specter's Own Threat Model

Decisions for the open points of [plan.md](./plan.md). Each says what was decided, why, and what was
rejected. Facts about existing code were read from the repository on 2026-10-11; the one thing that
could not be settled by reading is marked **to verify** and has a task.

## 1. Identifiers change on every update, so the report is the file to review

**Decision**: the committed Specter file keeps the ids of the install that exported it. The documented
update procedure is "import the committed file, change it in the app, export both files". That procedure
rewrites every id in the Specter file, and the folder's README says so (FR-018). Reviewers read the
report's diff. No check compares an id.

**Evidence**:
- `docs/formats/specter-file.md`: ids "are opaque ... An import gives every record a new id".
- `apps/api/src/exchange/import/plan.ts` (`checkModel`) mints a new id for every element, threat and
  mitigation.
- Milestone 6's research (§3, §4) expected stable ids only from "one install's exports". It is true
  for a long-lived authoring install and false for the repository's procedure.
- The report's order and numbering do not use ids: Milestone 5's research §7 sorts by type, name, risk,
  category and title, numbers elements `E1…` in report order, and takes Mermaid ids from that order.
  An id only breaks a complete tie (see #2).

**Rationale**: it needs no product change (FR-022), keeps the repository as the only source (a contributor
needs no access to anyone's database), and gives the reviewer a diff that shows the change (SC-007).

**Alternatives considered**:
- **A long-lived authoring install.** Ids stay stable and the JSON diff is small, but the real source
  is a database nobody else has. Rejected: a contributor cannot update the model.
- **Keep ids on import** (an option of the import operation). It would give a small JSON diff from the
  repository alone. Rejected for this milestone: it is a product change, and it widens what an import may
  do (a file would choose its own ids, with collisions across threat models to define). Recorded as a
  finding for later (User Story 5) if the noise proves costly.
- **Normalising ids in the committed file** (for example `e1`, `t1`). The file would no longer be what
  Specter exports, and FR-013 would fail.

## 2. No ties that only an id could break

**Decision**: the model satisfies three uniqueness rules, and a check enforces them (contracts/checks.md,
check 3):
- elements of one type have different names (FR-004);
- threats on one element (or on none) have different category-and-title pairs;
- mitigations of one threat have different descriptions.

**Evidence**: `apps/api/src/exchange/order.ts` and Milestone 5's research §7 order records by those
fields "then id". Two records equal in every field before the id could come out in the other order
after an import, because the ids are new. Then the round-trip check (FR-014) and the report check
(FR-015) would fail with a difference that looks like noise and is not.

**Rationale**: making the cause a check of its own turns an obscure failure into a message that names
the two records.

**Alternatives considered**: comparing as sets instead of lists. Rejected: it would also hide a real
reordering bug in the export, which is what FR-014 exists to catch.

## 3. The drift check is the real "Generate threats" run

**Decision**: the test imports the committed file into a scratch project **twice** (model A and model
B, contracts/checks.md), runs `POST /api/v1/threat-models/{id}/threats/generate` on **model B only**, and
reads B's threats back. Checks 2 and 7 use A, which generation never touched: otherwise the threats a new
rule adds would reach the export and the report, and the "only warns" half of the decision would become a
failure through the other checks. It classifies:
- **Blocking**: a threat with a `stale` mark after the run (the engine's own verdict: rule retired,
  unknown or its conditions unmet), and a committed file that already carries a stale mark.
- **Warning**: a rule threat the run created, that is, one not in the committed file. The test names
  its rule (`library_ref`) and its element.

The scratch models are discarded; nothing about the run is compared with ids. `ThreatRecord` includes
`stale` (`packages/core/src/schemas/threat.ts`), so the threat list carries what the classification
needs and no further operation is required.

**Evidence**:
- `apps/api/src/rule-engine/plan.ts` (`planGeneration`): a generated threat with no candidate any more
  is marked stale with a reason (`rule_retired`, `rule_unknown` or `conditions_unmet`); each candidate
  without a stored threat is created. The result counts are `created`, `existing`, `newly_stale`,
  `no_longer_stale` and `skipped_elements`.
- A threat is identified by its element and rule only (`keyOf`), so editing a threat's text, status or
  mitigations never counts as drift.
- `packages/threat-library/rules/retired.yaml` exists (empty today), and retirement makes the threat
  stale: this is why Option C fails the build on retirement.

**Rationale**: a second implementation of "stale" would drift from the engine. Using the operation also
proves the committed model loads into the engine, which is the point of dogfooding.

**Details**:
- `skipped_elements` greater than 0 means an element's stored properties were outside the vocabulary
  (Milestone 3, FR-002a). The import already refuses such a file, so a non-zero count is a failure with
  its own message, not silence.
- The classification uses the threat list of the scratch model after the run and the committed file's
  rule threats before it, matched on element name, element type and `library_ref` (names are unique,
  #2), not on ids.

**Alternatives considered**: calling `planGeneration` directly with the file's elements. It is pure and
faster, and gives the same counts, but it skips the import and the database, and a regression between
them would go unseen. Rejected for the main check; the broken-input tests (`checks.test.ts`) use the
pure classification function on crafted results.

## 4. A warning is a Vitest annotation

**Decision**: the new-threat warning is raised with the test context's `annotate(message, 'warning')`,
inside a test that passes. Vitest 5's `github-actions` reporter, which Vitest enables by itself when
`GITHUB_ACTIONS` is `true`, turns an annotation into a `::warning file=…,line=…::message` workflow
command, which GitHub shows on the pull request's checks. The default reporter prints it locally.

**Evidence**: `vitest@5.0.3` (`dist/chunks/index…js`): `GithubActionsReporter.onTestCaseAnnotate` emits
a workflow command whose type is the annotation type when it is `notice`, `warning` or `error`, and
only when the annotation has a `location`; `defaults.reporters` appends `github-actions` when
`GITHUB_ACTIONS === "true"`. `annotate` is on the test context (`TestContext.annotate(message, type?)`).

**Verified on 2026-10-11 (the spike): yes.** A throwaway test in `apps/api/test/dogfood/` that called
`await annotate('…', 'warning')` inside a passing test, run with `GITHUB_ACTIONS=true pnpm --filter @specter/api exec vitest run …`
under this repository's configuration (`projects`, a `globalSetup`), printed
`::warning file=<path of the test>,line=4,column=9::<message>` and the test still passed. The annotation
carries a location, so the reporter emits it. The spike file was deleted.

**Fallback (not needed; kept in case a later Vitest changes this)**: write the same workflow command, `::warning title=…,file=…::…` on a line of
its own, straight to the real standard output (`process.stdout.write`, not `console.warn`, which Vitest
intercepts and prefixes). A second fallback is a warning in the test's own name and a note in the job
summary. Neither changes the contract in contracts/checks.md: a message names the rule and the element,
and the build passes.

**Alternatives considered**: a separate workflow step that runs the comparison and posts a comment.
Rejected: it needs `pull-requests: write`, which the workflows deliberately do not grant
(`docs/ci.md`), and a second place to maintain.

## 5. A scratch project cannot be called "Specter"

**Decision**: the test creates its own project with a unique name (the existing `uniqueName` helper),
imports the committed file into it, and compares everything except two header lines of the report: the
project line and the export time. It separately asserts that the committed report's project line names
the project the file names, and that the report's title names the threat model.

**Evidence**:
- `packages/db/migrations/004_projects.sql`: project names are unique install-wide, ignoring case and
  surrounding space (`projects_name_key`). A test project named "Specter" would collide with a
  developer's real one: `apps/api/test/global-setup.ts` says the tests share the local database with
  `docker compose up`, and its teardown deletes projects created during the run.
- `apps/api/src/report/markdown.ts`: the header holds `**Project:**` and `**Exported:**`; nothing else
  in the report depends on the project or the clock (Milestone 5's research §7: "the only variable
  text").
- The threat model's own name is kept by an import when it is free, and it is free in a new project.

**Alternatives considered**: renaming the scratch project to "Specter" and failing when it exists.
Rejected: it makes the suite fail on a developer's machine for a reason unrelated to the change.

## 6. Authoring: the documented API, throwaway scripts, nothing committed

**Decision**: the model is built in a local `docker compose up` install, through the documented API
(`API.md`), with scripts kept outside the repository, from the blueprint in data-model.md. The
diagram is then opened in the web app to check its layout by eye (FR-004), and edited there if needed.
The two exports are taken with the documented operations.

**Rationale**:
- FR-013 allows the app or its documented API, and about 100 generated threats each need a status and
  a reason. By hand in the browser that is hours of error-prone clicking; through the API it is a table
  of decisions.
- Nothing is committed from the scripts: a committed script would be a second description of the model,
  and the spec says the repository holds only the exports.
- The blueprint, not the script, is what a reviewer reads. It lives in this directory as the plan's
  record and as the traceability list the pull request carries (SC-003).

**Alternatives considered**:
- **Only the web app.** Faithful to "built in Specter" and exercises the editor, but impractical for
  the triage and unreviewable. Mitigated by using the editor for the layout pass.
- **A generator that writes the file.** Rejected: FR-013 forbids a hand-made file, and a generator is
  one.

## 7. Where the files live and what they are called

**Decision**: `docs/threat-model/` holds `README.md`, `threat-model.specter.json` and `report.md`.

**Rationale**: the `.specter.json` ending is the one Specter's own download uses
(`apps/api/src/exchange/filename.ts`), so the file opens as a Specter file; `report.md` is a name a
reader finds without knowing the project's conventions. The date is left out of the names: the
repository's history carries it, and a dated name would change on every update and break links. The
folder sits next to `docs/formats/`, which already describes the file formats it uses.

**Alternatives considered**: the repository root (`THREAT_MODEL.md`) for visibility: rejected, the root
already holds many files, and the README link provides the visibility. `specs/`: rejected, specs are
per-milestone records, and this is a living document.

## 8. The committed file is checked in canonical form

**Decision**: besides validating the file against the published schema and the shared zod schema, the
check requires the text to equal what the real exporter writes for the same content,
`serializeExport(buildSpecterFile(snapshotOf(file), exported_at))`: the bytes, the key order and the content
order of the records (two-space indentation, `\n`, one final newline). Found while implementing:
`serializeExport(JSON.parse(text))` is not enough, because `JSON.parse` keeps the order it is given, so a file
with shuffled keys would reproduce itself.

**Evidence**: `apps/api/src/exchange/specter-export.ts` exports `serializeExport`, and
`docs/formats/specter-file.md` states the byte form. A hand edit that leaves valid JSON in another shape
(reformatted, keys reordered) is then caught. A hand edit in the canonical form is not, which the spec
says and accepts (Edge Cases).

**Alternatives considered**: nothing cheaper detects a hand-made file, and the import round trip alone
would accept one.

## 9. The secret and personal-data patterns

**Decision**: the scan covers the two committed files and the folder's README. The patterns are a data
table in `apps/api/test/dogfood/patterns.ts`:
- an email address;
- an IPv4 address (four dotted groups of 0 to 255);
- a 12-digit cloud account identifier (`\b\d{12}\b`);
- an AWS access key id (`AKIA` or `ASIA` followed by 16 capitals or digits);
- a JSON web token (`eyJ…` three dot-separated groups);
- a bearer credential (`Bearer ` followed by 20 or more token characters);
- a private key block (`-----BEGIN … PRIVATE KEY-----`);
- a hosting-provider token (`gh[pousr]_` followed by 36 characters);
- an assignment of a value to a secret-sounding name (`password`, `secret`, `token`, `api_key`
  followed by `=` or `:` and a non-empty value).

Each pattern has a sample that must match and a sample that must not (`checks.test.ts`), so a pattern
cannot rot into one that matches nothing. The patterns are heuristics: a clean scan is not proof, and
the review of FR-010 (SC-006) stands behind it.

**Rationale**: constitution Principle IV keeps detection heuristics as data, so they are readable and
diffable without reading the test. Version numbers such as `22.1.0` do not match the IPv4 pattern (three
groups); four-group versions are rare, and a false positive is fixed by rewording.

**Alternatives considered**: a dependency such as a secret scanner. Rejected (Principle III): the
repository's CodeQL and GitHub's own secret scanning already look at the whole tree, and this check is
only a cheap guard on the one file people paste text into.

## 10. How the constitution's wording maps to a status

**Decision**: the risk register (data-model.md §4) applies these rules:

| The section says | Threat status | Mitigations on it |
|---|---|---|
| Mitigated | mitigated | at least one implemented or verified |
| Partially mitigated | open | the implemented controls, and a proposed one for what remains |
| Accepted risk | accepted, with a reason | the controls in place, if any |
| Open risk | open | the planned remedy, as proposed, if the plan names one |
| Residual risks (listed under a mitigated item) | accepted, with a reason | none |
| "Low risk at current scale" (the unpaginated lists) | accepted, with a reason | none |
| Planned (a later phase's feature) | not in the model | |
| "No widening" notes (Elevation of Privilege) | not a risk: no threat | |

**Rationale**: Specter's statuses are open, mitigated, accepted and not applicable, so "partially
mitigated" has no status of its own (spec Edge Cases). The two mappings in the middle are
interpretations, since the section does not use the words "accepted risk" for them. They are marked as
such in the traceability list so the reviewer can overrule them.

When a rule-generated threat already covers a register risk (for example the rule for a missing audit
log), the register's status, reason and mitigations are put on the generated threat. No manual
duplicate is added (FR-006: manual threats are for what the rules cannot derive).

## 11. The model's own status, and the pipeline

**Decision**: the threat model is committed as `in_review`, and moved to `approved` only by the
maintainers after they have read the traceability list in the pull request (spec, Assumptions). The
build and release pipeline, the supply chain and the repository settings are threats of the whole model
(`element_id = null`), and so are the other risks that belong to no single element.

**Rationale**: five element types cannot draw a CI pipeline, and the constitution records those risks
in detail (Tampering, Information Disclosure and Elevation of Privilege bullets). Model-level threats
are an existing capability, shown in the report under "Threats not linked to an element".

## 12. The constitution change

**Decision**: a MINOR amendment, 1.11.0 → 1.12.0, with these edits:
- **Principle V**: add that Specter's own threat model is committed in `docs/threat-model/`, that the
  Threat Model section governs when they disagree and the model is corrected, and that a change that
  updates the section updates the model in the same change (a rule that is only added may follow, the
  check only warns).
- **The Threat Model section's preface**: one sentence pointing to the model as its structured
  counterpart.
- **Sync Impact Report**: the version change, the rationale, "Modified principles: V (applied, text
  extended)", "Threat Model changes: none (no entry point, asset or trust boundary)", and the date.
- **Development Workflow**: the pull request must state whether the model changed (it already must say
  whether the section did).

**Rationale**: M6 recorded each milestone's effect the same way. It is MINOR because it adds a duty
(Governance: "materially expanded guidance"), not a PATCH wording change.

## 13. Reading the committed files from a test

**Decision**: the tests find the folder relative to their own file (`import.meta.url`), as
`apps/api/test/global-setup.ts` finds `.env.test`, so they run from any working directory and in CI.
A missing file is a failure with the fix in the message, not a skip: a skipped check would let the files
be deleted unnoticed.

## 14. What the report check proves, and what it does not

**The report does not read the live rule library** (checked: nothing under `apps/api/src/report/`,
`apps/api/src/exchange/` or `snapshot.ts` imports `@specter/threat-library`; a stale threat's text comes
from the stale reason stored on the threat). So editing a rule's wording cannot change the rebuilt
report, and check 7 stays outside the "only warns" case.

The report is built by the real operation from the imported model, so equality (after #5's two lines)
proves three things: the committed report is not hand-edited, the renderer still produces it, and the
model loads without loss. It does not prove the report displays well on the repository host; that is
a visual check in the quickstart. The Mermaid diagram is fenced as `mermaid`
(`apps/api/src/report/markdown.ts`), which the host draws; a model of 41 elements and 21 flows is far below
the diagram's size limits (`MERMAID_MAX_EDGES = 400`), so the "too large to draw" note cannot replace
it. A test asserts the committed report contains the fenced diagram, so a future size change cannot
silently drop it.
